//! Public routes (no authentication required)

use axum::{extract::State, Json, Router};
use serde::Serialize;
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

/// Launch page configuration
#[derive(Serialize)]
struct LaunchPageResponse {
    title: String,
    description: String,
    icon_url: String,
    theme_color: String,
}

/// Get launch page metadata
async fn get_launch_page(State(_state): State<Arc<AppState>>) -> Result<Json<LaunchPageResponse>> {
    Ok(Json(LaunchPageResponse {
        title: "Wabi".to_string(),
        description: "Self-hosted communication platform".to_string(),
        icon_url: "/icon.png".to_string(),
        theme_color: "#5865F2".to_string(),
    }))
}

/// Frontend app metadata
#[derive(Serialize)]
struct FrontendMetadata {
    version: String,
    api_version: String,
    features: Vec<String>,
}

async fn get_frontend_metadata(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<FrontendMetadata>> {
    Ok(Json(FrontendMetadata {
        version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: "1.0".to_string(),
        features: vec!["chat".to_string(), "voice".to_string()],
    }))
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
