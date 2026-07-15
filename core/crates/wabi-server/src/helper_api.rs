//! Helper-side LAN-facing API (Phase 5D).
//!
//! When a helper advertises `--lan-reachable-at`, it starts a minimal axum
//! listener on that address.  Incoming requests from LAN clients must present
//! a `SignedLocalRouteToken` (minted by the primary) in the
//! `x-wabi-local-route-token` header.  The helper verifies the HMAC signature
//! using the same JWT secret as the authority, so it can accept traffic without
//! phoning home.
//!
//! Currently this endpoint is just a verification gate (skeleton).  Future
//! iterations can add actual blob relay, media room proxy, or cache read
//! handlers guarded by the token.

use axum::{
    extract::{Query, Request},
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tracing::{error, info, warn};

use crate::lan::{verify_token, SignedLocalRouteToken};

/// Shared state for the helper API.
pub struct HelperApiState {
    /// The HMAC secret (same as the authority's JWT secret).
    pub jwt_secret: String,
}

/// Information returned by the health / introspection endpoint.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenVerifyResponse {
    pub valid: bool,
    pub node_id: String,
    pub capability: String,
    pub resource_id: String,
    pub expires_at: i64,
    pub user_id: i64,
}

/// Start the helper-side API listener on `bind_addr`.
///
/// Returns the bound [`tokio::task::JoinHandle`] so the caller can await
/// shutdown or select! against it.
pub fn start_helper_api(bind_addr: SocketAddr, jwt_secret: String) -> tokio::task::JoinHandle<()> {
    let state = Arc::new(HelperApiState { jwt_secret });
    let app = Router::new()
        .route("/health", get(health_check))
        .route("/verify-token", get(verify_token_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            extract_and_validate_token,
        ))
        .with_state(state);

    let handle = tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(bind_addr).await {
            Ok(l) => l,
            Err(e) => {
                error!("[helper-api] Failed to bind {}: {}", bind_addr, e);
                return;
            }
        };
        info!("[helper-api] Listening on {}", bind_addr);
        if let Err(e) = axum::serve(listener, app).await {
            error!("[helper-api] Server error: {}", e);
        }
    });

    handle
}

/// Health check endpoint (no token required).
async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "mode": "helper" }))
}

/// Parse and verify the token from the query parameter `token`.
async fn verify_token_handler(
    axum::extract::State(state): axum::extract::State<Arc<HelperApiState>>,
    Query(params): Query<TokenQuery>,
) -> Result<Json<TokenVerifyResponse>, StatusCode> {
    let token: SignedLocalRouteToken =
        serde_json::from_str(&params.token).map_err(|_| StatusCode::BAD_REQUEST)?;

    if !verify_token(&state.jwt_secret, &token) {
        warn!("[helper-api] Token signature verification failed");
        return Err(StatusCode::FORBIDDEN);
    }

    let now = chrono::Utc::now().timestamp();
    if token.expires_at < now {
        warn!("[helper-api] Token expired");
        return Err(StatusCode::FORBIDDEN);
    }

    Ok(Json(TokenVerifyResponse {
        valid: true,
        node_id: token.node_id,
        capability: token.capability.to_string(),
        resource_id: token.resource_id,
        expires_at: token.expires_at,
        user_id: token.user_id,
    }))
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: String,
}

/// Middleware: look for `x-wabi-local-route-token` header, verify it,
/// and inject the decoded token into request extensions so downstream
/// handlers can read it.
///
/// Non-`/health` requests without a valid token get 403.
async fn extract_and_validate_token(
    axum::extract::State(state): axum::extract::State<Arc<HelperApiState>>,
    req: Request,
    next: Next,
) -> impl IntoResponse {
    // Health check bypasses token validation.
    let path = req.uri().path();
    if path == "/health" {
        return next.run(req).await;
    }

    let token_header = match req.headers().get("x-wabi-local-route-token") {
        Some(h) => match h.to_str() {
            Ok(s) => s.to_string(),
            Err(_) => {
                warn!("[helper-api] Invalid token header encoding");
                return StatusCode::BAD_REQUEST.into_response();
            }
        },
        None => {
            warn!("[helper-api] Missing x-wabi-local-route-token header");
            return StatusCode::FORBIDDEN.into_response();
        }
    };

    let token: SignedLocalRouteToken = match serde_json::from_str(&token_header) {
        Ok(t) => t,
        Err(e) => {
            warn!("[helper-api] Token JSON parse error: {}", e);
            return StatusCode::BAD_REQUEST.into_response();
        }
    };

    if !verify_token(&state.jwt_secret, &token) {
        warn!("[helper-api] Token signature verification failed");
        return StatusCode::FORBIDDEN.into_response();
    }

    let now = chrono::Utc::now().timestamp();
    if token.expires_at < now {
        warn!("[helper-api] Token expired");
        return StatusCode::FORBIDDEN.into_response();
    }

    // Token is valid — inject it for downstream use.
    let mut req = req;
    req.extensions_mut().insert(token);
    next.run(req).await
}
