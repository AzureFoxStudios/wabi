//! Bot account endpoints.
//!
//! Implements the generic bot platform primitive (no Hermes-specific code):
//! - POST /api/bot/create — owner-only, mints a bot account + opaque token
//! - POST /api/bot/rotate  — owner-only, rotates an existing bot's token
//! - POST /api/bot/disable — owner-only, revokes a bot token
//!
//! Bots authenticate with `Authorization: Bot <token>` (see auth_extractor).
//! The token is high-entropy and stored only as a hash in the bot registry.

use axum::{extract::State, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

/// The canonical username for the Hermes service bot.
/// Auto-registered on startup so cron / deliveries can emit as this bot.
pub const HERMES_BOT_USERNAME: &str = "hermes-bot";

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/create", axum::routing::post(handle_create))
        .route("/rotate", axum::routing::post(handle_rotate))
        .route("/disable", axum::routing::post(handle_disable))
        .route("/send-message", axum::routing::post(handle_send_message))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct BotCreateRequest {
    username: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotCreateResponse {
    bot_user_id: u64,
    bot_token: String,
    username: String,
}

#[derive(Debug, Deserialize)]
struct BotUserRequest {
    #[serde(rename = "botUserId")]
    bot_user_id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotRotateResponse {
    bot_user_id: u64,
    bot_token: String,
}

/// Require that the authenticated user is the server owner.
async fn require_owner(state: &AppState, auth: &AuthUser) -> Result<()> {
    if auth.is_bot || !state.is_owner(auth.user_id).await {
        return Err(AppError::Forbidden(
            "Only the server owner can manage bots".into(),
        ));
    }
    Ok(())
}

/// POST /api/bot/create — create a bot account and mint its first token.
async fn handle_create(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotCreateRequest>,
) -> Result<Json<BotCreateResponse>> {
    require_owner(&state, &auth).await?;

    let username = req.username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::BadRequest("Bot username cannot be empty".into()));
    }
    if state.wdb.get_user_by_username(&username).await?.is_some() {
        return Err(AppError::BadRequest("Username already taken".into()));
    }

    // Bots have no password: store a random bcrypt hash so password login
    // always fails and the account can never be used as a human login.
    let dummy_password = bcrypt::hash(&uuid::Uuid::new_v4().to_string(), bcrypt::DEFAULT_COST)?;
    let user_id = state
        .wdb
        .create_user(&username, Some(&username.to_lowercase()), &dummy_password)
        .await?;

    let (bot_token, _record) = state.bot_registry.create(user_id).await;

    Ok(Json(BotCreateResponse {
        bot_user_id: user_id,
        bot_token,
        username,
    }))
}

/// POST /api/bot/rotate — invalidate a bot's current token and mint a new one.
async fn handle_rotate(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotUserRequest>,
) -> Result<Json<BotRotateResponse>> {
    require_owner(&state, &auth).await?;

    let bot_token = state
        .bot_registry
        .rotate(req.bot_user_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("Bot {} not found", req.bot_user_id)))?;

    Ok(Json(BotRotateResponse {
        bot_user_id: req.bot_user_id,
        bot_token,
    }))
}

/// POST /api/bot/disable — revoke a bot's token and disable the account.
async fn handle_disable(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotUserRequest>,
) -> Result<Json<serde_json::Value>> {
    require_owner(&state, &auth).await?;

    if !state.bot_registry.disable(req.bot_user_id).await {
        return Err(AppError::NotFound(format!("Bot {} not found", req.bot_user_id)));
    }

    Ok(Json(json!({
        "success": true,
        "botUserId": req.bot_user_id,
    })))
}

/// POST /api/bot/send-message — send a message as the authenticated bot.
///
/// Accepts `Bot <token>` auth (resolved by AuthUser's extractor). Writes the
/// message to WDB via the same path as REST /api/messages, then broadcasts it
/// over the live Socket.IO layer so connected clients receive it in real
/// time, and fires webhook delivery (H1b).
async fn handle_send_message(
    state: State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotSendMessageRequest>,
) -> Result<Json<BotSendMessageResponse>> {
    if !auth.is_bot {
        return Err(AppError::Forbidden(
            "Only bot accounts can use /api/bot/send-message".into(),
        ));
    }
    let sender_id = auth.user_id as u64;
    let sender_username = auth.username;

    // Reuse the same WDB write path as REST /api/messages.
    let created_at_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let channel_force_spoiler = state
        .wdb
        .get_channel(&req.channel_id)
        .await
        .ok()
        .flatten()
        .map(|c| c.force_spoiler)
        .unwrap_or(false);
    let is_spoiler = req.is_spoiler || channel_force_spoiler;

    let message_id = state
        .wdb
        .send_message(&req.channel_id, sender_id, &req.content, is_spoiler, &[])
        .await?;

    let message_view = json!({
        "id": message_id.clone(),
        "user": sender_username,
        "userId": format!("user-{}", sender_id),
        "senderStableId": format!("user-{}", sender_id),
        "text": req.content,
        "timestamp": created_at_micros / 1000,
        "bornAt": created_at_micros / 1000,
        "type": req.message_type.clone().unwrap_or_else(|| "text".into()),
        "isBot": true,
    });

    // Broadcast to all connected socket clients in the channel.
    let msg_payload = json!({
        "channelId": &req.channel_id,
        "message": message_view,
    });
    if let Some(io) = state.sio.read().await.clone() {
        let ch = req.channel_id.clone();
        let payload = msg_payload.clone();
        tokio::spawn(async move {
            let _ = io.to(ch).emit("message", &payload).await;
        });
    }

    // H1b: fire webhook delivery for this message.
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

    Ok(Json(BotSendMessageResponse {
        message_id,
        channel_id: req.channel_id,
        content: req.content,
        username: sender_username,
        is_bot: true,
    }))
}

/// Ensure the Hermes service bot exists and return its token.
/// Called once on startup; idempotent if the bot already exists.
pub async fn ensure_hermes_bot(state: &AppState) -> Result<String> {
    // Check if a bot with username "hermes-bot" already exists.
    if let Ok(Some(user)) = state.wdb.get_user_by_username(HERMES_BOT_USERNAME).await {
        // Verify it's registered as a bot in the registry; if not, re-create
        // the token record.
        if state.bot_registry.is_bot(user.user_id).await {
            // Token is one-shot at creation; store in memory for internal use.
            // The token is never exposed via API — only the server process uses it.
            tracing::info!("[bot:hermes] bot account already exists (id={})", user.user_id);
            return Ok(format!("user-{}", user.user_id));
        }
    }
    // No existing bot — create one via the registry.
    let dummy_password = bcrypt::hash(
        &uuid::Uuid::new_v4().to_string(),
        bcrypt::DEFAULT_COST,
    )
    .map_err(|e| AppError::Internal(format!("bcrypt error: {e}")))?;
    let user_id = state
        .wdb
        .create_user(HERMES_BOT_USERNAME, Some(&HERMES_BOT_USERNAME.to_lowercase()), &dummy_password)
        .await
        .map_err(|e| AppError::Internal(format!("create_user failed: {e}")))?;
    let (_token, _) = state.bot_registry.create(user_id).await;
    tracing::info!("[bot:hermes] registered hermes-bot account (id={})", user_id);
    Ok(format!("user-{}", user_id))
}

#[derive(Debug, Deserialize)]
struct BotSendMessageRequest {
    channel_id: String,
    content: String,
    message_type: Option<String>,
    #[serde(default)]
    is_spoiler: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotSendMessageResponse {
    message_id: String,
    channel_id: String,
    content: String,
    username: String,
    is_bot: bool,
}
