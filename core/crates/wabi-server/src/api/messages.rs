//! Message routes
//!
//! GET /api/messages/{channel_id}  — WDB history (session cache merge skipped for v1)
//! POST /api/messages              — synchronous WDB write (WDB is in-process, no async fire needed)

use axum::{
    extract::{Path, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
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

    // Submit to WDB synchronously (WDB is in-process, no async fire needed).
    // The adapter builds a CommandCommit with event_type="message_created"
    // and an idempotency_key, runs the sequencer, and returns the
    // WDB-assigned message_id (format!("msg_{:x}", commit_seq)).
    let message_id = state
        .wdb
        .send_message(&req.channel_id, sender_id, &req.content)
        .await?;

    // Optimistic session cache push — keeps the in-memory layer consistent
    // for any code that reads state.session_messages directly. (Skipped for
    // v1: WDB writes are sync, so the WDB read in GET will see the message
    // immediately.)
    let _ = (message_id.clone(), created_at_micros, message_type.clone());

    Ok(Json(MessageResponse {
        id: message_id,
        channel_id: req.channel_id,
        user_id: sender_id.to_string(),
        username: sender_username,
        content: req.content,
        message_type,
        created_at: created_at_micros / 1000,
        edited_at: None,
    }))
}
