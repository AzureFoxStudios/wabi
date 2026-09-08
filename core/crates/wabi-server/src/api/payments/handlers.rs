use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::{
    account_user_id, get_policy_row, is_admin_user, json_error, upsert_policy,
    AccountLinkInput, ListQuery, PaymentAccountLink, PaymentDonationConfig,
    PaymentUserBlock, SaveAccessInput, SaveDonationInput, UserBlockInput, DEFAULT_WORKSPACE_ID,
};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

pub async fn get_payment_access(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let auth = super::authenticate_account(&headers, &state).await.ok();
    // Import is an administrator-owned migration; public/member reads only
    // resolve the legacy value when no canonical row exists.
    let import_legacy = match &auth {
        Some(auth) if !auth.is_guest => state.is_admin(auth.user_id).await,
        _ => false,
    };
    let policy = match super::load_access_policy(&state, import_legacy).await {
        Ok(policy) => policy,
        Err(error) => return super::access_unavailable(&error),
    };
    // WS-3: the actor is now computed server-side from the persisted policy
    // and user blocks, matching the frontend PaymentAccessActorStatus contract.
    let actor = match auth {
        Some(auth) => match super::evaluate_payment_access(&state, &policy, auth.user_id, auth.is_guest).await {
            Ok(actor) => actor,
            Err(error) => return super::access_unavailable(&error),
        },
        None => serde_json::json!({
            "authenticated": false,
            "userId": null,
            "roles": [],
            "blocked": false,
            "canCreate": false,
            "reasonCode": "unauthenticated",
            "reason": "Sign in to create payments."
        }),
    };
    Json(json!({ "success": true, "policy": policy, "actor": actor })).into_response()
}

pub async fn save_payment_access(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<SaveAccessInput>,
) -> Response {
    let auth = match super::authenticate_account(&headers, &state).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    if auth.is_guest || !is_admin_user(auth.user_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let sanitized = match super::parse_access_policy(&input.policy) {
        Ok(policy) => policy,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    if let Err(error) = super::save_access_policy(&state, &sanitized).await {
        return super::access_unavailable(&error);
    }
    Json(json!({ "success": true, "policy": sanitized })).into_response()
}

pub async fn list_account_links(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let user_id = match account_user_id(&headers, &state).await {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    let _workspace_id = query
        .workspace_id
        .as_deref()
        .unwrap_or(DEFAULT_WORKSPACE_ID);
    let links = match state.wdb.list_payment_account_links(user_id).await {
        Ok(links) => links,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to load account links: {}", e),
            )
        }
    };
    Json(json!({ "success": true, "links": links })).into_response()
}

pub async fn create_account_link(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<AccountLinkInput>,
) -> Response {
    let user_id = match account_user_id(&headers, &state).await {
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
    if let Err(e) = state.wdb.upsert_payment_account_link(&link).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to save account link: {}", e),
        );
    }
    Json(json!({ "success": true, "link": link })).into_response()
}

pub async fn delete_account_link(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(plugin_id): Path<String>,
) -> Response {
    let user_id = match account_user_id(&headers, &state).await {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if let Err(e) = state
        .wdb
        .delete_payment_account_link(user_id, &plugin_id)
        .await
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to delete account link: {}", e),
        );
    }
    Json(json!({ "success": true })).into_response()
}

pub async fn get_donation_config(State(state): State<Arc<AppState>>) -> Response {
    let config = match get_policy_row(&state, "policy:payments_donations").await {
        Ok(Some(value)) => match serde_json::from_value::<PaymentDonationConfig>(value) {
            Ok(config) => config,
            Err(error) => return super::access_unavailable(&error.into()),
        },
        Ok(None) => PaymentDonationConfig::default(),
        Err(error) => return super::access_unavailable(&error),
    };
    Json(json!({ "success": true, "config": config })).into_response()
}

pub async fn save_donation_config(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<SaveDonationInput>,
) -> Response {
    let user_id = match account_user_id(&headers, &state).await {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if !is_admin_user(user_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let config = sanitize_donation_config(&input.config);
    if let Err(error) = upsert_policy(
        &state,
        "policy:payments_donations",
        &serde_json::to_value(&config).unwrap(),
    )
    .await {
        return super::access_unavailable(&error);
    }
    Json(json!({ "success": true, "config": config })).into_response()
}

pub async fn list_user_blocks(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let user_id = match account_user_id(&headers, &state).await {
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
    let blocks = match state.wdb.list_payment_user_blocks(workspace_id).await {
        Ok(blocks) => blocks,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to load user blocks: {}", e),
            )
        }
    };
    Json(json!({ "success": true, "blocks": blocks })).into_response()
}

pub async fn create_user_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<UserBlockInput>,
) -> Response {
    let admin_id = match account_user_id(&headers, &state).await {
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
    if let Err(e) = state.wdb.upsert_payment_user_block(&block).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to save user block: {}", e),
        );
    }
    Json(json!({ "success": true, "block": block })).into_response()
}

pub async fn clear_user_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(blocked_user_id): Path<i64>,
) -> Response {
    let admin_id = match account_user_id(&headers, &state).await {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    if let Err(e) = state
        .wdb
        .delete_payment_user_block(DEFAULT_WORKSPACE_ID, blocked_user_id)
        .await
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to clear user block: {}", e),
        );
    }
    Json(json!({ "success": true })).into_response()
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
