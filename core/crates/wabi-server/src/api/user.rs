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

/// Shared REST/realtime validation. Empty values explicitly clear optional text.
pub(crate) fn profile_text(
    value: &serde_json::Value,
    field: &str,
    max: usize,
    clearable: bool,
) -> std::result::Result<String, String> {
    let text = match value {
        serde_json::Value::Null if clearable => "",
        serde_json::Value::String(text) => text.trim(),
        _ => return Err(format!("{field} must be text")),
    };
    if (!clearable && text.is_empty())
        || text.chars().count() > max
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(format!(
            "{field} must be {}text of at most {max} characters without control characters",
            if clearable { "" } else { "nonempty " }
        ));
    }
    Ok(text.to_owned())
}

pub(crate) fn profile_image_url(
    value: &serde_json::Value,
    field: &str,
) -> std::result::Result<String, String> {
    let url = match value {
        serde_json::Value::Null => "",
        serde_json::Value::String(url) => url.trim(),
        _ => return Err(format!("{field} must be an image URL or null")),
    };
    if url.is_empty() {
        return Ok(String::new());
    }
    if url.len() > 2048 || url.chars().any(char::is_control) {
        return Err(format!("invalid {field} image URL"));
    }
    let https = url.starts_with("https://")
        && reqwest::Url::parse(url).is_ok_and(|parsed| parsed.host_str().is_some());
    if !(url.starts_with("/uploads/") || url.starts_with("/api/") || https) {
        return Err(format!(
            "{field} must use an uploaded image path or HTTPS URL"
        ));
    }
    Ok(url.to_owned())
}

pub(crate) fn profile_font(value: &serde_json::Value) -> std::result::Result<String, String> {
    let value = match value {
        serde_json::Value::Null => serde_json::json!({}),
        serde_json::Value::String(family) if family.is_empty() => serde_json::json!({}),
        serde_json::Value::String(family) => serde_json::json!({ "family": family }),
        serde_json::Value::Object(_) => value.clone(),
        _ => return Err("usernameFont must be a style object or legacy font name".into()),
    };
    let object = value.as_object().expect("normalized font object");
    if let Some(key) = object.keys().find(|key| {
        !["design", "preset", "family", "size", "weight", "style"].contains(&key.as_str())
    }) {
        return Err(format!("unknown usernameFont field: {key}"));
    }
    let font: wabi_core::UsernameFont =
        serde_json::from_value(value).map_err(|error| format!("invalid usernameFont: {error}"))?;
    for (field, value, allowed) in [
        (
            "family",
            font.family.as_deref(),
            &[
                "inherit",
                "Arial",
                "Georgia",
                "Times New Roman",
                "Comic Sans MS",
                "Courier New",
                "Trebuchet MS",
                "Verdana",
                "Impact",
                "Palatino",
                "Helvetica",
            ][..],
        ),
        (
            "size",
            font.size.as_deref(),
            &["0.9em", "1em", "1.2em", "1.4em", "16px"][..],
        ),
        (
            "weight",
            font.weight.as_deref(),
            &["400", "500", "600", "700"][..],
        ),
        ("style", font.style.as_deref(), &["normal", "italic"][..]),
        (
            "preset",
            font.preset.as_deref(),
            &["none", "ember", "ocean", "mint", "violet"][..],
        ),
    ] {
        if value.is_some_and(|value| !allowed.contains(&value)) {
            return Err(format!("unsupported usernameFont.{field}"));
        }
    }
    if let Some(design) = &font.design {
        design.validate()?;
    }
    serde_json::to_string(&font).map_err(|error| error.to_string())
}

pub(crate) fn profile_user_patch(
    data: &serde_json::Value,
) -> std::result::Result<wabidb::domain::UserUpdate, String> {
    let mut patch = wabidb::domain::UserUpdate::default();
    if let Some(value) = data.get("username") {
        patch.username = Some(profile_text(value, "username", 32, false)?);
    }
    if let Some(value) = data.get("profilePicture") {
        patch.profile_picture = Some(profile_image_url(value, "profilePicture")?);
    }
    if let Some(value) = data.get("usernameFont") {
        patch.username_font = Some(profile_font(value)?);
    }
    if let Some(value) = data.get("bio") {
        patch.bio = Some(profile_text(value, "bio", 280, true)?);
    }
    if let Some(value) = data.get("statusMessage") {
        patch.status_message = Some(profile_text(value, "statusMessage", 120, true)?);
    }
    if let Some(value) = data.get("color") {
        let color = profile_text(value, "color", 64, true)?;
        patch.color = Some(format!("\0{color}"));
    }
    Ok(patch)
}

