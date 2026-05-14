//! Socket.IO real-time layer (socketioxide 0.16)
//!
//! Implements the wabi-protocol event surface expected by the Svelte frontend.

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

async fn on_join(socket: SocketRef, username: String, state: SioState, io: SocketIo) {
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();

    let authed_username = if !token.is_empty() {
        username_from_token(&token, &state.app.config.jwt_secret)
            .unwrap_or_else(|| username.clone())
    } else {
        username.clone()
    };

    let user_id_num = if !token.is_empty() {
        user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1)
    } else {
        -1
    };

    // Check if banned
    if user_id_num > 0 {
        if let Ok(true) = state.app.stdb.is_user_banned(user_id_num).await {
            let _ = socket.emit("ban", &json!({ "reason": "You are banned from this server" }));
            return;
        }
    }

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    // Join a room named after stable_id so io.to(stable_id) routes here
    socket.join(stable_id.clone());

    let color = state
        .app
        .stdb
        .get_user(&authed_username)
        .await
        .ok()
        .and_then(|u| u.into_iter().next())
        .and_then(|r| r.get("color").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_else(|| "#98D8C8".to_string());

    let connected_user = ConnectedUser {
        stable_id: stable_id.clone(),
        db_user_id: if user_id_num > 0 {
            Some(user_id_num)
        } else {
            None
        },
        username: authed_username.clone(),
        color: color.clone(),
    };

    // Register in presence map
    {
        let mut connected = state.connected_users.write().await;
        connected.insert(socket.id.to_string(), connected_user.clone());
    }

    let owner_id = *state.app.owner_user_id.read().await;

    let server_members: Vec<Value> = state
        .app
        .stdb
        .get_all_users()
        .await
        .unwrap_or_default()
        .iter()
        .map(|row| row_to_user_view(row, owner_id))
        .collect();

    let online_users: Vec<Value> = {
        let connected = state.connected_users.read().await;
        connected.values().map(|u| connected_user_to_view(u, owner_id)).collect()
    };

    let channels: Vec<Value> = state
        .app
        .stdb
        .get_channels_raw()
        .await
        .unwrap_or_default()
        .iter()
        .map(row_to_channel_view)
        .collect();

    let init = json!({
        "channels": channels,
        "users": online_users,
        "serverMembers": server_members,
        "emotes": [],
        "emojis": [],
        "roleDefinitions": [],
        "voiceState": {},
        "messagePurgeVersion": 0,
        "session": { "sessionId": socket.id.to_string() },
    });

    if let Err(e) = socket.emit("init", &init) {
        warn!("[sio] init emit failed: {}", e);
    }

    // Broadcast arrival to all other connected sockets
    let user_view = connected_user_to_view(&connected_user, owner_id);
    let _ = socket.broadcast().emit("user-joined", &user_view).await;
    let _ = io; // keep io alive
}

async fn on_disconnect(socket: SocketRef, state: SioState, io: SocketIo) {
    let socket_id = socket.id.to_string();
    info!("[sio] disconnected: {}", socket_id);

    let departed = {
        let mut connected = state.connected_users.write().await;
        connected.remove(&socket_id)
    };

    if let Some(user) = &departed {
        let _ = io
            .emit(
                "user-left",
                &json!({
                    "id":       user.stable_id,
                    "dbUserId": user.db_user_id,
                    "username": user.username,
                }),
            )
            .await;
    }

    // Clean up voice channels
    let voice_lefts: Vec<(String, String)> = {
        let voice = state.voice_channels.read().await;
        voice
            .iter()
            .flat_map(|(ch, members)| {
                members
                    .iter()
                    .filter(|p| p.socket_id == socket_id)
                    .map(|p| (ch.clone(), p.stable_id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    };

    if !voice_lefts.is_empty() {
        let mut voice = state.voice_channels.write().await;
        for (channel_id, _) in &voice_lefts {
            if let Some(members) = voice.get_mut(channel_id) {
                members.retain(|p| p.socket_id != socket_id);
            }
        }
        drop(voice);
        for (channel_id, stable_id) in &voice_lefts {
            let _ = io
                .emit(
                    "voice-channel-left",
                    &json!({
                        "channelId": channel_id,
                        "userId":    stable_id,
                    }),
                )
                .await;
            let _ = io
                .emit(
                    "voice-channel-user-left",
                    &json!({
                        "channelId": channel_id,
                        "userId":    stable_id,
                        "socketId":  socket_id,
                    }),
                )
                .await;
        }
    }

    // Clean up group call sessions
    let departed_stable = departed
        .as_ref()
        .map(|u| u.stable_id.clone())
        .unwrap_or_else(|| socket_id.clone());
    let group_call_lefts: Vec<(String, Vec<String>)> = {
        let mut sessions = state.group_call_sessions.write().await;
        let mut lefts = Vec::new();
        let mut to_remove = Vec::new();

        for (channel_id, session) in sessions.iter_mut() {
            let was_in = session.connected_participants.remove(&departed_stable)
                || session.invited_participants.remove(&departed_stable);
            if !was_in {
                continue;
            }

            let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();
            lefts.push((channel_id.clone(), recipients));

            if session.connected_participants.is_empty() {
                to_remove.push(channel_id.clone());
            }
        }
        for ch in to_remove {
            sessions.remove(&ch);
        }
        lefts
    };

    for (channel_id, recipients) in group_call_lefts {
        for recipient_id in recipients {
            let _ = io
                .to(recipient_id)
                .emit(
                    "group-call-participant-left",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": departed_stable,
                        "userId": socket_id
                    }),
                )
                .await;
        }
    }

    // Broadcast call-ended so DM call partners can clean up
    let _ = io
        .emit("call-ended", &json!({ "userId": departed_stable }))
        .await;
}

async fn on_join_channel(socket: SocketRef, channel_id: String, state: SioState) {
    // Get user ID from socket token
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id = if !token.is_empty() {
        user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1)
    } else {
        -1
    };

    // Check channel minRole requirement
    if let Ok(channels) = state.app.stdb.get_channels_raw().await {
        if let Some(channel) = channels.iter().find(|ch| ch.get("channel_id").and_then(|v| v.as_str()) == Some(&channel_id)) {
            if let Some(min_role_str) = channel.get("min_role").and_then(|v| v.as_str()) {
                let user_role = state.app.get_user_highest_role(user_id).await;
                // Simple role check: "guest" < "member" < "admin" < "owner"
                let role_priority = |r: &str| match r {
                    "owner" => 3,
                    "admin" => 2,
                    "member" => 1,
                    _ => 0,
                };
                if role_priority(&user_role) < role_priority(min_role_str) {
                    warn!("[sio] user {} blocked from channel {}: requires {}, has {}", user_id, channel_id, min_role_str, user_role);
                    return;
                }
            }
        }
    }

    socket.join(channel_id.clone());

    let stdb_msgs: Vec<Value> = state
        .app
        .stdb
        .get_messages_raw(&channel_id, 50)
        .await
        .unwrap_or_default()
        .iter()
        .map(row_to_message_view)
        .collect();

    let session = state.app.session_messages.read().await;
    let session_msgs = session.get(&channel_id).cloned().unwrap_or_default();
    drop(session);

    let stdb_ids: HashSet<String> = stdb_msgs
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let mut all: Vec<Value> = stdb_msgs;
    for msg in session_msgs {
        let id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !stdb_ids.contains(&id) {
            all.push(msg);
        }
    }
    all.sort_by_key(|m| m.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0));

    let payload = json!({ "channelId": channel_id, "messages": all, "hasMore": false });
    if let Err(e) = socket.emit("channel-messages", &payload) {
        warn!("[sio] channel-messages failed: {}", e);
    }
}

