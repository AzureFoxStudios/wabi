//! Non-custodial payment intents (PromptPay-first).
//! Stored as JSONL under `{data_dir}/payments/intents.jsonl` so we do not
//! require a WabiDB schema change for this overnight pass.
//! Admin manually confirms PromptPay (Thai banks don't webhook hobbyist servers).

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::promptpay::{build_promptpay_qr_payload, PromptPayQrParams};
use super::{extract_user_id, is_admin_user, json_error};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentIntent {
    pub id: String,
    pub user_id: i64,
    pub provider: String, // "promptpay" | "stripe" (stripe stub)
    pub amount_minor: i64,
    pub currency: String,
    pub status: String, // pending | completed | rejected | expired
    pub promptpay_proxy_id: Option<String>,
    pub promptpay_qr_payload: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub confirmed_by: Option<i64>,
    pub confirm_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIntentInput {
    pub amount_minor: i64,
    pub currency: Option<String>,
    /// PromptPay phone or national ID of the *payee* (server operator).
    pub promptpay_proxy_id: Option<String>,
    pub note: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmIntentInput {
    pub actual_amount_minor: Option<i64>,
    pub reference_note: Option<String>,
}

fn intents_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("payments").join("intents.jsonl")
}

fn ensure_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn load_intents(data_dir: &str) -> Vec<PaymentIntent> {
    let path = intents_path(data_dir);
    if !path.exists() {
        return Vec::new();
    }
    let Ok(file) = fs::File::open(&path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(i) = serde_json::from_str::<PaymentIntent>(&line) {
            out.push(i);
        }
    }
    out
}

fn rewrite_intents(data_dir: &str, intents: &[PaymentIntent]) {
    let path = intents_path(data_dir);
    ensure_dir(&path);
    let tmp = path.with_extension("jsonl.tmp");
    if let Ok(mut f) = fs::File::create(&tmp) {
        for i in intents {
            if let Ok(line) = serde_json::to_string(i) {
                let _ = writeln!(f, "{line}");
            }
        }
        let _ = f.sync_all();
        let _ = fs::rename(tmp, path);
    }
}

fn append_intent(data_dir: &str, intent: &PaymentIntent) {
    let path = intents_path(data_dir);
    ensure_dir(&path);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        if let Ok(line) = serde_json::to_string(intent) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub async fn create_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateIntentInput>,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if input.amount_minor <= 0 {
        return json_error(StatusCode::BAD_REQUEST, "amountMinor must be > 0");
    }
    let provider = input
        .provider
        .as_deref()
        .unwrap_or("promptpay")
        .to_ascii_lowercase();
    if provider != "promptpay" {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Only promptpay intents are supported in core v1 (non-custodial)",
        );
    }

    let proxy = input
        .promptpay_proxy_id
        .clone()
        .or_else(|| std::env::var("WABI_PROMPTPAY_PROXY_ID").ok())
        .unwrap_or_default();
    if proxy.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "promptpayProxyId required (or set WABI_PROMPTPAY_PROXY_ID)",
        );
    }

    let id = format!("pi_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().timestamp_millis();
    let qr = match build_promptpay_qr_payload(PromptPayQrParams {
        proxy_id: proxy.trim(),
        amount_minor: input.amount_minor,
        intent_id: &id,
        merchant_name: &env_or("WABI_PROMPTPAY_MERCHANT_NAME", "WABI"),
        merchant_city: &env_or("WABI_PROMPTPAY_MERCHANT_CITY", "BANGKOK"),
    }) {
        Ok(p) => p,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
    };

    let intent = PaymentIntent {
        id,
        user_id,
        provider: "promptpay".into(),
        amount_minor: input.amount_minor,
        currency: input
            .currency
            .unwrap_or_else(|| "THB".into())
            .to_ascii_uppercase(),
        status: "pending".into(),
        promptpay_proxy_id: Some(proxy.trim().to_string()),
        promptpay_qr_payload: Some(qr),
        note: input.note,
        created_at: now,
        updated_at: now,
        confirmed_by: None,
        confirm_note: None,
    };
    append_intent(&state.config.data_dir, &intent);
    Json(json!({ "success": true, "intent": intent })).into_response()
}

pub async fn list_intents(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let user_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    let admin = is_admin_user(user_id, &state).await;
    let mut intents = load_intents(&state.config.data_dir);
    if !admin {
        intents.retain(|i| i.user_id == user_id);
    }
    intents.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(json!({ "success": true, "intents": intents })).into_response()
}

pub async fn confirm_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<ConfirmIntentInput>,
) -> Response {
    let admin_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let mut intents = load_intents(&state.config.data_dir);
    let Some(pos) = intents.iter().position(|i| i.id == id) else {
        return json_error(StatusCode::NOT_FOUND, "Intent not found");
    };
    if intents[pos].status != "pending" {
        return json_error(StatusCode::CONFLICT, "Intent is not pending");
    }
    let now = chrono::Utc::now().timestamp_millis();
    intents[pos].status = "completed".into();
    intents[pos].updated_at = now;
    intents[pos].confirmed_by = Some(admin_id);
    intents[pos].confirm_note = input.reference_note;
    if let Some(amt) = input.actual_amount_minor {
        if amt > 0 {
            intents[pos].amount_minor = amt;
        }
    }
    rewrite_intents(&state.config.data_dir, &intents);
    Json(json!({ "success": true, "intent": intents[pos].clone() })).into_response()
}

pub async fn reject_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<ConfirmIntentInput>,
) -> Response {
    let admin_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let mut intents = load_intents(&state.config.data_dir);
    let Some(pos) = intents.iter().position(|i| i.id == id) else {
        return json_error(StatusCode::NOT_FOUND, "Intent not found");
    };
    if intents[pos].status != "pending" {
        return json_error(StatusCode::CONFLICT, "Intent is not pending");
    }
    let now = chrono::Utc::now().timestamp_millis();
    intents[pos].status = "rejected".into();
    intents[pos].updated_at = now;
    intents[pos].confirmed_by = Some(admin_id);
    intents[pos].confirm_note = input.reference_note;
    rewrite_intents(&state.config.data_dir, &intents);
    Json(json!({ "success": true, "intent": intents[pos].clone() })).into_response()
}
