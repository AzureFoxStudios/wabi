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
struct AuthToken(String);

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
    pub is_deafened: bool,
    pub transmit_mode: String,
    /// True for participants that only listen to a voice channel (multi-listen
    /// / TeamSpeak-style) without transmitting. A socket can be `primary` in one
    /// channel and `listening` in several others.
    pub is_listening_only: bool,
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

    json!({
        "id":          user.stable_id,
        "username":    user.username,
        "color":       user.color,
        "status":      "active",
        "handle":      null,
        "profilePicture": profile_picture,
        "usernameFont": username_font,
        "bio":         bio,
        "dbUserId":    user.db_user_id,
        "roles":       [role],
        "highestRole": role,
        "isRegistered": is_registered,
    })
}

#[allow(dead_code)]
fn voice_participant_to_view(p: &VoiceParticipant) -> Value {
    json!({
        "userId":     p.stable_id,
        "socketId":   p.socket_id,
        "username":   p.username,
        "isDeafened": p.is_deafened,
        "transmitMode": p.transmit_mode,
        "isListeningOnly": p.is_listening_only,
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
                is_deafened: false,
                transmit_mode: "primary".to_string(),
                is_listening_only: false,
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