async fn on_message(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            warn!("[sio] message missing channelId");
            return;
        }
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let username = username_from_token(&token, &state.app.config.jwt_secret)
        .unwrap_or_else(|| "unknown".to_string());
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    // Check if user is muted
    if user_id_num > 0 {
        if let Ok(true) = state.app.stdb.is_user_muted(user_id_num, Some(&channel_id)).await {
            warn!("[sio] user {} muted in channel {}", user_id_num, channel_id);
            return;
        }
    }
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let color = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.color.clone())
            .unwrap_or_else(|| "#98D8C8".to_string())
    };

    let message_id = new_message_id(&channel_id, &username);
    let timestamp = now_ms();
    let client_message_id = cmd
        .get("clientMessageId")
        .and_then(|v| v.as_str())
        .map(String::from);

    let message_view = json!({
        "id":             message_id.clone(),
        "user":           username,
        "userId":         stable_id.clone(),
        "senderStableId": stable_id,
        "color":          color,
        "text":           cmd.get("text").and_then(|v| v.as_str()).unwrap_or(""),
        "timestamp":      timestamp,
        "type":           cmd.get("type").and_then(|v| v.as_str()).unwrap_or("text"),
        "clientMessageId": client_message_id.clone(),
        "encrypted":      cmd.get("encrypted"),
        "iv":             cmd.get("iv"),
        "isSpoiler":      cmd.get("isSpoiler"),
        "replyTo":        cmd.get("replyTo"),
        "gifUrl":         cmd.get("gifUrl"),
    });

    {
        let mut session = state.app.session_messages.write().await;
        let msgs = session.entry(channel_id.clone()).or_default();
        msgs.push(message_view.clone());
        if msgs.len() > 1000 {
            msgs.drain(0..msgs.len() - 1000);
        }
    }

    if user_id_num > 0 {
        if let Err(e) = state
            .app
            .stdb
            .upsert_message(
                &message_id,
                &channel_id,
                user_id_num,
                &username,
                cmd.get("text").and_then(|v| v.as_str()).unwrap_or(""),
                timestamp,
            )
            .await
        {
            warn!("Failed to persist message to STDB: {}", e);
        }

        // Schedule message deletion if channel has retention set
        if let Ok(Some(duration)) = state.app.stdb.get_channel_retention(&channel_id).await {
            if let Some(ms) = retention_to_ms(&duration) {
                let stdb = state.app.stdb.clone();
                let msg_id = message_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    let _ = stdb.delete_message(&msg_id).await;
                });
            }
        }
    }

    let _ = socket.emit(
        "message-accepted",
        &json!({
            "channelId":      channel_id,
            "messageId":      message_id,
            "clientMessageId": client_message_id,
            "timestamp":      timestamp,
        }),
    );

    let _ = io
        .to(channel_id)
        .emit(
            "message",
            &json!({
                "channelId": cmd.get("channelId"),
                "message":   message_view,
            }),
        )
        .await;
}

async fn on_load_history(socket: SocketRef, req: Value, state: SioState) {
    let channel_id = match req.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let limit = req
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(50)
        .min(100) as u32;

    let messages: Vec<Value> = state
        .app
        .stdb
        .get_messages_raw(&channel_id, limit)
        .await
        .unwrap_or_default()
        .iter()
        .map(row_to_message_view)
        .collect();

    let _ = socket.emit(
        "history-loaded",
        &json!({
            "channelId": channel_id,
            "messages":  messages,
            "hasMore":   false,
            "direction": req.get("direction").unwrap_or(&json!("before")),
            "requestId": req.get("requestId"),
        }),
    );
}

async fn on_delete_message(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let message_id = match cmd.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Auth check — must have a real user account (not guest)
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id <= 0 {
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Guests cannot delete messages"}));
        return;
    }

    // Check if user owns the message (or is admin)
    let is_admin = state.app.is_admin(user_id).await;
    if !is_admin {
        match state.app.stdb.get_message_sender(&message_id).await {
            Ok(Some(sender_id)) => {
                let user_stable_id = format!("user-{}", user_id);
                if sender_id != user_stable_id {
                    warn!("[sio] delete-message: user {} not authorized to delete message {} (owned by {})", user_id, message_id, sender_id);
                    let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Cannot delete others' messages"}));
                    return;
                }
            }
            Err(e) => {
                warn!("Failed to check message ownership: {}", e);
                let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Database error"}));
                return;
            }
            Ok(None) => {
                warn!("[sio] delete-message: message {} not found", message_id);
                let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Message not found"}));
                return;
            }
        }
    }

    // Remove from session cache
    {
        let mut session = state.app.session_messages.write().await;
        if let Some(msgs) = session.get_mut(&channel_id) {
            msgs.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(&message_id));
        }
    }

    // Persist deletion to SpacetimeDB
    if let Err(e) = state.app.stdb.delete_message(&message_id).await {
        warn!("Failed to delete message {}: {}", message_id, e);
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Database error"}));
        return;
    }

    // Acknowledge to sender
    let _ = socket.emit("message-deleted", &json!({"channelId": channel_id, "messageId": message_id}));

    // Broadcast deletion to channel
    let _ = io.to(channel_id.clone()).emit(
        "message-deleted",
        &json!({"channelId": channel_id, "messageId": message_id}),
    ).await;
}

async fn on_typing(socket: SocketRef, data: Value, state: SioState) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let username = username_from_token(&token, &state.app.config.jwt_secret).unwrap_or_default();
    let _ = socket
        .broadcast()
        .to(channel_id.clone())
        .emit(
            "typing",
            &json!({ "channelId": channel_id, "usernames": [username] }),
        )
        .await;
}

