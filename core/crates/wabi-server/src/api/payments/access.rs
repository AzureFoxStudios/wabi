//! One payment-access policy for both administrative routes and enforcement.
//! Legacy JSON is read only while the canonical WabiDB row is absent. Only an
//! authenticated administrator may import it; ordinary access checks never
//! write. Import and explicit saves share one application-local lock.

use std::path::Path;

use anyhow::{anyhow, Context};
use axum::{
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde_json::Value;
use wabidb::engine::wabi_store::WabiStore;

use super::{json_error, PaymentAccessPolicy};
use crate::{
    auth_extractor::{authenticate_access_token, AuthUser},
    state::AppState,
};

pub const ACCESS_POLICY_KEY: &str = "policy:payments_access";

/// Use the account boundary, not a second JWT decoder. Refresh, step-up,
/// scoped external-tool and revoked credentials are not account credentials.
pub async fn authenticate_account(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<AuthUser, Response> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| json_error(StatusCode::UNAUTHORIZED, "Authentication required"))?;
    authenticate_access_token(state, token).await.map_err(|_| {
        json_error(
            StatusCode::UNAUTHORIZED,
            "Valid account access token required",
        )
    })
}

pub async fn account_user_id(headers: &HeaderMap, state: &AppState) -> Result<i64, Response> {
    authenticate_account(headers, state)
        .await
        .map(|auth| auth.user_id)
}

/// Preserve the supported partial-update input shape, while rejecting invalid
/// supplied types instead of silently enabling payments. An explicitly empty
/// allowlist allows nobody; only an omitted field receives the default list.
pub fn parse_access_policy(raw: &Value) -> Result<PaymentAccessPolicy, &'static str> {
    let object = raw.as_object().ok_or("Payment policy must be an object")?;
    let mut policy = PaymentAccessPolicy::default();
    if let Some(value) = object.get("enabled") {
        policy.enabled = value.as_bool().ok_or("enabled must be a boolean")?;
    }
    if let Some(value) = object.get("allowGuest") {
        policy.allow_guest = value.as_bool().ok_or("allowGuest must be a boolean")?;
    }
    if let Some(value) = object.get("allowedRoleNames") {
        let values = value
            .as_array()
            .ok_or("allowedRoleNames must be an array of role names")?;
        let mut roles = Vec::with_capacity(values.len());
        for value in values {
            let role = value
                .as_str()
                .ok_or("Each allowed role must be a string")?
                .trim()
                .to_ascii_lowercase();
            if role.is_empty()
                || role.len() > 48
                || !role
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err("Each allowed role must be a valid role name");
            }
            roles.push(role);
        }
        roles.sort();
        roles.dedup();
        policy.allowed_role_names = roles;
    }
    Ok(policy)
}

fn decode_saved_policy(value: Value) -> anyhow::Result<PaymentAccessPolicy> {
    // Persisted records require the complete contract. Missing/corrupt data is
    // an error, not an absent policy and never an instruction to enable it.
    serde_json::from_value(value).context("Invalid saved payment access policy")
}

async fn legacy_access_policy(data_dir: &str) -> anyhow::Result<Option<PaymentAccessPolicy>> {
    let bytes = match tokio::fs::read(Path::new(data_dir).join("admin_policies.json")).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Cannot read legacy admin policies"),
    };
    let value: Value = serde_json::from_slice(&bytes).context("Invalid legacy admin policies")?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("Invalid legacy admin policy container"))?;
    object
        .get("payments_access")
        .cloned()
        .map(decode_saved_policy)
        .transpose()
}

pub async fn load_access_policy(
    state: &AppState,
    import_legacy: bool,
) -> anyhow::Result<PaymentAccessPolicy> {
    let _guard = state.payment_policy_lock.lock().await;
    if let Some(value) = state.wdb.get_payment_policy(ACCESS_POLICY_KEY).await? {
        return decode_saved_policy(value);
    }
    if let Some(policy) = legacy_access_policy(&state.config.data_dir).await? {
        if import_legacy {
            state
                .wdb
                .upsert_payment_policy(ACCESS_POLICY_KEY, &serde_json::to_value(&policy)?)
                .await?;
        }
        return Ok(policy);
    }
    // No explicit policy anywhere: preserve the already-enforced default.
    Ok(PaymentAccessPolicy::default())
}

pub async fn save_access_policy(
    state: &AppState,
    policy: &PaymentAccessPolicy,
) -> anyhow::Result<()> {
    let _guard = state.payment_policy_lock.lock().await;
    // A valid explicit save can repair even corrupt legacy/canonical state.
    // The adapter acknowledges the command/event/projection before success.
    state
        .wdb
        .upsert_payment_policy(ACCESS_POLICY_KEY, &serde_json::to_value(policy)?)
        .await?;
    Ok(())
}

pub fn access_unavailable(error: &anyhow::Error) -> Response {
    tracing::error!("Payment access unavailable: {error:#}");
    json_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Payment access is unavailable. Try again later or contact an administrator.",
    )
}
