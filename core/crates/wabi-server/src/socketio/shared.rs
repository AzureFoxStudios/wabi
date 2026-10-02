// Socket.IO real-time layer (socketioxide 0.16)
//
// Implements the wabi-protocol event surface expected by the Svelte frontend.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use socketioxide::{
    extract::{AckSender, Data, SocketRef, State},
    handler::ConnectHandler,
    layer::SocketIoLayer,
    SocketIo,
};
use tokio::sync::{Mutex as TokioMutex, RwLock};
use tracing::{info, warn};

use crate::state::AppState;

/// Global handle to the socket.io presence map. Populated once at server
/// startup by `create_socket_layer`; read by non-socket handlers such as the
/// admin dashboard stats ("online now"). Same OnceLock pattern as
/// `whiteboard_versions` in whiteboard_ops.rs.
static CONNECTED_USERS: std::sync::OnceLock<ConnectedUsers> = std::sync::OnceLock::new();

/// Publish the live presence map (called from `create_socket_layer`).
pub fn publish_connected_users(map: ConnectedUsers) {
    let _ = CONNECTED_USERS.set(map);
}

/// Read access to the live presence map, if the socket layer is up.
pub fn shared_connected_users() -> ConnectedUsers {
    CONNECTED_USERS
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(RwLock::new(HashMap::new())))
}

/// Count people, not transports: a member with two tabs is online once.
pub async fn connected_user_count() -> u64 {
    shared_connected_users().read().await.values()
        .map(|user| &user.stable_id).collect::<std::collections::HashSet<_>>().len() as u64
}

/// Remove an account from a channel's realtime room immediately after a
/// persisted channel ban. Future joins still go through require_access.
pub async fn evict_channel_user(io: &SocketIo, state: &AppState, channel_id: &str, user_id: i64) {
    // Some automatic bans hold only a membership reader. Order their completed
    // eviction against receive admission/publication for this channel; those
    // operations recheck access after acquiring this same gate.
    let _channel = crate::channel_access::publication_gate(state, channel_id).lock().await;
    let media_room = format!("wabidb-call-channel:{channel_id}");
    for device in io.sockets() {
        if device.extensions.get::<SioIdentity>().is_some_and(|identity| identity.user_id == user_id) {
            let _ = device.leave(channel_id.to_string());
            let _ = device.leave(media_room.clone());
            crate::api::voice_policy::remove_admission(&state.config.data_dir, channel_id, &device.id.to_string());
            crate::api::voice_self_state::remove(channel_id, &device.id.to_string());
            evict_channel_whiteboards(&device, channel_id);
            let _ = device.emit("channel-access-revoked", &json!({ "channelId": channel_id }));
        }
    }
}

/// Remove only viewers who fail the newly saved role gate. Members whose role
/// still permits access keep their voice session and media room intact.
pub async fn evict_channel_disallowed(io: &SocketIo, state: &AppState, channel_id: &str) {
    let media_room = format!("wabidb-call-channel:{channel_id}");
    for device in io.sockets() {
        let Some(identity) = device.extensions.get::<SioIdentity>() else { continue; };
        if matches!(crate::channel_access::channel_role_allows(state, identity.user_id, channel_id).await, Ok(true)) {
            continue;
        }
        let _ = device.leave(channel_id.to_string());
        let _ = device.leave(media_room.clone());
            crate::api::voice_policy::remove_admission(&state.config.data_dir, channel_id, &device.id.to_string());
            crate::api::voice_self_state::remove(channel_id, &device.id.to_string());
        evict_channel_whiteboards(&device, channel_id);
        let _ = device.emit("channel-access-revoked", &json!({ "channelId": channel_id }));
    }
}


pub fn evict_server_user(io: &SocketIo, user_id: i64) {
    for device in io.sockets() {
        if device.extensions.get::<SioIdentity>().is_some_and(|identity| identity.user_id == user_id) {
            let _ = device.emit("auth-revoked", &json!({ "reason": "You have been banned from this server" }));
            let _ = device.disconnect();
        }
    }
}

/// Revoke receive access too: an idle client must not retain private rooms
/// merely because it never sends another guarded application event. Called
/// after durable denial and its in-memory publication, outside the writer.
pub async fn disconnect_revoked_sockets(
    io: &SocketIo,
    secret: &str,
    revocations: &RwLock<crate::state::RevocationStore>,
) {
    let denied = {
        let revocations = revocations.read().await;
        io.sockets().into_iter().filter(|socket| {
            let token = socket.extensions.get::<AuthToken>();
            token.as_ref().is_none_or(|token|
                socket_token_revoked_by(&token.0, secret, &revocations))
        }).collect::<Vec<_>>()
    };
    for socket in denied {
        let _ = socket.emit("auth-revoked", &json!({ "reason": "session revoked; please sign in again" }));
        let _ = socket.disconnect();
    }
}

// ---------------------------------------------------------------------------
// Per-socket auth token stored in socket extensions
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct AuthToken(pub String);

/// Keep denial publication serialized with namespace insertion. Otherwise a
/// revocation between middleware authorization and insertion can miss an idle
/// newly connected socket. Released after connection handlers are installed.
#[derive(Clone)]
struct SioAdmissionGuard {
    _revocations: Arc<tokio::sync::OwnedRwLockReadGuard<crate::state::RevocationStore>>,
}

async fn authorize_socket_connect(
    socket: SocketRef,
    Data(auth): Data<Value>,
    State(state): State<SioState>,
) -> Result<(), String> {
    authorize_socket_identity(&socket, &auth, &state).await
        .map_err(|reason| format!("auth-failed: {reason}"))
}

async fn authorize_socket_identity(
    socket: &SocketRef,
    auth: &Value,
    state: &SioState,
) -> Result<(), &'static str> {
    let token = auth.get("token").and_then(Value::as_str).unwrap_or("").to_string();
    let identity = validate_token_sync(&token, &state.app.config.jwt_secret)?;
    let revocations = state.app.revocations.clone().read_owned().await;
    if socket_token_revoked_by(&token, &state.app.config.jwt_secret, &revocations) {
        return Err("session revoked; please sign in again");
    }
    crate::auth_extractor::ensure_active_principal(&state.app, identity.user_id)
        .await.map_err(|_| "account access unavailable; please sign in again")?;
    let blacklist = state.app.get_blacklist().await.ok_or("ban enforcement unavailable")?;
    if blacklist.is_user_banned(identity.user_id).await.is_some() {
        return Err("account banned from this server");
    }
    socket.extensions.insert(identity);
    socket.extensions.insert(AuthToken(token));
    socket.extensions.insert(SioAdmissionGuard { _revocations: Arc::new(revocations) });
    Ok(())
}

/// Handshake-validated identity stored in socket extensions after JWT
/// validation at connect time. Handlers read this instead of re-decoding
/// the token on every event.
#[derive(Clone, Debug)]
pub(crate) struct SioIdentity {
    pub user_id: i64,
    pub username: String,
    pub is_guest: bool,
}

// ---------------------------------------------------------------------------
// Handshake-time token validation + identity helpers
// ---------------------------------------------------------------------------

