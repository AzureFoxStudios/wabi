//! Warm standby snapshot endpoints.
//!
//! These endpoints deliberately accept and produce only encrypted snapshot
//! envelopes. There is no plaintext receive path: operators can debug
//! manifests/hashes, but full snapshot row data must remain age-encrypted.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

use crate::{
    error::{AppError, Result},
    nodes::{HelperNode, NodeCapability, NodeRegistryError},
    standby::{
        encrypt_to_recipient_b64, EncryptedSnapshotEnvelope, SnapshotManifest, SnapshotStore,
        SnapshotStoreError, SNAPSHOT_ENCRYPTION_ALGORITHM,
    },
    state::AppState,
};

const NODE_ID_HEADER: &str = "x-wabi-node-id";
const NODE_SECRET_HEADER: &str = "x-wabi-node-secret";

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
    /// Registered standby/backup node id. If `recipientPublicKey` is omitted,
    /// this node's registered public key is used as the age recipient.
    recipient_node_id: String,
    #[serde(default)]
    recipient_public_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StandbyStatusResponse {
    authority_node_id: String,
    standby_nodes: Vec<HelperNode>,
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
        .filter(|node| is_standby_capable(node))
        .collect();
    Ok(Json(StandbyStatusResponse {
        authority_node_id: state.config.node_id.clone(),
        standby_nodes: nodes,
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
) -> Result<Json<EncryptedSnapshotEnvelope>> {
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

    let recipient_public_key = req
        .recipient_public_key
        .unwrap_or_else(|| recipient_node.public_key.clone());
    if recipient_public_key.trim().is_empty() {
        return Err(AppError::BadRequest(
            "standby recipient public key is required".into(),
        ));
    }

    let payload = state.stdb.export_live_state_snapshot_rows().await?;
    let plaintext = serde_json::to_vec(&payload)
        .map_err(|error| AppError::Internal(format!("snapshot serialization failed: {error}")))?;
    let encrypted_payload_b64 = encrypt_to_recipient_b64(&plaintext, &recipient_public_key)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let encrypted_payload = base64::engine::general_purpose::STANDARD
        .decode(&encrypted_payload_b64)
        .map_err(|error| AppError::Internal(format!("snapshot base64 decode failed: {error}")))?;
    let manifest = SnapshotManifest::new_live_state(
        state.config.node_id.clone(),
        recipient_node.node_id,
        &encrypted_payload,
        SNAPSHOT_ENCRYPTION_ALGORITHM,
    );

    Ok(Json(EncryptedSnapshotEnvelope {
        manifest,
        encrypted_payload_b64,
    }))
}

async fn manual_import_stub() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "manual standby import/restore is intentionally not implemented yet",
            "reason": "restore must be an explicit operator flow that validates schema, retention semantics, and target authority state before touching STDB"
        })),
    )
}

async fn manual_promote_stub() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "manual standby promotion is intentionally not implemented yet",
            "reason": "no automatic failover; promotion must be an explicit operator action with a runbook"
        })),
    )
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
