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
use crate::error::Result;
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/{channel_id}", axum::routing::get(get_messages))
        .route("/", axum::routing::post(send_message))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct MessageListResponse {
    messages: Vec<MessageResponse>,
    has_more: bool,
}

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
    files: Vec<serde_json::Value>,
}

/// Convert a WDB typed `Message` to the JSON `MessageResponse` shape.
/// WDB stores `created_at_micros` / `edited_at_micros`; the frontend wants
/// milliseconds. `author_device_id` is the best we have for a "display name"
/// — the WDB `Message` doesn't carry a username; for v1 the frontend can
/// do a second lookup via `wdb.get_user(author_user_id)` to enrich it.
fn message_to_response(m: wabidb::domain::Message) -> MessageResponse {
    MessageResponse {
        id: m.message_id,
        channel_id: m.channel_id,
        user_id: m.author_user_id.to_string(),
        username: m.author_device_id,
        content: m.content,
        message_type: m.message_type,
        created_at: m.created_at_micros / 1000,
        edited_at: m.edited_at_micros.map(|e| e / 1000),
        is_spoiler: m.is_spoiler,
        files: m.files
            .into_iter()
            .map(|f| json!({
                "fileUrl": f.file_url,
                "fileName": f.file_name,
                "fileSize": f.file_size,
            }))
            .collect(),
    }
}

async fn get_messages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<MessageListResponse>> {
    let limit: u64 = 100;
    let wdb_messages = state
        .wdb
        .list_messages_typed(&channel_id, limit)
        .await?;

    let messages: Vec<MessageResponse> = wdb_messages
        .into_iter()
        .map(message_to_response)
        .collect();

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
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<MessageResponse>> {
    let sender_id = auth.user_id as u64;
    let sender_username = auth.username;
    let message_type = req.message_type.unwrap_or_else(|| "text".into());
    let created_at_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let is_live = state
        .channel_auto_delete_label
        .read()
        .await
        .get(&req.channel_id)
        .map(|s| s == "live")
        .unwrap_or(false);

    // A spoiler channel forces every message to be a spoiler regardless of
    // the client's request. Look the channel up to combine the flags.
    let channel_force_spoiler = state
        .wdb
        .get_channel(&req.channel_id)
        .await
        .ok()
        .flatten()
        .map(|c| c.force_spoiler)
        .unwrap_or(false);
    let is_spoiler = req.is_spoiler || channel_force_spoiler;

    let message_id = if is_live {
        format!("live_{}", uuid::Uuid::new_v4())
    } else {
        // Submit to WDB synchronously (WDB is in-process, no async fire needed).
        // The adapter builds a CommandCommit with event_type="message_created"
        // and an idempotency_key, runs the sequencer, and returns the
        // WDB-assigned message_id (format!("msg_{:x}", commit_seq)).
        state
            .wdb
            .send_message(&req.channel_id, sender_id, &req.content, is_spoiler, &[])
            .await?
    };

    // Push live messages into the in-memory session buffer.
    if is_live {
        let cap = state
            .live_channel_cap
            .read()
            .await
            .get(&req.channel_id)
            .copied()
            .unwrap_or(1000);
        let mut session = state.session_messages.write().await;
        let msgs = session.entry(req.channel_id.clone()).or_default();
        if msgs.len() >= cap as usize {
            msgs.drain(0..msgs.len() - (cap as usize).saturating_sub(1));
        }
        msgs.push(json!({
            "id": message_id.clone(),
            "user": sender_username.clone(),
            "userId": sender_id.to_string(),
            "text": req.content.clone(),
            "timestamp": created_at_micros / 1000,
            "bornAt": created_at_micros / 1000,
            "type": message_type.clone(),
            "isSpoiler": is_spoiler,
        }));
    }

    // H1b: fire outbound webhook delivery (`message.created`) to every
    // webhook URL registered on this channel. Fire-and-forget so a slow
    // webhook never blocks the sender.
    crate::bot_delivery::spawn_message_created_delivery(
        state.wdb.clone(),
        req.channel_id.clone(),
        crate::bot_delivery::MessageCreatedPayload {
            channel_id: req.channel_id.clone(),
            message_id: message_id.clone(),
            content: req.content.clone(),
            author: sender_username.clone(),
            timestamp: created_at_micros / 1000,
        },
    );

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
        files: vec![],
    }))
}