/// Synchronous JWT validation for the handshake connect closure.
/// Returns `Ok(SioIdentity)` for a signed, unexpired account access token;
/// `Err(message)` otherwise. Async middleware checks current principal,
/// revocation and bans before namespace admission; events check them again.
pub(crate) fn validate_token_sync(token: &str, secret: &str) -> Result<SioIdentity, &'static str> {
    use jsonwebtoken::{decode, DecodingKey, Validation};

    if token.is_empty() {
        return Err("missing token");
    }

    #[derive(Deserialize)]
    struct Claims {
        sub: String,
        username: String,
        #[serde(default)]
        is_guest: bool,
        #[serde(default)]
        token_type: String,
        #[serde(default)]
        stepup: bool,
    }

    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;

    let data = decode::<Claims>(token, &key, &v).map_err(|e| {
        if e.kind() == &jsonwebtoken::errors::ErrorKind::ExpiredSignature {
            "token expired"
        } else {
            "invalid token"
        }
    })?;

    // Match authenticate_access_token: refresh, scoped-tool, and step-up
    // credentials cannot become account sessions. Missing type remains a
    // legacy access token; step-up tokens themselves use type "access".
    if !matches!(data.claims.token_type.as_str(), "" | "access") || data.claims.stepup {
        return Err("account access token required");
    }

    let user_id = data.claims.sub.parse::<i64>().map_err(|_| "invalid user id")?;
    if user_id <= 0 {
        return Err("invalid user id");
    }

    Ok(SioIdentity {
        user_id,
        username: data.claims.username,
        is_guest: data.claims.is_guest,
    })
}

/// Read the handshake-validated `SioIdentity` from socket extensions.
/// Returns `None` if the socket was not authenticated at handshake time.
pub(crate) fn resolve_sio_identity(socket: &SocketRef) -> Option<SioIdentity> {
    socket.extensions.get::<SioIdentity>().map(|x| x.clone())
}

/// Compute the stable user id string from the handshake-validated identity.
/// Falls back to the raw socket id for unauthenticated connections (should
/// not happen after handshake enforcement, but kept for defence-in-depth).
pub(crate) fn get_stable_id(socket: &SocketRef) -> String {
    if let Some(id) = socket.extensions.get::<SioIdentity>() {
        format!("user-{}", id.user_id)
    } else {
        socket.id.to_string()
    }
}

// ---------------------------------------------------------------------------
// Shared real-time state
// ---------------------------------------------------------------------------

/// Info about a connected socket's user identity.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct ConnectedUser {
    pub stable_id: String,
    pub db_user_id: Option<i64>,
    pub username: String,
    pub color: String,
    /// Self-selected presence (multi-tab inherited on join, owned by
    /// `set-presence`). Invisible is broadcast as "offline".
    pub presence: UserPresence,
    /// Unix microseconds of the last activity (connect, message, or
    /// periodic heartbeat). The periodic sweep uses this to remove
    /// entries that are stale (e.g. on_disconnect never fired because
    /// the socket was lost without a clean close).
    ///
    /// WABI_AUDIT_REPORT.md finding #3.
    pub last_seen_micros: i64,
}

/// Self-selected user presence. Lives here because ConnectedUser carries it
/// across sockets; `set-presence` owns mutations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum UserPresence {
    Active,
    Away,
    Busy,
    Invisible,
}

impl UserPresence {
    #[allow(dead_code)]
    pub fn parse(raw: &str) -> UserPresence {
        match raw {
            "away" => UserPresence::Away,
            "busy" => UserPresence::Busy,
            "invisible" | "offline" => UserPresence::Invisible,
            _ => UserPresence::Active,
        }
    }

    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            UserPresence::Active => "active",
            UserPresence::Away => "away",
            UserPresence::Busy => "busy",
            UserPresence::Invisible => "invisible",
        }
    }
}

/// socket_id → ConnectedUser for all live sockets.
#[allow(dead_code)]
pub type ConnectedUsers = Arc<RwLock<HashMap<String, ConnectedUser>>>;

/// A participant currently in a voice channel.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct VoiceParticipant {
    pub socket_id: String,
    pub stable_id: String,
    pub username: String,
    #[allow(dead_code)]
    pub color: String,
    /// Client-declared mic state (Discord-style chip). Self-mute is client
    /// authority; admin `voice-mute` kicks instead of flipping this.
    pub is_muted: bool,
    pub is_deafened: bool,
    pub transmit_mode: String,
    /// True for participants that only listen to a voice channel (multi-listen
    /// / TeamSpeak-style) without transmitting. A socket can be `primary` in one
    /// channel and `listening` in several others.
    pub is_listening_only: bool,
    pub profile_picture: Option<String>,
}

/// channel_id → Vec<VoiceParticipant>.
#[allow(dead_code)]
pub type VoiceChannels = Arc<RwLock<HashMap<String, Vec<VoiceParticipant>>>>;

/// Ephemeral call consent is device-owned. Account membership is durable in
/// WabiDB, but another logged-in device must not borrow this socket's consent,
/// and an old socket disconnect must not remove its replacement's admission.
#[derive(Clone, Debug, Default)]
pub struct GroupCallParticipants(HashMap<String, HashSet<String>>);

impl GroupCallParticipants {
    pub fn join(&mut self, account: &str, socket: &str) {
        self.0.entry(account.to_string()).or_default().insert(socket.to_string());
    }
    pub fn contains(&self, account: &str) -> bool { self.0.contains_key(account) }
    pub fn contains_socket(&self, account: &str, socket: &str) -> bool {
        self.0.get(account).is_some_and(|sockets| sockets.contains(socket))
    }
    pub fn len(&self) -> usize { self.0.len() }
    pub fn is_empty(&self) -> bool { self.0.is_empty() }
    pub fn iter(&self) -> impl Iterator<Item = &String> { self.0.keys() }
    /// Membership removal deliberately revokes ALL of the account's devices.
    pub fn remove(&mut self, account: &str) -> bool { self.0.remove(account).is_some() }
    /// Returns the departing account and whether its last admitted device left.
    pub fn leave_socket(&mut self, socket: &str) -> Option<(String, bool)> {
        let account = self.0.iter().find(|(_, sockets)| sockets.contains(socket))?.0.clone();
        let sockets = self.0.get_mut(&account).expect("account found above");
        sockets.remove(socket);
        let last = sockets.is_empty();
        if last { self.0.remove(&account); }
        Some((account, last))
    }
}

/// State for an active group/DM-group call. Not a postcard-encoded record.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct GroupCallSession {
    #[allow(dead_code)]
    pub channel_id: String,
    pub channel_name: String,
    pub initiator_stable_id: String,
    pub is_video_call: bool,
    pub has_ever_established: bool,
    pub last_invite_sender_id: String,
    pub invited_participants: HashSet<String>,
    pub connected_participants: GroupCallParticipants,
}

/// channel_id → GroupCallSession.
#[allow(dead_code)]
pub type GroupCallSessions = Arc<RwLock<HashMap<String, GroupCallSession>>>;

/// An in-memory breakout room session. WabiDB has no breakout table yet, so
/// breakout metadata (which voice channels are breakouts, under which parent)
/// lives here and is lost on server restart. The channels themselves are
/// persisted to WabiDB as ordinary voice channels.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct BreakoutRoomState {
    pub id: String,
    pub name: String,
    pub parent_channel_id: String,
    pub breakout_index: u32,
    pub created_at_micros: i64,
}

/// parent_channel_id → breakout rooms created under it.
#[allow(dead_code)]
pub type BreakoutRooms = Arc<RwLock<HashMap<String, Vec<BreakoutRoomState>>>>;

#[derive(Clone)]
#[allow(dead_code)]
pub struct SioState {
    pub app: Arc<AppState>,
    pub connected_users: ConnectedUsers,
    pub voice_channels: VoiceChannels,
    pub group_call_sessions: GroupCallSessions,
    pub breakout_rooms: BreakoutRooms,
    pub roster_cache: Arc<TokioMutex<Option<RosterSnapshot>>>,
}

