//! Message routes
//!
//! GET /api/messages/{channel_id}  — STDB history merged with session cache
//! POST /api/messages              — immediate response, async STDB write

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

use crate::error::{AppError, Result};
use crate::state::AppState;

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

fn row_to_response(row: &std::collections::HashMap<String, Value>) -> Option<MessageResponse> {
    let id = row.get("message_id")?.as_str()?.to_string();
    let channel_id = row.get("channel_id")?.as_str()?.to_string();
    let user_id = row
        .get("sender_id")
        .and_then(|v| v.as_str())
        .unwrap_or("0")
        .to_string();
    let username = row
        .get("sender_username")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&user_id)
        .to_string();
    let content = row.get("content")?.as_str()?.to_string();
    let created_at = row.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0);
    let edited_at = row.get("edited_at").and_then(|v| v.as_i64());
    Some(MessageResponse {
        id,
        channel_id,
        user_id,
        username,
        content,
        message_type: "text".into(),
        created_at,
        edited_at,
    })
}

/// Merge STDB history with session cache, dedup by message_id, sort by timestamp.
async fn get_messages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<MessageListResponse>> {
    let stdb_rows = state
        .stdb
        .get_messages_raw(&channel_id, 100)
        .await
        .map_err(|e| AppError::Internal(format!("STDB fetch failed: {}", e)))?;

    let mut seen_ids: HashSet<String> = stdb_rows
        .iter()
        .filter_map(|r| r.get("message_id")?.as_str().map(String::from))
        .collect();

    let mut messages: Vec<MessageResponse> = stdb_rows.iter().filter_map(row_to_response).collect();

    // Merge in-memory session messages not yet persisted to STDB.
    {
        let session = state.session_messages.read().await;
        if let Some(cached) = session.get(&channel_id) {
            for msg in cached {
                let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if seen_ids.contains(id) {
                    continue;
                }
                seen_ids.insert(id.to_string());
                // Translate socket.io message view field names to HTTP response shape.
                let message_id = id.to_string();
                let ch = msg
                    .get("channelId")
                    .or_else(|| msg.get("channel_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&channel_id)
                    .to_string();
                let user_id = msg
                    .get("userId")
                    .or_else(|| msg.get("sender_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string();
                let username = msg
                    .get("user")
                    .or_else(|| msg.get("sender_username"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&user_id)
                    .to_string();
                let content = msg
                    .get("text")
                    .or_else(|| msg.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let created_at = msg
                    .get("timestamp")
                    .or_else(|| msg.get("created_at"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                messages.push(MessageResponse {
                    id: message_id,
                    channel_id: ch,
                    user_id,
                    username,
                    content,
                    message_type: "text".into(),
                    created_at,
                    edited_at: None,
                });
            }
        }
    }

    messages.sort_by_key(|m| m.created_at);
    let has_more = messages.len() >= 100;
    Ok(Json(MessageListResponse { messages, has_more }))
}

#[derive(Debug, Deserialize)]
struct SendMessageRequest {
    channel_id: String,
    content: String,
    message_type: Option<String>,
}

struct BearerClaims {
    user_id: i64,
    username: String,
}

fn claims_from_bearer(headers: &HeaderMap, jwt_secret: &str) -> Option<BearerClaims> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(serde::Deserialize)]
    struct C {
        sub: String,
        username: String,
    }
    let auth = headers.get("authorization")?.to_str().ok()?;
    let token = auth.strip_prefix("Bearer ")?;
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60; // 60 second grace period for clock skew
    let c = decode::<C>(token, &key, &v).ok()?.claims;
    Some(BearerClaims {
        user_id: c.sub.parse().ok()?,
        username: c.username,
    })
}

/// Accept message immediately, cache it, fire STDB write async.
async fn send_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<MessageResponse>> {
    let claims = claims_from_bearer(&headers, &state.config.jwt_secret)
        .ok_or_else(|| AppError::Unauthorized("valid auth token required".into()))?;
    let sender_id = claims.user_id;
    let sender_username = claims.username;

    let rand: u32 = rand::random();
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let message_id = format!("msg:http:{}:{}:{:x}", req.channel_id, created_at, rand);

    // Add to session cache immediately so GET returns it before STDB confirms.
    {
        let mut session = state.session_messages.write().await;
        let msgs = session.entry(req.channel_id.clone()).or_default();
        msgs.push(json!({
            "id":              message_id,
            "channelId":       req.channel_id,
            "userId":          format!("user-{}", sender_id),
            "user":            sender_username,
            "text":            req.content,
            "timestamp":       created_at,
        }));
        if msgs.len() > 1000 {
            msgs.drain(0..msgs.len() - 1000);
        }
    }

    // Fire STDB write in background — don't block the response.
    {
        let stdb = state.stdb.clone();
        let msg_id = message_id.clone();
        let ch_id = req.channel_id.clone();
        let uname = sender_username.clone();
        let content = req.content.clone();
        tokio::spawn(async move {
            if let Err(e) = stdb
                .upsert_message(&msg_id, &ch_id, sender_id, &uname, &content, created_at)
                .await
            {
                tracing::warn!("[messages] async STDB write failed: {}", e);
            }
        });
    }

    Ok(Json(MessageResponse {
        id: message_id,
        channel_id: req.channel_id,
        user_id: sender_id.to_string(),
        username: sender_username,
        content: req.content,
        message_type: req.message_type.unwrap_or_else(|| "text".into()),
        created_at,
        edited_at: None,
    }))
}
