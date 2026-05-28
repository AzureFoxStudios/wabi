use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::{
    extract_user_id, get_policy_row, is_admin_user, json_error, upsert_account_link, upsert_policy,
    AccountLinkInput, ListQuery, PaymentAccessPolicy, PaymentAccountLink, PaymentDonationConfig,
    PaymentUserBlock, SaveAccessInput, SaveDonationInput, UserBlockInput, DEFAULT_WORKSPACE_ID,
};
use crate::state::AppState;

pub async fn get_payment_access(State(state): State<Arc<AppState>>) -> Response {
    let policy = match get_policy_row(&state.stdb, "policy:payments_access").await {
        Some(v) => serde_json::from_value::<PaymentAccessPolicy>(v).unwrap_or_default(),
        None => PaymentAccessPolicy::default(),
    };
    Json(json!({ "success": true, "policy": policy })).into_response()
}

pub async fn save_payment_access(
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
    upsert_policy(
        &state.stdb,
        "policy:payments_access",
        &serde_json::to_value(&sanitized).unwrap(),
    )
    .await;
    Json(json!({ "success": true, "policy": sanitized })).into_response()
}

pub async fn list_account_links(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    let workspace_id = query
        .workspace_id
        .as_deref()
        .unwrap_or(DEFAULT_WORKSPACE_ID);
    let sql = format!(
        "SELECT row_json FROM state_payment_account_link WHERE user_id = {} AND workspace_id = '{}'",
        user_id,
        crate::db::StdbClient::sanitize_sql(workspace_id),
    );
    let links: Vec<PaymentAccountLink> = state
        .stdb
        .sql_query(&sql)
        .await
        .map(|resp| {
            resp.decode_rows()
                .iter()
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

pub async fn create_account_link(
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
        return json_error(
            StatusCode::BAD_REQUEST,
            "pluginId and providerAccountRef are required",
        );
    }
    let now = chrono::Utc::now().timestamp_millis();
    let link = PaymentAccountLink {
        user_id,
        workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
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

pub async fn delete_account_link(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(plugin_id): Path<String>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    let _ = state
        .stdb
        .ingest_event(
            "payment",
            "delete_account_link",
            &json!({
                "userId": user_id,
                "pluginId": plugin_id,
                "workspaceId": DEFAULT_WORKSPACE_ID,
            }),
        )
        .await;
    Json(json!({ "success": true })).into_response()
}

pub async fn get_donation_config(State(state): State<Arc<AppState>>) -> Response {
    let config = match get_policy_row(&state.stdb, "policy:payments_donations").await {
        Some(v) => serde_json::from_value::<PaymentDonationConfig>(v).unwrap_or_default(),
        None => PaymentDonationConfig::default(),
    };
    Json(json!({ "success": true, "config": config })).into_response()
}

pub async fn save_donation_config(
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
    upsert_policy(
        &state.stdb,
        "policy:payments_donations",
        &serde_json::to_value(&config).unwrap(),
    )
    .await;
    Json(json!({ "success": true, "config": config })).into_response()
}

pub async fn list_user_blocks(
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
    let workspace_id = query
        .workspace_id
        .as_deref()
        .unwrap_or(DEFAULT_WORKSPACE_ID);
    let limit = query.limit.unwrap_or(500).min(5000);
    let sql = format!(
        "SELECT row_json FROM state_payment_user_block WHERE workspace_id = '{}' LIMIT {}",
        crate::db::StdbClient::sanitize_sql(workspace_id),
        limit,
    );
    let blocks: Vec<PaymentUserBlock> = state
        .stdb
        .sql_query(&sql)
        .await
        .map(|resp| {
            resp.decode_rows()
                .iter()
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

pub async fn create_user_block(
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
    let workspace_id = input
        .workspace_id
        .clone()
        .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string());
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

pub async fn clear_user_block(
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

fn sanitize_access_policy(raw: &serde_json::Value) -> PaymentAccessPolicy {
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
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 48
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                })
                .collect();
            roles.sort();
            roles.dedup();
            if roles.is_empty() {
                fallback.allowed_role_names.clone()
            } else {
                roles
            }
        })
        .unwrap_or_else(|| fallback.allowed_role_names.clone());

    PaymentAccessPolicy {
        enabled,
        allow_guest,
        allowed_role_names,
    }
}

fn sanitize_donation_config(raw: &serde_json::Value) -> PaymentDonationConfig {
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
