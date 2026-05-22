mod handlers;

use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::StdbClient;
use crate::state::AppState;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/access", get(handlers::get_payment_access).post(handlers::save_payment_access))
        .route("/account-links", get(handlers::list_account_links).post(handlers::create_account_link))
        .route("/account-links/{plugin_id}", delete(handlers::delete_account_link))
        .route("/donations", get(handlers::get_donation_config).post(handlers::save_donation_config))
        .route("/user-blocks", get(handlers::list_user_blocks).post(handlers::create_user_block))
        .route("/user-blocks/{user_id}", delete(handlers::clear_user_block))
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
        Self {
            enabled: false,
            allow_guest: false,
            allowed_role_names: vec!["owner".into(), "admin".into(), "mod".into(), "member".into()],
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
    struct Claims { sub: String }

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let c = decode::<Claims>(token, &key, &v)
        .map_err(|e| anyhow::anyhow!("invalid token: {}", e))?;
    c.claims.sub.parse::<i64>()
        .map_err(|_| anyhow::anyhow!("invalid user_id in token"))
}

pub async fn is_admin_user(user_id: i64, state: &std::sync::Arc<AppState>) -> bool {
    *state.owner_user_id.read().await == Some(user_id)
}

pub async fn get_policy_row(stdb: &StdbClient, key: &str) -> Option<Value> {
    let query = format!(
        "SELECT row_json FROM state_payment_policy WHERE policy_key = '{}' LIMIT 1",
        StdbClient::sanitize_sql(key)
    );
    let resp = stdb.sql_query(&query).await.ok()?;
    let rows = resp.decode_rows();
    let row = rows.first()?;
    row.get("row_json").and_then(|v| v.as_str()).and_then(|s| serde_json::from_str(s).ok())
}

pub async fn upsert_policy(stdb: &StdbClient, key: &str, value: &Value) {
    let _ = stdb.ingest_event("payment", "upsert_policy", &json!({
        "policyKey": key,
        "updatedAt": chrono::Utc::now().timestamp_millis(),
        "row": value,
    })).await;
}

pub async fn upsert_account_link(stdb: &StdbClient, link: &PaymentAccountLink) {
    let _ = stdb.ingest_event("payment", "upsert_account_link", &json!({
        "userId": link.user_id,
        "pluginId": link.plugin_id,
        "workspaceId": link.workspace_id,
        "row": link,
    })).await;
}
