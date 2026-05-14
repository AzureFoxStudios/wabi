//! Channel routes
//!
//! GET    /api/channels      — list all channels (public)
//! POST   /api/channels      — create channel (admin only)
//! GET    /api/channels/{id} — get single channel (public)
//! DELETE /api/channels/{id} — archive channel (admin only)

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::{AppError, Result};
use crate::state::AppState;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", axum::routing::get(list_channels))
        .route("/", axum::routing::post(create_channel))
        .route("/{id}", axum::routing::get(get_channel))
        .route("/{id}", axum::routing::delete(delete_channel))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct ChannelListResponse {
    channels: Vec<ChannelResponse>,
}

#[derive(Debug, Serialize)]
struct ChannelResponse {
    id: String,
    name: String,
    channel_type: String,
    position: i32,
    parent_id: Option<String>,
}

async fn list_channels(State(state): State<Arc<AppState>>) -> Result<Json<ChannelListResponse>> {
    let raw = state
        .stdb
        .get_channels_raw()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch channels: {}", e)))?;

    let channels = raw
        .iter()
        .filter_map(|row| {
            let id = row.get("channel_id")?.as_str()?.to_string();
            let name = row.get("name")?.as_str()?.to_string();
            let channel_type = row.get("channel_type")?.as_str()?.to_string();
            let position = row.get("position").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let parent_id = row.get("parent_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            Some(ChannelResponse { id, name, channel_type, position, parent_id })
        })
        .collect();

    Ok(Json(ChannelListResponse { channels }))
}

async fn get_channel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ChannelResponse>> {
    let raw = state
        .stdb
        .get_channels_raw()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch channels: {}", e)))?;

    raw.iter()
        .find(|row| row.get("channel_id").and_then(|v| v.as_str()) == Some(&id))
        .and_then(|row| {
            let name = row.get("name")?.as_str()?.to_string();
            let channel_type = row.get("channel_type")?.as_str()?.to_string();
            let position = row.get("position").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let parent_id = row.get("parent_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            Some(Ok(Json(ChannelResponse { id: id.clone(), name, channel_type, position, parent_id })))
        })
        .unwrap_or_else(|| Err(AppError::NotFound(format!("Channel {} not found", id))))
}

#[derive(Debug, Deserialize)]
struct CreateChannelRequest {
    name: String,
    #[serde(default = "default_channel_type")]
    channel_type: String,
}

fn default_channel_type() -> String {
    "text".to_string()
}

async fn create_channel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<ChannelResponse>> {
    let claims = claims_from_bearer(&headers, &state.config.jwt_secret)
        .ok_or_else(|| AppError::Unauthorized("valid auth token required".into()))?;

    if !state.is_admin(claims.user_id).await {
        return Err(AppError::Unauthorized("only admins can create channels".into()));
    }

    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("channel name cannot be empty".into()));
    }

    // Use slugified name as ID so it's stable and URL-safe.
    let channel_id = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    state
        .stdb
        .create_channel(&channel_id, &name, &req.channel_type, claims.user_id)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create channel: {}", e)))?;

    Ok(Json(ChannelResponse {
        id: channel_id,
        name,
        channel_type: req.channel_type,
        position: 0,
        parent_id: None,
    }))
}

async fn delete_channel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let claims = claims_from_bearer(&headers, &state.config.jwt_secret)
        .ok_or_else(|| AppError::Unauthorized("valid auth token required".into()))?;

    if !state.is_admin(claims.user_id).await {
        return Err(AppError::Unauthorized("only admins can delete channels".into()));
    }

    state
        .stdb
        .delete_channel(&id)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to delete channel: {}", e)))?;

    Ok(Json(serde_json::json!({ "deleted": id })))
}

struct BearerClaims {
    user_id: i64,
}

fn claims_from_bearer(headers: &HeaderMap, jwt_secret: &str) -> Option<BearerClaims> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(serde::Deserialize)]
    struct C {
        sub: String,
    }
    let auth = headers.get("authorization")?.to_str().ok()?;
    let token = auth.strip_prefix("Bearer ")?;
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let c = decode::<C>(token, &key, &v).ok()?.claims;
    Some(BearerClaims { user_id: c.sub.parse().ok()? })
}
