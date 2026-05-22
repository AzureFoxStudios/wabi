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
struct AuthToken(String);

// ---------------------------------------------------------------------------
// Shared real-time state
// ---------------------------------------------------------------------------

/// Info about a connected socket's user identity.
#[derive(Clone, Debug)]
pub struct ConnectedUser {
    pub stable_id: String,
    pub db_user_id: Option<i64>,
    pub username: String,
    pub color: String,
}

/// socket_id → ConnectedUser for all live sockets.
pub type ConnectedUsers = Arc<RwLock<HashMap<String, ConnectedUser>>>;

/// A participant currently in a voice channel.
#[derive(Clone, Debug)]
pub struct VoiceParticipant {
    pub socket_id: String,
    pub stable_id: String,
    pub username: String,
    #[allow(dead_code)]
    pub color: String,
    pub is_deafened: bool,
}

/// channel_id → Vec<VoiceParticipant>.
pub type VoiceChannels = Arc<RwLock<HashMap<String, Vec<VoiceParticipant>>>>;

/// State for an active group/DM-group call.
#[derive(Clone, Debug)]
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
pub type GroupCallSessions = Arc<RwLock<HashMap<String, GroupCallSession>>>;

#[derive(Clone)]
pub struct SioState {
    pub app: Arc<AppState>,
    pub connected_users: ConnectedUsers,
    pub voice_channels: VoiceChannels,
    pub group_call_sessions: GroupCallSessions,
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

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
    })
}

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

fn connected_user_to_view(user: &ConnectedUser, owner_id: Option<i64>) -> Value {
    let role = highest_role(user.db_user_id, owner_id);
    json!({
        "id":          user.stable_id,
        "username":    user.username,
        "color":       user.color,
        "status":      "active",
        "dbUserId":    user.db_user_id,
        "roles":       [role],
        "highestRole": role,
    })
}

fn voice_participant_to_view(p: &VoiceParticipant) -> Value {
    json!({
        "userId":     p.stable_id,
        "socketId":   p.socket_id,
        "username":   p.username,
        "isDeafened": p.is_deafened,
    })
}

fn retention_to_ms(duration: &str) -> Option<u64> {
    match duration {
        "5s"  => Some(5_000),
        "30s" => Some(30_000),
        "1m"  => Some(60_000),
        "5m"  => Some(300_000),
        "15m" => Some(900_000),
        "30m" => Some(1_800_000),
        "1h"  => Some(3_600_000),
        "6h"  => Some(21_600_000),
        "12h" => Some(43_200_000),
        "24h" => Some(86_400_000),
        "3d"  => Some(259_200_000),
        "7d"  => Some(604_800_000),
        "14d" => Some(1_209_600_000),
        "30d" => Some(2_592_000_000),
        "90d" => Some(7_776_000_000),
        _     => None,
    }
}

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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_message_id(channel_id: &str, username: &str) -> String {
    let rand: u32 = rand::random();
    format!("msg:{}:{}:{}:{:x}", username, channel_id, now_ms(), rand)
}

// ---------------------------------------------------------------------------
// Call helpers
// ---------------------------------------------------------------------------

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

fn is_stable_connected(connected: &HashMap<String, ConnectedUser>, stable_id: &str) -> bool {
    connected.values().any(|u| u.stable_id == stable_id)
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
