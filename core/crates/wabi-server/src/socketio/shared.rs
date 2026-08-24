// Socket.IO real-time layer (socketioxide 0.16)
//
// Implements the wabi-protocol event surface expected by the Svelte frontend.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use socketioxide::{
    extract::{Data, SocketRef, State},
    layer::SocketIoLayer,
    SocketIo,
};
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Per-socket auth token stored in socket extensions
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct AuthToken(pub String);

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
/// Returns `Ok(SioIdentity)` if the token has a valid signature and is not
/// expired; `Err(message)` otherwise. Revocation and ban checks are deferred
/// to `resolve_identity` (async, per-event).
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

    // Refresh tokens must never open a socket — they are exchange-only
    // credentials for POST /api/auth/refresh (mirrors the AuthUser extractor).
    if data.claims.token_type == "refresh" {
        return Err("refresh tokens cannot authenticate sockets");
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

/// User presence states. `Invisible` renders as `"offline"` to other users
/// (masked view) while the socket stays connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum UserPresence {
    Active,
    Away,
    Busy,
    Invisible,
}

impl UserPresence {
    /// Parse a client-supplied presence string; unknown values fall back to
    /// `Active` rather than rejecting the session.
    pub fn parse(value: &str) -> Self {
        match value.to_lowercase().as_str() {
            "away" | "idle" => Self::Away,
            "busy" | "dnd" => Self::Busy,
            "invisible" | "offline" => Self::Invisible,
            _ => Self::Active,
        }
    }

    /// Canonical wire string for `status` fields.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Away => "away",
            Self::Busy => "busy",
            Self::Invisible => "invisible",
        }
    }
}

/// Info about a connected socket's user identity.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct ConnectedUser {
    pub stable_id: String,
    pub db_user_id: Option<i64>,
    pub username: String,
    pub color: String,
    /// Presence of this socket's account; multi-tab sockets inherit the
    /// first tab's value so a second tab can't flip Invisible back to Active.
    pub presence: UserPresence,
    /// Unix microseconds of the last activity (connect, message, or
    /// periodic heartbeat). The periodic sweep uses this to remove
    /// entries that are stale (e.g. on_disconnect never fired because
    /// the socket was lost without a clean close).
    ///
    /// WABI_AUDIT_REPORT.md finding #3.
    pub last_seen_micros: i64,
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

/// State for an active group/DM-group call.
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
    pub connected_participants: HashSet<String>,
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

/// Spawn the periodic sweep task. Call from server startup.
/// The JoinHandle is returned so shutdown can cancel the loop.
#[allow(dead_code)]
pub fn spawn_sweep_loop(state: SioState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        // Skip the first immediate tick — on_disconnect handles startup cleanly.
        interval.tick().await;
        loop {
            interval.tick().await;
            let (u, v, g) = sweep_stale_state(
                &state.connected_users,
                &state.voice_channels,
                &state.group_call_sessions,
            )
            .await;
            if u > 0 || v > 0 || g > 0 {
                tracing::info!("[sweep] removed {} stale connected users, {} empty voice channels, {} empty group call sessions", u, v, g);
            }
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
}

/// Decode a JWT into the small subset of claims resolve_identity needs.
/// Returns None on decode/expiry failure.
async fn decode_socket_claims(token: &str, secret: &str) -> Option<SocketTokenClaims> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    decode::<SocketTokenClaims>(token, &key, &v)
        .ok()
        .map(|d| d.claims)
}

#[derive(Deserialize)]
struct SocketTokenClaims {
    sub: String,
    username: String,
    #[serde(default)]
    is_guest: bool,
    #[serde(default)]
    jti: String,
    #[serde(default)]
    iat: i64,
}

/// Resolve the socket's identity from the handshake-validated `SioIdentity`
/// extension, then check revocation and ban status. Returns `None` on any
/// failure; the caller emits an error event and returns. For revoked tokens
/// this emits `auth-revoked` and disconnects the socket before returning
/// `None`.
///
/// Token signature/expiry are already validated at handshake. This only
/// performs the async checks (revocation + ban) that cannot run in the
/// connect closure.
pub async fn resolve_identity(socket: &SocketRef, state: &SioState) -> Option<SocketIdentity> {
    let sio = socket.extensions.get::<SioIdentity>().map(|x| x.clone());

    let (user_id, username, is_guest) = if let Some(ref id) = sio {
        (id.user_id, id.username.clone(), id.is_guest)
    } else {
        // Fallback: no handshake identity (e.g. legacy connection).
        // Try reading the raw token and decoding.
        let token = socket
            .extensions
            .get::<AuthToken>()
            .map(|t| t.0.clone())
            .unwrap_or_default();
        if token.is_empty() {
            return None;
        }
        let claims = decode_socket_claims(&token, &state.app.config.jwt_secret).await?;
        let uid = claims.sub.parse::<i64>().unwrap_or(-1);
        if uid <= 0 {
            return None;
        }
        (uid, claims.username, claims.is_guest)
    };

    // Revoked tokens get a disconnect, not just a rejected handler.
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    if socket_token_revoked(&state.app, &token).await {
        let _ = socket.emit(
            "auth-revoked",
            &json!({ "reason": "session revoked; please sign in again" }),
        );
        let _ = socket.clone().disconnect();
        return None;
    }

    // Banned users are rejected at the socket-event level too (not just REST).
    if let Ok(true) = state.app.wdb.is_user_banned(user_id as u64).await {
        let _ = socket.emit("ban", &json!({ "reason": "You are banned from this server" }));
        return None;
    }

    Some(SocketIdentity {
        user_id,
        username,
        is_guest,
        jti: String::new(),
        iat: 0,
    })
}

