//! Message routes
//!
//! GET /api/messages/{channel_id}  — WDB history (session cache merge skipped for v1)
//! POST /api/messages              — synchronous WDB write (WDB is in-process, no async fire needed)

use axum::{
    extract::{Path, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

/// Detect every `steam://run/<appid>` deep link in a message's text.
pub fn find_steam_join_appids(content: &str) -> Vec<u32> {
    let Ok(re) = regex::Regex::new(r"steam://run/(\d+)") else { return Vec::new(); };
    let mut appids = Vec::new();
    for caps in re.captures_iter(content) {
        if let Some(m) = caps.get(1) {
            if let Ok(appid) = m.as_str().parse::<u32>() {
                if !appids.contains(&appid) { appids.push(appid); }
            }
        }
    }
    appids
}

async fn emit_steam_join_events(
    state: &AppState, channel_id: &str, message_id: &str, username: &str, user_id: u64, content: &str,
) {
    let appids = find_steam_join_appids(content);
    if appids.is_empty() { return; }
    if let Some(io) = state.socket_io() {
        for appid in appids {
            let payload = json!({
                "appid": appid, "messageId": message_id, "channelId": channel_id,
                "username": username, "userId": format!("user-{}", user_id),
            });
            let ch = channel_id.to_string();
            let io = io.clone();
            tokio::spawn(async move { let _ = io.to(ch).emit("steam_join", &payload).await; });
        }
    }
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/{channel_id}", axum::routing::get(get_messages))
        .route("/", axum::routing::post(send_message))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct MessageListResponse { messages: Vec<MessageResponse>, has_more: bool }

#[derive(Debug, Serialize)]
struct MessageResponse {
    id: String,
    channel_id: String,
    user_id: String,
    username: String,
    content: String,
    message_type: String,
    created_at: i64,
    edited_at: Option<i64>,
    #[serde(default)]
    is_spoiler: bool,
    #[serde(default)]
    encrypted: bool,
    #[serde(default)]
    files: Vec<serde_json::Value>,
}

fn message_to_response(m: wabidb::domain::Message, username: String) -> MessageResponse {
    let encrypted = crate::api::e2ee::is_ciphertext(&m.content);
    MessageResponse {
        id: m.message_id,
        channel_id: m.channel_id,
        user_id: m.author_user_id.to_string(),
        username: if username.is_empty() { m.author_device_id } else { username },
        content: m.content,
        message_type: m.message_type,
        created_at: m.created_at_micros / 1000,
        edited_at: m.edited_at_micros.map(|e| e / 1000),
        is_spoiler: m.is_spoiler,
        encrypted,
        files: m.files.into_iter().map(|f| json!({
            "fileUrl": f.file_url, "fileName": f.file_name, "fileSize": f.file_size,
        })).collect(),
    }
}

async fn get_messages(
    State(state): State<Arc<AppState>>, auth: AuthUser, Path(channel_id): Path<String>,
) -> Result<Json<MessageListResponse>> {
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    let limit: u64 = 100;
    let wdb_messages = state.wdb.list_messages_typed(&channel_id, limit).await?;
    let mut name_by_id: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
    let distinct_ids: Vec<u64> = {
        let seen: std::collections::HashSet<u64> = wdb_messages.iter().map(|m| m.author_user_id).collect();
        seen.into_iter().collect()
    };
    for id in distinct_ids {
        if let Ok(Some(u)) = state.wdb.get_user(id).await { name_by_id.insert(id, u.username); }
    }
    let messages: Vec<MessageResponse> = wdb_messages.into_iter().map(|m| {
        let username = name_by_id.get(&m.author_user_id).cloned().unwrap_or_default();
        message_to_response(m, username)
    }).collect();
    let has_more = messages.len() as u64 >= limit;
    Ok(Json(MessageListResponse { messages, has_more }))
}

#[derive(Debug, Deserialize)]
struct SendMessageRequest {
    channel_id: String,
    content: String,
    message_type: Option<String>,
    #[serde(default)]
    is_spoiler: bool,
}

async fn send_message(
    State(state): State<Arc<AppState>>, auth: AuthUser, Json(req): Json<SendMessageRequest>,
) -> Result<Json<MessageResponse>> {
    // Channel policy changes use this same boundary when evicting live rooms.
    let retention_guard = state.retention_policy_lock.lock().await;
    crate::channel_access::require_access(&state, auth.user_id, &req.channel_id).await?;
    match state.wdb.require_local_room_owner(&req.channel_id, "send_message") {
        Ok(()) => {}
        Err(wabidb::error::WabiError::Validation { .. }) => {
            return Err(AppError::Conflict(
                "This room is assigned to another node and cannot accept a write here".into(),
            ));
        }
        Err(error) => return Err(AppError::Wdb(error)),
    }
    let blacklist = state.get_blacklist().await.ok_or_else(|| AppError::Internal("Channel restriction enforcement unavailable".into()))?;
    if blacklist.is_channel_timed_out(&req.channel_id, auth.user_id).await.is_some() {
        return Err(AppError::Forbidden("You are timed out in this channel".into()));
    }

    // Serialize policy changes with the message commit so a pending room
    // cannot write plaintext after a participant enables encryption.
    // This check happens BEFORE every server content feature. In an E2EE room,
    // plaintext is rejected and the server sees only a versioned ciphertext
    // envelope. Membership/device changes fail closed until clients rekey.
    let e2ee = crate::api::e2ee::validate_outbound_message(
        &state, &req.channel_id, auth.user_id, &req.content,
    ).await.map_err(AppError::Forbidden)?;

    let channel_kind = state.wdb.get_channel_kind(&req.channel_id).await;
    let is_private_conversation = matches!(channel_kind.as_deref(), Some("dm" | "group"));
    let mut safety_flag = None;
    if !is_private_conversation && !state.is_owner(auth.user_id).await {
        let needs_ack = crate::api::server_center::rules_required_for_post(&state.config.data_dir, auth.user_id)
            .map_err(|error| AppError::Internal(format!("Server rules could not be checked; message refused: {error}")))?;
        if needs_ack { return Err(AppError::Forbidden("Read and acknowledge this server's current rules before posting".into())); }
    }
    if !e2ee && !state.is_owner(auth.user_id).await {
        if let Some(rule) = crate::api::server_center::evaluate_safety_rules(
            &state.config.data_dir, &req.content, is_private_conversation,
        ).map_err(|error| AppError::Internal(format!("Safety policy is unreadable; message refused: {error}")))? {
            let reason = rule.reason.clone().unwrap_or_else(|| format!("Safety rule: {}", rule.name));
            match &rule.action {
                crate::api::server_center::SafetyAction::Flag => {
                    safety_flag = Some(rule.clone());
                }
                crate::api::server_center::SafetyAction::Delete => return Err(AppError::Forbidden(format!("Message blocked by server safety rule: {}", rule.name))),
                crate::api::server_center::SafetyAction::Warn => return Err(AppError::Forbidden(reason)),
                crate::api::server_center::SafetyAction::Timeout => {
                    let minutes = rule.timeout_minutes.unwrap_or(10).max(1) as i64;
                    let expires_at = (chrono::Utc::now().timestamp() as u64).saturating_add((minutes as u64).saturating_mul(60));
                    blacklist.restrict_channel(&req.channel_id, auth.user_id, &reason, Some(expires_at)).await
                        .map_err(|error| AppError::Internal(format!("safety timeout could not be saved: {error}")))?;
                    return Err(AppError::Forbidden(format!("Timed out for {minutes} minute(s): {reason}")));
                }
                crate::api::server_center::SafetyAction::Ban => {
                    blacklist.restrict_channel(&req.channel_id, auth.user_id, &reason, None).await
                        .map_err(|error| AppError::Internal(format!("safety ban could not be saved: {error}")))?;
                    if let Some(io) = state.socket_io() { crate::socketio::evict_channel_user(&io, &req.channel_id, auth.user_id); }
                    return Err(AppError::Forbidden(format!("Banned from this channel: {reason}")));
                }
            }
        }
    }

    let sender_id = auth.user_id as u64;
    let sender_username = auth.username;
    let message_type = if e2ee { "text".to_string() } else { req.message_type.unwrap_or_else(|| "text".into()) };
    // A retention epoch must not be inserted between selecting Live/durable
    // mode and assigning the durable message its database timestamp.
    let created_at_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros() as i64).unwrap_or(0);
    let is_live = state.channel_auto_delete_label.read().await.get(&req.channel_id).map(|s| s == "live").unwrap_or(false);
    let channel_force_spoiler = state.wdb.get_channel(&req.channel_id).await.ok().flatten().map(|c| c.force_spoiler).unwrap_or(false);
    let is_spoiler = if e2ee { false } else { req.is_spoiler || channel_force_spoiler };

    let message_id = if is_live {
        format!("live_{}", uuid::Uuid::new_v4())
    } else {
        state.wdb.send_message(&req.channel_id, sender_id, &req.content, is_spoiler, &[]).await?
    };

    if is_live {
        let cap = state.live_channel_cap.read().await.get(&req.channel_id).copied().unwrap_or(1000);
        let mut session = state.session_messages.write().await;
        let msgs = session.entry(req.channel_id.clone()).or_default();
        if msgs.len() >= cap as usize { msgs.drain(0..msgs.len() - (cap as usize).saturating_sub(1)); }
        msgs.push(json!({
            "id": message_id.clone(), "user": sender_username.clone(), "userId": sender_id.to_string(),
            "text": req.content.clone(), "timestamp": created_at_micros / 1000, "bornAt": created_at_micros / 1000,
            "type": message_type.clone(), "isSpoiler": is_spoiler, "encrypted": e2ee,
        }));
    }
    drop(retention_guard);

    if let Some(rule) = safety_flag {
        crate::api::server_center::record_safety_flag(&state, &req.channel_id, &message_id, auth.user_id, &sender_username, &rule)
            .await.map_err(|error| AppError::Internal(format!("Message {message_id} was saved, but its safety flag could not be recorded: {error}")))?;
    }

    // E2EE means no server-side content fan-out. Webhooks, Steam detection,
    // previews and classifiers cannot receive plaintext that the server never had.
    if !e2ee {
        crate::bot_delivery::spawn_message_created_delivery(
            state.wdb.clone(), req.channel_id.clone(), crate::bot_delivery::MessageCreatedPayload {
                channel_id: req.channel_id.clone(), message_id: message_id.clone(), content: req.content.clone(),
                author: sender_username.clone(), timestamp: created_at_micros / 1000,
            },
        );
        emit_steam_join_events(&state, &req.channel_id, &message_id, &sender_username, sender_id, &req.content).await;
    }

    Ok(Json(MessageResponse {
        id: message_id,
        channel_id: req.channel_id,
        user_id: sender_id.to_string(),
        username: sender_username,
        content: req.content,
        message_type,
        created_at: created_at_micros / 1000,
        edited_at: None,
        is_spoiler,
        encrypted: e2ee,
        files: vec![],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_single_steam_run_link() {
        assert_eq!(find_steam_join_appids("join me: steam://run/1086940"), vec![1086940]);
    }

    #[test]
    fn finds_multiple_unique_steam_run_links() {
        assert_eq!(find_steam_join_appids("a: steam://run/1086940 b: steam://run/553850 a: steam://run/1086940"), vec![1086940, 553850]);
    }

    #[test]
    fn ignores_non_steam_urls() {
        assert!(find_steam_join_appids("https://store.steampowered.com/app/1086940").is_empty());
        assert!(find_steam_join_appids("steam://joinlobby/1086940/abc/123").is_empty());
        assert!(find_steam_join_appids("no links here").is_empty());
    }

    #[test]
    fn handles_empty_string() { assert!(find_steam_join_appids("").is_empty()); }
}