async fn on_voice_channel_join(socket: SocketRef, data: Value, state: SioState, _io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    // Check if user is muted on this voice channel
    if user_id_num > 0 {
        if let Ok(true) = state.app.stdb.is_user_muted(user_id_num, Some(&channel_id)).await {
            warn!("[sio] user {} muted in voice channel {}", user_id_num, channel_id);
            let _ = socket.emit("voice-channel-error", &json!({ "channelId": channel_id, "error": "You are muted in this channel" }));
            return;
        }
    }

    let is_deafened = if user_id_num > 0 {
        state.app.stdb.is_user_deafened(user_id_num, Some(&channel_id)).await.unwrap_or(false)
    } else {
        false
    };

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let (username, color) = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| (u.username.clone(), u.color.clone()))
            .unwrap_or_else(|| ("unknown".to_string(), "#98D8C8".to_string()))
    };

    let participant = VoiceParticipant {
        socket_id: socket.id.to_string(),
        stable_id: stable_id.clone(),
        username: username.clone(),
        color: color.clone(),
        is_deafened,
    };

    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        let members = voice.entry(channel_id.clone()).or_default();
        members.retain(|p| p.socket_id != socket.id.to_string());
        members.push(participant.clone());
        members.iter().map(voice_participant_to_view).collect()
    };

    let _ = socket.emit(
        "voice-channel-state",
        &json!({
            "channelId": channel_id,
            "members":   current_members,
        }),
    );

    let participant_view = voice_participant_to_view(&participant);

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-joined",
            &json!({
                "channelId": channel_id,
                "user":      participant_view,
            }),
        )
        .await;

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-user-joined",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
                "socketId":  socket.id.to_string(),
                "username":  username,
            }),
        )
        .await;
}

async fn on_voice_channel_leave(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            members.retain(|p| p.socket_id != socket.id.to_string());
        }
    }

    let _ = io
        .emit(
            "voice-channel-left",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
            }),
        )
        .await;

    let _ = io
        .emit(
            "voice-channel-user-left",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
                "socketId":  socket.id.to_string(),
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Call lifecycle handlers
// ---------------------------------------------------------------------------

async fn on_call_initiate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };
    let is_video_call = data
        .get("isVideoCall")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // Group call
        let channels = state.app.stdb.get_channels_raw().await.unwrap_or_default();
        let channel_opt = channels.iter().find(|c| {
            c.get("channel_id")
                .or_else(|| c.get("id"))
                .and_then(|v| v.as_str())
                == Some(channel_id.as_str())
        });

        let (channel_name, channel_members) = match channel_opt {
            Some(c) => {
                let name = c
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let members: Vec<String> = c
                    .get("members")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (name, members)
            }
            None => {
                let _ = socket.emit(
                    "call-error",
                    &json!({
                        "code": "invalid_channel",
                        "message": "Group channel not found",
                        "targetUserId": channel_id
                    }),
                );
                return;
            }
        };

        if !channel_members.is_empty() && !channel_members.contains(&my_stable_id) {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "not_group_member",
                    "message": "You are not a member of this group",
                    "targetUserId": channel_id
                }),
            );
            return;
        }

        let connected_snapshot: HashMap<String, ConnectedUser> = {
            let connected = state.connected_users.read().await;
            connected.clone()
        };

        let (invitees, is_video, ch_name) = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = sessions
                .entry(channel_id.clone())
                .or_insert_with(|| GroupCallSession {
                    channel_id: channel_id.clone(),
                    channel_name: channel_name.clone(),
                    initiator_stable_id: my_stable_id.clone(),
                    is_video_call,
                    has_ever_established: false,
                    last_invite_sender_id: socket.id.to_string(),
                    invited_participants: HashSet::new(),
                    connected_participants: HashSet::new(),
                });

            session.channel_name = channel_name.clone();
            if session.connected_participants.is_empty() {
                session.initiator_stable_id = my_stable_id.clone();
            }
            if !session.has_ever_established {
                session.is_video_call = is_video_call;
            }

            session.invited_participants.remove(&my_stable_id);
            if !session.connected_participants.contains(&my_stable_id) {
                session.connected_participants.insert(my_stable_id.clone());
                if session.connected_participants.len() > 1 {
                    session.has_ever_established = true;
                }
            }

            let invitees: Vec<String> = if channel_members.is_empty() {
                connected_snapshot
                    .values()
                    .filter(|u| {
                        u.stable_id != my_stable_id
                            && !session.connected_participants.contains(&u.stable_id)
                            && !session.invited_participants.contains(&u.stable_id)
                    })
                    .map(|u| u.stable_id.clone())
                    .collect()
            } else {
                channel_members
                    .iter()
                    .filter(|id| {
                        *id != &my_stable_id
                            && !session.connected_participants.contains(*id)
                            && !session.invited_participants.contains(*id)
                            && is_stable_connected(&connected_snapshot, id)
                    })
                    .cloned()
                    .collect()
            };

            if invitees.is_empty()
                && session.connected_participants.len() == 1
                && session.invited_participants.is_empty()
            {
                sessions.remove(&channel_id);
                drop(sessions);
                let _ = socket.emit(
                    "call-error",
                    &json!({
                        "code": "target_unavailable",
                        "message": "No group members are currently connected",
                        "targetUserId": channel_id
                    }),
                );
                return;
            }

            for id in &invitees {
                session.invited_participants.insert(id.clone());
            }
            if !invitees.is_empty() {
                session.last_invite_sender_id = socket.id.to_string();
            }

            (
                invitees,
                session.is_video_call,
                session.channel_name.clone(),
            )
        };

        for invitee_id in invitees {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-incoming",
                    &json!({
                        "userId": my_stable_id,
                        "username": my_username,
                        "isVideoCall": is_video,
                        "channelId": channel_id,
                        "channelName": ch_name
                    }),
                )
                .await;
        }
    } else if let Some(target_id) = data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call
        let is_connected = {
            let connected = state.connected_users.read().await;
            is_stable_connected(&connected, &target_id)
        };

        if !is_connected {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "target_unavailable",
                    "message": "Target user is not currently connected",
                    "targetUserId": target_id
                }),
            );
            return;
        }

        if target_id == my_stable_id {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "self_call",
                    "message": "You cannot call yourself",
                    "targetUserId": target_id
                }),
            );
            return;
        }

        let _ = io
            .to(target_id)
            .emit(
                "call-incoming",
                &json!({
                    "userId": my_stable_id,
                    "username": my_username,
                    "isVideoCall": is_video_call
                }),
            )
            .await;
    }
}

async fn on_call_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };
    let is_video_call = data
        .get("isVideoCall")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // Group call answer
        let (existing_connected, ch_name) = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => {
                    drop(sessions);
                    let _ = socket.emit(
                        "call-error",
                        &json!({
                            "code": "caller_unavailable",
                            "message": "Group call is no longer available",
                            "targetUserId": channel_id
                        }),
                    );
                    return;
                }
            };

            session.invited_participants.remove(&my_stable_id);
            if !session.connected_participants.contains(&my_stable_id) {
                session.connected_participants.insert(my_stable_id.clone());
                if session.connected_participants.len() > 1 {
                    session.has_ever_established = true;
                }
            }

            let existing: Vec<String> = session
                .connected_participants
                .iter()
                .filter(|id| *id != &my_stable_id)
                .cloned()
                .collect();
            (existing, session.channel_name.clone())
        };

        for existing_id in existing_connected {
            let _ = io
                .to(existing_id)
                .emit(
                    "group-call-participant-joined",
                    &json!({
                        "channelId": channel_id,
                        "channelName": ch_name,
                        "stableUserId": my_stable_id,
                        "userId": my_stable_id,
                        "username": my_username
                    }),
                )
                .await;
        }
    } else if let Some(caller_id) = data
        .get("callerId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call answer
        let is_connected = {
            let connected = state.connected_users.read().await;
            is_stable_connected(&connected, &caller_id)
        };

        if !is_connected {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "caller_unavailable",
                    "message": "Caller disconnected before the call was answered",
                    "targetUserId": caller_id
                }),
            );
            return;
        }

        let _ = io
            .to(caller_id)
            .emit(
                "call-accepted",
                &json!({
                    "userId": my_stable_id,
                    "username": my_username,
                    "isVideoCall": is_video_call
                }),
            )
            .await;
    }
}