pub struct RosterSnapshot {
    pub revision: u64,
    pub built_at: Instant,
    pub members: Vec<Value>,
}

impl RosterSnapshot {
    pub fn reusable(&self, revision: u64) -> bool {
        self.revision == revision && self.built_at.elapsed() < Duration::from_secs(30)
    }
}

/// Periodic sweep of stale Socket.IO state. Safety net for on_disconnect
/// failures (network errors, panics, missed events). Run every 60s from
/// the server's startup task.
///
/// WABI_AUDIT_REPORT.md findings #3 (connected_users), #4 (group call
/// sessions), #5 (voice channels).
///
/// Removes:
/// - voice_channels entries with no participants (channel went empty
///   but on_disconnect didn't catch it).
/// - group_call_sessions entries with empty `connected_participants`.
/// - connected_users entries whose `last_seen_micros` is older than
///   `CONNECTED_USER_STALE_AFTER_MICROS` (5 min). Catches the case
///   where a socket is lost without a clean close, so on_disconnect
///   never fires and the entry sits in the map forever.
#[allow(dead_code)]
pub async fn sweep_stale_state(
    connected_users: &ConnectedUsers,
    voice_channels: &VoiceChannels,
    group_call_sessions: &GroupCallSessions,
) -> (usize, usize, usize) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    // HashMap::retain returns (), so we count before/after.
    let users_removed = {
        let mut users = connected_users.write().await;
        let before = users.len();
        users.retain(|_, u| now - u.last_seen_micros < CONNECTED_USER_STALE_AFTER_MICROS);
        before - users.len()
    };
    let voice_removed = {
        let mut voice = voice_channels.write().await;
        let before = voice.len();
        voice.retain(|_, members| !members.is_empty());
        before - voice.len()
    };
    let groups_removed = {
        let mut groups = group_call_sessions.write().await;
        let before = groups.len();
        groups.retain(|_, session| !session.connected_participants.is_empty());
        before - groups.len()
    };
    (users_removed, voice_removed, groups_removed)
}

/// A connected_user with `last_seen_micros` older than this is considered
/// stale and removed by `sweep_stale_state`. 5 minutes.
#[allow(dead_code)]
pub const CONNECTED_USER_STALE_AFTER_MICROS: i64 = 5 * 60 * 1_000_000;

/// Grace window before the guest reaper considers a never-connected guest
/// account dead. Covers the gap between POST /api/auth/guest returning and
/// the client opening its socket, plus restart reconnects.
#[allow(dead_code)]
pub const GUEST_REAP_GRACE_MICROS: i64 = 5 * 60 * 1_000_000;

/// Hard-temporary guests: tombstone-delete every guest account (empty
/// password hash) that has no live socket and is past the creation grace
/// window. This is the safety net for disconnects `on_disconnect` missed
/// (crash, network loss, stale-socket sweep) and doubles as the boot sweep:
/// run shortly after startup it clears every accumulated `Guest_*` row,
/// since no guest can be connected before the listener accepts sockets.
///
/// Returns the number of accounts reaped. Registered users are never
/// touched — the empty-password-hash check is the guard.
pub async fn reap_disconnected_guests(state: &SioState) -> usize {
    let now_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let Ok(users) = state.app.wdb.list_users().await else {
        tracing::warn!("[guest-reap] list_users failed; skipping pass");
        return 0;
    };

    let mut connected: std::collections::HashSet<i64> = state
        .connected_users
        .read()
        .await
        .values()
        .filter_map(|u| u.db_user_id)
        .collect();
    // Presence snapshots can lag socket admission/cleanup. The namespace is
    // the transport liveness authority, including idle signed guest sessions.
    if let Some(io) = state.app.socket_io() {
        connected.extend(io.sockets().iter().filter_map(|socket|
            socket.extensions.get::<SioIdentity>().map(|identity| identity.user_id)));
    }

    let mut reaped = 0;
    for user in users {
        if !user.password_hash.is_empty() {
            continue; // registered account — keep forever
        }
        if connected.contains(&(user.user_id as i64)) {
            continue; // live session
        }
        if now_micros - user.created_at_micros < GUEST_REAP_GRACE_MICROS {
            continue; // fresh account, socket may still be on its way
        }
        match state.app.wdb.delete_user(user.user_id).await {
            Ok(()) => reaped += 1,
            Err(e) => {
                tracing::warn!("[guest-reap] delete_user {} failed: {}", user.user_id, e)
            }
        }
    }
    if reaped > 0 {
        tracing::info!("[guest-reap] tombstoned {reaped} disconnected guest account(s)");
    }
    reaped
}

/// Spawn the periodic sweep task. Call from server startup.
/// The JoinHandle is returned so shutdown can cancel the loop.
#[allow(dead_code)]
pub fn spawn_sweep_loop(state: SioState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Boot sweep: wait one interval so sockets reconnecting after a
        // restart land in connected_users first, then clear every guest
        // row left over from the previous process.
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        state
            .app
            .instance_operations
            .run(reap_disconnected_guests(&state))
            .await;

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        // The boot sweep above already handled the startup pass.
        interval.tick().await;
        loop {
            interval.tick().await;
            state.app.instance_operations.run(async {
                if let Some(io) = state.app.socket_io() {
                    let live: HashSet<_> = io.sockets().iter().map(|socket| socket.id.to_string()).collect();
                    let now = now_micros();
                    for (socket_id, user) in state.connected_users.write().await.iter_mut() {
                        if live.contains(socket_id) { user.last_seen_micros = now; }
                    }
                }
                let (u, v, g) = sweep_stale_state(
                    &state.connected_users,
                    &state.voice_channels,
                    &state.group_call_sessions,
                )
                .await;
                if u > 0 || v > 0 || g > 0 {
                    tracing::info!("[sweep] removed {} stale connected users, {} empty voice channels, {} empty group call sessions", u, v, g);
                }
                // Guest reconciliation: catches disconnects on_disconnect
                // missed and guests whose stale socket entry was just swept.
                reap_disconnected_guests(&state).await;
            }).await;
        }
    })
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn username_from_token(token: &str, secret: &str) -> Option<String> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(Deserialize)]
    struct C {
        username: String,
    }
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60; // 60 second grace period for clock skew
    decode::<C>(token, &key, &v).ok().map(|d| d.claims.username)
}

#[allow(dead_code)]
fn user_id_from_token(token: &str, secret: &str) -> Option<i64> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(Deserialize)]
    struct C {
        sub: String,
    }
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60; // 60 second grace period for clock skew
    decode::<C>(token, &key, &v)
        .ok()
        .and_then(|d| d.claims.sub.parse().ok())
}

/// Resolved socket identity from a validated bearer token.
#[derive(Clone, Debug)]
pub struct SocketIdentity {
    pub user_id: i64,
    pub username: String,
    pub is_guest: bool,
    pub jti: String,
    pub iat: i64,
    // Also retain proof for direct/internal handler invocations. Production
    // callbacks keep a shared copy in their owned event scope, including when
    // a helper uses only `resolve_identity(...).is_some()`.
    credential: Option<SocketCredentialProof>,
}

#[derive(Clone)]
struct SocketCredentialProof {
    store: Arc<RwLock<crate::state::RevocationStore>>,
    reader: Arc<tokio::sync::OwnedRwLockReadGuard<crate::state::RevocationStore>>,
}

impl std::fmt::Debug for SocketCredentialProof {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SocketCredentialProof(..)")
    }
}

