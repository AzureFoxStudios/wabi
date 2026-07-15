//! Break-glass operator endpoints.
//!
//! These are reachable ONLY from the loopback interface AND only when a
//! `WABI_OPERATOR_SECRET` is configured. They exist for the "person with
//! console access to the machine" scenario: when the owner is compromised or
//! locked out and recovery codes are unavailable, an operator can reset
//! ownership or revoke all tokens without needing a valid JWT.
//!
//! Because they bypass normal auth, BOTH guards (loopback + operator secret)
//! must pass or the request is rejected.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::state::AppState;
use std::sync::Arc;
use wabidb::engine::wabi_store::WabiStore;

/// Local JSON error helper (operator endpoints are self-contained).
fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

#[derive(Debug, Deserialize)]
struct ResetOwnerInput {
    #[serde(rename = "userId")]
    user_id: i64,
}

#[derive(Debug, Serialize)]
struct OperatorStatus {
    enabled: bool,
    owner_user_id: Option<i64>,
    loopback_only: bool,
}

/// True only when the request originated from the loopback interface.
fn is_loopback(connect_info: ConnectInfo<SocketAddr>) -> bool {
    connect_info.0.ip().is_loopback()
}

/// True only when a operator secret is configured AND matches the request.
fn operator_secret_ok(headers: &HeaderMap) -> bool {
    let Ok(expected) = std::env::var("WABI_OPERATOR_SECRET") else {
        return false;
    };
    if expected.is_empty() {
        return false;
    }
    let Some(provided) = headers
        .get("x-operator-secret")
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    // Constant-time-ish compare to avoid trivial timing leaks.
    if expected.len() != provided.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.bytes().zip(provided.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Guard used by every operator endpoint.
fn operator_auth(
    headers: &HeaderMap,
    connect_info: ConnectInfo<SocketAddr>,
) -> Result<(), Response> {
    if !is_loopback(connect_info) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Operator endpoints are only available from loopback",
        ));
    }
    if !operator_secret_ok(headers) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "Operator secret required (set WABI_OPERATOR_SECRET)",
        ));
    }
    Ok(())
}

async fn operator_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    connect_info: ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(resp) = operator_auth(&headers, connect_info) {
        return resp;
    }
    let owner = *state.owner_user_id.read().await;
    Json(json!(OperatorStatus {
        enabled: true,
        owner_user_id: owner,
        loopback_only: true,
    }))
    .into_response()
}

/// Reset the server owner. Revokes the previous owner's tokens and assigns
/// ownership to `userId`. Intended for true lockout recovery.
async fn reset_owner(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    connect_info: ConnectInfo<SocketAddr>,
    Json(input): Json<ResetOwnerInput>,
) -> Response {
    if let Err(resp) = operator_auth(&headers, connect_info) {
        return resp;
    }
    // Revoke the old owner's sessions so a compromised owner can't immediately
    // re-assert control.
    if let Some(old) = *state.owner_user_id.read().await {
        if old != input.user_id {
            state.revoke_user(old).await;
        }
    }
    // Persist the new owner.
    {
        *state.owner_user_id.write().await = Some(input.user_id);
    }
    if let Err(e) = state.wdb.claim_owner(input.user_id as u64).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to persist owner: {e}"),
        );
    }
    state.revoke_all_tokens().await;
    Json(json!({ "success": true, "owner_user_id": input.user_id })).into_response()
}

/// Revoke every outstanding token (force global re-auth).
async fn revoke_all(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    connect_info: ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(resp) = operator_auth(&headers, connect_info) {
        return resp;
    }
    state.revoke_all_tokens().await;
    Json(json!({ "success": true })).into_response()
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(operator_status))
        .route("/reset-owner", post(reset_owner))
        .route("/revoke-all", post(revoke_all))
        .with_state(state)
}
