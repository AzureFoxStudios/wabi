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

use crate::error::{AppError, Result};
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
    /// True when the add-on is usable right now (compile-time AND runtime state).
    pub enabled: bool,
    /// True when the add-on is always compiled into this binary (no cargo feature).
    pub compiled: bool,
    pub backend_runtime: String,
    /// Cargo feature that attaches this add-on at build time (None = always compiled).
    pub cargo_feature: Option<String>,
    /// Env var that switches this add-on on/off at runtime, when one exists.
    pub runtime_env: Option<String>,
    /// True when the owner can flip this add-on in-app (Server Center → Add-ons).
    pub runtime_switch: bool,
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
/// Runtime flags an add-on's `enabled` value depends on.
///
/// Kept separate from `AppState` so the inventory stays unit-testable without
/// booting a server: compile-time presence comes from cargo features, runtime
/// presence comes from these flags.
#[derive(Debug, Clone, Copy, Default)]
pub struct AddonRuntimeFlags {
    pub tailcat_enabled: bool,
    pub lore_enabled: bool,
    pub steam_enabled: bool,
}

/// Build the inventory from compile-time features + runtime flags.
pub fn enabled_addons_with(runtime: AddonRuntimeFlags) -> Vec<AddonCapability> {
    let AddonRuntimeFlags {
        tailcat_enabled,
        lore_enabled,
        steam_enabled,
    } = runtime;
    let mut out = Vec::new();

    out.push(AddonCapability {
        id: "steam".into(), name: "Steam".into(), version: "0.1.0".into(),
        description: "Verified account linking and private, selective game import".into(),
        enabled: steam_enabled,
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: None,
        runtime_env: Some("WABI_STEAM_ENABLED".into()),
        runtime_switch: true,
        permissions: vec!["network:outbound".into()],
        frontend: FrontendInfo { bundled: true, contributions: FrontendContributions {
            channel_types: vec![], workspace_panels: vec![], settings_pages: vec!["steam".into()], mobile_tabs: vec![],
        } },
    });

    // tailcat — always compiled into wabi-server (runtime-gated like mesh):
    // disabled = no subprocess, no listener, zero footprint.
    out.push(AddonCapability {
        id: "tailcat".into(),
        name: "Tailcat Private Access".into(),
        version: "0.1.0".into(),
        description: "Token-dialed WireGuard pipes (tailscale/tailcat) so family/friend members reach a home-hosted server without port forwarding. Transport only - Wabi auth always gates membership.".into(),
        enabled: tailcat_enabled,
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: None,
        runtime_env: None,
        runtime_switch: true,
        permissions: vec!["network:outbound".into(), "process:spawn".into()],
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
        enabled: lore_enabled,
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("wabi-lore".into()),
        runtime_env: Some("WABI_LORE_ENABLED".into()),
        runtime_switch: true,
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
    // DISABLED (P1/W3, 2026-08-21): WebhookService is unwired — no registration
    // API, zero .trigger() call sites. The capability is latent SSRF surface
    // with no product value yet; catalog advertises nothing the server does.
    #[cfg(feature = "wabi-webhooks")]
    out.push(AddonCapability {
        id: "webhooks".into(),
        name: "Webhooks".into(),
        version: "0.1.0".into(),
        description: "Webhook service for Wabi - triggers webhooks on events".into(),
        enabled: false,
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("wabi-webhooks".into()),
        runtime_env: None,
        runtime_switch: false,
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
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("payments-rails".into()),
        runtime_env: None,
        runtime_switch: false,
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
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("payments-rails".into()),
        runtime_env: None,
        runtime_switch: false,
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
        compiled: true,
        backend_runtime: "rust".into(),
        cargo_feature: Some("payments-rails".into()),
        runtime_env: None,
        runtime_switch: false,
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

/// Inventory for this process: compile-time features + live runtime state.
async fn enabled_addons(state: &AppState) -> Vec<AddonCapability> {
    enabled_addons_with(AddonRuntimeFlags {
        // Runtime truth, not compile-time optimism: an add-on is only "enabled"
        // when this process can actually serve it right now.
        tailcat_enabled: state.tailcat.status().await.enabled,
        #[cfg(feature = "wabi-lore")]
        lore_enabled: state.lore_service.read().await.is_some(),
        #[cfg(not(feature = "wabi-lore"))]
        lore_enabled: false,
        steam_enabled: state
            .addon_enabled("steam", Some("WABI_STEAM_ENABLED"), false)
            .await,
    })
}

/// GET /api/addons — list enabled addons + frontend extension manifests.
async fn list_addons(State(state): State<Arc<AppState>>) -> Result<Json<AddonsListResponse>> {
    Ok(Json(AddonsListResponse {
        addons: enabled_addons(&state).await,
    }))
}

/// GET /api/addons/:id — single addon capability (404 if not enabled in this binary).
async fn get_addon(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<AddonCapability>> {
    let needle = id.trim().to_lowercase();
    match enabled_addons(&state).await
        .into_iter()
        .find(|a| a.id.to_lowercase() == needle)
    {
        Some(addon) => Ok(Json(addon)),
        None => Err(crate::error::AppError::NotFound(format!(
            "addon not enabled: {id}"
        ))),
    }
}

#[derive(Debug, serde::Deserialize)]
struct SwitchRequest {
    enabled: bool,
}

/// POST /api/addons/{id}/switch — owner/admin toggles a compiled-in add-on.
///
/// Applies immediately for steam (routes consult the switch per request) and
/// tailcat (its own manager is the kill-switch). Lore initializes at startup,
/// so the response says `appliesOnRestart: true`.
async fn switch_addon(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SwitchRequest>,
) -> Result<Json<serde_json::Value>> {
    let actor = crate::api::admin::admin_auth(&headers, &state)
        .await
        .map_err(|resp| match resp.status() {
            axum::http::StatusCode::FORBIDDEN => {
                AppError::Forbidden("Admin access required".into())
            }
            _ => AppError::Unauthorized("Authentication required".into()),
        })?;

    let id = id.trim().to_lowercase();
    if !crate::addon_switches::AddonSwitches::is_switchable(&id) {
        return Err(AppError::NotFound(format!(
            "addon is not switchable at runtime: {id}"
        )));
    }

    if id == "tailcat" {
        state
            .tailcat
            .set_enabled(body.enabled, actor)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    } else {
        state
            .set_addon_enabled(&id, body.enabled)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }

    Ok(Json(serde_json::json!({
        "id": id,
        "enabled": body.enabled,
        "appliesOnRestart": id == "lore",
    })))
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
        .route("/{id}", axum::routing::get(get_addon))
        // Owner action: flip a compiled-in add-on on/off without a rebuild.
        .route("/{id}/switch", axum::routing::post(switch_addon));

    #[cfg(feature = "wabi-lore")]
    let router = router.nest("/lore", crate::api::lore::routes(state.clone()));

    let router = router.nest("/tailcat", crate::api::tailcat::routes(state.clone()));

    router.with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(tailcat: bool, lore: bool) -> AddonRuntimeFlags {
        AddonRuntimeFlags {
            tailcat_enabled: tailcat,
            lore_enabled: lore,
            steam_enabled: false,
        }
    }

    #[test]
    fn retired_mesh_is_not_advertised() {
        let addons = enabled_addons_with(flags(false, false));
        assert!(
            addons.iter().all(|a| a.id != "mesh"),
            "the retired wabi-mesh coordinator must not appear as an add-on"
        );
    }

    #[test]
    fn always_compiled_addons_report_their_attach_metadata() {
        let addons = enabled_addons_with(flags(true, false));
        let tailcat = addons.iter().find(|a| a.id == "tailcat").expect("tailcat");
        assert!(tailcat.compiled);
        assert!(tailcat.cargo_feature.is_none(), "tailcat is always compiled");
        assert_eq!(tailcat.runtime_env, None, "tailcat toggles in-app, not by env");

        let steam = addons.iter().find(|a| a.id == "steam").expect("steam");
        assert_eq!(steam.runtime_env.as_deref(), Some("WABI_STEAM_ENABLED"));
        assert!(steam.runtime_switch, "steam flips in-app");
        assert!(!steam.enabled, "steam starts off until switched on");
    }

    #[test]
    fn switchable_flags_match_the_runtime_switch_set() {
        let addons = enabled_addons_with(flags(true, true));
        for addon in &addons {
            assert_eq!(
                addon.runtime_switch,
                crate::addon_switches::AddonSwitches::is_switchable(&addon.id),
                "runtime_switch must mirror the switchable set for {}",
                addon.id
            );
        }
    }

    #[test]
    fn runtime_flags_decide_enabled_not_compilation() {
        let on = enabled_addons_with(flags(true, true));
        assert!(on.iter().find(|a| a.id == "tailcat").unwrap().enabled);

        // Compiled in, switched off at runtime: must report disabled.
        let off = enabled_addons_with(flags(false, true));
        assert!(!off.iter().find(|a| a.id == "tailcat").unwrap().enabled);
    }

    #[test]
    #[cfg(feature = "wabi-lore")]
    fn lore_reports_runtime_state_when_feature_on() {
        let reachable = enabled_addons_with(flags(false, true));
        let lore = reachable.iter().find(|a| a.id == "lore").expect("lore");
        assert!(lore.enabled, "lore is enabled when the service is registered");
        assert_eq!(lore.runtime_env.as_deref(), Some("WABI_LORE_ENABLED"));
        assert!(lore
            .frontend
            .contributions
            .channel_types
            .contains(&"lore".into()));

        // Compiled but the Lore service never registered: capability must say so.
        let unreachable = enabled_addons_with(flags(false, false));
        let lore = unreachable.iter().find(|a| a.id == "lore").expect("lore");
        assert!(
            !lore.enabled,
            "compiled-but-unreachable lore must not advertise itself as enabled"
        );
    }

    #[test]
    #[cfg(not(feature = "wabi-lore"))]
    fn lore_absent_when_feature_off() {
        let addons = enabled_addons_with(flags(false, false));
        assert!(addons.iter().all(|a| a.id != "lore"));
    }

    #[test]
    #[cfg(feature = "wabi-payments-crypto")]
    fn payments_crypto_present_when_feature_on() {
        let addons = enabled_addons_with(flags(false, false));
        assert!(addons.iter().any(|a| a.id == "payments-crypto"));
    }

    #[test]
    #[cfg(feature = "wabi-payments-eu")]
    fn payments_eu_present_when_feature_on() {
        let addons = enabled_addons_with(flags(false, false));
        assert!(addons.iter().any(|a| a.id == "payments-eu"));
    }

    #[test]
    #[cfg(feature = "wabi-payments-us")]
    fn payments_us_present_when_feature_on() {
        let addons = enabled_addons_with(flags(false, false));
        assert!(addons.iter().any(|a| a.id == "payments-us"));
    }

    #[test]
    #[cfg(not(feature = "payments-rails"))]
    fn payments_rails_absent_when_feature_off() {
        let addons = enabled_addons_with(flags(false, false));
        assert!(addons.iter().all(|a| !a.id.starts_with("payments-")));
    }
}