tokio::task_local! {
    static SOCKET_EVENT_CREDENTIAL: Arc<tokio::sync::OnceCell<SocketCredentialProof>>;
}

/// Retain a single credential reader through the existing owned callback.
/// Identity resolution happens after membership admission inside the future;
/// repeated checks reuse this reader even when a denial writer is queued.
async fn scoped_socket_event<F>(
    operations: crate::instance_operations::InstanceOperations,
    future: F,
) -> F::Output
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let context = SOCKET_EVENT_CREDENTIAL
        .try_with(Arc::clone)
        .unwrap_or_else(|_| Arc::new(tokio::sync::OnceCell::new()));
    crate::instance_operations::scoped(operations, async move {
        SOCKET_EVENT_CREDENTIAL.scope(context, future).await
    })
    .await
}

async fn socket_credential_reader(app: &AppState) -> Option<SocketCredentialProof> {
    let context = SOCKET_EVENT_CREDENTIAL.try_with(Arc::clone).ok();
    let acquire = || async {
        SocketCredentialProof {
            store: app.revocations.clone(),
            reader: Arc::new(app.revocations.clone().read_owned().await),
        }
    };
    let proof = match context {
        Some(context) => context.get_or_init(acquire).await.clone(),
        None => acquire().await,
    };
    Arc::ptr_eq(&proof.store, &app.revocations).then_some(proof)
}

/// Resolve the socket's identity from the handshake-validated `SioIdentity`
/// extension, then check revocation and ban status. Returns `None` on any
/// failure; the caller emits an error event and returns. For revoked tokens
/// this emits `auth-revoked` and disconnects the socket before returning
/// `None`.
///
/// Token signature/expiry and current principal are validated by handshake
/// middleware. Established events check revocation, current account and bans
/// again, without expiring an otherwise healthy long-lived call.
pub async fn resolve_identity(socket: &SocketRef, state: &SioState) -> Option<SocketIdentity> {
    let proof = socket_credential_reader(&state.app).await?;
    let mut identity = resolve_identity_under(socket, state, &proof.reader).await?;
    identity.credential = Some(proof);
    Some(identity)
}

/// Account-denial callbacks supply their already-held writer here. They must
/// not enter the ordinary callback reader scope or call resolve_identity.
async fn resolve_identity_under(
    socket: &SocketRef,
    state: &SioState,
    revocations: &crate::state::RevocationStore,
) -> Option<SocketIdentity> {
    let sio = socket.extensions.get::<SioIdentity>().map(|x| x.clone());

    let (user_id, username, is_guest) = if let Some(ref id) = sio {
        (id.user_id, id.username.clone(), id.is_guest)
    } else {
        // Fallback: no handshake identity (e.g. legacy connection).
        // Apply the same credential policy as a fresh handshake.
        let token = socket
            .extensions
            .get::<AuthToken>()
            .map(|t| t.0.clone())
            .unwrap_or_default();
        if token.is_empty() {
            return None;
        }
        let identity = validate_token_sync(&token, &state.app.config.jwt_secret).ok()?;
        (identity.user_id, identity.username, identity.is_guest)
    };

    // Revoked tokens get a disconnect, not just a rejected handler.
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    if socket_token_revoked_by(&token, &state.app.config.jwt_secret, revocations) {
        let _ = socket.emit(
            "auth-revoked",
            &json!({ "reason": "session revoked; please sign in again" }),
        );
        let _ = socket.clone().disconnect();
        return None;
    }

    if crate::auth_extractor::ensure_active_principal(&state.app, user_id).await.is_err() {
        let _ = socket.emit("auth-revoked", &json!({ "reason": "account access unavailable; please sign in again" }));
        let _ = socket.clone().disconnect();
        return None;
    }

    // Banned users are rejected at the socket-event level too (not just REST).
    let Some(blacklist) = state.app.get_blacklist().await else {
        let _ = socket.emit("auth-revoked", &json!({ "reason": "Ban enforcement unavailable" }));
        let _ = socket.clone().disconnect();
        return None;
    };
    if blacklist.is_user_banned(user_id).await.is_some() {
        let _ = socket.emit("ban", &json!({ "reason": "You are banned from this server" }));
        let _ = socket.clone().disconnect();
        return None;
    }

    Some(SocketIdentity {
        user_id,
        username,
        is_guest,
        jti: String::new(),
        iat: 0,
        credential: None,
    })
}

/// Same persisted channel boundary as REST. In particular GroupDm does not
/// inherit the ordinary-channel owner/admin override.
pub async fn can_access_channel(state: &SioState, user_id: i64, channel_id: &str) -> bool {
    crate::channel_access::require_access(&state.app, user_id, channel_id).await.is_ok()
}

/// Kept as a compatibility entry point for existing DM call sites. The shared
/// policy handles BOTH conversation kinds and never parses IDs as authority.
pub async fn can_access_dm(state: &SioState, user_id: i64, channel_id: &str) -> bool {
    can_access_channel(state, user_id, channel_id).await
}

async fn require_socket_channel(socket: &SocketRef, state: &SioState, channel_id: &str, error_event: &str) -> Option<SocketIdentity> {
    let identity = resolve_identity(socket, state).await?;
    if !can_access_channel(state, identity.user_id, channel_id).await {
        let _ = socket.emit(error_event, &json!({"channelId": channel_id, "error": "Channel access denied"}));
        return None;
    }
    Some(identity)
}

/// Channel IDs supplied alongside nested message IDs are not authority. Check
/// the durable message's parent even for administrators and original authors.
async fn message_in_channel(state: &SioState, channel_id: &str, message_id: &str) -> bool {
    match state.app.wdb.get_message_typed(message_id).await {
        Ok(Some(message)) => message.channel_id == channel_id && !message.is_deleted,
        Ok(None) => state.app.session_messages.read().await.get(channel_id)
            .is_some_and(|messages| messages.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(message_id))),
        Err(_) => false,
    }
}

/// Check a previously authenticated socket's original bearer against current
/// revocation state. New handshakes still enforce expiration. Established
/// sockets may outlive exp (including healthy calls), but expiration must never
/// hide their original subject/iat from later user or global revocation floors.
/// Invalid signatures/claims fail closed; signed guest credentials use the same
/// rule. Individual-jti entries remain subject to the existing exp+1h pruning
/// limit; unlike user/global floors they are not retained indefinitely.
fn socket_token_revoked_by(token: &str, secret: &str, revocations: &crate::state::RevocationStore) -> bool {
    if token.is_empty() { return true; }
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(Deserialize)]
    struct C {
        sub: String,
        // Legacy account access tokens may lack a per-token identifier. Their
        // signed subject and issuance time still obey account/global floors.
        #[serde(default)]
        jti: String,
        iat: i64,
    }
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut v = Validation::default();
    // Signature verification and required claims stay enabled. Only temporal
    // expiry is irrelevant to this established-session revocation lookup.
    v.validate_exp = false;
    match decode::<C>(token, &key, &v) {
        Ok(d) => {
            let Ok(sub) = d.claims.sub.parse::<i64>() else { return true; };
            // A negative iat would wrap to u64 inside the floor comparison.
            if sub <= 0 || d.claims.iat < 0 { return true; }
            revocations.is_revoked(&d.claims.jti, sub, d.claims.iat)
        }
        Err(_) => true,
    }
}

#[cfg(test)]
mod socket_authentication_tests {
    use super::*;

    const SECRET: &str = "socket-authentication-test-only";

