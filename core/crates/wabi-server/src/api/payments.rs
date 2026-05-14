//! Payment API routes — non-custodial payment provider integration
//!
//! Implements access policy, account links, donations config, user blocks.
//! All data operations go through STDBreducers.
//!
//! Ported from Iyoku's Node.js `paymentRoutes.ts` + `payments/` modules.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::StdbClient;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE_ID: &str = "default-workspace";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/access", get(get_payment_access).post(save_payment_access))
        .route("/account-links", get(list_account_links).post(create_account_link))
        .route("/account-links/{plugin_id}", delete(delete_account_link))
        .route("/donations", get(get_donation_config).post(save_donation_config))
        .route("/user-blocks", get(list_user_blocks).post(create_user_block))
        .route("/user-blocks/{user_id}", delete(clear_user_block))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
        Self {
            enabled: false,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentAccountLink {
    #[serde(rename = "userId")]
    pub user_id: i64,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "providerAccountRef")]
    pub provider_account_ref: String,
    #[serde(rename = "displayLabel")]
    pub display_label: Option<String>,
    pub metadata: Option<Value>,
    #[serde(rename = "linkedAt")]
    pub linked_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

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
            currency: "USD".into(),
            country_code: None,
            suggested_amounts_minor: vec![500, 1000, 2500],
            headline: "Support This Server".into(),
            description: "Contribute to server hosting and maintenance.".into(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentUserBlock {
    #[serde(rename = "userId")]
    pub user_id: i64,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    pub reason: Option<String>,
    #[serde(rename = "blockedByUserId")]
    pub blocked_by_user_id: Option<i64>,
    #[serde(rename = "blockedByUsername")]
    pub blocked_by_username: Option<String>,
    #[serde(rename = "blockedUsername")]
    pub blocked_username: Option<String>,
    #[serde(rename = "blockedAt")]
    pub blocked_at: i64,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AccountLinkInput {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(rename = "providerAccountRef")]
    provider_account_ref: String,
    #[serde(rename = "displayLabel")]
    display_label: Option<String>,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct UserBlockInput {
    #[serde(rename = "userId")]
    user_id: i64,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
    reason: Option<String>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SaveAccessInput {
    policy: Value,
}

#[derive(Debug, Deserialize)]
struct SaveDonationInput {
    config: Value,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "success": false, "error": message }).to_string(),
    )
        .into_response()
}

/// Extract user ID from Bearer token. Returns None if unauthenticated.
fn extract_user_id(headers: &axum::http::HeaderMap, jwt_secret: &str) -> anyhow::Result<i64> {
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
    let c = decode::<Claims>(token, &key, &v)
        .map_err(|e| anyhow::anyhow!("invalid token: {}", e))?;
    c.claims
        .sub
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("invalid user_id in token"))
}

/// Check if user is the server owner (admin).
async fn is_admin_user(user_id: i64, state: &Arc<AppState>) -> bool {
    *state.owner_user_id.read().await == Some(user_id)
}

/// Query STDB for a single policy row by key, parse as JSON.
async fn get_policy_row(stdb: &StdbClient, key: &str) -> Option<Value> {
    let query = format!(
        "SELECT row_json FROM state_payment_policy WHERE policy_key = '{}' LIMIT 1",
        StdbClient::sanitize_sql(key)
    );
    let resp = stdb.sql_query(&query).await.ok()?;
    let rows = resp.decode_rows();
    let row = rows.first()?;
    row.get("row_json").and_then(|v| v.as_str()).and_then(|s| serde_json::from_str(s).ok())
}

/// Ingest a policy upsert via STDB reducer.
async fn upsert_policy(stdb: &StdbClient, key: &str, value: &Value) {
    let _ = stdb
        .ingest_event(
            "payment",
            "upsert_policy",
            &json!({
                "policyKey": key,
                "updatedAt": chrono::Utc::now().timestamp_millis(),
                "row": value,
            }),
        )
        .await;
}

