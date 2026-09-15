//! Warm standby snapshot endpoints.
//!
//! These endpoints deliberately accept only encrypted snapshot envelopes for
//! storage. WabiDB does not yet have a deletion-safe live-state exporter and
//! importer, so export/restore/promotion fail closed instead of returning an
//! empty envelope that could be mistaken for a valid backup.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

use crate::{
    auth_extractor::authenticate_access_token,
    error::{AppError, Result},
    nodes::{HelperNode, NodeCapability, NodeRegistryError},
    standby::{EncryptedSnapshotEnvelope, SnapshotStore, SnapshotStoreError},
    state::AppState,
};

const NODE_ID_HEADER: &str = "x-wabi-node-id";
const NODE_SECRET_HEADER: &str = "x-wabi-node-secret";
const STANDBY_NOT_READY_REASON: &str = "WabiDB live-state export/import is not implemented yet; Wabi will not claim an empty or raw-history snapshot is a recoverable backup";

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/snapshots", post(receive_snapshot))
        .route("/snapshots/export", post(export_snapshot))
        .route("/snapshots/import", post(manual_import_stub))
        .route("/promote", post(manual_promote_stub))
        .route("/status", get(status))
        .with_state(state)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiveSnapshotResponse {
    ok: bool,
    snapshot_id: String,
    stored_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSnapshotRequest {
    /// Registered standby/backup node id. The request is still validated now
    /// so callers cannot accidentally build automation around an unknown node.
    recipient_node_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    recipient_public_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StandbyStatusResponse {
    authority_node_id: String,
    standby_nodes: Vec<HelperNode>,
    snapshot_receive_ready: bool,
    snapshot_export_ready: bool,
    manual_restore_ready: bool,
    manual_promotion_ready: bool,
    automatic_failover: bool,
    status_note: &'static str,
}

async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<StandbyStatusResponse>> {
    require_admin(&state, &headers).await?;
    let nodes = state
        .node_registry
        .list_nodes()
        .await
        .into_iter()
        .filter(is_standby_capable)
        .collect();
    Ok(Json(StandbyStatusResponse {
        authority_node_id: state.config.node_id.clone(),
        standby_nodes: nodes,
        // Encrypted envelopes can be stored and validated today. Wabi itself
        // does not yet create a complete WabiDB live-state envelope.
        snapshot_receive_ready: true,
        snapshot_export_ready: false,
        manual_restore_ready: false,
        manual_promotion_ready: false,
        automatic_failover: false,
        status_note: STANDBY_NOT_READY_REASON,
    }))
}

async fn receive_snapshot(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(envelope): Json<EncryptedSnapshotEnvelope>,
) -> Result<Json<ReceiveSnapshotResponse>> {
    let node = require_standby_node(&state, &headers).await?;

    if envelope.manifest.encryption.recipient_node_id != node.node_id {
        return Err(AppError::BadRequest(
            "snapshot recipient did not match authenticated standby node".into(),
        ));
    }

    let store = SnapshotStore::for_data_dir(PathBuf::from(&state.config.data_dir));
    let path = store
        .store_encrypted(&envelope)
        .await
        .map_err(snapshot_store_error_to_app_error)?;

    state
        .node_registry
        .record_standby_snapshot(&node.node_id, &envelope.manifest.snapshot_id, "received")
        .await
        .map_err(registry_error_to_app_error)?;

    Ok(Json(ReceiveSnapshotResponse {
        ok: true,
        snapshot_id: envelope.manifest.snapshot_id,
        stored_path: path.to_string_lossy().to_string(),
    }))
}

async fn export_snapshot(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ExportSnapshotRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    require_admin(&state, &headers).await?;

    let recipient_node = state
        .node_registry
        .list_nodes()
        .await
        .into_iter()
        .find(|node| node.node_id == req.recipient_node_id)
        .ok_or_else(|| AppError::NotFound("standby node not found".into()))?;

    if !is_standby_capable(&recipient_node) {
        return Err(AppError::BadRequest(
            "recipient node does not have standby or backup capability".into(),
        ));
    }

    // Previous code encrypted an empty BTreeMap and returned HTTP 200. That
    // looked like a usable backup while containing none of the WabiDB state.
    // Fail closed until a live-state exporter can snapshot current retained
    // projections without preserving deleted/history-only data.
    Ok((
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "standby snapshot export is not ready for WabiDB",
            "recipientNodeId": recipient_node.node_id,
            "reason": STANDBY_NOT_READY_REASON,
            "automaticFailover": false
        })),
    ))
}

async fn manual_import_stub(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    require_admin(&state, &headers).await?;
    Ok((
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "manual standby import/restore is not implemented yet",
            "reason": STANDBY_NOT_READY_REASON,
            "automaticFailover": false
        })),
    ))
}

async fn manual_promote_stub(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<serde_json::Value>)> {
    require_admin(&state, &headers).await?;
    Ok((
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "manual standby promotion is not implemented yet",
            "reason": "promotion remains an explicit operator action; automatic election is intentionally disabled to avoid split-brain",
            "automaticFailover": false
        })),
    ))
}

async fn require_standby_node(state: &Arc<AppState>, headers: &HeaderMap) -> Result<HelperNode> {
    let node_id = headers
        .get(NODE_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing x-wabi-node-id".into()))?;
    let node_secret = headers
        .get(NODE_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing x-wabi-node-secret".into()))?;

    let node = state
        .node_registry
        .authenticate_node(node_id, node_secret)
        .await
        .map_err(registry_error_to_app_error)?;
    if !is_standby_capable(&node) {
        return Err(AppError::Unauthorized(
            "node is not registered with standby or backup capability".into(),
        ));
    }
    Ok(node)
}

async fn require_admin(state: &Arc<AppState>, headers: &HeaderMap) -> Result<()> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("valid auth token required".into()))?;
    let auth = authenticate_access_token(state, token).await?;
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("admin access required".into()));
    }
    Ok(())
}

fn is_standby_capable(node: &HelperNode) -> bool {
    node.capabilities.contains(&NodeCapability::Standby)
        || node.capabilities.contains(&NodeCapability::Backup)
}

fn snapshot_store_error_to_app_error(error: SnapshotStoreError) -> AppError {
    match error {
        SnapshotStoreError::Validation(_)
        | SnapshotStoreError::InvalidBase64(_)
        | SnapshotStoreError::UnsupportedEncryption
        | SnapshotStoreError::AlgorithmMismatch { .. }
        | SnapshotStoreError::PayloadHashMismatch
        | SnapshotStoreError::UnsafeSnapshotId => AppError::BadRequest(error.to_string()),
        SnapshotStoreError::Persistence(_) => AppError::Internal(error.to_string()),
    }
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