    fn claims() -> Value {
        json!({
            "sub": "7", "username": "fixture", "is_guest": false,
            "token_type": "access", "stepup": false,
            "iat": 1_500_000_000_i64, "exp": 9_999_999_999_i64,
            "jti": "socket-fixture"
        })
    }

    fn signed(claims: &Value, secret: &str) -> String {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            claims,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    #[test]
    fn account_and_legacy_access_credentials_keep_their_identity() {
        for is_guest in [false, true] {
            for token_type in [Some("access"), Some(""), None] {
                for stepup in [Some(false), None] {
                    let mut payload = claims();
                    payload["is_guest"] = json!(is_guest);
                    match token_type {
                        Some(kind) => payload["token_type"] = json!(kind),
                        None => {
                            payload.as_object_mut().unwrap().remove("token_type");
                        }
                    }
                    if stepup.is_none() {
                        payload.as_object_mut().unwrap().remove("stepup");
                    }
                    let identity = validate_token_sync(&signed(&payload, SECRET), SECRET).unwrap();
                    assert_eq!(identity.user_id, 7);
                    assert_eq!(identity.username, "fixture");
                    assert_eq!(identity.is_guest, is_guest);
                }
            }
        }
    }

    #[test]
    fn refresh_scoped_and_unknown_credentials_cannot_open_account_sockets() {
        for token_type in ["refresh", "lore", "unknown", "Access"] {
            let mut payload = claims();
            payload["token_type"] = json!(token_type);
            assert_eq!(
                validate_token_sync(&signed(&payload, SECRET), SECRET).unwrap_err(),
                "account access token required",
                "credential type {token_type} must not become an account session"
            );
        }
    }

    #[test]
    fn stepup_credentials_cannot_open_sockets_even_when_the_type_is_access_or_legacy() {
        for token_type in [Some("access"), Some(""), None] {
            let mut payload = claims();
            payload["stepup"] = json!(true);
            match token_type {
                Some(kind) => payload["token_type"] = json!(kind),
                None => {
                    payload.as_object_mut().unwrap().remove("token_type");
                }
            }
            assert_eq!(
                validate_token_sync(&signed(&payload, SECRET), SECRET).unwrap_err(),
                "account access token required"
            );
        }
    }

    #[test]
    fn malformed_credentials_do_not_gain_legacy_access_defaults() {
        for (field, value) in [
            ("token_type", Value::Null),
            ("token_type", json!(7)),
            ("stepup", Value::Null),
            ("stepup", json!("false")),
        ] {
            let mut payload = claims();
            payload[field] = value;
            assert_eq!(
                validate_token_sync(&signed(&payload, SECRET), SECRET).unwrap_err(),
                "invalid token",
                "invalid {field} must fail closed"
            );
        }
    }

    #[test]
    fn access_policy_preserves_signature_expiry_and_subject_validation() {
        assert_eq!(
            validate_token_sync("", SECRET).unwrap_err(),
            "missing token"
        );
        for token in ["malformed.jwt".into(), signed(&claims(), "different-key")] {
            assert_eq!(
                validate_token_sync(&token, SECRET).unwrap_err(),
                "invalid token"
            );
        }
        let mut expired = claims();
        expired["exp"] = json!(1_500_000_100_i64);
        assert_eq!(
            validate_token_sync(&signed(&expired, SECRET), SECRET).unwrap_err(),
            "token expired"
        );
        let mut missing_expiry = claims();
        missing_expiry.as_object_mut().unwrap().remove("exp");
        assert_eq!(
            validate_token_sync(&signed(&missing_expiry, SECRET), SECRET).unwrap_err(),
            "invalid token"
        );
        for subject in ["0", "-7", "not-an-id", "9223372036854775808"] {
            let mut payload = claims();
            payload["sub"] = json!(subject);
            assert_eq!(
                validate_token_sync(&signed(&payload, SECRET), SECRET).unwrap_err(),
                "invalid user id"
            );
        }
    }
}

#[cfg(test)]
mod socket_revocation_tests {
    use super::*;
    use crate::state::RevocationStore;

    const SECRET: &str = "established-socket-revocation-test-only";
    fn claims() -> Value {
        json!({"sub":"7","username":"fixture","is_guest":false,"token_type":"access",
            "iat":1_500_000_000_i64,"exp":1_500_000_100_i64,"jti":"socket-fixture"})
    }
    fn signed(claims: &Value, secret: &str) -> String {
        jsonwebtoken::encode(&jsonwebtoken::Header::default(), claims,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes())).unwrap()
    }

    #[test]
    fn expired_established_credentials_keep_continuity_but_cannot_start_a_new_socket() {
        for is_guest in [false, true] {
            let mut payload = claims(); payload["is_guest"] = json!(is_guest);
            let token = signed(&payload, SECRET);
            assert_eq!(validate_token_sync(&token, SECRET).unwrap_err(), "token expired");
            assert!(!socket_token_revoked_by(&token, SECRET, &RevocationStore::default()),
                "token expiry alone must not tear down an established healthy call");
        }
    }

    #[test]
    fn expired_established_credentials_still_obey_every_retained_revocation_rule() {
        let token = signed(&claims(), SECRET);
        let mut revoked = RevocationStore::default();
        assert!(!socket_token_revoked_by(&token, SECRET, &revoked));
        revoked.user_iat_revoked.insert(7, 1_500_000_001);
        assert!(socket_token_revoked_by(&token, SECRET, &revoked), "later account revocation must not disappear after exp");
        revoked.user_jti_exemptions.insert(7, HashSet::from(["socket-fixture".into()]));
        assert!(!socket_token_revoked_by(&token, SECRET, &revoked), "existing explicit same-session exemption stays valid");
        revoked.epoch = 1_500_000_001;
        assert!(socket_token_revoked_by(&token, SECRET, &revoked), "global revocation overrides the exemption");
        revoked = RevocationStore::default(); revoked.users.insert(7);
        assert!(socket_token_revoked_by(&token, SECRET, &revoked));
        revoked = RevocationStore::default(); revoked.jtis.insert("socket-fixture".into(), u64::MAX);
        assert!(socket_token_revoked_by(&token, SECRET, &revoked), "a retained per-token revocation remains effective");
    }

    #[test]
    fn legacy_missing_jti_preserves_continuity_without_bypassing_account_floors() {
        let mut payload = claims(); payload.as_object_mut().unwrap().remove("jti");
        let token = signed(&payload, SECRET); let mut revoked = RevocationStore::default();
        assert!(!socket_token_revoked_by(&token, SECRET, &revoked));
        revoked.user_iat_revoked.insert(7, 1_500_000_001);
        assert!(socket_token_revoked_by(&token, SECRET, &revoked));
    }

    #[test]
    fn invalid_signature_or_claims_cannot_turn_into_unrevoked_cached_identity() {
        let revoked = RevocationStore::default();
        for token in [String::new(), "malformed.jwt".into(), signed(&claims(), "different-key")] {
            assert!(socket_token_revoked_by(&token, SECRET, &revoked));
        }
        for (field, value) in [("sub", json!("0")), ("sub", json!("-7")), ("sub", json!("not-an-id")),
            ("sub", json!("9223372036854775808")), ("iat", json!(-1)), ("iat", Value::Null), ("jti", json!(7))] {
            let mut payload = claims(); payload[field] = value;
            assert!(socket_token_revoked_by(&signed(&payload, SECRET), SECRET, &revoked), "invalid {field}");
        }
        for field in ["sub", "iat", "exp"] {
            let mut payload = claims(); payload.as_object_mut().unwrap().remove(field);
            assert!(socket_token_revoked_by(&signed(&payload, SECRET), SECRET, &revoked), "missing required {field}");
        }
    }
}