/// Ingest an account link upsert via STDB reducer.
async fn upsert_account_link(stdb: &StdbClient, link: &PaymentAccountLink) {
    let _ = stdb
        .ingest_event(
            "payment",
            "upsert_account_link",
            &json!({
                "userId": link.user_id,
                "pluginId": link.plugin_id,
                "workspaceId": link.workspace_id,
                "row": link,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// GET /api/payments/access
// ---------------------------------------------------------------------------

async fn get_payment_access(State(state): State<Arc<AppState>>) -> Response {
    let policy = match get_policy_row(&state.stdb, "policy:payments_access").await {
        Some(v) => serde_json::from_value::<PaymentAccessPolicy>(v)
            .unwrap_or_default(),
        None => PaymentAccessPolicy::default(),
    };

    Json(json!({ "success": true, "policy": policy })).into_response()
}

// ---------------------------------------------------------------------------
// POST /api/payments/access (save)
// ---------------------------------------------------------------------------

async fn save_payment_access(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<SaveAccessInput>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    if !is_admin_user(user_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }

    let sanitized = sanitize_access_policy(&input.policy);
    upsert_policy(&state.stdb, "policy:payments_access", &serde_json::to_value(&sanitized).unwrap()).await;

    Json(json!({ "success": true, "policy": sanitized })).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/payments/account-links
// ---------------------------------------------------------------------------

async fn list_account_links(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    let workspace_id = query.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID);

    let sql = format!(
        "SELECT row_json FROM state_payment_account_link WHERE user_id = {} AND workspace_id = '{}'",
        user_id,
        StdbClient::sanitize_sql(workspace_id),
    );

    let links: Vec<PaymentAccountLink> = state
        .stdb
        .sql_query(&sql)
        .await
        .map(|resp| {
            resp.decode_rows().iter()
                .filter_map(|row| {
                    row.get("row_json")
                        .and_then(|v| v.as_str())
                        .and_then(|s| serde_json::from_str(s).ok())
                })
                .collect()
        })
        .unwrap_or_default();

    Json(json!({ "success": true, "links": links })).into_response()
}

// ---------------------------------------------------------------------------
// POST /api/payments/account-links
// ---------------------------------------------------------------------------

async fn create_account_link(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<AccountLinkInput>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    let plugin_id = input.plugin_id.trim().to_string();
    let provider_account_ref = input.provider_account_ref.trim().to_string();

    if plugin_id.is_empty() || provider_account_ref.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "pluginId and providerAccountRef are required");
    }

    let now = chrono::Utc::now().timestamp_millis();
    let workspace_id = DEFAULT_WORKSPACE_ID.to_string();

    let link = PaymentAccountLink {
        user_id,
        workspace_id: workspace_id.clone(),
        plugin_id,
        provider_account_ref,
        display_label: input.display_label,
        metadata: input.metadata,
        linked_at: now,
        updated_at: now,
    };

    upsert_account_link(&state.stdb, &link).await;

    Json(json!({ "success": true, "link": link })).into_response()
}

// ---------------------------------------------------------------------------
// DELETE /api/payments/account-links/:pluginId
// ---------------------------------------------------------------------------

async fn delete_account_link(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(plugin_id): Path<String>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    let workspace_id = DEFAULT_WORKSPACE_ID.to_string();

    let _ = state
        .stdb
        .ingest_event(
            "payment",
            "delete_account_link",
            &json!({
                "userId": user_id,
                "pluginId": plugin_id,
                "workspaceId": workspace_id,
            }),
        )
        .await;

    Json(json!({ "success": true })).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/payments/donations
// ---------------------------------------------------------------------------

async fn get_donation_config(State(state): State<Arc<AppState>>) -> Response {
    let config = match get_policy_row(&state.stdb, "policy:payments_donations").await {
        Some(v) => serde_json::from_value::<PaymentDonationConfig>(v)
            .unwrap_or_default(),
        None => PaymentDonationConfig::default(),
    };

    Json(json!({ "success": true, "config": config })).into_response()
}

// ---------------------------------------------------------------------------
// POST /api/payments/donations
// ---------------------------------------------------------------------------

async fn save_donation_config(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<SaveDonationInput>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    if !is_admin_user(user_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }

    let config = sanitize_donation_config(&input.config);
    upsert_policy(&state.stdb, "policy:payments_donations", &serde_json::to_value(&config).unwrap()).await;

    Json(json!({ "success": true, "config": config })).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/payments/user-blocks
// ---------------------------------------------------------------------------

async fn list_user_blocks(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    if !is_admin_user(user_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }

    let workspace_id = query.workspace_id.as_deref().unwrap_or(DEFAULT_WORKSPACE_ID);
    let limit = query.limit.unwrap_or(500).min(5000);

    let sql = format!(
        "SELECT row_json FROM state_payment_user_block WHERE workspace_id = '{}' LIMIT {}",
        StdbClient::sanitize_sql(workspace_id),
        limit,
    );

    let blocks: Vec<PaymentUserBlock> = state
        .stdb
        .sql_query(&sql)
        .await
        .map(|resp| {
            resp.decode_rows().iter()
                .filter_map(|row| {
                    row.get("row_json")
                        .and_then(|v| v.as_str())
                        .and_then(|s| serde_json::from_str(s).ok())
                })
                .collect()
        })
        .unwrap_or_default();

    Json(json!({ "success": true, "blocks": blocks })).into_response()
}

// ---------------------------------------------------------------------------
// POST /api/payments/user-blocks
// ---------------------------------------------------------------------------

async fn create_user_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<UserBlockInput>,
) -> Response {
    let admin_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }

    let workspace_id = input.workspace_id.clone().unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string());
    let now = chrono::Utc::now().timestamp_millis();

    let block = PaymentUserBlock {
        user_id: input.user_id,
        workspace_id: workspace_id.clone(),
        reason: input.reason.clone(),
        blocked_by_user_id: Some(admin_id),
        blocked_by_username: None,
        blocked_username: None,
        blocked_at: now,
        expires_at: input.expires_at,
    };

    let _ = state
        .stdb
        .ingest_event(
            "payment",
            "upsert_user_block",
            &json!({
                "userId": block.user_id,
                "workspaceId": block.workspace_id,
                "row": block,
            }),
        )
        .await;

    Json(json!({ "success": true, "block": block })).into_response()
}

// ---------------------------------------------------------------------------
// DELETE /api/payments/user-blocks/:userId
// ---------------------------------------------------------------------------

async fn clear_user_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(blocked_user_id): Path<i64>,
) -> Response {
    let admin_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };

    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }

    let _ = state
        .stdb
        .ingest_event(
            "payment",
            "delete_user_block",
            &json!({
                "userId": blocked_user_id,
                "workspaceId": DEFAULT_WORKSPACE_ID,
            }),
        )
        .await;

    Json(json!({ "success": true })).into_response()
}

