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
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

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

/// Current user response. Includes private account fields for the authenticated user.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserResponse {
    user_id: i64,
    username: String,
    email: Option<String>,
    is_guest: bool,
    /// True when the account is a bot service account (BOT badge).
    is_bot: bool,
    created_at: i64,
    is_owner: bool,
}

/// Public profile response for looking up another user.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicUserProfileResponse {
    user_id: i64,
    username: String,
    handle: Option<String>,
    color: Option<String>,
    display_name: Option<String>,
    avatar_url: Option<String>,
    status_message: Option<String>,
    /// True when the account is a bot service account (BOT badge).
    is_bot: bool,
    created_at: i64,
}

/// Convert WDB User micros timestamp to milliseconds.
fn wdb_user_to_response(u: &wabidb::domain::User) -> (String, Option<String>, i64) {
    (u.username.clone(), u.handle.clone(), u.created_at_micros / 1000)
}

/// Get current user profile
async fn get_current_user(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<UserResponse>> {
    if let Some(user) = state.wdb.get_user(auth.user_id as u64).await? {
        let (username, _handle, created_at_ms) = wdb_user_to_response(&user);
        let is_owner = *state.owner_user_id.read().await == Some(auth.user_id);
        let is_bot = state.is_bot_user(auth.user_id as u64).await;
        Ok(Json(UserResponse {
            user_id: auth.user_id,
            username,
            // The WDB User type has no `email` field. Frontend can fall
            // back to handle/display_name.
            email: None,
            is_guest: auth.is_guest,
            is_bot,
            created_at: created_at_ms,
            is_owner,
        }))
    } else {
        Ok(Json(UserResponse {
            user_id: auth.user_id,
            username: auth.username,
            email: None,
            is_guest: auth.is_guest,
            is_bot: false,
            created_at: 0,
            is_owner: false,
        }))
    }
}

/// Get user settings
async fn get_settings(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    // The WDB User has `handle` and `color` but not display_name / avatar_url /
    // status_message / theme. Until Carl adds the settings fields to
    // wabidb::domain::User, we return what we have + nulls for the rest.
    if let Some(user) = state.wdb.get_user(auth.user_id as u64).await? {
        Ok(Json(serde_json::json!({
            "displayName": null,  // TODO: wabidb User.display_name
            "avatarUrl": null,    // TODO: wabidb User.avatar_url
            "statusMessage": null, // TODO: wabidb User.status_message
            "theme": null,        // TODO: wabidb User.theme
            "color": user.color,
            "handle": user.handle,
        })))
    } else {
        Ok(Json(serde_json::json!({})))
    }
}

/// Update settings request
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettingsRequest {
    display_name: Option<String>,
    avatar_url: Option<String>,
    status_message: Option<String>,
    theme: Option<String>,
}

/// Update user settings
async fn update_settings(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<serde_json::Value>> {
    // The WDB User has no settings fields yet. For v1, we do a `touch_user`
    // (updates last_seen) as the closest equivalent to "user upsert" until
    // Carl adds a real update method. The settings fields are dropped.
    let _ = (req.display_name, req.avatar_url, req.status_message, req.theme);
    state.wdb.touch_user(auth.user_id as u64).await?;
    Ok(Json(serde_json::json!({ "ok": true, "note": "settings not yet persisted to wabidb; tracked by last_seen" })))
}

/// Get a public-safe user profile by ID.
async fn get_user_profile(
    _auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<PublicUserProfileResponse>> {
    if let Some(user) = state.wdb.get_user(id as u64).await? {
        let (username, _handle, created_at_ms) = wdb_user_to_response(&user);
        let is_bot = state.is_bot_user(id as u64).await;
        Ok(Json(PublicUserProfileResponse {
            user_id: id,
            username,
            handle: user.handle,
            color: Some(user.color),
            // Settings fields: not in WDB User yet. Return None for v1.
            display_name: None,
            avatar_url: None,
            status_message: None,
            is_bot,
            created_at: created_at_ms,
        }))
    } else {
        Err(AppError::NotFound(format!("User {} not found", id)))
    }
}

// GET /api/user/layout
// The WDB User domain has no `layout_json` field. Until Carl adds it (or
// creates a new projections::layouts table), this returns null.
async fn get_layout(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    let _ = state.wdb.get_user(auth.user_id as u64).await?;
    Ok(Json(
        serde_json::json!({ "layoutJson": null, "updatedAt": null }),
    ))
}

// PUT /api/user/layout
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLayoutRequest {
    layout_json: String,
}

// The WDB User domain has no `layout_json` field. For v1, save is a no-op
// (acknowledge with ok so the frontend's optimistic update doesn't roll
// back). When Carl adds a `user_layout_upserted` event + projection handler,
// this becomes a real write.
async fn save_layout(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveLayoutRequest>,
) -> Result<Json<serde_json::Value>> {
    let _ = state.wdb.touch_user(auth.user_id as u64).await?;
    let _ = body.layout_json;
    Ok(Json(serde_json::json!({
        "ok": true,
        "note": "layout not yet persisted to wabidb; UI optimistic update preserved"
    })))
}