async fn on_call_reject(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // Group call reject
        let (recipients, username) = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => return,
            };

            if !session.invited_participants.remove(&my_stable_id) {
                return;
            }

            let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();

            let should_cleanup = session.connected_participants.is_empty()
                || (session.connected_participants.len() == 1
                    && session.invited_participants.is_empty()
                    && !session.has_ever_established);
            if should_cleanup {
                sessions.remove(&channel_id);
            }

            (recipients, my_stable_id.clone())
        };

        let display_name = {
            let connected = state.connected_users.read().await;
            connected
                .values()
                .find(|u| u.stable_id == my_stable_id)
                .map(|u| u.username.clone())
                .unwrap_or_else(|| username.clone())
        };

        for recipient_id in recipients {
            let _ = io
                .to(recipient_id)
                .emit(
                    "group-call-invite-cleared",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": my_stable_id,
                        "username": display_name,
                        "reason": "rejected"
                    }),
                )
                .await;
        }
    } else if let Some(caller_id) = data
        .get("callerId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call reject
        let _ = io
            .to(caller_id)
            .emit(
                "call-rejected",
                &json!({
                    "userId": my_stable_id
                }),
            )
            .await;
    }
}

async fn on_call_cancel(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // Group call cancel (only valid before call is established)
        let invitees_to_cancel = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => return,
            };

            if !session.connected_participants.contains(&my_stable_id) {
                return;
            }
            if session.connected_participants.len() > 1 {
                return;
            }

            let invitees: Vec<String> = session.invited_participants.iter().cloned().collect();
            sessions.remove(&channel_id);
            invitees
        };

        for invitee_id in invitees_to_cancel {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-cancelled",
                    &json!({
                        "userId": socket.id.to_string(),
                        "channelId": channel_id
                    }),
                )
                .await;
        }
    } else if let Some(target_id) = data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call cancel
        let _ = io
            .to(target_id)
            .emit(
                "call-cancelled",
                &json!({
                    "userId": my_stable_id
                }),
            )
            .await;
    }
}

async fn on_call_end(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let participant_ids: Vec<String> = data
        .get("participants")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if !participant_ids.is_empty() {
        for participant_id in participant_ids {
            let _ = io
                .to(participant_id)
                .emit("call-ended", &json!({ "userId": my_stable_id }))
                .await;
        }
    } else {
        let _ = socket
            .broadcast()
            .emit("call-ended", &json!({ "userId": my_stable_id }))
            .await;
    }
}

async fn on_group_call_leave(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let channel_id = match data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };

    let (was_connected, recipients, pending_cancel) = {
        let mut sessions = state.group_call_sessions.write().await;
        let session = match sessions.get_mut(&channel_id) {
            Some(s) => s,
            None => return,
        };

        let was_invited = session.invited_participants.remove(&my_stable_id);
        let was_connected = session.connected_participants.remove(&my_stable_id);

        if !was_invited && !was_connected {
            return;
        }

        let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();

        let should_cleanup = session.connected_participants.is_empty()
            || (session.connected_participants.len() == 1
                && session.invited_participants.is_empty()
                && !session.has_ever_established);

        let pending = if should_cleanup && !session.invited_participants.is_empty() {
            let inv: Vec<String> = session.invited_participants.iter().cloned().collect();
            let sender = session.last_invite_sender_id.clone();
            Some((inv, sender))
        } else {
            None
        };

        if should_cleanup {
            sessions.remove(&channel_id);
        }

        (was_connected, recipients, pending)
    };

    if was_connected {
        for recipient_id in &recipients {
            let _ = io
                .to(recipient_id.clone())
                .emit(
                    "group-call-participant-left",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": my_stable_id,
                        "userId": socket.id.to_string()
                    }),
                )
                .await;
        }
    }

    if let Some((invitees, canceller_id)) = pending_cancel {
        for invitee_id in invitees {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-cancelled",
                    &json!({
                        "userId": canceller_id,
                        "channelId": channel_id
                    }),
                )
                .await;
        }
    }
}

async fn on_group_call_stop_ringing(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let channel_id = match data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };
    let target_user_id = match data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };

    let (recipients, socket_id) = {
        let mut sessions = state.group_call_sessions.write().await;
        let session = match sessions.get_mut(&channel_id) {
            Some(s) => s,
            None => return,
        };

        if !session.connected_participants.contains(&my_stable_id) {
            return;
        }
        if !session.invited_participants.remove(&target_user_id) {
            return;
        }

        let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();
        (recipients, socket.id.to_string())
    };

    let _ = io
        .to(target_user_id.clone())
        .emit(
            "call-cancelled",
            &json!({
                "userId": socket_id,
                "channelId": channel_id
            }),
        )
        .await;

    let display_name = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == target_user_id)
            .map(|u| u.username.clone())
            .unwrap_or_else(|| target_user_id.clone())
    };

    for recipient_id in recipients {
        let _ = io
            .to(recipient_id)
            .emit(
                "group-call-invite-cleared",
                &json!({
                    "channelId": channel_id,
                    "stableUserId": target_user_id,
                    "username": display_name,
                    "reason": "stopped"
                }),
            )
            .await;
    }
}

// ---------------------------------------------------------------------------
// DM / group management handlers
// ---------------------------------------------------------------------------

async fn on_create_dm(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    // Auth check — guests cannot create DMs
    if my_user_id <= 0 {
        let _ = socket.emit("dm-error", &json!({ "error": "Guests cannot create DMs" }));
        return;
    }

    // Build stable DM channel id: dm-sorted-member1-sorted-member2
    let my_stable_id = format!("user-{}", my_user_id);

    // Sort the two IDs to get a canonical channel id regardless of who initiates
    let member_ids = [my_stable_id.clone(), target_user_id.clone()];
    let mut sorted = member_ids.to_vec();
    sorted.sort();
    let channel_id = format!("dm-{}", sorted.join("-"));

    // Check if DM already exists in channel list
    let existing = state.app.stdb.get_channels_raw().await.unwrap_or_default();
    if existing.iter().any(|c| {
        c.get("channel_id")
            .or_else(|| c.get("id"))
            .and_then(|v| v.as_str()) == Some(&channel_id)
    }) {
        let _ = socket.emit("dm-error", &json!({ "error": "DM already exists", "channelId": channel_id }));
        return;
    }

    // Resolve target user info for the event payload
    let target_username = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == target_user_id || u.stable_id == format!("user-{}", target_user_id))
            .map(|u| u.username.clone())
            .unwrap_or_else(|| target_user_id.clone())
    };

    // Persist DM channel to STDB
    if let Err(e) = state
        .app
        .stdb
        .create_dm_channel(&channel_id, &format!("DM with {}", target_username), &sorted, my_user_id)
        .await
    {
        warn!("[sio] create-dm: failed to create channel {}: {}", channel_id, e);
        let _ = socket.emit("dm-error", &json!({ "error": "Failed to create DM", "channelId": channel_id }));
        return;
    }

    let dm_event = json!({
        "channelId": channel_id,
        "otherUser": {
            "id": target_user_id,
            "username": target_username,
            "color": "#98D8C8",
        }
    });

    // Emit dm-created to the initiating socket
    let _ = socket.emit("dm-created", &dm_event);
    // Broadcast dm-channel-added to all other clients
    let _ = io.broadcast().emit("dm-channel-added", &dm_event).await;
}

