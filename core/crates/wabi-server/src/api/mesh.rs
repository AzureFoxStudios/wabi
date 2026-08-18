//! Mesh API endpoints for multi-node coordination

use axum::{extract::State, http::StatusCode, response::Json, routing::get, routing::post};
use serde::Deserialize;
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub(crate) struct HeartbeatPayload {
    node_id: String,
    #[allow(dead_code)]
    is_primary: bool,
    timestamp: i64,
}

/// Get mesh service status
pub async fn get_mesh_status(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !state.is_admin(auth.user_id).await {
        return Err(StatusCode::FORBIDDEN);
    }
    match state.get_mesh_status().await {
        Ok(mesh_status) => Ok(Json(serde_json::json!(mesh_status))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Get mesh configuration
pub async fn get_mesh_config(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !state.is_admin(auth.user_id).await {
        return Err(StatusCode::FORBIDDEN);
    }
    match state.get_mesh_config().await {
        Ok(config) => Ok(Json(serde_json::json!(config))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Receive a heartbeat from a peer node
pub async fn post_heartbeat(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<HeartbeatPayload>,
) -> StatusCode {
    state.record_heartbeat(&payload.node_id, payload.timestamp).await;
    StatusCode::OK
}

/// Mesh API routes
pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/status", get(get_mesh_status))
        .route("/config", get(get_mesh_config))
        .route("/heartbeat", post(post_heartbeat))
        .with_state(state)
}