// ---------------------------------------------------------------------------
// Protocol mapping helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod socket_event_admission_tests {
    use super::*;
    use crate::{
        api::routes::create_api_router,
        auth_extractor::JwtClaims,
        config::{LoreAddonConfig, ServerConfig, ServerRole},
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Method, Request, StatusCode},
        Router,
    };
    use tower::ServiceExt;
    use wabidb::domain::{ChannelKind, MemberRole};

    async fn transport(app: &Router, method: Method, path: &str, body: String) -> String {
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "text/plain;charset=UTF-8")
                    .body(Body::from(body))
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        String::from_utf8(
            to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }

    async fn fixture() -> (
        tempfile::TempDir,
        SioState,
        SocketRef,
        SocketIo,
        String,
        JwtClaims,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let app_state = Arc::new(
            AppState::new(ServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                data_dir: path.to_string_lossy().into_owned(),
                uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
                jwt_secret: "socket-event-admission-fixture".into(),
                turn_enabled: false,
                turn_uri: None,
                turn_secret: None,
                node_id: "socket-event-test".into(),
                is_primary: true,
                server_role: ServerRole::Authority,
                authority_url: None,
                admin_user_ids: vec![],
                blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
                max_body_size: None,
                mesh_enabled: false,
                mesh_peers: vec![],
                lore: LoreAddonConfig::default(),
            })
            .await
            .unwrap(),
        );
        let uid = app_state
            .wdb
            .create_user("event-owner", None, "registered-hash")
            .await
            .unwrap();
        app_state.wdb.claim_owner(uid).await.unwrap();
        *app_state.owner_user_id.write().await = Some(uid as i64);
        let channel = app_state
            .wdb
            .create_channel("event-admission-canary", ChannelKind::Text, uid, false)
            .await
            .unwrap();
        app_state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
        let now = chrono::Utc::now().timestamp();
        let claims = JwtClaims {
            sub: uid.to_string(),
            username: "event-owner".into(),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(app_state.config.jwt_secret.as_bytes()),
        )
        .unwrap();
        let app = create_api_router(app_state.clone())
            .with_state(app_state.clone())
            .layer(create_socket_layer(app_state.clone()));
        let open = transport(
            &app,
            Method::GET,
            "/socket.io/?EIO=4&transport=polling",
            String::new(),
        )
        .await;
        let handshake: Value = serde_json::from_str(open.strip_prefix('0').unwrap()).unwrap();
        let path = format!(
            "/socket.io/?EIO=4&transport=polling&sid={}",
            handshake["sid"].as_str().unwrap()
        );
        transport(
            &app,
            Method::POST,
            &path,
            format!("40{}", json!({"token": token})),
        )
        .await;
        let connected = transport(&app, Method::GET, &path, String::new()).await;
        assert!(connected.starts_with("40"), "{connected}");
        let io = app_state.socket_io().unwrap();
        let socket = io.sockets().into_iter().next().unwrap();
        assert!(socket.extensions.get::<SioAdmissionGuard>().is_none());
        let state = SioState {
            app: app_state,
            connected_users: Arc::new(RwLock::new(HashMap::new())),
            voice_channels: Arc::new(RwLock::new(HashMap::new())),
            group_call_sessions: Arc::new(RwLock::new(HashMap::new())),
            breakout_rooms: Arc::new(RwLock::new(HashMap::new())),
            roster_cache: Arc::new(TokioMutex::new(None)),
        };
        (directory, state, socket, io, channel, claims)
    }

    #[tokio::test]
    async fn message_waiting_on_retention_keeps_current_credential_until_actual_publication() {
        let (_directory, state, socket, io, channel, _) = fixture().await;
        let app = state.app.clone();
        let _membership = app.membership_gate.clone().read_owned().await;
        let policy = app.retention_policy_lock.lock().await;
        // Match the production callback's credential context. The post-gate
        // channel check must reuse its first proof behind a queued denial,
        // rather than acquire a second fair reader while retaining the first.
        let mut callback = Box::pin(SOCKET_EVENT_CREDENTIAL.scope(
            Arc::new(tokio::sync::OnceCell::new()),
            on_message(
                socket,
                json!({
                    "channelId": channel, "text": "credential-canary", "clientMessageId": "credential-canary"
                }),
                state,
                io,
            ),
        ));
        // All preceding identity/channel lookups use ready projection state;
        // this exact handler poll parks at the deliberately held policy mutex.
        assert!(futures::poll!(callback.as_mut()).is_pending());
        assert!(app
            .wdb
            .list_messages_typed(&channel, 100)
            .await
            .unwrap()
            .is_empty());
        let mut denial = Box::pin(app.revocations.clone().write_owned());
        assert!(
            futures::poll!(denial.as_mut()).is_pending(),
            "revocation can finish while an authenticated message waits to publish"
        );
        drop(policy);
        tokio::time::timeout(Duration::from_secs(5), callback)
            .await
            .unwrap();
        let _denial = tokio::time::timeout(Duration::from_secs(5), denial)
            .await
            .unwrap();
        let messages = app.wdb.list_messages_typed(&channel, 100).await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "credential-canary");
    }

    #[tokio::test]
    async fn callback_reuses_one_credential_reader_behind_a_queued_denial_and_preserves_call_expiry_policy(
    ) {
        let (_directory, state, socket, _, _, mut claims) = fixture().await;
        let app = state.app.clone();
        // Model an already-admitted call whose original signed credential has
        // aged past exp. Fresh handshakes still reject this same credential.
        claims.iat = chrono::Utc::now().timestamp() - 7200;
        claims.exp = chrono::Utc::now().timestamp() - 3600;
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(app.config.jwt_secret.as_bytes()),
        )
        .unwrap();
        assert!(validate_token_sync(&token, &app.config.jwt_secret).is_err());
        socket.extensions.insert(AuthToken(token));
        scoped_socket_event(app.instance_operations.clone(), async move {
            let _membership = state.app.membership_gate.clone().read_owned().await;
            assert!(resolve_identity(&socket, &state).await.is_some());
            // The temporary identity above has already dropped; the callback
            // context must still own its proof and reuse it on the next check.
            let mut denial = Box::pin(state.app.revocations.clone().write_owned());
            assert!(futures::poll!(denial.as_mut()).is_pending());
            assert!(
                tokio::time::timeout(Duration::from_secs(5), resolve_identity(&socket, &state))
                    .await
                    .unwrap()
                    .is_some(),
                "nested reader waited behind its own denial writer"
            );
            drop(denial);
        })
        .await;
        assert!(
            app.revocations.try_write().is_ok(),
            "callback leaked its credential reader"
        );
    }

    #[tokio::test]
    async fn aborted_callback_keeps_credential_and_membership_through_durable_message_before_revocation(
    ) {
        let (_directory, state, socket, io, channel, claims) = fixture().await;
        let app = state.app.clone();
        let operations = app.instance_operations.clone();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let message_channel = channel.clone();
        let caller = tokio::spawn(async move {
            scoped_socket_event(operations, async move {
                let _membership = state.app.membership_gate.clone().read_owned().await;
                assert!(resolve_identity(&socket, &state).await.is_some());
                started.send(()).unwrap();
                release_rx.await.unwrap();
                // This re-enters identity resolution behind the queued denial
                // writer before submitting the real durable message command.
                on_message(
                    socket,
                    json!({"channelId": message_channel,
                    "text":"owned-credential-canary", "clientMessageId":"owned-credential-canary"}),
                    state,
                    io,
                )
                .await;
            })
            .await;
        });
        tokio::time::timeout(Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(app.membership_gate.try_write().is_err());
        let writer = app.clone();
        let mut denial =
            tokio::spawn(async move { writer.revoke_token_with_exp(claims.jti, claims.exp).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while app.revocations.try_read().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            !denial.is_finished(),
            "revocation overtook the admitted callback"
        );
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(app.membership_gate.try_write().is_err());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), &mut denial)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let messages = app.wdb.list_messages_typed(&channel, 100).await.unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "owned-credential-canary");
        assert!(app
            .session_messages
            .read()
            .await
            .get(&channel)
            .unwrap()
            .iter()
            .any(|message| message["text"] == "owned-credential-canary"));
        let checkpoint =
            tokio::time::timeout(Duration::from_secs(5), app.instance_operations.quiesce())
                .await
                .unwrap()
                .unwrap();
        drop(checkpoint);
    }
}

