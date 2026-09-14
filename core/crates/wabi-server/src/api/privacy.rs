//! Member-visible privacy contract.
//!
//! These endpoints expose the policy that affects a signed-in member without
//! exposing administrative internals. A user should not need admin access to
//! learn whether a room is retained, server-readable, or subject to content automation.

use axum::{extract::{Path, State}, Json, Router};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};

use crate::{auth_extractor::AuthUser, error::Result, state::AppState};
use wabidb::engine::wabi_store::WabiStore;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivacySummary {
    confidentiality: &'static str,
    e2ee_available: bool,
    private_content_automation: bool,
    reports_preserve_evidence: bool,
    analytics_scope: String,
    external_processing: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelPrivacySummary {
    channel_id: String,
    retention: String,
    confidentiality: &'static str,
    e2ee: bool,
    private_conversation: bool,
    automated_content_rules: bool,
    reports_preserve_evidence: bool,
}

fn privacy_value(data_dir: &str) -> serde_json::Value {
    std::fs::read(PathBuf::from(data_dir).join("server_center.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("privacy").cloned())
        .unwrap_or_default()
}

fn bool_field(value: &serde_json::Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(|v| v.as_bool()).unwrap_or(fallback)
}

fn string_field(value: &serde_json::Value, key: &str, fallback: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or(fallback).to_string()
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    // Rehydrate exact Live/sub-day/Forever choices before normal traffic has a
    // chance to rely on the coarse whole-day WabiDB compatibility policy.
    super::retention_policy::hydrate_runtime(state.clone());
    Router::new()
        .route("/", axum::routing::get(summary))
        .route("/channels/{channel_id}", axum::routing::get(channel_summary))
        .with_state(state)
}

async fn summary(State(state): State<Arc<AppState>>, _auth: AuthUser) -> Json<PrivacySummary> {
    let privacy = privacy_value(&state.config.data_dir);
    Json(PrivacySummary {
        confidentiality: "server_readable",
        e2ee_available: false,
        private_content_automation: bool_field(&privacy, "privateContentAutomation", false),
        reports_preserve_evidence: string_field(&privacy, "reportEvidencePreservation", "explicit_report") == "explicit_report",
        analytics_scope: string_field(&privacy, "analyticsMode", "off"),
        external_processing: string_field(&privacy, "externalProcessing", "none"),
    })
}

async fn channel_summary(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<ChannelPrivacySummary>> {
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    let kind = state.wdb.get_channel_kind(&channel_id).await;
    let private_conversation = matches!(kind.as_deref(), Some("dm" | "group"));
    let privacy = privacy_value(&state.config.data_dir);
    let private_automation = bool_field(&privacy, "privateContentAutomation", false);

    let retention = if let Some(label) = super::retention_policy::label(&state.config.data_dir, &channel_id) {
        label
    } else {
        match state.wdb.get_channel_retention(&channel_id).await? {
            Some(policy) if policy.days == 0 => "forever".to_string(),
            Some(policy) => format!("{}d", policy.days),
            None => "24h".to_string(),
        }
    };

    Ok(Json(ChannelPrivacySummary {
        channel_id,
        retention,
        confidentiality: "server_readable",
        e2ee: false,
        private_conversation,
        automated_content_rules: !private_conversation || private_automation,
        reports_preserve_evidence: string_field(&privacy, "reportEvidencePreservation", "explicit_report") == "explicit_report",
    }))
}
