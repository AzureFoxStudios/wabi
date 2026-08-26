//! Public routes (no authentication required)

use axum::{extract::State, Json, Router};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::Result;
use crate::state::AppState;

/// Create public router
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/launch-page", axum::routing::get(get_launch_page))
        .route(
            "/frontend-app-metadata",
            axum::routing::get(get_frontend_metadata),
        )
        .route(
            "/backend-endpoints",
            axum::routing::get(get_backend_endpoints),
        )
        .route("/auth-policy", axum::routing::get(get_auth_policy))
        .with_state(state)
}

// Also wire /api/setup/status under the api router (called on every page load)
pub fn setup_routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", axum::routing::get(get_setup_status))
        .with_state(state)
}

/// Load the stored `frontend_app_metadata` admin policy (same file the admin
/// routes persist to). Falls back to an empty policy so the frontend contract
/// is always well-formed, never a hardcoded shape that hides user data.
pub(crate) fn load_frontend_metadata_policy(data_dir: &str) -> Value {
    let path = PathBuf::from(data_dir).join("admin_policies.json");
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(map) = serde_json::from_str::<serde_json::Map<String, Value>>(&s) {
            if let Some(policy) = map.get("frontend_app_metadata") {
                return policy.clone();
            }
        }
    }
    serde_json::json!({
        "displayName": null,
        "iconUrl": null,
        "bannerUrl": null,
        "accentColor": null,
        "description": null,
        "tagline": null,
        "launchPageFallbackEnabled": true
    })
}

/// Frontend app metadata — serves the admin-edited server identity
/// (name, icon, banner, accent, tagline) merged with app/version info.
async fn get_frontend_metadata(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>> {
    let policy = load_frontend_metadata_policy(&state.config.data_dir);
    let mut body = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "api_version": "1.0",
        "features": ["chat", "voice"],
    });
    if let (Some(src), Some(dst)) = (policy.as_object(), body.as_object_mut()) {
        for (key, value) in src {
            dst.insert(key.clone(), value.clone());
        }
    }
    Ok(Json(body))
}

/// Launch page configuration — identity fields (name/icon/banner/tagline)
/// are always served for boot + login chrome. `enabled` is only true when
/// the host actually authored a launch *story* (headline, CTA, highlights,
/// custom CSS). A logo or banner alone must not open the empty glass panel.
async fn get_launch_page(State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    let policy = load_frontend_metadata_policy(&state.config.data_dir);

    let name = policy
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Wabi")
        .to_string();
    let sub = policy
        .get("tagline")
        .and_then(Value::as_str)
        .or_else(|| policy.get("description").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .unwrap_or("Self-hosted communication platform")
        .to_string();
    let icon = policy
        .get("iconUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("/icon.png")
        .to_string();
    let banner = policy
        .get("bannerUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let accent = policy
        .get("accentColor")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("#5865F2")
        .to_string();
    let headline = policy
        .get("headline")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let hero_title = policy
        .get("heroTitle")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let hero_cta = policy
        .get("heroPrimaryCtaLabel")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let has_highlights = policy
        .get("highlights")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let has_custom_css = policy
        .get("customCss")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let launch_enabled = policy
        .get("launchPageEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || hero_title.is_some()
        || headline.is_some()
        || hero_cta.is_some()
        || has_highlights
        || has_custom_css;

    Ok(Json(serde_json::json!({
        "title": name,
        "description": sub,
        "icon_url": icon,
        "theme_color": accent,
        "enabled": launch_enabled,
        "brandProfile": policy.get("brandProfile").cloned().unwrap_or(Value::Null),
        "brandName": name,
        "headline": headline,
        "subheadline": sub,
        "logoUrl": icon,
        "backgroundImageUrl": banner,
        "customCss": policy.get("customCss").cloned().unwrap_or(Value::Null),
        "heroImageUrl": if launch_enabled { banner.clone() } else { None },
        "heroTitle": hero_title,
        "heroBody": policy.get("heroBody").cloned().unwrap_or(Value::Null),
        "heroPrimaryCtaLabel": hero_cta,
        "heroPrimaryCtaUrl": policy.get("heroPrimaryCtaUrl").cloned().unwrap_or(Value::Null),
        "highlights": policy.get("highlights").cloned().unwrap_or(Value::Array(vec![])),
        "footerNote": policy.get("footerNote").cloned().unwrap_or(Value::Null),
        "palette": { "accent": accent }
    })))
}

/// Compose the compact boot-brand JSON that `serve_static` injects into the
/// embedded index.html (Phase 1 boot optimization). Field extraction mirrors
/// `get_launch_page` exactly so the two can never drift.
///
/// Returns `None` when displayName AND iconUrl AND accentColor are all unset
/// (stock Wabi) — the caller then serves the embedded file untouched.
pub fn build_boot_brand_json(policy: &Value) -> Option<String> {
    let name = policy
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let icon = policy
        .get("iconUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let accent = policy
        .get("accentColor")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if name.is_none() && icon.is_none() && accent.is_none() {
        return None;
    }
    // Same launch-story expression as get_launch_page.
    let launch_enabled = policy
        .get("launchPageEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || policy
            .get("heroTitle")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        || policy
            .get("headline")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        || policy
            .get("heroPrimaryCtaLabel")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        || policy
            .get("highlights")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
        || policy
            .get("customCss")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());

    let json = serde_json::to_string(&serde_json::json!({
        "brandName": name.unwrap_or(""),
        "logoUrl": icon.unwrap_or(""),
        "accent": accent.unwrap_or(""),
        "launchEnabled": launch_enabled,
    }))
    .ok()?;
    // Make the payload safe to embed inside an inline <script> block: the
    // HTML parser closes the element at the first `</script` regardless of
    // JS string context. `\uXXXX` escapes are valid JSON *and* JS, so this
    // changes nothing for well-formed values and neutralizes breakout via
    // admin-entered strings like `</script><script>alert(1)</script>`.
    Some(
        json.replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('&', "\\u0026"),
    )
}

async fn get_auth_policy(State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    let path = PathBuf::from(&state.config.data_dir).join("admin_policies.json");
    let policy = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok())
        .and_then(|map| map.get("auth_policy").cloned())
        .unwrap_or_else(|| serde_json::json!({
            "mode": "open",
            "allowGuest": true,
            "allowRegister": true,
            "emailVerifyRequired": false
        }));
    Ok(Json(policy))
}

async fn get_backend_endpoints(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>> {
    Ok(Json(serde_json::json!({
        "api": "/api",
        "socket": "/socket.io",
        "health": "/health"
    })))
}

async fn get_setup_status(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let needs_setup = state.needs_setup().await;
    Ok(Json(serde_json::json!({
        "setupRequired": needs_setup
    })))
}