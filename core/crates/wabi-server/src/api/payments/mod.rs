mod handlers;
mod intents;
mod promptpay;

use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::payments::{
    PaymentAccountLinkRecord, PaymentUserBlockRecord,
};

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    // One-shot migration of the pre-Phase-1 `payments/intents.jsonl` file.
    {
        let state = state.clone();
        tokio::spawn(async move {
            intents::migrate_legacy_intents(&state).await;
        });
    }
    Router::new()
        .route(
            "/access",
            get(handlers::get_payment_access).post(handlers::save_payment_access),
        )
        .route(
            "/account-links",
            get(handlers::list_account_links).post(handlers::create_account_link),
        )
        .route(
            "/account-links/{plugin_id}",
            delete(handlers::delete_account_link),
        )
        .route(
            "/donations",
            get(handlers::get_donation_config).post(handlers::save_donation_config),
        )
        .route(
            "/user-blocks",
            get(handlers::list_user_blocks).post(handlers::create_user_block),
        )
        .route("/user-blocks/{user_id}", delete(handlers::clear_user_block))
        // Non-custodial PromptPay intents (Thailand-first)
        .route(
            "/intents",
            get(intents::list_intents).post(intents::create_intent),
        )
        .route(
            "/intents/{id}/confirm",
            post(intents::confirm_intent),
        )
        .route(
            "/intents/{id}/reject",
            post(intents::reject_intent),
        )
        .with_state(state)
}

const DEFAULT_WORKSPACE_ID: &str = "default-workspace";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentAccessPolicy {
    pub enabled: bool,
    #[serde(rename = "allowGuest")]
    pub allow_guest: bool,
    #[serde(rename = "allowedRoleNames")]
    pub allowed_role_names: Vec<String>,
}

impl Default for PaymentAccessPolicy {
    fn default() -> Self {
        // WS-3: the policy is now ENFORCED in create_intent, so the default
        // must match the behavior servers already had (any registered user
        // can create intents). Admins use it as a kill-switch / restrictor,
        // not an opt-in — `enabled: false` turns payments off for everyone.
        Self {
            enabled: true,
            allow_guest: false,
            allowed_role_names: vec![
                "owner".into(),
                "admin".into(),
                "mod".into(),
                "member".into(),
            ],
        }
    }
}

/// API alias of the wabidb payment projection record (Phase 1: event-sourced).
pub type PaymentAccountLink = PaymentAccountLinkRecord;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentDonationConfig {
    pub enabled: bool,
    #[serde(rename = "providerPluginId")]
    pub provider_plugin_id: Option<String>,
    #[serde(rename = "methodId")]
    pub method_id: Option<String>,
    pub currency: String,
    #[serde(rename = "countryCode")]
    pub country_code: Option<String>,
    #[serde(rename = "suggestedAmountsMinor")]
    pub suggested_amounts_minor: Vec<i64>,
    pub headline: String,
    pub description: String,
}

impl Default for PaymentDonationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider_plugin_id: None,
            method_id: None,
            currency: "THB".into(),
            country_code: None,
            suggested_amounts_minor: vec![5000, 10000, 25000], // satang: 50/100/250 THB
            headline: "Support This Server".into(),
            description: "Contribute to server hosting and maintenance.".into(),
        }
    }
}

/// API alias of the wabidb payment projection record (Phase 1: event-sourced).
pub type PaymentUserBlock = PaymentUserBlockRecord;

#[derive(Debug, Deserialize)]
pub struct AccountLinkInput {
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "providerAccountRef")]
    pub provider_account_ref: String,
    #[serde(rename = "displayLabel")]
    pub display_label: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct UserBlockInput {
    #[serde(rename = "userId")]
    pub user_id: i64,
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub reason: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ListQuery {
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct SaveAccessInput {
    pub policy: Value,
}

#[derive(Debug, Deserialize)]
pub struct SaveDonationInput {
    pub config: Value,
}

pub fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "success": false, "error": message }).to_string(),
    )
        .into_response()
}

