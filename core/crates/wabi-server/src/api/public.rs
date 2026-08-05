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
fn load_frontend_metadata_policy(data_dir: &str) -> Value {
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

/// Launch page configuration — legacy `{title, description, icon_url,
/// theme_color}` fields plus the LaunchPageConfig fields the frontend merges
/// into saved-server branding. `enabled` intentionally stays false until a
/// dedicated launch config exists; the emergent server identity fields are
/// still served so saved-server name/icon/banner/tagline resolve.
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
        .unwrap_or("/wabi-logo-small.webp")
        .to_string();
    let accent = policy
        .get("accentColor")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("#5865F2")
        .to_string();

    Ok(Json(serde_json::json!({
        "title": name,
        "description": sub,
        "icon_url": icon,
        "theme_color": accent,
        "enabled": false,
        "brandName": name,
        "headline": null,
        "subheadline": sub,
        "logoUrl": icon,
        "backgroundImageUrl": null,
        "customCss": null,
        "heroImageUrl": banner,
        "heroTitle": null,
        "heroBody": null,
        "heroPrimaryCtaLabel": null,
        "heroPrimaryCtaUrl": null,
        "highlights": [],
        "footerNote": null,
        "palette": { "accent": accent }
    })))
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