/// Merge one container slot without discarding unrelated preferences.
pub(crate) fn merge_user_container(
    root: serde_json::Value,
    key: &str,
    value: serde_json::Value,
) -> serde_json::Value {
    let mut object = match root {
        serde_json::Value::Object(object)
            if object.is_empty()
                || object.keys().any(|key| {
                    [
                        "layout",
                        "theme",
                        "railDensity",
                        "railSide",
                        "background_image",
                        "profile_media",
                    ]
                    .contains(&key.as_str())
                }) =>
        {
            object
        }
        serde_json::Value::Null => serde_json::Map::new(),
        legacy => {
            let mut object = serde_json::Map::new();
            object.insert("layout".into(), legacy);
            object
        }
    };
    object.insert(key.into(), value);
    serde_json::Value::Object(object)
}

pub(crate) fn profile_media_patch(
    data: &serde_json::Value,
    mut existing: serde_json::Map<String, serde_json::Value>,
) -> std::result::Result<serde_json::Map<String, serde_json::Value>, String> {
    for key in ["banner_url", "overlay_url"] {
        if let Some(value) = data.get(key) {
            let url = profile_image_url(value, key)?;
            existing.insert(
                key.into(),
                if url.is_empty() {
                    serde_json::Value::Null
                } else {
                    url.into()
                },
            );
        }
    }
    for (key, min, max) in [
        ("overlay_scale", 0.5, 3.0),
        ("overlay_offset_x", -200.0, 200.0),
        ("overlay_offset_y", -200.0, 200.0),
    ] {
        if let Some(value) = data.get(key) {
            let number = value
                .as_f64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("{key} must be a finite number"))?;
            existing.insert(key.into(), serde_json::json!(number.clamp(min, max)));
        }
    }
    Ok(existing)
}

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
        .route(
            "/layout",
            axum::routing::get(get_layout)
                .put(save_layout)
                .post(save_layout),
        )
        .route("/theme", axum::routing::get(get_theme).post(save_theme))
        .route("/theme/reset", axum::routing::post(reset_theme))
        .route(
            "/profile-media",
            axum::routing::get(get_profile_media).post(save_profile_media),
        )
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
    (
        u.username.clone(),
        u.handle.clone(),
        u.created_at_micros / 1000,
    )
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
    if let Some(user) = state.wdb.get_user(auth.user_id as u64).await? {
        let stored = state.wdb.get_user_layout(auth.user_id as u64).await?;
        let theme = stored
            .and_then(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json).ok())
            .and_then(|root| {
                root.get("theme")
                    .and_then(|theme| theme.get("theme_id"))
                    .cloned()
            });
        Ok(Json(serde_json::json!({
            "displayName": user.username,
            "avatarUrl": user.profile_picture,
            "statusMessage": user.status_message,
            "bio": user.bio,
            "usernameFont": user.username_font.and_then(|font| serde_json::from_str::<serde_json::Value>(&font).ok()),
            "theme": theme,
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
    let mut data = serde_json::Map::new();
    if let Some(value) = req.display_name {
        data.insert("username".into(), value.into());
    }
    if let Some(value) = req.avatar_url {
        data.insert("profilePicture".into(), value.into());
    }
    if let Some(value) = req.status_message {
        data.insert("statusMessage".into(), value.into());
    }
    let patch = profile_user_patch(&serde_json::Value::Object(data.clone()))
        .map_err(AppError::BadRequest)?;
    let theme_patch = if let Some(theme) = req.theme {
        let theme =
            profile_text(&theme.into(), "theme", 128, false).map_err(AppError::BadRequest)?;
        let stored = state.wdb.get_user_layout(auth.user_id as u64).await?;
        let root = stored
            .map(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json))
            .transpose()
            .map_err(|_| AppError::BadRequest("stored settings are invalid".into()))?
            .unwrap_or_else(|| serde_json::json!({}));
        let mut existing_theme = root
            .get("theme")
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        existing_theme.insert("theme_id".into(), theme.into());
        Some(merge_user_container(
            root,
            "theme",
            serde_json::Value::Object(existing_theme),
        ))
    } else {
        None
    };
    if !data.is_empty() {
        state.wdb.update_user(auth.user_id as u64, patch).await?;
    }
    if let Some(root) = theme_patch {
        state
            .wdb
            .upsert_user_layout(auth.user_id as u64, &root.to_string())
            .await?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
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
            username: username.clone(),
            handle: user.handle,
            color: Some(user.color),
            display_name: Some(username),
            avatar_url: user.profile_picture,
            status_message: user.status_message,
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
    // The layoutJson container holds docking layout (`layout`), theme (`theme`),
    // rail chrome (`railDensity`/`railSide`) and profile media
    // (`profile_media` — written by save_profile_media/presence.rs).
    validate_layout_keys(&parsed)?;

    let _ = state
        .wdb
        .upsert_user_layout(auth.user_id as u64, &body.layout_json)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLayoutRequest {
    /// Clients send camelCase `layoutJson` (layoutPersistence.ts /
    /// railLayout.ts). The original snake_case field rejected every PUT with
    /// a 422 ("[Docking] Layout save failed: HTTP error", 2026-08-27 report)
    /// — accept the camelCase name, keep the snake alias for API symmetry.
    #[serde(rename = "layoutJson", alias = "layout_json")]
    layout_json: String,
}

/// Top-level keys allowed inside the shared layoutJson container.
/// Must include every slot the server's own writers store
/// (save_profile_media / socketio presence both persist `profile_media`).
fn validate_layout_keys(parsed: &serde_json::Value) -> Result<()> {
    const ALLOWED_KEYS: [&str; 6] = [
        "layout",
        "theme",
        "railDensity",
        "railSide",
        "profile_media",
        "background_image",
    ];
    if let Some(obj) = parsed.as_object() {
        for key in obj.keys() {
            if !ALLOWED_KEYS.contains(&key.as_str()) {
                return Err(AppError::BadRequest(format!("unknown layout key: {key}")));
            }
        }
    }
    Ok(())
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
    let container: Option<serde_json::Value> = stored
        .and_then(|layout| serde_json::from_str::<serde_json::Value>(&layout.layout_json).ok());
    let top_level_bg = container
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|map| map.get("background_image"))
        .cloned();
    let mut value = container
        .and_then(|value| value.get("theme").cloned().or(Some(value)))
        .unwrap_or_else(|| serde_json::from_str(DEFAULT_THEME_JSON).expect("valid default theme"));
    // Theme-agnostic background: stored at the container top level so it
    // applies under any theme. Merge it into the response so old and new
    // clients can read it without a second roundtrip.
    if let Some(bg) = top_level_bg {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("background_image".to_string(), bg);
        }
    }
    Ok(Json(value))
}

async fn save_theme(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let object = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("theme preferences must be a JSON object".into()))?;
    let allowed = [
        "theme_id",
        "custom_theme",
        "uniform_font_enabled",
        "uniform_font_family",
        "uniform_font_size",
        "uniform_font_weight",
        "uniform_font_style",
        "theme_ambient",
        "background_image",
    ];
    let filtered = object
        .iter()
        .filter(|(key, _)| allowed.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    // Theme-agnostic background: `background_image` lives at the container top
    // level (applies under any theme), NOT inside the `theme` sub-object.
    // Everything else stays inside `theme` as before.
    let background_image = filtered.get("background_image").cloned();
    let mut theme_map = filtered.clone();
    theme_map.remove("background_image");
    let theme = serde_json::Value::Object(theme_map.clone());
    let layout = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let layout_value = layout
        .and_then(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    // Merge INTO the existing container instead of rebuilding it: the same
    // container holds railDensity/railSide (and future slots) — a bare
    // {layout, theme} rebuild silently dropped them, the exact clobber class
    // mergeIntoServerContainer guards against client-side.
    let mut combined = match layout_value {
        serde_json::Value::Object(map) => map,
        // Legacy pre-container payloads (raw dock layout without keys) move
        // under `layout` so the container shape stays normalized.
        other => {
            let mut map = serde_json::Map::new();
            if !other.is_null() {
                map.insert("layout".to_string(), other);
            }
            map
        }
    };
    // Only touch the `theme` sub-object when the request actually carries
    // theme keys: a background-only save ({background_image: {...}} alone)
    // must leave theme_id/custom_theme untouched.
    if !theme_map.is_empty() {
        combined.insert("theme".to_string(), theme);
    }
    // Top-level background: present (object) sets it, explicit null clears it.
    if let Some(bg) = background_image {
        combined.insert("background_image".to_string(), bg);
    }
    let json = serde_json::to_string(&serde_json::Value::Object(combined))
        .map_err(|error| AppError::BadRequest(format!("invalid theme preferences: {error}")))?;
    state
        .wdb
        .upsert_user_layout(auth.user_id as u64, &json)
        .await?;
    Ok(Json(serde_json::Value::Object(filtered)))
}

async fn reset_theme(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    let layout = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let root = layout
        .map(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json))
        .transpose()
        .map_err(|_| AppError::BadRequest("stored settings are invalid".into()))?
        .unwrap_or_else(|| serde_json::json!({}));
    let combined = merge_user_container(
        root,
        "theme",
        serde_json::from_str(DEFAULT_THEME_JSON).expect("valid default theme"),
    );
    state
        .wdb
        .upsert_user_layout(
            auth.user_id as u64,
            &serde_json::to_string(&combined)
                .map_err(|error| AppError::BadRequest(error.to_string()))?,
        )
        .await?;
    Ok(Json(
        serde_json::from_str(DEFAULT_THEME_JSON).expect("valid default theme"),
    ))
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
    let existing = state.wdb.get_user_layout(auth.user_id as u64).await?;
    let root = existing
        .map(|record| serde_json::from_str::<serde_json::Value>(&record.layout_json))
        .transpose()
        .map_err(|_| AppError::BadRequest("stored settings are invalid".into()))?
        .unwrap_or_else(|| serde_json::json!({}));
    let existing_media = root
        .get("profile_media")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let saved_media =
        profile_media_patch(&serde_json::Value::Object(media.clone()), existing_media)
            .map_err(AppError::BadRequest)?;
    let combined = merge_user_container(
        root,
        "profile_media",
        serde_json::Value::Object(saved_media.clone()),
    );
    let serialized = serde_json::to_string(&combined)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    state
        .wdb
        .upsert_user_layout(auth.user_id as u64, &serialized)
        .await?;
    Ok(Json(serde_json::Value::Object(saved_media)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: the frontend PUTs `{ layoutJson: "..." }` (camelCase).
    /// Without `rename_all = "camelCase"` serde expected `layout_json`,
    /// extraction failed, and Axum returned 422 before the handler ran.
    #[test]
    fn save_layout_request_accepts_camel_case_body() {
        let body = r#"{ "layoutJson": "{\"layout\":{}}" }"#;
        let req: SaveLayoutRequest =
            serde_json::from_str(body).expect("camelCase layoutJson must deserialize");
        assert_eq!(req.layout_json, r#"{"layout":{}}"#);
    }

    /// The GET-merge-PUT writers forward every existing container slot, so
    /// the whitelist must accept all server-written keys — including
    /// profile_media (banners/overlays) or saves 400 for those users.
    #[test]
    fn validate_layout_keys_accepts_full_container_and_rejects_unknown() {
        let full: serde_json::Value = serde_json::from_str(
            r#"{ "layout": {}, "theme": {}, "railDensity": "cozy", "railSide": "left", "profile_media": {"banner_url": null} }"#,
        )
        .unwrap();
        assert!(validate_layout_keys(&full).is_ok());

        let unknown: serde_json::Value =
            serde_json::from_str(r#"{ "layout": {}, "arbitrary": 1 }"#).unwrap();
        assert!(validate_layout_keys(&unknown).is_err());
    }
}
