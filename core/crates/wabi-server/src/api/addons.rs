//! Addon capability endpoint — single source of truth for enabled addons.
//!
//! `GET /api/addons` returns the compile-time-enabled Rust addons plus their
//! canonical `plugin.json` frontend contribution block (schema: docs/addons/plugin-schema.md).
//!
//! Frontend must call this endpoint (not `/api/plugins`). A3 wires
//! `hasAddonCapability()`; this module only serves the server side.

use axum::{extract::State, Json, Router};
use serde::Serialize;
use std::sync::Arc;

use crate::error::Result;
use crate::state::AppState;

/// Frontend contribution block from the canonical plugin schema.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendContributions {
    pub channel_types: Vec<String>,
    pub workspace_panels: Vec<String>,
    pub settings_pages: Vec<String>,
    pub mobile_tabs: Vec<String>,
}

/// One enabled addon as returned by GET /api/addons.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonCapability {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub backend_runtime: String,
    pub cargo_feature: Option<String>,
    pub permissions: Vec<String>,
    pub frontend: FrontendInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendInfo {
    pub bundled: bool,
    pub contributions: FrontendContributions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonsListResponse {
    pub addons: Vec<AddonCapability>,
}

/// Build the list of addons enabled in *this* binary (compile-time features).
///
/// Manifest field values are embedded here (not read from disk at runtime) so
/// the server binary is self-contained and does not depend on source-tree
/// paths next to the executable. Keep in sync with `core/addons/*/plugin.json`.
fn enabled_addons() -> Vec<AddonCapability> {
    let mut out = Vec::new();

    // mesh — always compiled into wabi-server (non-optional dep)
    out.push(AddonCapability {
        id: "mesh".into(),
        name: "Mesh".into(),
        version: "0.1.0".into(),
        description: "Mesh service for multi-node coordination".into(),
        enabled: true,
        backend_runtime: "rust".into(),
        cargo_feature: None,
        permissions: vec!["network:outbound".into()],
        frontend: FrontendInfo {
            bundled: false,
            contributions: FrontendContributions {
                channel_types: vec![],
                workspace_panels: vec![],
                settings_pages: vec![],
                mobile_tabs: vec![],
            },
        },
    });

    // lore — optional feature `wabi-lore`
    #[cfg(feature = "wabi-lore")]
    out.push(AddonCapability {
        id: "lore".into(),
        name: "Lore".into(),
        version: "0.1.0".into(),
        description: "Version-controlled binary asset storage via Epic Games Lore - for CAD files, 3D models, and large binaries".into(),
        enabled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("wabi-lore".into()),
        permissions: vec![
            "network:outbound".into(),
            "filesystem:read".into(),
            "filesystem:write".into(),
        ],
        frontend: FrontendInfo {
            bundled: false,
            contributions: FrontendContributions {
                // A6 will gate Asset Storage create on this contribution.
                channel_types: vec!["lore".into()],
                workspace_panels: vec![],
                settings_pages: vec![],
                mobile_tabs: vec![],
            },
        },
    });

    // webhooks — optional feature `wabi-webhooks`
    #[cfg(feature = "wabi-webhooks")]
    out.push(AddonCapability {
        id: "webhooks".into(),
        name: "Webhooks".into(),
        version: "0.1.0".into(),
        description: "Webhook service for Wabi - triggers webhooks on events".into(),
        enabled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("wabi-webhooks".into()),
        permissions: vec!["network:outbound".into()],
        frontend: FrontendInfo {
            bundled: false,
            contributions: FrontendContributions {
                channel_types: vec![],
                workspace_panels: vec![],
                settings_pages: vec![],
                mobile_tabs: vec![],
            },
        },
    });

    // payments rails (roadmap Phases 2-4) — optional feature `payments-rails`.
    // The frontend payment catalog is gated on these via hasAddonCapability.
    #[cfg(feature = "wabi-payments-crypto")]
    out.push(AddonCapability {
        id: "payments-crypto".into(),
        name: "Payments - Crypto".into(),
        version: "0.1.0".into(),
        description: "Crypto payment pointers: USDC Base/Solana, USDT Tron, BTC (BIP21), Lightning (LNURL/BOLT12), Monero - rendered as scan-ready QR URIs".into(),
        enabled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("payments-rails".into()),
        permissions: vec![],
        frontend: FrontendInfo {
            bundled: false,
            contributions: FrontendContributions {
                channel_types: vec![],
                workspace_panels: vec![],
                settings_pages: vec![],
                mobile_tabs: vec![],
            },
        },
    });

    #[cfg(feature = "wabi-payments-eu")]
    out.push(AddonCapability {
        id: "payments-eu".into(),
        name: "Payments - EU (SEPA)".into(),
        version: "0.1.0".into(),
        description: "SEPA Instant via EPC QR (EPC069-12 v3.1) - any EU banking app scans the code and settles in seconds".into(),
        enabled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("payments-rails".into()),
        permissions: vec![],
        frontend: FrontendInfo {
            bundled: false,
            contributions: FrontendContributions {
                channel_types: vec![],
                workspace_panels: vec![],
                settings_pages: vec![],
                mobile_tabs: vec![],
            },
        },
    });

    #[cfg(feature = "wabi-payments-us")]
    out.push(AddonCapability {
        id: "payments-us".into(),
        name: "Payments - US".into(),
        version: "0.1.0".into(),
        description: "Manual US rails: CashApp/Venmo/Zelle pointers and ACH details with doxx-floor disclosures and WABI-XXXX reconciliation codes".into(),
        enabled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("payments-rails".into()),
        permissions: vec![],
        frontend: FrontendInfo {
            bundled: false,
            contributions: FrontendContributions {
                channel_types: vec![],
                workspace_panels: vec![],
                settings_pages: vec![],
                mobile_tabs: vec![],
            },
        },
    });

    out
}

/// GET /api/addons — list enabled addons + frontend extension manifests.
async fn list_addons(State(_state): State<Arc<AppState>>) -> Result<Json<AddonsListResponse>> {
    Ok(Json(AddonsListResponse {
        addons: enabled_addons(),
    }))
}

/// GET /api/addons/:id — single addon capability (404 if not enabled in this binary).
async fn get_addon(
    State(_state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AddonCapability>> {
    let needle = id.trim().to_lowercase();
    match enabled_addons()
        .into_iter()
        .find(|a| a.id.to_lowercase() == needle)
    {
        Some(addon) => Ok(Json(addon)),
        None => Err(crate::error::AppError::NotFound(format!(
            "addon not enabled: {id}"
        ))),
    }
}

/// Routes nested at `/addons` under the API router → `/api/addons`, `/api/addons/{id}`.
///
/// Lore feature routes are nested *inside* this router at `/lore/...` so they
/// share the `/api/addons` prefix without competing with a sibling nest for the
/// same prefix (avoids `/addons/{id}` vs `/addons/lore/...` ambiguity).
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let router = Router::new()
        .route("/", axum::routing::get(list_addons))
        // Simple single-segment id only. Multi-segment paths under /addons/lore
        // are handled by the nested lore router below.
        .route("/{id}", axum::routing::get(get_addon));

    #[cfg(feature = "wabi-lore")]
    let router = router.nest("/lore", crate::api::lore::routes(state.clone()));

    router.with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mesh_always_present() {
        let addons = enabled_addons();
        assert!(
            addons.iter().any(|a| a.id == "mesh"),
            "mesh must always be listed"
        );
    }

    #[test]
    #[cfg(feature = "wabi-lore")]
    fn lore_present_when_feature_on() {
        let addons = enabled_addons();
        let lore = addons.iter().find(|a| a.id == "lore").expect("lore");
        assert!(lore.enabled);
        assert!(lore
            .frontend
            .contributions
            .channel_types
            .contains(&"lore".into()));
    }

    #[test]
    #[cfg(not(feature = "wabi-lore"))]
    fn lore_absent_when_feature_off() {
        let addons = enabled_addons();
        assert!(addons.iter().all(|a| a.id != "lore"));
    }

    #[test]
    #[cfg(feature = "wabi-payments-crypto")]
    fn payments_crypto_present_when_feature_on() {
        let addons = enabled_addons();
        assert!(addons.iter().any(|a| a.id == "payments-crypto"));
    }

    #[test]
    #[cfg(feature = "wabi-payments-eu")]
    fn payments_eu_present_when_feature_on() {
        let addons = enabled_addons();
        assert!(addons.iter().any(|a| a.id == "payments-eu"));
    }

    #[test]
    #[cfg(feature = "wabi-payments-us")]
    fn payments_us_present_when_feature_on() {
        let addons = enabled_addons();
        assert!(addons.iter().any(|a| a.id == "payments-us"));
    }

    #[test]
    #[cfg(not(feature = "payments-rails"))]
    fn payments_rails_absent_when_feature_off() {
        let addons = enabled_addons();
        assert!(addons
            .iter()
            .all(|a| !a.id.starts_with("payments-")));
    }
}