pub fn extract_user_id(headers: &axum::http::HeaderMap, jwt_secret: &str) -> anyhow::Result<i64> {
    use jsonwebtoken::{decode, DecodingKey, Validation};

    let auth = headers
        .get("authorization")
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid authorization header"))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| anyhow::anyhow!("missing Bearer prefix"))?;

    #[derive(serde::Deserialize)]
    struct Claims {
        sub: String,
    }

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let c =
        decode::<Claims>(token, &key, &v).map_err(|e| anyhow::anyhow!("invalid token: {}", e))?;
    c.claims
        .sub
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("invalid user_id in token"))
}

pub async fn is_admin_user(user_id: i64, state: &std::sync::Arc<AppState>) -> bool {
    state.is_admin(user_id).await
}

/// Extract `(user_id, is_guest)` from the Bearer token. WS-3: guest status is
/// required to enforce the payments access policy.
pub fn extract_identity(
    headers: &axum::http::HeaderMap,
    jwt_secret: &str,
) -> anyhow::Result<(i64, bool)> {
    use jsonwebtoken::{decode, DecodingKey, Validation};

    let auth = headers
        .get("authorization")
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid authorization header"))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| anyhow::anyhow!("missing Bearer prefix"))?;

    #[derive(serde::Deserialize, Default)]
    struct Claims {
        sub: String,
        #[serde(default)]
        is_guest: bool,
    }

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let c = decode::<Claims>(token, &key, &v)
        .map_err(|e| anyhow::anyhow!("invalid token: {}", e))?;
    let user_id = c
        .claims
        .sub
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("invalid user_id in token"))?;
    Ok((user_id, c.claims.is_guest))
}

/// WS-3: evaluate the payments access policy for a user. Shared by
/// `create_intent` (enforcement) and `GET /access` (actor disclosure).
/// Returns the camelCase actor JSON the frontend contract expects.
pub async fn evaluate_payment_access(
    state: &std::sync::Arc<AppState>,
    user_id: i64,
    is_guest: bool,
) -> Value {
    let policy = match get_policy_row(state, "policy:payments_access").await {
        Some(v) => serde_json::from_value::<PaymentAccessPolicy>(v).unwrap_or_default(),
        None => PaymentAccessPolicy::default(),
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let blocked = state
        .wdb
        .list_payment_user_blocks(DEFAULT_WORKSPACE_ID)
        .await
        .map(|blocks| {
            blocks.into_iter().any(|b| {
                b.user_id == user_id
                    && b.expires_at
                        .map(|expires| expires > now_ms)
                        .unwrap_or(true)
            })
        })
        .unwrap_or(false);

    let mut roles: Vec<String> = Vec::new();
    if is_admin_user(user_id, state).await {
        roles.push("admin".into());
    }
    roles.push(if is_guest { "guest".into() } else { "member".into() });

    let role_allowed = policy.allowed_role_names.is_empty()
        || policy
            .allowed_role_names
            .iter()
            .any(|allowed| roles.iter().any(|role| role == allowed));

    let (can_create, reason_code, reason): (bool, Option<&str>, Option<&str>) = if blocked {
        (
            false,
            Some("blocked"),
            Some("You are blocked from creating payments on this server."),
        )
    } else if !policy.enabled {
        (
            false,
            Some("disabled"),
            Some("Payments are disabled on this server."),
        )
    } else if is_guest && !policy.allow_guest {
        (
            false,
            Some("guest"),
            Some("Guests cannot create payments on this server."),
        )
    } else if !role_allowed {
        (
            false,
            Some("role"),
            Some("Your role is not allowed to create payments on this server."),
        )
    } else {
        (true, None, None)
    };

    serde_json::json!({
        "authenticated": true,
        "userId": user_id,
        "roles": roles,
        "blocked": blocked,
        "canCreate": can_create,
        "reasonCode": reason_code,
        "reason": reason,
    })
}

pub async fn get_policy_row(state: &AppState, key: &str) -> Option<Value> {
    // Phase 1: payment-policy projection wired into WabiDB events.
    match state.wdb.get_payment_policy(key).await {
        Ok(Some(v)) => Some(v),
        _ => None,
    }
}

pub async fn upsert_policy(state: &AppState, key: &str, value: &Value) {
    let _ = state.wdb.upsert_payment_policy(key, value).await;
}

pub async fn upsert_account_link(state: &AppState, link: &PaymentAccountLink) {
    // Phase 1: account links are persisted as `payment_account_link_upserted`
    // events and replayed into the projection on restart.
    let _ = state.wdb.upsert_payment_account_link(link).await;
}