// ---------------------------------------------------------------------------
// Sanitizers — mirrors Node.js validation logic
// ---------------------------------------------------------------------------

fn sanitize_access_policy(raw: &Value) -> PaymentAccessPolicy {
    let fallback = PaymentAccessPolicy::default();
    let obj = match raw.as_object() {
        Some(o) => o,
        None => return fallback,
    };

    let enabled = obj
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback.enabled);

    let allow_guest = obj
        .get("allowGuest")
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback.allow_guest);

    let allowed_role_names = obj
        .get("allowedRoleNames")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let mut roles: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_lowercase()))
                .filter(|s| !s.is_empty() && s.len() <= 48 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .collect();
            roles.sort();
            roles.dedup();
            if roles.is_empty() { fallback.allowed_role_names.clone() } else { roles }
        })
        .unwrap_or_else(|| fallback.allowed_role_names.clone());

    PaymentAccessPolicy {
        enabled,
        allow_guest,
        allowed_role_names,
    }
}

fn sanitize_donation_config(raw: &Value) -> PaymentDonationConfig {
    let fallback = PaymentDonationConfig::default();
    let obj = match raw.as_object() {
        Some(o) => o,
        None => return fallback,
    };

    let enabled = obj
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback.enabled);

    let provider_plugin_id = obj
        .get("providerPluginId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().chars().take(96).collect());

    let method_id = obj
        .get("methodId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().chars().take(96).collect());

    let currency = obj
        .get("currency")
        .and_then(|v| v.as_str())
        .filter(|s| s.len() == 3 && s.chars().all(|c| c.is_ascii_alphabetic()))
        .unwrap_or(&fallback.currency)
        .to_uppercase();

    let country_code = obj
        .get("countryCode")
        .and_then(|v| v.as_str())
        .filter(|s| s.len() == 2 && s.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|s| s.to_uppercase());

    let suggested_amounts = obj
        .get("suggestedAmountsMinor")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let mut amounts: Vec<i64> = arr
                .iter()
                .filter_map(|v| v.as_i64())
                .filter(|&n| n > 0 && n <= 1_000_000_000)
                .collect();
            amounts.sort();
            amounts.dedup();
            amounts.truncate(8);
            if amounts.is_empty() {
                fallback.suggested_amounts_minor.clone()
            } else {
                amounts
            }
        })
        .unwrap_or_else(|| fallback.suggested_amounts_minor.clone());

    let headline = obj
        .get("headline")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().chars().take(120).collect())
        .unwrap_or(fallback.headline);

    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().chars().take(500).collect())
        .unwrap_or(fallback.description);

    PaymentDonationConfig {
        enabled,
        provider_plugin_id,
        method_id,
        currency,
        country_code,
        suggested_amounts_minor: suggested_amounts,
        headline,
        description,
    }
}