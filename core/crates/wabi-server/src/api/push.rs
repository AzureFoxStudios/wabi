//! Web Push API: VAPID public key, subscribe, unsubscribe, preferences, test,
//! and the dispatcher the rest of the server uses to notify an account's devices.
//!
//! Routes (nested under `/api/push`):
//! - GET    /vapid-public-key
//! - POST   /subscribe     (auth, registered accounts only)
//! - DELETE /subscribe     (auth)
//! - GET    /preferences   (auth)
//! - PUT    /preferences   (auth)
//! - GET    /channels      (auth) — channels with message push on
//! - PUT    /channels      (auth, registered accounts only)
//! - POST   /test          (auth)
//!
//! Delivery uses `crate::web_push` (RFC 8291/8292) and works for both browser
//! subscriptions and UnifiedPush endpoints, which speak the same protocol.
//!
//! Message push for server channels is opt-in per channel: an account only
//! wakes for channels it explicitly switched on (PUT /channels). Direct
//! messages ride the `direct_messages` account switch (default on) and calls
//! the `calls` switch; neither consults the channel list. The test endpoint
//! deliberately bypasses every gate so an operator can always tell delivery
//! apart from configuration.
//!
//! Privacy: a push payload never contains message text. It carries who it is
//! from and where to open, so encrypted DMs stay unreadable to the server's
//! notification path as well, and the push service only ever sees ciphertext.

use axum::{extract::State, Json, Router};
use p256::ecdsa::SigningKey;
use p256::pkcs8::DecodePrivateKey;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::push_store::{now_ms, PushPreferences, PushSubscriptionRecord};
use crate::state::AppState;
use crate::web_push::{self, PushMessage, SendOutcome, Urgency};
use wabidb::domain::ChannelKind;
use wabidb::engine::wabi_store::WabiStore;

const MAX_ENDPOINT_LEN: usize = 2048;
const MAX_KEY_LEN: usize = 256;
/// Per-account device cap, enforced in the store (oldest registration evicted).
pub const MAX_DEVICES_PER_USER: usize = 10;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/vapid-public-key", axum::routing::get(get_vapid_public_key))
        .route("/subscribe", axum::routing::post(subscribe).delete(unsubscribe))
        .route("/preferences", axum::routing::get(get_preferences).put(put_preferences))
        .route(
            "/channels",
            axum::routing::get(get_push_channels).put(put_push_channels),
        )
        .route("/test", axum::routing::post(test_push))
        .with_state(state)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VapidPublicResponse {
    public_key: String,
}