async fn on_delete_dm(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    if !channel_id.starts_with("dm-") {
        let _ = socket.emit("dm-error", &json!({ "error": "Not a DM channel", "channelId": channel_id }));
        return;
    }

    // Auth check
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if my_user_id <= 0 {
        let _ = socket.emit("dm-error", &json!({ "error": "Guests cannot delete DMs", "channelId": channel_id }));
        return;
    }

    // Persist deletion to STDB
    if let Err(e) = state.app.stdb.delete_dm_channel(&channel_id).await {
        warn!("[sio] delete-dm: failed to delete channel {}: {}", channel_id, e);
        let _ = socket.emit("dm-error", &json!({ "error": "Failed to delete DM", "channelId": channel_id }));
        return;
    }

    let _ = socket.emit("dm-deleted", &json!({ "channelId": channel_id }));
    let _ = io.broadcast().emit("dm-deleted", &json!({ "channelId": channel_id })).await;
}

async fn on_ban_user(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("ban-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("ban-error", &json!({ "error": "Only admins can ban users" }));
        return;
    }

    let reason = data.get("reason").and_then(|v| v.as_str());

    // Disconnect the target if connected, then broadcast
    let target_stable_id = format!("user-{}", target_user_id);
    let mut disconnected_socket_id = None;

    {
        let mut connected = state.connected_users.write().await;
        for (sid, user) in connected.iter_mut() {
            if user.stable_id == target_stable_id {
                disconnected_socket_id = Some(sid.clone());
                break;
            }
        }
    }

    if let Some(sid) = disconnected_socket_id {
        // Emit ban to the target socket forcing disconnect
        let _ = io
            .to(sid.clone())
            .emit("ban", &json!({ "reason": reason }))
            .await;
    }

    // Broadcast user-banned event
    let _ = io
        .broadcast()
        .emit(
            "user-banned",
            &json!({
                "userId": target_stable_id,
                "dbUserId": target_user_id,
                "reason": reason
            }),
        )
        .await;
}

async fn on_voice_mute(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-mute-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-mute-error", &json!({ "error": "Only admins can mute users" }));
        return;
    }

    // Mute the user on this channel
    if let Err(e) = state.app.stdb.mute_user(target_user_id, Some(&channel_id), my_user_id).await {
        warn!("[sio] voice-mute: failed to mute user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-mute-error", &json!({ "error": "Failed to mute user" }));
        return;
    }

    // Kick the user from the voice channel if connected
    let target_stable_id = format!("user-{}", target_user_id);
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            members.retain(|p| p.stable_id != target_stable_id);
        }
    }

    // Broadcast voice-user-muted event
    let _ = io
        .broadcast()
        .emit(
            "voice-user-muted",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_voice_unmute(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-unmute-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-unmute-error", &json!({ "error": "Only admins can unmute users" }));
        return;
    }

    // Unmute the user on this channel
    if let Err(e) = state.app.stdb.unmute_user(target_user_id, Some(&channel_id)).await {
        warn!("[sio] voice-unmute: failed to unmute user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-unmute-error", &json!({ "error": "Failed to unmute user" }));
        return;
    }

    // Broadcast voice-user-unmuted event
    let target_stable_id = format!("user-{}", target_user_id);
    let _ = io
        .broadcast()
        .emit(
            "voice-user-unmuted",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_voice_deafen(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-deafen-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-deafen-error", &json!({ "error": "Only admins can deafen users" }));
        return;
    }

    // Deafen the user on this channel
    if let Err(e) = state.app.stdb.deafen_user(target_user_id, Some(&channel_id), my_user_id).await {
        warn!("[sio] voice-deafen: failed to deafen user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-deafen-error", &json!({ "error": "Failed to deafen user" }));
        return;
    }

    // Update the participant's is_deafened flag if they're in the voice channel
    let target_stable_id = format!("user-{}", target_user_id);
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            if let Some(participant) = members.iter_mut().find(|p| p.stable_id == target_stable_id) {
                participant.is_deafened = true;
            }
        }
    }

    // Broadcast voice-user-deafened event
    let _ = io
        .broadcast()
        .emit(
            "voice-user-deafened",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_voice_undeafen(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Only admins can undeafen users" }));
        return;
    }

    // Undeafen the user on this channel
    if let Err(e) = state.app.stdb.undeafen_user(target_user_id, Some(&channel_id)).await {
        warn!("[sio] voice-undeafen: failed to undeafen user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Failed to undeafen user" }));
        return;
    }

    // Update the participant's is_deafened flag if they're in the voice channel
    let target_stable_id = format!("user-{}", target_user_id);
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            if let Some(participant) = members.iter_mut().find(|p| p.stable_id == target_stable_id) {
                participant.is_deafened = false;
            }
        }
    }

    // Broadcast voice-user-undeafened event
    let target_stable_id = format!("user-{}", target_user_id);
    let _ = io
        .broadcast()
        .emit(
            "voice-user-undeafened",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_kick_group_member(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Auth check — must be channel admin or server admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if my_user_id <= 0 {
        let _ = socket.emit("kick-error", &json!({ "error": "Guests cannot kick members" }));
        return;
    }

    // Check if server admin or has channel admin role
    let is_server_admin = state.app.is_admin(my_user_id).await;
    if !is_server_admin {
        // TODO: check channel-specific admin role
    }

    // Broadcast group-member-removed
    let _ = io
        .broadcast()
        .emit(
            "group-member-removed",
            &json!({
                "channelId": channel_id,
                "userId": target_user_id,
            }),
        )
        .await;
}

async fn on_leave_group(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    let stable_id = if my_user_id > 0 {
        format!("user-{}", my_user_id)
    } else {
        socket.id.to_string()
    };

    // Broadcast group-removed to all members (the leaving user is leaving the group)
    let _ = io
        .to(channel_id.clone())
        .emit(
            "group-removed",
            &json!({ "channelId": channel_id }),
        )
        .await;

    let _ = io
        .broadcast()
        .emit(
            "group-member-removed",
            &json!({
                "channelId": channel_id,
                "userId": stable_id,
            }),
        )
        .await;
}

async fn on_add_group_member(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let user_id = match data.get("userId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("add-member-error", &json!({ "error": "Only admins can add members" }));
        return;
    }

    // Resolve user info for the event
    let (username, color) = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == user_id || u.stable_id == format!("user-{}", user_id))
            .map(|u| (u.username.clone(), u.color.clone()))
            .unwrap_or_else(|| (user_id.clone(), "#98D8C8".to_string()))
    };

    let _ = io
        .broadcast()
        .emit(
            "group-member-added",
            &json!({
                "channelId": channel_id,
                "userId": user_id,
                "user": {
                    "id": user_id,
                    "username": username,
                    "color": color,
                }
            }),
        )
        .await;
}

