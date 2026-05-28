#![allow(dead_code)]
//! User routes
//!
//! Implements:
//! - GET /api/user/me
//! - PUT /api/user/settings
//! - GET /api/user/profile/{id}
//! - GET/PUT /api/user/layout

use axum::{
    extract::{Path, State},
    http::header::HeaderMap,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::Result;
use crate::state::AppState;

fn extract_user_id_from_token(headers: &HeaderMap, jwt_secret: &str) -> Result<i64> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(serde::Deserialize)]
    struct C {
        sub: String,
    }
    let auth = headers
        .get("authorization")
        .ok_or_else(|| anyhow::anyhow!("missing authorization header"))?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid authorization header"))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| anyhow::anyhow!("missing Bearer prefix"))?;
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let c = decode::<C>(token, &key, &v).map_err(|e| anyhow::anyhow!("invalid token: {}", e))?;
    let user_id = c
        .claims
        .sub
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("invalid user_id in token"))?;
    Ok(user_id)
}

/// Create user router
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/me", axum::routing::get(get_current_user))
        // Accept PUT, POST, and GET — frontend uses GET for load, PUT/POST for save
        .route(
            "/settings",
            axum::routing::get(get_settings)
                .put(update_settings)
                .post(update_settings),
        )
        .route("/profile/{id}", axum::routing::get(get_user_profile))
        .route("/layout", axum::routing::get(get_layout).put(save_layout))
        .with_state(state)
}

/// Current user response
#[derive(Debug, Serialize)]
struct UserResponse {
    user_id: i64,
    username: String,
    email: Option<String>,
    is_guest: bool,
    created_at: i64,
}

/// Get current user profile
async fn get_current_user(State(_state): State<Arc<AppState>>) -> Result<Json<UserResponse>> {
    // TODO: Extract user from JWT token in request
    // For now, return placeholder
    Ok(Json(UserResponse {
        user_id: 1,
        username: "demo_user".to_string(),
        email: None,
        is_guest: false,
        created_at: 0,
    }))
}

/// Get user settings
async fn get_settings(State(_state): State<Arc<AppState>>) -> Result<Json<UserResponse>> {
    // TODO: Extract user from JWT token in request
    // For now, return placeholder
    Ok(Json(UserResponse {
        user_id: 1,
        username: "demo_user".to_string(),
        email: None,
        is_guest: false,
        created_at: 0,
    }))
}

/// Update settings request
#[derive(Debug, Deserialize)]
struct UpdateSettingsRequest {
    display_name: Option<String>,
    avatar_url: Option<String>,
    status_message: Option<String>,
    theme: Option<String>,
}

/// Update user settings
async fn update_settings(
    State(_state): State<Arc<AppState>>,
    Json(_req): Json<UpdateSettingsRequest>,
) -> Result<Json<UserResponse>> {
    // TODO: Update user settings in SpacetimeDB
    Ok(Json(UserResponse {
        user_id: 1,
        username: "demo_user".to_string(),
        email: None,
        is_guest: false,
        created_at: 0,
    }))
}

/// Get user profile by ID
async fn get_user_profile(
    State(_state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<UserResponse>> {
    // TODO: Look up user by ID in SpacetimeDB
    Ok(Json(UserResponse {
        user_id: id,
        username: format!("user_{}", id),
        email: None,
        is_guest: false,
        created_at: 0,
    }))
}

// GET /api/user/layout
async fn get_layout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let user_id = extract_user_id_from_token(&headers, &state.config.jwt_secret)?;
    match state.stdb.get_user_layout(user_id).await? {
        Some((layout_json, updated_at)) => Ok(Json(
            serde_json::json!({ "layoutJson": layout_json, "updatedAt": updated_at }),
        )),
        None => Ok(Json(
            serde_json::json!({ "layoutJson": null, "updatedAt": null }),
        )),
    }
}

// PUT /api/user/layout
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLayoutRequest {
    layout_json: String,
}

async fn save_layout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SaveLayoutRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = extract_user_id_from_token(&headers, &state.config.jwt_secret)?;
    state
        .stdb
        .upsert_user_layout(user_id, &body.layout_json)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