async fn get_vapid_public_key(State(state): State<Arc<AppState>>) -> Result<Json<VapidPublicResponse>> {
    let key = state
        .push_store
        .public_key()
        .await
        .ok_or_else(|| AppError::Internal("VAPID keys unavailable".into()))?;
    Ok(Json(VapidPublicResponse { public_key: key }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeBody {
    endpoint: String,
    keys: SubscribeKeys,
    device_id: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscribeKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

async fn subscribe(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<SubscribeBody>,
) -> Result<Json<OkResponse>> {
    // Guests are deleted when their last socket leaves and bots have no device;
    // neither should accumulate stored push secrets.
    if auth.is_bot || auth.is_guest {
        return Err(AppError::Forbidden("Push notifications need a registered account".into()));
    }
    let endpoint = body.endpoint.trim();
    let p256dh = body.keys.p256dh.trim();
    let auth_secret = body.keys.auth.trim();
    let device_id = body.device_id.trim();
    if endpoint.is_empty() || p256dh.is_empty() || auth_secret.is_empty() || device_id.is_empty() {
        return Err(AppError::BadRequest("missing push subscription fields".into()));
    }
    if endpoint.len() > MAX_ENDPOINT_LEN
        || p256dh.len() > MAX_KEY_LEN
        || auth_secret.len() > MAX_KEY_LEN
        || device_id.len() > 128
    {
        return Err(AppError::BadRequest("push subscription fields too long".into()));
    }
    // Reject anything we could never deliver to before storing it: the key must
    // be a real P-256 point, the secret 16 bytes, and the endpoint https. The
    // address itself is re-validated on every send (DNS can change).
    if !endpoint.starts_with("https://") {
        return Err(AppError::BadRequest("push endpoint must use https".into()));
    }
    if web_push::encrypt(b"", p256dh, auth_secret).is_err() {
        return Err(AppError::BadRequest("invalid push subscription keys".into()));
    }

    let record = PushSubscriptionRecord {
        user_id: auth.user_id,
        device_id: device_id.to_string(),
        endpoint: endpoint.to_string(),
        p256dh: p256dh.to_string(),
        auth: auth_secret.to_string(),
        platform: body.platform.unwrap_or_else(|| "web".into()).chars().take(32).collect(),
        user_agent: body.user_agent.map(|s| s.chars().take(256).collect()),
        updated_at_ms: now_ms(),
    };

    state
        .push_store
        .upsert(record, MAX_DEVICES_PER_USER)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(OkResponse { ok: true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnsubscribeBody {
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
}

async fn unsubscribe(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<UnsubscribeBody>,
) -> Result<Json<OkResponse>> {
    if let Some(endpoint) = body.endpoint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let removed = state
            .push_store
            .remove_endpoint_for_user(auth.user_id, endpoint)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        if !removed {
            return Err(AppError::Forbidden(
                "push subscription does not belong to this account".into(),
            ));
        }
    } else if let Some(device_id) = body.device_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        state
            .push_store
            .remove_user_device(auth.user_id, device_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    } else {
        return Err(AppError::BadRequest("endpoint or deviceId required".into()));
    }
    Ok(Json(OkResponse { ok: true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesBody {
    #[serde(default)]
    direct_messages: Option<bool>,
    #[serde(default)]
    calls: Option<bool>,
}

async fn get_preferences(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PushPreferences>> {
    Ok(Json(state.push_store.preferences_for(auth.user_id).await))
}

async fn put_preferences(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PreferencesBody>,
) -> Result<Json<PushPreferences>> {
    if auth.is_bot || auth.is_guest {
        return Err(AppError::Forbidden("Push notifications need a registered account".into()));
    }
    let mut preferences = state.push_store.preferences_for(auth.user_id).await;
    if let Some(value) = body.direct_messages {
        preferences.direct_messages = value;
    }
    if let Some(value) = body.calls {
        preferences.calls = value;
    }
    state
        .push_store
        .set_preferences(auth.user_id, preferences)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(preferences))
}

/// Channels with message push switched on, in stable order.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushChannelsResponse {
    enabled: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushChannelsBody {
    #[serde(default)]
    enabled: Vec<String>,
}

/// Bounds so one account cannot grow `web_push.json` without limit.
const MAX_PUSH_CHANNELS: usize = 2_000;
const MAX_CHANNEL_ID_LEN: usize = 128;

async fn get_push_channels(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<PushChannelsResponse>> {
    Ok(Json(PushChannelsResponse {
        enabled: state
            .push_store
            .push_channels_for(auth.user_id)
            .await
            .into_iter()
            .collect(),
    }))
}

async fn put_push_channels(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<PushChannelsBody>,
) -> Result<Json<PushChannelsResponse>> {
    if auth.is_bot || auth.is_guest {
        return Err(AppError::Forbidden("Push notifications need a registered account".into()));
    }
    if body.enabled.len() > MAX_PUSH_CHANNELS {
        return Err(AppError::BadRequest("too many channels".into()));
    }
    // The client replaces its whole list (the settings screen owns the UI),
    // so validate every entry before anything is persisted. Membership is not
    // checked here: delivery always re-checks that the account is a member of
    // the channel, so a stray id can never wake anybody else's devices.
    let mut enabled = BTreeSet::new();
    for raw in body.enabled {
        let channel_id = raw.trim();
        if channel_id.is_empty() || channel_id.len() > MAX_CHANNEL_ID_LEN {
            return Err(AppError::BadRequest("invalid channel id".into()));
        }
        enabled.insert(channel_id.to_string());
    }
    state
        .push_store
        .set_push_channels(auth.user_id, enabled.clone())
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(PushChannelsResponse {
        enabled: enabled.into_iter().collect(),
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPushResponse {
    ok: bool,
    sent: usize,
    failed: usize,
}

async fn test_push(auth: AuthUser, State(state): State<Arc<AppState>>) -> Result<Json<TestPushResponse>> {
    let payload = serde_json::json!({
        "title": "Wabi",
        "body": "Test push — if you see this, push notifications work.",
        "icon": "/icon-192.png",
        "wabiNav": "settings",
        "section": "notifications",
        "tag": "wabi-push-test"
    });
    let (sent, failed) = send_push_to_user(
        &state,
        auth.user_id,
        &payload,
        Urgency::Normal,
        300,
        Some("wabi-push-test"),
    )
    .await;
    Ok(Json(TestPushResponse { ok: sent > 0, sent, failed }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/// What happened, which decides the account preference and delivery policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushKind {
    DirectMessage,
    /// A message in a server channel or group chat. Opt-in per channel; the
    /// channel list in settings is its only switch.
    ChannelMessage,
    IncomingCall { video: bool },
}

impl PushKind {
    fn allowed(self, preferences: &PushPreferences) -> bool {
        match self {
            PushKind::DirectMessage => preferences.direct_messages,
            // The per-channel list is the switch for channels; there is no
            // account-level ceiling above it (yet).
            PushKind::ChannelMessage => true,
            PushKind::IncomingCall { .. } => preferences.calls,
        }
    }
    /// A call that rings out is worthless later; a message is not.
    fn ttl_secs(self) -> u32 {
        match self {
            PushKind::DirectMessage | PushKind::ChannelMessage => 24 * 60 * 60,
            PushKind::IncomingCall { .. } => 45,
        }
    }
}

/// Socket rooms and call targets name accounts `user-<id>`; push needs the id.
pub fn user_id_from_stable(stable_id: &str) -> Option<i64> {
    stable_id
        .strip_prefix("user-")
        .and_then(|id| id.parse::<i64>().ok())
        .filter(|id| *id > 0)
}

/// Build the payload for a DM or call event. No message text is ever included.
pub fn payload_for(kind: PushKind, from: &str, channel_id: &str) -> serde_json::Value {
    let from = from.trim();
    let from = if from.is_empty() { "Someone" } else { from };
    match kind {
        PushKind::DirectMessage => serde_json::json!({
            "title": from,
            "body": "New message",
            "icon": "/icon-192.png",
            "tag": format!("dm-{channel_id}"),
            "kind": "dm",
            "wabiNav": "dm",
            "channelId": channel_id,
        }),
        PushKind::ChannelMessage => serde_json::json!({
            "title": from,
            "body": "New message",
            "icon": "/icon-192.png",
            "tag": format!("ch-{channel_id}"),
            "kind": "channel",
            "wabiNav": "channel",
            "channelId": channel_id,
        }),
        PushKind::IncomingCall { video } => serde_json::json!({
            "title": if video { "Incoming video call" } else { "Incoming call" },
            "body": format!("{from} is calling"),
            "icon": "/icon-192.png",
            "tag": format!("call-{channel_id}"),
            "kind": "call",
            "wabiNav": "call",
            "callId": channel_id,
            "requireInteraction": true,
        }),
    }
}

/// Payload for a message in a server channel or group. Carries the channel
/// name and the sender, never the message text. Group chats open in the DM
/// surface where they actually live, so they use the dm nav kind; every other
/// channel opens as a channel.
pub fn payload_for_channel(
    channel_name: Option<&str>,
    in_group: bool,
    from: &str,
    channel_id: &str,
) -> serde_json::Value {
    let from = from.trim();
    let from = if from.is_empty() { "Someone" } else { from };
    let name = channel_name.map(str::trim).filter(|name| !name.is_empty());
    let (title, body) = match name {
        Some(name) if in_group => (name.to_string(), format!("New message from {from}")),
        Some(name) => (format!("#{name}"), format!("New message from {from}")),
        // Channel deleted or unnamed: fall back to the sender so the
        // notification still says something true.
        None => (from.to_string(), "New message".to_string()),
    };
    serde_json::json!({
        "title": title,
        "body": body,
        "icon": "/icon-192.png",
        "tag": format!("ch-{channel_id}"),
        "kind": if in_group { "dm" } else { "channel" },
        "wabiNav": if in_group { "dm" } else { "channel" },
        "channelId": channel_id,
    })
}

/// Minimum spacing between pushes for one (account, channel, kind). A
/// burst of messages should wake the device once; the topic header also lets
/// the push service collapse anything still queued.
const MIN_PUSH_GAP: Duration = Duration::from_secs(4);
const GAP_TABLE_LIMIT: usize = 10_000;

fn gap_table() -> &'static Mutex<HashMap<(i64, String), Instant>> {
    static TABLE: OnceLock<Mutex<HashMap<(i64, String), Instant>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True when this event may send now; records it when it may.
fn take_gap(user_id: i64, key: String, now: Instant) -> bool {
    let mut table = gap_table().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if table.len() >= GAP_TABLE_LIMIT {
        table.retain(|_, at| now.saturating_duration_since(*at) < MIN_PUSH_GAP);
    }
    match table.get(&(user_id, key.clone())) {
        Some(at) if now.saturating_duration_since(*at) < MIN_PUSH_GAP => false,
        _ => {
            table.insert((user_id, key), now);
            true
        }
    }
}

/// Channel messages fire only for channels the account switched on in
/// settings (the per-channel opt-in list). DMs and calls ignore that list:
/// they are gated by their account-level switches alone, so a DM or a ringing
/// call can never depend on a row the user has to find first.
fn may_notify_conversation(kind: PushKind, channel_enabled: bool) -> bool {
    !matches!(kind, PushKind::ChannelMessage) || channel_enabled
}

/// Fire-and-forget: notify one account about an event without delaying the
/// request that caused it. Honours the account's preferences and the
/// per-channel opt-in for channel messages.
pub fn spawn_notify(state: Arc<AppState>, user_id: i64, kind: PushKind, from: String, channel_id: String) {
    tokio::spawn(async move {
        notify_user(&state, user_id, kind, &from, &channel_id).await;
    });
}

pub async fn notify_user(state: &AppState, user_id: i64, kind: PushKind, from: &str, channel_id: &str) {
    if user_id <= 0 {
        debug!("push: skipped user={user_id} kind={kind:?} reason=not_a_registered_account");
        return;
    }
    let preferences = state.push_store.preferences_for(user_id).await;
    if !kind.allowed(&preferences) {
        debug!("push: skipped user={user_id} kind={kind:?} channel={channel_id} reason=preferences_off");
        return;
    }
    // Checked before the gap so a channel nobody switched on can never
    // consume the send window of one that did.
    let channel_enabled = if matches!(kind, PushKind::ChannelMessage) {
        state.push_store.push_channel_enabled(user_id, channel_id).await
    } else {
        true
    };
    if !may_notify_conversation(kind, channel_enabled) {
        debug!("push: skipped user={user_id} kind={kind:?} channel={channel_id} reason=channel_not_enabled");
        return;
    }
    if !take_gap(user_id, format!("{kind:?}:{channel_id}"), Instant::now()) {
        debug!("push: skipped user={user_id} kind={kind:?} channel={channel_id} reason=within_min_gap");
        return;
    }
    let payload = match kind {
        PushKind::ChannelMessage => {
            // One map lookup so the notification can say where the message
            // landed; group chats tap into the DM surface.
            let (name, in_group) = match state.wdb.get_channel(channel_id).await {
                Ok(Some(channel)) => (
                    channel.name,
                    matches!(channel.channel_kind, ChannelKind::GroupDm),
                ),
                _ => (String::new(), false),
            };
            payload_for_channel(
                if name.is_empty() { None } else { Some(&name) },
                in_group,
                from,
                channel_id,
            )
        }
        _ => payload_for(kind, from, channel_id),
    };
    let topic = web_push::topic_for(&format!("{kind:?}:{channel_id}"));
    send_push_to_user(state, user_id, &payload, Urgency::High, kind.ttl_secs(), Some(&topic)).await;
}

/// Send a JSON payload to every registered device of `user_id`.
pub async fn send_push_to_user(
    state: &AppState,
    user_id: i64,
    payload: &serde_json::Value,
    urgency: Urgency,
    ttl_secs: u32,
    topic: Option<&str>,
) -> (usize, usize) {
    let subs = state.push_store.list_for_user(user_id).await;
    if subs.is_empty() {
        debug!("push: skipped user={user_id} reason=no_subscriptions");
        return (0, 0);
    }
    let (Some(private_pem), Some(public_b64)) = (
        state.push_store.private_pem().await,
        state.push_store.public_key().await,
    ) else {
        warn!("push: VAPID keys unavailable");
        return (0, subs.len());
    };
    let key = match SigningKey::from_pkcs8_pem(&private_pem) {
        Ok(key) => key,
        Err(error) => {
            warn!("push: VAPID private key unreadable: {error}");
            return (0, subs.len());
        }
    };
    let subject = state.push_store.subject().await;
    let body = payload.to_string();

    let results = futures::future::join_all(subs.iter().map(|sub| {
        let key = &key;
        let public_b64 = &public_b64;
        let subject = &subject;
        let body = &body;
        async move {
            let message = PushMessage {
                endpoint: &sub.endpoint,
                p256dh: &sub.p256dh,
                auth: &sub.auth,
                payload: body.as_bytes(),
                ttl_secs,
                urgency,
                topic,
            };
            (sub, web_push::send(key, public_b64, subject, &message).await)
        }
    }))
    .await;

    let (mut sent, mut failed) = (0usize, 0usize);
    for (sub, outcome) in results {
        match outcome {
            SendOutcome::Delivered => sent += 1,
            SendOutcome::Gone => {
                failed += 1;
                // The push service says this subscription no longer exists.
                // Same ownership rule as an explicit unsubscribe.
                let _ = state.push_store.remove_endpoint_for_user(user_id, &sub.endpoint).await;
            }
            SendOutcome::Failed(reason) => {
                failed += 1;
                warn!("push send failed user={} endpoint={}: {reason}", user_id, truncate_endpoint(&sub.endpoint));
            }
        }
    }
    if sent > 0 {
        info!("push: sent {sent} failed {failed} user={user_id}");
    }
    (sent, failed)
}

fn truncate_endpoint(endpoint: &str) -> String {
    if endpoint.len() <= 64 {
        endpoint.to_string()
    } else {
        // Endpoints are bearer-like secrets; log only enough to tell services apart.
        format!("{}…", endpoint.chars().take(64).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_never_carry_message_text_and_route_to_the_right_place() {
        let dm = payload_for(PushKind::DirectMessage, "Ada", "dm-1");
        assert_eq!(dm["title"], "Ada");
        assert_eq!(dm["body"], "New message");
        assert_eq!(dm["wabiNav"], "dm");
        assert_eq!(dm["channelId"], "dm-1");
        assert_eq!(dm["tag"], "dm-dm-1");

        let call = payload_for(PushKind::IncomingCall { video: true }, "Ada", "call-9");
        assert_eq!(call["title"], "Incoming video call");
        assert_eq!(call["body"], "Ada is calling");
        assert_eq!(call["wabiNav"], "call");
        assert_eq!(call["callId"], "call-9");
        assert_eq!(call["requireInteraction"], true);
        // The bare ChannelMessage arm never names the channel; notify_user
        // routes it through payload_for_channel, and this fallback exists only
        // if that lookup fails — still with no message text.
        let ch = payload_for(PushKind::ChannelMessage, "Ada", "ch_9");
        assert_eq!(ch["title"], "Ada");
        assert_eq!(ch["wabiNav"], "channel");
        assert_eq!(payload_for(PushKind::DirectMessage, "  ", "x")["title"], "Someone");
    }

    #[test]
    fn stable_ids_map_to_accounts_and_nothing_else() {
        assert_eq!(user_id_from_stable("user-42"), Some(42));
        for bad in ["user-0", "user--3", "user-", "42", "guest-7", "user-4x", ""] {
            assert_eq!(user_id_from_stable(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn preferences_gate_each_kind_independently() {
        let all_on = PushPreferences::default();
        assert!(PushKind::DirectMessage.allowed(&all_on));
        assert!(PushKind::IncomingCall { video: false }.allowed(&all_on));
        assert!(PushKind::ChannelMessage.allowed(&all_on));
        let no_dm = PushPreferences { direct_messages: false, ..all_on };
        assert!(!PushKind::DirectMessage.allowed(&no_dm));
        assert!(PushKind::IncomingCall { video: false }.allowed(&no_dm));
        // Channels have no account-level ceiling; the per-channel list alone gates them.
        assert!(PushKind::ChannelMessage.allowed(&no_dm));
        let no_calls = PushPreferences { calls: false, ..all_on };
        assert!(PushKind::DirectMessage.allowed(&no_calls));
        assert!(!PushKind::IncomingCall { video: true }.allowed(&no_calls));
    }

    #[test]
    fn channel_messages_are_opt_in_but_dms_and_calls_are_not() {
        assert!(!may_notify_conversation(PushKind::ChannelMessage, false), "an untouched channel stays silent");
        assert!(may_notify_conversation(PushKind::ChannelMessage, true), "an opted-in channel may push");
        // DMs follow their own account switch, never the channel list.
        assert!(may_notify_conversation(PushKind::DirectMessage, false));
        // A 1:1 call is identified by an account id, not a channel row, so the
        // ringing path must ignore the list entirely.
        assert!(may_notify_conversation(PushKind::IncomingCall { video: false }, false));
    }

    #[test]
    fn channel_payloads_say_where_and_tap_into_the_right_surface() {
        let general = payload_for_channel(Some("general"), false, "Ada", "ch_1");
        assert_eq!(general["title"], "#general");
        assert_eq!(general["body"], "New message from Ada");
        assert_eq!(general["wabiNav"], "channel");
        assert_eq!(general["kind"], "channel");
        assert_eq!(general["channelId"], "ch_1");
        assert_eq!(general["tag"], "ch-ch_1");

        // Group chats live in the DM surface, so their taps must too.
        let squad = payload_for_channel(Some("Squad"), true, "Ada", "group-9");
        assert_eq!(squad["title"], "Squad");
        assert_eq!(squad["wabiNav"], "dm");
        assert_eq!(squad["kind"], "dm");
        assert_eq!(squad["channelId"], "group-9");

        // Deleted or unnamed channel: say something true anyway.
        let orphan = payload_for_channel(None, false, "Ada", "ch_2");
        assert_eq!(orphan["title"], "Ada");
        assert_eq!(orphan["body"], "New message");
        // Sender and blank names fall back to the neutral wording.
        assert_eq!(payload_for_channel(Some("   "), false, "Ada", "ch_3")["title"], "Ada");
        assert_eq!(
            payload_for_channel(Some("general"), false, "  ", "ch_4")["body"],
            "New message from Someone"
        );
    }

    #[test]
    fn a_ringing_call_expires_quickly_but_a_message_waits() {
        assert!(PushKind::IncomingCall { video: false }.ttl_secs() <= 60);
        assert!(PushKind::DirectMessage.ttl_secs() >= 60 * 60);
        assert!(PushKind::ChannelMessage.ttl_secs() >= 60 * 60);
    }

    #[test]
    fn bursts_are_coalesced_per_channel_and_account() {
        let start = Instant::now();
        // Unique ids so parallel tests sharing the static table cannot collide.
        let (a, b) = (9_000_001, 9_000_002);
        assert!(take_gap(a, "DirectMessage:c1".into(), start));
        assert!(!take_gap(a, "DirectMessage:c1".into(), start + Duration::from_secs(1)));
        assert!(take_gap(a, "DirectMessage:c2".into(), start), "another channel is independent");
        assert!(take_gap(b, "DirectMessage:c1".into(), start), "another account is independent");
        assert!(take_gap(a, "DirectMessage:c1".into(), start + MIN_PUSH_GAP + Duration::from_millis(1)));
    }

    #[test]
    fn log_lines_do_not_contain_the_whole_endpoint() {
        let endpoint = format!("https://push.example/{}", "s".repeat(200));
        assert!(truncate_endpoint(&endpoint).chars().count() <= 65);
    }
}