async fn on_update_group_avatar(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let avatar_url = data.get("avatarUrl").and_then(|v| v.as_str()).map(String::from);

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("avatar-error", &json!({ "error": "Only admins can update avatars" }));
        return;
    }

    // Persist avatar update to STDB via upsert_group
    if let Err(e) = state
        .app
        .stdb
        .upsert_group(&channel_id, "", "group", None, avatar_url.as_deref(), None)
        .await
    {
        warn!("[sio] update-group-avatar: failed to update avatar for {}: {}", channel_id, e);
        let _ = socket.emit("avatar-error", &json!({ "error": "Failed to update avatar" }));
        return;
    }

    // Broadcast group-avatar-updated
    let _ = io
        .broadcast()
        .emit(
            "group-avatar-updated",
            &json!({
                "channelId": channel_id,
                "avatar": avatar_url,
            }),
        )
        .await;
}

async fn on_edit_message(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let new_text = match data.get("newText").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return,
    };

    // Auth check — must have a real user account
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if my_user_id <= 0 {
        let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Guests cannot edit messages" }));
        return;
    }

    // Check if user owns the message (or is admin)
    let is_admin = state.app.is_admin(my_user_id).await;
    if !is_admin {
        match state.app.stdb.get_message_sender(&message_id).await {
            Ok(Some(sender_id)) => {
                let user_stable_id = format!("user-{}", my_user_id);
                if sender_id != user_stable_id {
                    warn!("[sio] edit-message: user {} not authorized to edit message {} (owned by {})", my_user_id, message_id, sender_id);
                    let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Cannot edit others' messages" }));
                    return;
                }
            }
            Err(e) => {
                warn!("Failed to check message ownership: {}", e);
                let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Database error" }));
                return;
            }
            Ok(None) => {
                warn!("[sio] edit-message: message {} not found", message_id);
                let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Message not found" }));
                return;
            }
        }
    }

    // Persist edit to STDB
    if let Err(e) = state.app.stdb.edit_message(&message_id, &new_text).await {
        warn!("[sio] edit-message: failed to edit message {}: {}", message_id, e);
        let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Database error" }));
        return;
    }

    // Broadcast message-edited to all clients in the channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "message-edited",
            &json!({
                "channelId": channel_id,
                "messageId": message_id,
                "newText": new_text,
            }),
        )
        .await;
}

async fn on_join_stdb_call(socket: SocketRef, data: Value, io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let room_id = format!("stdb-call-{}", session_id);
    let _ = socket.join(room_id.clone());
    info!("[sio] Socket {} joined STDB call room {}", socket.id, room_id);
}

async fn on_stdb_media(socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let _user_id = match data.get("userId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Payload is the encoded audio (ArrayBuffer from frontend)
    // In socketioxide, binary data arrives in `data` — we'll relay it as-is
    let payload = data.clone();

    // Broadcast stdb-media to all participants in this STDB call session (except sender)
    // Using Socket.IO rooms: join participants in "stdb-call-{sessionId}" room on call start
    let room_id = format!("stdb-call-{}", session_id);
    let _ = io
        .to(room_id)
        .except(socket.id.clone())
        .emit("stdb-media", &payload)
        .await;
}

async fn on_add_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let emoji_id = match data.get("emojiId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id_num <= 0 {
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Guests cannot react" }));
        return;
    }

    // Store the reaction
    if let Err(e) = state.app.stdb.add_reaction(&message_id, &channel_id, user_id_num, &emoji_id).await {
        warn!("[sio] add-emoji-reaction: failed to add reaction: {}", e);
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Failed to add reaction" }));
        return;
    }

    // Check if there's an emoji role rule for this emoji/message
    if let Ok(rules) = state.app.stdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            if let Some(rule_emoji) = rule.get("emojiId").and_then(|v| v.as_str()) {
                if rule_emoji == emoji_id {
                    if let Some(role_name) = rule.get("roleName").and_then(|v| v.as_str()) {
                        // Assign the role to the user
                        let _ = state.app.stdb.ingest_event("rbac", "assign_role", &json!({
                            "userId": user_id_num,
                            "workspaceId": "default-workspace",
                            "role": role_name,
                            "assignedBy": 0,
                        })).await;
                    }
                }
            }
        }
    }

    // Broadcast reaction to channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "emoji-reaction-added",
            &json!({
                "messageId": message_id,
                "userId": user_id_num,
                "emojiId": emoji_id,
            }),
        )
        .await;
}

