//! LAN acceleration routes (Phase 5).
//!
//! A client on the same network as a helper can ask the authority for a
//! signed local-route token.  The authority picks a **currently-online**
//! helper that has reported a LAN address and mints a short-lived token.
//!
//! Routes
//! - GET /api/lan/discover
//!   → returns list of LAN-reachable helpers currently online
//! - GET /api/lan/route?capability=blob_download&resourceId=xxx
//!   → returns `SignedLocalRouteToken` or 204 (no LAN helper available)
//!
//! Phase 5C mDNS augmentation: discover via registry + local mDNS browse.
//! Phase 5B (mDNS helper registration) is done.  Phase 5D (helper-side token
//! verification) lives in `helper_api.rs`.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    auth_extractor::AuthUser,
    lan::{sign_token, LocalCapability, SignedLocalRouteToken},
    state::AppState,
};

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RouteRequest {
    pub capability: String,
    pub resource_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResponse {
    pub token: SignedLocalRouteToken,
}

// ---------------------------------------------------------------------------
// Discover response
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHelperInfo {
    pub node_id: String,
    pub display_name: String,
    pub endpoint: String,
    pub capabilities: Vec<String>,
    pub last_seen_secs_ago: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResponse {
    /// Number of online helpers reachable on the LAN
    pub count: usize,
    /// List of helpers
    pub helpers: Vec<LanHelperInfo>,
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/discover", get(get_lan_discover))
        .route("/route", get(get_lan_route))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn get_lan_route(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Query(req): Query<RouteRequest>,
) -> Result<Json<RouteResponse>, LanRouteError> {
    // Decode capability
    let capability: LocalCapability = req
        .capability
        .parse()
        .map_err(|e: String| LanRouteError::BadRequest(e))?;

    // 1.  Find an online LAN-reachable helper
    let nodes = state.node_registry.list_nodes().await;
    let candidate = nodes
        .iter()
        .find(|n| n.status == crate::nodes::NodeStatus::Online && n.lan_reachable_at.is_some());

    let Some(node) = candidate else {
        return Err(LanRouteError::NoLanHelper);
    };

    let node_endpoint = node
        .lan_reachable_at
        .clone()
        .unwrap_or_else(|| "http://unknown".into());

    let now = chrono::Utc::now().timestamp();
    let expires = now + 300; // 5-minute token

    let mut token = SignedLocalRouteToken {
        authority_node_id: state
            .node_registry
            .authority_node_id()
            .unwrap_or_else(|| "wabi-local")
            .to_string(),
        node_id: node.node_id.clone(),
        node_endpoint,
        capability,
        resource_id: req.resource_id,
        user_id: _auth.user_id,
        issued_at: now,
        expires_at: expires,
        signature: String::new(),
    };

    // Sign with the server's JWT secret (re-used as HMAC key)
    sign_token(&state.config.jwt_secret, &mut token);

    Ok(Json(RouteResponse { token }))
}

// ---------------------------------------------------------------------------
// Discover LAN helpers
// ---------------------------------------------------------------------------

async fn get_lan_discover(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
) -> Json<DiscoverResponse> {
    let nodes = state.node_registry.list_nodes().await;
    let now = chrono::Utc::now();

    // 1. Registry view: known Online nodes with lan_reachable_at.
    let mut helpers: Vec<LanHelperInfo> = nodes
        .iter()
        .filter(|n| n.status == crate::nodes::NodeStatus::Online && n.lan_reachable_at.is_some())
        .map(|n| {
            let last_seen = n.last_heartbeat_at.unwrap_or_else(|| now);
            let ago = (now - last_seen).num_seconds();
            LanHelperInfo {
                node_id: n.node_id.clone(),
                display_name: n.display_name.clone(),
                endpoint: n.lan_reachable_at.clone().unwrap_or_default(),
                capabilities: n.capabilities.iter().map(|c| c.to_string()).collect(),
                last_seen_secs_ago: ago,
            }
        })
        .collect();

    // 2. mDNS overlay: helpers on the same LAN that might not have heartbeated yet.
    // Phase 5C mDNS augmentation: short sweep so the endpoint remains responsive.
    let registry_node_ids: std::collections::HashSet<&str> =
        nodes.iter().map(|n| n.node_id.as_str()).collect();
    match crate::mdns::browse_wabi_helpers(500).await {
        Ok(overlays) => {
            for (node_id, addr) in overlays {
                if registry_node_ids.contains(node_id.as_str()) {
                    continue; // Registry already knows about this one.
                }
                helpers.push(LanHelperInfo {
                    node_id: node_id.clone(),
                    display_name: "mDNS-discovered".to_string(),
                    endpoint: addr.to_string(),
                    capabilities: vec!["media_relay".to_string()], // broad assumption
                    last_seen_secs_ago: 0,
                });
            }
        }
        Err(e) => {
            tracing::warn!("[lan/discover] mDNS browse failed: {}", e);
        }
    }

    let count = helpers.len();
    Json(DiscoverResponse { count, helpers })
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

pub enum LanRouteError {
    BadRequest(String),
    NoLanHelper,
}

impl IntoResponse for LanRouteError {
    fn into_response(self) -> axum::response::Response {
        match self {
            LanRouteError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            LanRouteError::NoLanHelper => StatusCode::NO_CONTENT.into_response(),
        }
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn lan_route_compiles_with_empty_registry() {
        use crate::nodes::NodeRegistry;
        // Compilation check: ensure the module compiles. Full router tests require
        // a properly wired AppState which is tested at the binary level.
        let _registry = NodeRegistry::new_in_memory("auth-test".into());
    }
}
