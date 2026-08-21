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
        .route("/layout", axum::routing::get(get_layout).put(save_layout).post(save_layout))
        .route("/theme", axum::routing::get(get_theme).post(save_theme))
        .route("/theme/reset", axum::routing::post(reset_theme))
        .route("/profile-media", axum::routing::get(get_profile_media).post(save_profile_media))
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
async fn get_layout(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    let layout = state.wdb.get_user_layout(auth.user_id as u64).await?;
    match layout {
        Some(record) => Ok(Json(serde_json::json!({
            "layoutJson": record.layout_json,
            "updatedAt": record.updated_at_micros,
        }))),
        None => Ok(Json(
            serde_json::json!({ "layoutJson": null, "updatedAt": null }),
        )),
    }
}

// PUT /api/user/layout
async fn save_layout(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveLayoutRequest>,
) -> Result<Json<serde_json::Value>> {
    // Validate JSON before persisting
    let parsed: serde_json::Value = serde_json::from_str(&body.layout_json)
        .map_err(|e| AppError::BadRequest(format!("invalid layout JSON: {e}")))?;

    // Only allow known layout keys so users can't stash arbitrary data.
    // The layoutJson container also holds docking layout (`layout`) and theme (`theme`).
    let allowed_keys = ["layout", "theme", "railDensity", "railSide"];
    if let Some(obj) = parsed.as_object() {
        for key in obj.keys() {
            if !allowed_keys.contains(&key.as_str()) {
                return Err(AppError::BadRequest(format!(
                    "unknown layout key: {key}"
                )));
            }
        }
    }

    let _ = state
        .wdb
        .upsert_user_layout(auth.user_id as u64, &body.layout_json)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct SaveLayoutRequest {
    layout_json: String,
}

const DEFAULT_THEME_JSON: &str = r#"{
    "theme_id": "dark",
    "custom_theme": null,
    "uniform_font_enabled": 0,
    "uniform_font_family": null,
    "uniform_font_size": null,
    "uniform_font_weight": null,
    "uniform_font_style": null
}"#;

async fn get_theme(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    let stored = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let value = stored
        .and_then(|layout| serde_json::from_str::<serde_json::Value>(&layout.layout_json).ok())
        .and_then(|value| value.get("theme").cloned().or(Some(value)))
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_THEME_JSON).expect("valid default theme"));
    Ok(Json(value))
}

async fn save_theme(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let object = body.as_object().ok_or_else(|| {
        AppError::BadRequest("theme preferences must be a JSON object".into())
    })?;
    let allowed = [
        "theme_id", "custom_theme", "uniform_font_enabled", "uniform_font_family",
        "uniform_font_size", "uniform_font_weight", "uniform_font_style",
    ];
    let filtered = object
        .iter()
        .filter(|(key, _)| allowed.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    let theme = serde_json::Value::Object(filtered.clone());
    let layout = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let layout_value = layout
        .and_then(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let combined = if layout_value.get("layout").is_some() || layout_value.get("theme").is_some() {
        serde_json::json!({
            "layout": layout_value.get("layout").cloned().unwrap_or(serde_json::json!({})),
            "theme": theme,
        })
    } else {
        serde_json::json!({ "layout": layout_value, "theme": theme })
    };
    let json = serde_json::to_string(&combined)
        .map_err(|error| AppError::BadRequest(format!("invalid theme preferences: {error}")))?;
    state.wdb.upsert_user_layout(auth.user_id as u64, &json).await?;
    Ok(Json(serde_json::Value::Object(filtered)))
}

async fn reset_theme(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    let layout = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let layout_value = layout
        .and_then(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json).ok())
        .and_then(|value| value.get("layout").cloned().or(Some(value)))
        .unwrap_or_else(|| serde_json::json!({}));
    let combined = serde_json::json!({ "layout": layout_value, "theme": serde_json::from_str::<serde_json::Value>(DEFAULT_THEME_JSON).expect("valid default theme") });
    state.wdb.upsert_user_layout(auth.user_id as u64, &serde_json::to_string(&combined).map_err(|error| AppError::BadRequest(error.to_string()))?).await?;
    Ok(Json(serde_json::from_str(DEFAULT_THEME_JSON).expect("valid default theme")))
}

async fn get_profile_media(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    let stored = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let media = stored
        .and_then(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json).ok())
        .and_then(|value| value.get("profile_media").cloned())
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(Json(media))
}

async fn save_profile_media(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(media): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let media = media
        .as_object()
        .ok_or_else(|| AppError::BadRequest("profile media must be a JSON object".into()))?;
    let allowed = ["banner_url", "overlay_url"];
    let filtered = media
        .iter()
        .filter(|(key, _)| allowed.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    let existing = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let root = existing
        .and_then(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let combined = serde_json::json!({
        "layout": root.get("layout").cloned().unwrap_or_else(|| root.clone()),
        "theme": root.get("theme").cloned().unwrap_or_else(|| serde_json::json!({})),
        "profile_media": filtered,
    });
    let serialized = serde_json::to_string(&combined)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    state.wdb.upsert_user_layout(auth.user_id as u64, &serialized).await?;
    Ok(Json(serde_json::Value::Object(media.clone())))
}