async fn on_remove_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let emoji_id = match data.get("emojiId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id_num <= 0 {
        return;
    }

    // Remove the reaction
    if let Err(e) = state.app.stdb.remove_reaction(&message_id, user_id_num, &emoji_id).await {
        warn!("[sio] remove-emoji-reaction: failed to remove reaction: {}", e);
        return;
    }

    // Check if there's an emoji role rule with removeOnUnreact flag
    if let Ok(rules) = state.app.stdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            if let Some(rule_emoji) = rule.get("emojiId").and_then(|v| v.as_str()) {
                if rule_emoji == emoji_id {
                    if let Some(true) = rule.get("removeOnUnreact").and_then(|v| v.as_bool()) {
                        if let Some(role_name) = rule.get("roleName").and_then(|v| v.as_str()) {
                            // Remove the role from the user
                            let _ = state.app.stdb.ingest_event("rbac", "remove_role", &json!({
                                "userId": user_id_num,
                                "workspaceId": "default-workspace",
                                "role": role_name,
                            })).await;
                        }
                    }
                }
            }
        }
    }

    // Broadcast reaction removal to channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "emoji-reaction-removed",
            &json!({
                "messageId": message_id,
                "userId": user_id_num,
                "emojiId": emoji_id,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

async fn on_call_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let target_id = match data
        .get("targetId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(o) => o.clone(),
        None => return,
    };
    let channel_id_opt = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(ref channel_id) = channel_id_opt {
        let channels = state.app.stdb.get_channels_raw().await.unwrap_or_default();
        let channel = channels.iter().find(|c| {
            c.get("channel_id")
                .or_else(|| c.get("id"))
                .and_then(|v| v.as_str())
                == Some(channel_id.as_str())
        });

        match channel {
            Some(c) => {
                let ch_type = c
                    .get("channel_type")
                    .or_else(|| c.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if ch_type == "voice" {
                    let voice = state.voice_channels.read().await;
                    let members = voice.get(channel_id);
                    let sender_in = members
                        .map(|m| m.iter().any(|p| p.socket_id == socket.id.to_string()))
                        .unwrap_or(false);
                    let target_in = members
                        .map(|m| {
                            m.iter()
                                .any(|p| p.socket_id == target_id || p.stable_id == target_id)
                        })
                        .unwrap_or(false);
                    if !sender_in || !target_in {
                        return;
                    }
                } else if ch_type == "group" {
                    let sessions = state.group_call_sessions.read().await;
                    let session = match sessions.get(channel_id) {
                        Some(s) => s,
                        None => return,
                    };
                    if !session.connected_participants.contains(&my_stable_id)
                        || !session.connected_participants.contains(&target_id)
                    {
                        return;
                    }
                } else {
                    return;
                }
            }
            None => return,
        }
    }

    let _ = io
        .to(target_id)
        .emit(
            "call-offer",
            &json!({
                "offer":     offer,
                "senderId":  my_stable_id,
                "username":  my_username,
                "channelId": channel_id_opt
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

pub fn create_socket_layer(app: Arc<AppState>) -> SocketIoLayer {
    let app_for_broadcast = app.clone();
    let state = SioState {
        app,
        connected_users: Arc::new(RwLock::new(HashMap::new())),
        voice_channels: Arc::new(RwLock::new(HashMap::new())),
        group_call_sessions: Arc::new(RwLock::new(HashMap::new())),
    };

    let (layer, io) = SocketIo::builder().with_state(state).build_layer();

    // Share the SocketIo handle with HTTP handlers so they can emit broadcast events
    let _ = app_for_broadcast.sio_broadcast_tx.send(io.clone());

    io.ns(
        "/",
        |socket: SocketRef,
         Data(auth): Data<Value>,
         State(state): State<SioState>,
         io: SocketIo| {
            info!("[sio] connected: {}", socket.id);

            let token = auth
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            socket.extensions.insert(AuthToken(token));

            socket.on("join", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(username): Data<String>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_join(socket, username, s, io).await }
                }
            });

            socket.on(
                "rejoin",
                |socket: SocketRef, Data(_session_id): Data<String>| async move {
                    let _ = socket.emit(
                        "rejoin-failed",
                        &json!({ "reason": "sessions not persisted" }),
                    );
                },
            );

            socket.on("join-channel", {
                let s = state.clone();
                move |socket: SocketRef, Data(channel_id): Data<String>| {
                    let s = s.clone();
                    async move { on_join_channel(socket, channel_id, s).await }
                }
            });

            socket.on("message", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_message(socket, cmd, s, io).await }
                }
            });

            socket.on("load-history", {
                let s = state.clone();
                move |socket: SocketRef, Data(req): Data<Value>| {
                    let s = s.clone();
                    async move { on_load_history(socket, req, s).await }
                }
            });

            socket.on("delete-message", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(cmd): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_delete_message(socket, cmd, s, io).await }
                }
            });

            socket.on("typing", {
                let s = state.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    async move { on_typing(socket, data, s).await }
                }
            });

            socket.on("voice-channel-join", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_channel_join(socket, data, s, io).await }
                }
            });

            socket.on("voice-channel-subscribe", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_channel_join(socket, data, s, io).await }
                }
            });

            socket.on("voice-channel-leave", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_channel_leave(socket, data, s, io).await }
                }
            });

            // Call lifecycle
            socket.on("call-initiate", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_call_initiate(socket, data, s, io).await }
                }
            });

            socket.on("call-answer", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_call_answer(socket, data, s, io).await }
                }
            });

            socket.on("call-reject", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_call_reject(socket, data, s, io).await }
                }
            });

            socket.on("call-cancel", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_call_cancel(socket, data, s, io).await }
                }
            });

            socket.on("call-end", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_call_end(socket, data, s, io).await }
                }
            });

            socket.on("group-call-leave", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_group_call_leave(socket, data, s, io).await }
                }
            });

            socket.on("group-call-stop-ringing", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_group_call_stop_ringing(socket, data, s, io).await }
                }
            });

            // DM handlers
            socket.on("create-dm", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_create_dm(socket, data, s, io).await }
                }
            });

            socket.on("delete-dm", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_delete_dm(socket, data, s, io).await }
                }
            });

            // Group management
            socket.on("ban-user", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_ban_user(socket, data, s, io).await }
                }
            });

            socket.on("voice-mute", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_mute(socket, data, s, io).await }
                }
            });

            socket.on("voice-unmute", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_unmute(socket, data, s, io).await }
                }
            });

            socket.on("voice-deafen", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_deafen(socket, data, s, io).await }
                }
            });

            socket.on("voice-undeafen", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_voice_undeafen(socket, data, s, io).await }
                }
            });

            socket.on("kick-group-member", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_kick_group_member(socket, data, s, io).await }
                }
            });

            socket.on("leave-group", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_leave_group(socket, data, s, io).await }
                }
            });

            socket.on("add-group-member", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_add_group_member(socket, data, s, io).await }
                }
            });

            socket.on("update-group-avatar", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_update_group_avatar(socket, data, s, io).await }
                }
            });

            socket.on("edit-message", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_edit_message(socket, data, s, io).await }
                }
            });

            // WebRTC signal relay
            socket.on("call-offer", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_call_offer(socket, data, s, io).await }
                }
            });

            socket.on("call-answer-sdp", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let my_stable = get_my_stable_id(&socket, &s.app.config.jwt_secret);
                    let target_id = data
                        .get("targetId")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let answer = data.get("answer").cloned();
                    async move {
                        if let (Some(target), Some(ans)) = (target_id, answer) {
                            let _ = io
                                .to(target)
                                .emit(
                                    "call-answer-sdp",
                                    &json!({
                                        "answer":   ans,
                                        "senderId": my_stable
                                    }),
                                )
                                .await;
                        }
                    }
                }
            });

            socket.on("call-ice-candidate", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let my_stable = get_my_stable_id(&socket, &s.app.config.jwt_secret);
                    let target_id = data
                        .get("targetId")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let candidate = data.get("candidate").cloned();
                    async move {
                        if let (Some(target), Some(cand)) = (target_id, candidate) {
                            let _ = io
                                .to(target)
                                .emit(
                                    "call-ice-candidate",
                                    &json!({
                                        "candidate": cand,
                                        "senderId":  my_stable
                                    }),
                                )
                                .await;
                        }
                    }
                }
            });

            socket.on("get-emojis", {
                let s = state.clone();
                move |socket: SocketRef| {
                    let s = s.clone();
                    async move {
                        match s.app.stdb.get_emotes().await {
                            Ok(emotes) => {
                                let _ = socket.emit("emojis-list", &json!(emotes));
                            }
                            Err(e) => {
                                warn!("[sio] get-emojis failed: {}", e);
                                let _ = socket.emit("emojis-list", &json!([]));
                            }
                        }
                    }
                }
            });

            socket.on("add-emoji-reaction", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_add_emoji_reaction(socket, data, s, io).await }
                }
            });

            socket.on("remove-emoji-reaction", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_remove_emoji_reaction(socket, data, s, io).await }
                }
            });

            socket.on("get-role-definitions", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef| {
                    let s = s.clone();
                    let io = io.clone();
                    async move {
                        let roles: Vec<Value> = s
                            .app
                            .stdb
                            .get_role_definitions()
                            .await
                            .unwrap_or_default();
                        let _ = socket.emit("role-definitions-updated", &json!({ "roles": roles }));
                        let _ = io;
                    }
                }
            });

            socket.on("assign-role", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move {
                        let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
                        let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");

                        if target_user_id <= 0 || role_name.is_empty() {
                            warn!("[sio] assign-role: invalid params targetUserId={} roleName={}", target_user_id, role_name);
                            return;
                        }

                        // Auth check — caller must be admin
                        let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
                        let caller_id = user_id_from_token(&token, &s.app.config.jwt_secret).unwrap_or(-1);
                        if !s.app.is_admin(caller_id).await {
                            warn!("[sio] assign-role: user {} not authorized", caller_id);
                            let _ = socket.emit("assign-role-error", &json!({ "error": "Only admins can assign roles" }));
                            return;
                        }

                        // Ensure role definition exists
                        if let Err(e) = s.app.stdb.upsert_role_definition(
                            "default-workspace",
                            role_name,
                            role_name,
                            0,
                            None,
                            false,
                        ).await {
                            warn!("[sio] assign-role: failed to upsert role {}: {}", role_name, e);
                        }

                        // Assign the role to the target user
                        if let Err(e) = s.app.stdb.ingest_event("rbac", "assign_role", &json!({
                            "userId": target_user_id,
                            "workspaceId": "default-workspace",
                            "role": role_name,
                            "assignedBy": caller_id,
                        })).await {
                            warn!("[sio] assign-role: failed to assign role: {}", e);
                            let _ = socket.emit("assign-role-error", &json!({ "error": "Failed to assign role" }));
                            return;
                        }

                        // Broadcast updated role definitions to all clients
                        let roles: Vec<Value> = s
                            .app
                            .stdb
                            .get_role_definitions()
                            .await
                            .unwrap_or_default();
                        drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
                        drop(socket.emit("assign-role-success", &json!({ "targetUserId": target_user_id, "role": role_name })));
                    }
                }
            });

            socket.on("remove-role", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move {
                        let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
                        let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");

                        if target_user_id <= 0 || role_name.is_empty() {
                            return;
                        }

                        // Auth check
                        let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
                        let caller_id = user_id_from_token(&token, &s.app.config.jwt_secret).unwrap_or(-1);
                        if !s.app.is_admin(caller_id).await {
                            warn!("[sio] remove-role: user {} not authorized", caller_id);
                            return;
                        }

                        // Remove the role
                        if let Err(e) = s.app.stdb.ingest_event("rbac", "remove_role", &json!({
                            "userId": target_user_id,
                            "workspaceId": "default-workspace",
                            "role": role_name,
                        })).await {
                            warn!("[sio] remove-role: failed: {}", e);
                        }

                        // Broadcast updated role definitions to all clients
                        let roles: Vec<Value> = s
                            .app
                            .stdb
                            .get_role_definitions()
                            .await
                            .unwrap_or_default();
                        drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
                    }
                }
            });

            socket.on("update-channel-settings", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move {
                        let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
                            Some(id) => id.to_string(),
                            None => return,
                        };

                        // Auth check — must be admin
                        let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
                        let caller_id = user_id_from_token(&token, &s.app.config.jwt_secret).unwrap_or(-1);
                        if !s.app.is_admin(caller_id).await {
                            warn!("[sio] update-channel-settings: user {} not authorized", caller_id);
                            return;
                        }

                        // Update channel settings via ingest event
                        let mut row = serde_json::Map::new();
                        row.insert("channel_id".to_string(), json!(channel_id.clone()));
                        if let Some(min_role) = data.get("minRole").and_then(|v| v.as_str()) {
                            row.insert("min_role".to_string(), json!(min_role));
                        }
                        if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
                            row.insert("name".to_string(), json!(name));
                        }
                        if let Some(desc) = data.get("description").and_then(|v| v.as_str()) {
                            row.insert("description".to_string(), json!(desc));
                        }

                        if let Err(e) = s.app.stdb.ingest_event("channel", "update_settings", &json!({ "row": row })).await {
                            warn!("[sio] update-channel-settings failed: {}", e);
                            let _ = socket.emit("channel-settings-error", &json!({ "error": "Failed to update settings" }));
                            return;
                        }

                        let _ = socket.emit("channel-settings-updated", &json!({ "channelId": channel_id }));
                        let _ = io.broadcast().emit("channel-updated", &json!({ "channelId": channel_id })).await;
                    }
                }
            });

            socket.on("set-role-display-name", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move {
                        // Auth check — must be admin
                        let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
                        let caller_id = user_id_from_token(&token, &s.app.config.jwt_secret).unwrap_or(-1);
                        if !s.app.is_admin(caller_id).await {
                            warn!("[sio] set-role-display-name: user {} not authorized", caller_id);
                            return;
                        }

                        let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");
                        let display_name = data.get("displayName").and_then(|v| v.as_str()).unwrap_or("");

                        if role_name.is_empty() {
                            return;
                        }

                        if let Err(e) = s.app.stdb.upsert_role_definition(
                            "default-workspace",
                            role_name,
                            if display_name.is_empty() { role_name } else { display_name },
                            0,
                            None,
                            false,
                        ).await {
                            warn!("[sio] set-role-display-name: failed to update role {}: {}", role_name, e);
                        }

                        let roles: Vec<Value> = s
                            .app
                            .stdb
                            .get_role_definitions()
                            .await
                            .unwrap_or_default();
                        drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
                    }
                }
            });

            // DM / group management handlers
            socket.on("create-dm", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_create_dm(socket, data, s, io).await }
                }
            });

            socket.on("delete-dm", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_delete_dm(socket, data, s, io).await }
                }
            });

            socket.on("ban-user", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_ban_user(socket, data, s, io).await }
                }
            });

            socket.on("kick-group-member", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_kick_group_member(socket, data, s, io).await }
                }
            });

            socket.on("leave-group", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_leave_group(socket, data, s, io).await }
                }
            });

            socket.on("add-group-member", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_add_group_member(socket, data, s, io).await }
                }
            });

            socket.on("update-group-avatar", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_update_group_avatar(socket, data, s, io).await }
                }
            });

            socket.on("edit-message", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_edit_message(socket, data, s, io).await }
                }
            });

            socket.on("join-stdb-call", {
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let io = io.clone();
                    async move { on_join_stdb_call(socket, data, io).await }
                }
            });

            socket.on("stdb-media", {
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, Data(data): Data<Value>| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_stdb_media(socket, data, s, io).await }
                }
            });

            socket.on_disconnect({
                let s = state.clone();
                let io = io.clone();
                move |socket: SocketRef, _reason: socketioxide::socket::DisconnectReason| {
                    let s = s.clone();
                    let io = io.clone();
                    async move { on_disconnect(socket, s, io).await }
                }
            });
        },
    );

    layer
}