/// Channel access check for non-DM channels. Owner → admin → membership.
/// Mirrors the proven pattern in `socketio/whiteboard_ops.rs`.
pub async fn can_access_channel(state: &SioState, user_id: i64, channel_id: &str) -> bool {
    if *state.app.owner_user_id.read().await == Some(user_id) {
        return true;
    }
    if state.app.is_admin(user_id).await {
        return true;
    }
    if let Ok(channels) = state.app.wdb.list_channels(Some(user_id as u64)).await {
        for ch in &channels {
            if ch.channel_id == channel_id {
                return true;
            }
        }
    }
    false
}

/// DM-channel access check. Only the two participants may access. No
/// admin/owner override — admins must not silently read DMs. Prefers the
/// persisted members list; falls back to parsing `dm-user-{a}-user-{b}`.
/// Unknown/parse-failure ⇒ deny.
pub async fn can_access_dm(state: &SioState, user_id: i64, channel_id: &str) -> bool {
    let my_stable_id = format!("user-{}", user_id);

    // Prefer the persisted members list from the channel row.
    // Point lookup (t_6bbbc52a) — but members live in the separate
    // channel_members index, so query it directly instead of scanning all rows.
    if let Ok(members) = state.app.wdb.list_channel_members(channel_id).await {
        if !members.is_empty() {
            for m in &members {
                if format!("user-{}", m.user_id) == my_stable_id {
                    return true;
                }
            }
            return false;
        }
    }

    // Fall back to parsing dm-user-{a}-user-{b}.
    if let Some(rest) = channel_id.strip_prefix("dm-user-") {
        let parts: Vec<&str> = rest.split("-user-").collect();
        if parts.len() == 2 {
            if let (Ok(a), Ok(b)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
                return user_id == a || user_id == b;
            }
        }
    }

    false
}

/// True if the socket's bearer token has been revoked (password change on
/// another session, logout-everywhere, admin kick). REST requests check this
/// in `auth_extractor`; without this check a revoked token keeps full live
/// socket access until the JWT expires. Guest sockets carry an empty token
/// and are unaffected; a token that fails to decode keeps its existing
/// unauthenticated treatment.
async fn socket_token_revoked(app: &AppState, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(Deserialize)]
    struct C {
        sub: String,
        jti: String,
        iat: i64,
    }
    let key = DecodingKey::from_secret(app.config.jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    match decode::<C>(token, &key, &v) {
        Ok(d) => {
            let sub = d.claims.sub.parse::<i64>().unwrap_or(-1);
            app.is_token_revoked(&d.claims.jti, sub, d.claims.iat).await
        }
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Protocol mapping helpers
// ---------------------------------------------------------------------------

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
async fn connected_user_to_view(user: &ConnectedUser, owner_id: Option<i64>, state: &SioState) -> Value {
    let role = highest_role(user.db_user_id, owner_id);

    let (profile_picture, username_font, bio, is_registered) = if let Some(db_id) = user.db_user_id {
        if db_id > 0 {
            if let Ok(Some(db_user)) = state.app.wdb.get_user(db_id as u64).await {
                (
                    db_user.profile_picture,
                    db_user.username_font.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
                    db_user.bio,
                    Some(!db_user.password_hash.is_empty()),
                )
            } else {
                (None, None, None, None)
            }
        } else {
            (None, None, None, None)
        }
    } else {
        (None, None, None, None)
    };

    let (banner_url, overlay_url) = if let Some(db_id) = user.db_user_id {
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
        (
            media.get("banner_url").and_then(|v| v.as_str()).map(String::from),
            media.get("overlay_url").and_then(|v| v.as_str()).map(String::from),
        )
    } else {
        (None, None)
    };

    let badges = badges_json_for(state, user.db_user_id.unwrap_or(0)).await;

    json!({
        "id":          user.stable_id,
        "username":    user.username,
        "color":       user.color,
        "status":      "active",
        "handle":      null,
        "profilePicture": profile_picture,
        "bannerUrl":   banner_url,
        "overlayUrl":  overlay_url,
        "usernameFont": username_font,
        "bio":         bio,
        "dbUserId":    user.db_user_id,
        "roles":       [role],
        "highestRole": role,
        "badges":      badges,
        "isRegistered": is_registered,
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
                connected_participants: HashSet::new(),
            },
        );
        // Active session — should survive
        let mut connected = HashSet::new();
        connected.insert("user-2".to_string());
        groups.write().await.insert(
            "ch-active".to_string(),
            GroupCallSession {
                channel_id: "ch-active".to_string(),
                channel_name: "active call".to_string(),
                initiator_stable_id: "user-2".to_string(),
                is_video_call: false,
                has_ever_established: true,
                last_invite_sender_id: "user-2".to_string(),
                invited_participants: connected.clone(),
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
