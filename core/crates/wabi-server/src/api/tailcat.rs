//! Tailcat private-access addon routes (`/api/addons/tailcat/...`).
//!
//! Contract (docs/plans/2026-09-01-tailcat-private-access.md):
//! - turning ON requires an explicit `{confirm: true}` body (cognitive
//!   friction — plain-language consequences live in the admin panel UI);
//! - turning OFF is an instant kill-switch with no ceremony;
//! - members register their own client keys (self-service, AuthUser);
//!   only admins list/revoke keys;
//! - `/connect` gives a member their dial address iff the pipe is enabled
//!   AND they hold a registered key — pipe possession is never auth.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;

use super::admin::admin_auth;

/// Map an admin_auth rejection to the AppError with the same status code.
fn gate(resp: axum::response::Response) -> AppError {
    match resp.status() {
        axum::http::StatusCode::FORBIDDEN => AppError::Forbidden("Admin access required".into()),
        _ => AppError::Unauthorized("Authentication required".into()),
    }
}

#[derive(Debug, Deserialize)]
struct EnableRequest {
    confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterKeyRequest {
    public_key: String,
    label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectInfo {
    enabled: bool,
    registered: bool,
    address: Option<String>,
    /// The port clients dial THROUGH the pipe (the forwarder port, not the
    /// public server port) — e.g. http://server.tailcat:<pipePort>.
    pipe_port: u16,
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/audit", get(audit_tail))
        .route("/enable", post(enable))
        .route("/disable", post(disable))
        .route("/keys", get(list_keys).post(register_key))
        .route("/keys/{key_id}", delete(revoke_key))
        .route("/connect", get(connect_info))
        .with_state(state)
}

/// GET /api/addons/tailcat/status — admin-only snapshot.
async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    let snap = state.tailcat.status().await;
    Ok(Json(json!({
        "enabled": snap.enabled,
        "running": snap.running,
        "address": snap.address,
        "pipePort": snap.pipe_port,
        "serverPort": snap.server_port,
        "binaryPath": snap.binary_path,
        "binaryVersion": snap.binary_version,
        "keys": snap.keys,
        "lastError": snap.last_error,
        "startedAt": snap.started_at,
    })))
}

/// GET /api/addons/tailcat/audit — admin-only audit tail (who/what/when).
async fn audit_tail(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    Ok(Json(json!({ "entries": state.tailcat.audit_tail(50) })))
}

/// POST /api/addons/tailcat/enable — admin + explicit confirm.
async fn enable(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<EnableRequest>>,
) -> Result<Json<serde_json::Value>> {
    admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    let confirmed = body
        .and_then(|Json(req)| (req.confirm).then_some(()))
        .is_some();
    if !confirmed {
        return Err(AppError::BadRequest(
            "Explicit confirmation required: POST {\"confirm\": true}".into(),
        ));
    }
    let actor = admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    let snap = state
        .tailcat
        .set_enabled(true, actor)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "enabled": snap.enabled, "running": snap.running, "address": snap.address, "lastError": snap.last_error })))
}

/// POST /api/addons/tailcat/disable — instant kill-switch, no confirm.
async fn disable(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    let actor = admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    let snap = state
        .tailcat
        .set_enabled(false, actor)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "enabled": snap.enabled, "running": snap.running })))
}

/// GET /api/addons/tailcat/keys — admin-only list.
async fn list_keys(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    Ok(Json(json!({ "keys": state.tailcat.keys() })))
}

/// POST /api/addons/tailcat/keys — a member registers their own client key.
async fn register_key(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterKeyRequest>,
) -> Result<Json<serde_json::Value>> {
    let record = state
        .tailcat
        .register_key(auth.user_id, req.public_key, req.label)
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(Json(json!({
        "id": record.id,
        "userId": record.user_id,
        "publicKey": record.public_key,
        "label": record.label,
        "createdAt": record.created_at,
    })))
}

/// DELETE /api/addons/tailcat/keys/{key_id} — admin-only revocation.
async fn revoke_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let actor = admin_auth(&headers, &state)
        .await
        .map_err(gate)?;
    state
        .tailcat
        .revoke_key(&key_id, actor)
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(Json(json!({ "revoked": key_id })))
}

/// GET /api/addons/tailcat/connect — member connection info.
async fn connect_info(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ConnectInfo>> {
    let address = state.tailcat.address_for(auth.user_id).await;
    let registered = state
        .tailcat
        .keys()
        .iter()
        .any(|k| k.user_id == auth.user_id);
    let enabled = state.tailcat.status().await.enabled;
    let pipe_port = state.tailcat.pipe_port();
    Ok(Json(ConnectInfo {
        enabled,
        registered,
        address,
        pipe_port,
    }))
}
