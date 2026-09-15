//! Helper node registry API.
//!
//! Phase 1 routes are authority-owned helper-node management. They are not
//! federation and not the old `wabi-mesh` addon.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::Arc, time::Duration};

use crate::{
    api::media_node_catalog::{self, MediaNodeAdvertisement},
    auth_extractor::authenticate_access_token,
    error::{AppError, Result},
    nodes::{
        JoinNodeRequest, JoinNodeResponse, NodeCapability, NodeHeartbeatRequest, NodePairingToken,
        NodeRegistryError,
    },
    state::AppState,
};

const NODE_SECRET_HEADER: &str = "x-wabi-node-secret";

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_nodes))
        .route(
            "/pairing-tokens",
            get(list_pairing_tokens).post(create_pairing_token),
        )
        .route("/join", post(join_node))
        .route("/media-advertisements", get(list_media_advertisements))
        .route("/{node_id}/heartbeat", post(record_heartbeat))
        .route(
            "/{node_id}/media-advertisement",
            post(record_media_advertisement),
        )
        .route("/{node_id}/revoke", post(revoke_node))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePairingTokenRequest {
    label: String,
    capabilities: Vec<NodeCapability>,
    #[serde(default = "default_pairing_ttl_seconds")]
    ttl_seconds: u64,
}

fn default_pairing_ttl_seconds() -> u64 {
    15 * 60
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodesResponse<T> {
    items: Vec<T>,
}

async fn list_nodes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    require_admin(&state, &headers).await?;
    let nodes = state.node_registry.list_nodes().await;
    Ok(Json(json!({ "nodes": nodes })))
}

async fn list_media_advertisements(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    require_admin(&state, &headers).await?;
    let catalog = media_node_catalog::global(&state.config.data_dir);
    Ok(Json(json!({ "mediaNodes": catalog.list().await })))
}

async fn list_pairing_tokens(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<NodesResponse<NodePairingToken>>> {
    require_admin(&state, &headers).await?;
    Ok(Json(NodesResponse {
        items: state.node_registry.list_pairing_tokens().await,
    }))
}

async fn create_pairing_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreatePairingTokenRequest>,
) -> Result<Json<NodePairingToken>> {
    require_admin(&state, &headers).await?;
    let token = state
        .node_registry
        .create_pairing_token(
            req.label,
            req.capabilities,
            Duration::from_secs(req.ttl_seconds.max(30).min(24 * 60 * 60)),
        )
        .await
        .map_err(registry_error_to_app_error)?;
    Ok(Json(token))
}

async fn join_node(
    State(state): State<Arc<AppState>>,
    Json(req): Json<JoinNodeRequest>,
) -> Result<Json<JoinNodeResponse>> {
    let joined = state
        .node_registry
        .join_with_token(req)
        .await
        .map_err(registry_error_to_app_error)?;
    Ok(Json(joined))
}

async fn record_heartbeat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
    Json(req): Json<NodeHeartbeatRequest>,
) -> Result<Json<serde_json::Value>> {
    let node_secret = require_node_secret(&headers)?;

    let node = state
        .node_registry
        .record_heartbeat(&node_id, node_secret, req)
        .await
        .map_err(registry_error_to_app_error)?;
    Ok(Json(json!({ "ok": true, "node": node })))
}

async fn record_media_advertisement(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
    Json(req): Json<MediaNodeAdvertisement>,
) -> Result<Json<serde_json::Value>> {
    let node_secret = require_node_secret(&headers)?;
    let node = state
        .node_registry
        .authenticate_node(&node_id, node_secret)
        .await
        .map_err(registry_error_to_app_error)?;
    if !node.capabilities.contains(&NodeCapability::MediaRelay) {
        return Err(AppError::BadRequest(
            "node does not advertise media_relay capability".into(),
        ));
    }

    let catalog = media_node_catalog::global(&state.config.data_dir);
    let record = catalog
        .upsert(&node_id, req)
        .await
        .map_err(AppError::BadRequest)?;
    Ok(Json(json!({ "ok": true, "mediaNode": record })))
}

async fn revoke_node(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(node_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    require_admin(&state, &headers).await?;
    let node = state
        .node_registry
        .revoke_node(&node_id)
        .await
        .map_err(registry_error_to_app_error)?;
    let catalog = media_node_catalog::global(&state.config.data_dir);
    if let Err(error) = catalog.remove(&node_id).await {
        tracing::warn!(node_id, %error, "failed to remove revoked media-node advertisement");
    }
    Ok(Json(json!({ "ok": true, "node": node })))
}

fn require_node_secret(headers: &HeaderMap) -> Result<&str> {
    headers
        .get(NODE_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing x-wabi-node-secret".into()))
}

/// Require an account access credential and the current administrative role.
async fn require_admin(state: &Arc<AppState>, headers: &HeaderMap) -> Result<i64> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("valid auth token required".into()))?;
    let auth = authenticate_access_token(state, token).await?;
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("admin access required".into()));
    }
    Ok(auth.user_id)
}

fn registry_error_to_app_error(error: NodeRegistryError) -> AppError {
    match error {
        NodeRegistryError::PairingTokenNotFound
        | NodeRegistryError::PairingTokenExpired
        | NodeRegistryError::PairingTokenAlreadyUsed
        | NodeRegistryError::InvalidInput(_) => AppError::BadRequest(error.to_string()),
        NodeRegistryError::NodeNotFound => AppError::NotFound(error.to_string()),
        NodeRegistryError::InvalidNodeSecret | NodeRegistryError::NodeRevoked => {
            AppError::Unauthorized(error.to_string())
        }
        NodeRegistryError::Persistence(_) => AppError::Internal(error.to_string()),
    }
}