#[allow(dead_code)]
fn row_to_channel_view(row: &HashMap<String, Value>) -> Value {
    json!({
        "id":        row.get("channel_id").or_else(|| row.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
        "name":      row.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "createdAt": row.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
        "type":      row.get("channel_type").or_else(|| row.get("type")).and_then(|v| v.as_str()).unwrap_or("text"),
        "description": row.get("description").and_then(|v| v.as_str()),
        "members":   row.get("members"),
        "parentChannelId": row.get("parent_channel_id").and_then(|v| v.as_str()),
        "persistMessages": row.get("persist_messages").and_then(|v| v.as_bool()),
        "minRole":   row.get("min_role").and_then(|v| v.as_str()),
        "position":  row.get("position").and_then(|v| v.as_i64()).map(|v| v as i32),
        "parentId":  row.get("parent_id").and_then(|v| v.as_str()),
    })
}

#[allow(dead_code)]
fn highest_role(db_id: Option<i64>, owner_id: Option<i64>) -> &'static str {
    if owner_id.is_some() && db_id == owner_id {
        "owner"
    } else if db_id.is_some() {
        "member"
    } else {
        "guest"
    }
}

/// Snapshot and incremental user views must use the same live RBAC authority
/// as command authorization, not infer every non-owner account to be Member.
/// Role precedence: owner > admin > developer > moderator > artist > member.
/// Artist/Developer are orthogonal workspace tiers (Lore access), never
/// moderation/admin powers — they are read here by exact stored-role match,
/// NOT via the rank-based `has_role` (where every unknown role ranks 0).
async fn effective_user_role(state: &SioState, db_id: Option<i64>, is_registered: bool) -> &'static str {
    let Some(user_id) = db_id.filter(|id| *id > 0) else { return "guest"; };
    if !is_registered { return "guest"; }
    if state.app.is_owner(user_id).await { return "owner"; }
    if state.app.is_admin(user_id).await { return "admin"; }
    // Exact stored-role match (not rank-based `has_role`, where every
    // unknown role ranks 0): developer outranks moderator, artist sits
    // below it. Single-role store, so at most one arm fires.
    match state.app.wdb.get_user_role("default-workspace", user_id as u64).await {
        Ok(Some(stored)) if stored.eq_ignore_ascii_case("developer") => return "developer",
        Ok(Some(stored)) if stored.eq_ignore_ascii_case("artist") => return "artist",
        _ => {}
    }
    if state.app.has_role(user_id, "Moderator").await { return "mod"; }
    "member"
}

/// Used for serverMembers snapshot — all registered users, status unset (offline by default).
#[allow(dead_code)]
fn row_to_user_view(row: &HashMap<String, Value>, owner_id: Option<i64>) -> Value {
    let db_id = row.get("user_id").and_then(|v| v.as_i64());
    let stable_id = db_id
        .map(|id| format!("user-{}", id))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let role = highest_role(db_id, owner_id);
    json!({
        "id":          stable_id,
        "username":    row.get("username").and_then(|v| v.as_str()).unwrap_or(""),
        "handle":      row.get("handle").and_then(|v| v.as_str()),
        "color":       row.get("color").and_then(|v| v.as_str()).unwrap_or("#98D8C8"),
        "status":      "offline",
        "dbUserId":    db_id,
        "roles":       [role],
        "highestRole": role,
    })
}

#[allow(dead_code)]
async fn connected_user_to_view(user: &ConnectedUser, _owner_id: Option<i64>, state: &SioState) -> Value {
    let (profile_picture, username_font, bio, status_message, is_registered) = if let Some(db_id) = user.db_user_id {
        if db_id > 0 {
            if let Ok(Some(db_user)) = state.app.wdb.get_user(db_id as u64).await {
                (
                    db_user.profile_picture,
                    db_user.username_font.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
                    db_user.bio,
                    db_user.status_message,
                    Some(!db_user.password_hash.is_empty()),
                )
            } else {
                (None, None, None, None, None)
            }
        } else {
            (None, None, None, None, None)
        }
    } else {
        (None, None, None, None, None)
    };

    let role = effective_user_role(state, user.db_user_id, is_registered.unwrap_or(false)).await;
    let (banner_url, overlay_url, overlay_scale, overlay_ox, overlay_oy) = if let Some(db_id) = user.db_user_id {
        let stored = state
            .app
            .wdb
            .get_user_layout(db_id as u64)
            .await
            .ok()
            .flatten()
            .and_then(|l| serde_json::from_str::<Value>(&l.layout_json).ok());
        let media = stored
            .and_then(|root| root.get("profile_media").cloned())
            .and_then(|m| m.as_object().cloned())
            .unwrap_or_default();
        let num = |key: &str, default: f64| -> f64 {
            media.get(key).and_then(|v| v.as_f64()).unwrap_or(default)
        };
        (
            media.get("banner_url").and_then(|v| v.as_str()).map(String::from),
            media.get("overlay_url").and_then(|v| v.as_str()).map(String::from),
            num("overlay_scale", 1.0).clamp(0.5, 3.0),
            num("overlay_offset_x", 0.0).clamp(-200.0, 200.0),
            num("overlay_offset_y", 0.0).clamp(-200.0, 200.0),
        )
    } else {
        (None, None, 1.0, 0.0, 0.0)
    };

    let badges = badges_json_for(state, user.db_user_id.unwrap_or(0)).await;
    let is_bot = match user.db_user_id {
        Some(db_id) if db_id > 0 => state.app.is_bot_user(db_id as u64).await,
        _ => false,
    };

    json!({
        "id":          user.stable_id,
        "username":    user.username,
        "color":       user.color,
        "status":      "active",
        "handle":      null,
        "profilePicture": profile_picture,
        "bannerUrl":   banner_url,
        "overlayUrl":  overlay_url,
        "overlayScale": overlay_scale,
        "overlayOffsetX": overlay_ox,
        "overlayOffsetY": overlay_oy,
        "usernameFont": username_font,
        "bio":         bio,
        "statusMessage": status_message,
        "dbUserId":    user.db_user_id,
        "roles":       [role],
        "highestRole": role,
        "badges":      badges,
        "isRegistered": is_registered,
        "isBot": is_bot,
    })
}

#[allow(dead_code)]
fn voice_participant_to_view(p: &VoiceParticipant) -> Value {
    json!({
        "userId":     p.stable_id,
        "socketId":   p.socket_id,
        "username":   p.username,
        "isMuted":    p.is_muted,
        "isDeafened": p.is_deafened,
        "transmitMode": p.transmit_mode,
        "isListeningOnly": p.is_listening_only,
        "profilePicture": p.profile_picture,
    })
}

