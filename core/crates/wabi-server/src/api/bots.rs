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

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/create", axum::routing::post(handle_create))
        .route("/rotate", axum::routing::post(handle_rotate))
        .route("/disable", axum::routing::post(handle_disable))
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
