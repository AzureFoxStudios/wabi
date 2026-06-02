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
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::Arc, time::Duration};

use crate::{
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
        .route("/{node_id}/heartbeat", post(record_heartbeat))
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
    let node_secret = headers
        .get(NODE_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing x-wabi-node-secret".into()))?;

    let node = state
        .node_registry
        .record_heartbeat(&node_id, node_secret, req)
        .await
        .map_err(registry_error_to_app_error)?;
    Ok(Json(json!({ "ok": true, "node": node })))
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
    Ok(Json(json!({ "ok": true, "node": node })))
}

async fn require_admin(state: &Arc<AppState>, headers: &HeaderMap) -> Result<()> {
    let user_id = claims_from_bearer(headers, &state.config.jwt_secret)
        .ok_or_else(|| AppError::Unauthorized("valid auth token required".into()))?;
    if !state.is_admin(user_id).await {
        return Err(AppError::Unauthorized("admin access required".into()));
    }
    Ok(())
}

fn claims_from_bearer(headers: &HeaderMap, jwt_secret: &str) -> Option<i64> {
    #[derive(serde::Deserialize)]
    struct Claims {
        sub: String,
    }
    let auth = headers.get("authorization")?.to_str().ok()?;
    let token = auth.strip_prefix("Bearer ")?;
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut validation = Validation::default();
    validation.validate_exp = true;
    validation.leeway = 60;
    decode::<Claims>(token, &key, &validation)
        .ok()?
        .claims
        .sub
        .parse()
        .ok()
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