#[allow(dead_code)]
fn row_to_message_view(row: &HashMap<String, Value>) -> Value {
    let sender_id = row
        .get("sender_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    json!({
        "id":            row.get("message_id").and_then(|v| v.as_str()).unwrap_or(""),
        "user":          row.get("sender_username").and_then(|v| v.as_str()).unwrap_or(""),
        "userId":        sender_id,
        "senderStableId": sender_id,
        "color":         row.get("sender_color").and_then(|v| v.as_str()),
        "text":          row.get("content").and_then(|v| v.as_str()).unwrap_or(""),
        "timestamp":     row.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
        "type":          row.get("message_type").and_then(|v| v.as_str()).unwrap_or("text"),
        "encrypted":     row.get("is_encrypted").and_then(|v| v.as_bool()),
        "iv":            row.get("encryption_iv").and_then(|v| v.as_str()),
        "isPinned":      row.get("is_pinned").and_then(|v| v.as_bool()),
        "isEdited":      row.get("is_edited").and_then(|v| v.as_bool()),
        "isSpoiler":     row.get("is_spoiler").and_then(|v| v.as_bool()),
        "replyTo":       row.get("reply_to").and_then(|v| v.as_str()),
    })
}

#[allow(dead_code)]
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn new_message_id(channel_id: &str, username: &str) -> String {
    let rand: u32 = rand::random();
    format!("msg:{}:{}:{}:{:x}", username, channel_id, now_ms(), rand)
}

// ---------------------------------------------------------------------------
// Call helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn get_my_stable_id(socket: &SocketRef, jwt_secret: &str) -> String {
    if let Some(id) = socket.extensions.get::<SioIdentity>() {
        return format!("user-{}", id.user_id);
    }
    // Fallback for legacy connections without handshake identity.
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let uid = user_id_from_token(&token, jwt_secret).unwrap_or(-1);
    if uid > 0 {
        format!("user-{}", uid)
    } else {
        socket.id.to_string()
    }
}

#[allow(dead_code)]
fn is_stable_connected(connected: &HashMap<String, ConnectedUser>, stable_id: &str) -> bool {
    connected.values().any(|u| u.stable_id == stable_id)
}

#[cfg(test)]
mod tests {
    //! WABI_AUDIT_REPORT.md findings #3, #4, #5 — periodic sweep tests.
    //!
    //! The sweep runs in a 60s loop at server startup. These tests assert
    //! the sweep logic itself: empty channels and empty group call
    //! sessions are removed, non-empty ones survive.

    use super::*;
    use std::collections::HashSet;

    fn test_voice_channels() -> VoiceChannels {
        Arc::new(RwLock::new(HashMap::new()))
    }

    fn test_group_sessions() -> GroupCallSessions {
        Arc::new(RwLock::new(HashMap::new()))
    }

    fn test_connected_users() -> ConnectedUsers {
        Arc::new(RwLock::new(HashMap::new()))
    }

    fn make_user(stable_id: &str, last_seen_micros: i64) -> ConnectedUser {
        ConnectedUser {
            stable_id: stable_id.to_string(),
            db_user_id: None,
            username: stable_id.to_string(),
            color: "#fff".to_string(),
            presence: UserPresence::Active,
            last_seen_micros,
        }
    }

    #[tokio::test]
    async fn sweep_removes_empty_voice_channels() {
        let voice = test_voice_channels();
        // Empty channel — should be removed
        voice.write().await.insert("ch-empty".to_string(), vec![]);
        // Non-empty channel — should survive
        voice.write().await.insert(
            "ch-active".to_string(),
            vec![VoiceParticipant {
                socket_id: "s1".to_string(),
                stable_id: "user-1".to_string(),
                username: "alice".to_string(),
                color: "#fff".to_string(),
                is_muted: false,
                is_deafened: false,
                transmit_mode: "primary".to_string(),
                is_listening_only: false,
                profile_picture: None,
            }],
        );
        assert_eq!(voice.read().await.len(), 2);

        let groups = test_group_sessions();
        let users = test_connected_users();
        let (u_removed, v_removed, g_removed) =
            sweep_stale_state(&users, &voice, &groups).await;

        assert_eq!(u_removed, 0);
        assert_eq!(v_removed, 1);
        assert_eq!(g_removed, 0);
        let after = voice.read().await;
        assert_eq!(after.len(), 1);
        assert!(after.contains_key("ch-active"));
        assert!(!after.contains_key("ch-empty"));
    }

    #[tokio::test]
    async fn sweep_removes_empty_group_call_sessions() {
        let groups = test_group_sessions();
        // Session with no connected participants — should be removed
        let mut invited = HashSet::new();
        invited.insert("user-1".to_string());
        groups.write().await.insert(
            "ch-dead".to_string(),
            GroupCallSession {
                channel_id: "ch-dead".to_string(),
                channel_name: "dead call".to_string(),
                initiator_stable_id: "user-1".to_string(),
                is_video_call: false,
                has_ever_established: false,
                last_invite_sender_id: "user-1".to_string(),
                invited_participants: invited,
                connected_participants: GroupCallParticipants::default(),
            },
        );
        // Active session — should survive
        let mut connected = GroupCallParticipants::default();
        connected.join("user-2", "sock-2");
        groups.write().await.insert(
            "ch-active".to_string(),
            GroupCallSession {
                channel_id: "ch-active".to_string(),
                channel_name: "active call".to_string(),
                initiator_stable_id: "user-2".to_string(),
                is_video_call: false,
                has_ever_established: true,
                last_invite_sender_id: "user-2".to_string(),
                invited_participants: HashSet::from(["user-2".to_string()]),
                connected_participants: connected,
            },
        );

        let voice = test_voice_channels();
        let users = test_connected_users();
        let (u_removed, v_removed, g_removed) =
            sweep_stale_state(&users, &voice, &groups).await;

        assert_eq!(u_removed, 0);
        assert_eq!(v_removed, 0);
        assert_eq!(g_removed, 1);
        let after = groups.read().await;
        assert_eq!(after.len(), 1);
        assert!(after.contains_key("ch-active"));
        assert!(!after.contains_key("ch-dead"));
    }

    #[tokio::test]
    async fn sweep_empty_state_returns_zero_zero() {
        let voice = test_voice_channels();
        let groups = test_group_sessions();
        let users = test_connected_users();
        let (u, v, g) = sweep_stale_state(&users, &voice, &groups).await;
        assert_eq!((u, v, g), (0, 0, 0));
    }

    #[tokio::test]
    async fn sweep_removes_stale_connected_users_keeps_fresh() {
        let users = test_connected_users();
        // Stale: 10 minutes ago
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        let stale = now - 10 * 60 * 1_000_000;
        let fresh = now;
        users.write().await.insert(
            "sock-stale".to_string(),
            make_user("user-stale", stale),
        );
        users.write().await.insert(
            "sock-fresh".to_string(),
            make_user("user-fresh", fresh),
        );
        assert_eq!(users.read().await.len(), 2);

        let voice = test_voice_channels();
        let groups = test_group_sessions();
        let (u_removed, v_removed, g_removed) =
            sweep_stale_state(&users, &voice, &groups).await;

        assert_eq!(u_removed, 1);
        assert_eq!(v_removed, 0);
        assert_eq!(g_removed, 0);
        let after = users.read().await;
        assert_eq!(after.len(), 1);
        assert!(after.contains_key("sock-fresh"));
        assert!(!after.contains_key("sock-stale"));
    }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
