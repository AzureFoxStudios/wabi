//! Non-custodial payment intents (PromptPay-first, multi-rail since Phases 2-4).
//! Phase 1 (roadmap 2026-08-18): intents moved out of JSONL into the WabiDB
//! `payments` stream as `payment_intent_created` / `payment_intent_confirmed`
//! / `payment_intent_rejected` events, replayed into the payment projection
//! on restart. Admin manually confirms PromptPay (Thai banks don't webhook
//! hobbyist servers). A one-shot migration replays any legacy `intents.jsonl`
//! file from the pre-Phase-1 overnight pass.
//!
//! Phases 2-4: `provider` selects a compile-time-optional rail addon
//! (payments-crypto / payments-eu / payments-us, cargo feature
//! `payments-rails`). Each rail renders a rail-agnostic presentation blob
//! (`presentation_json` on the intent record) that the frontend intent card
//! renders: `{ mode: "qr", qrData, copyText, referenceCode, note }` or
//! `{ mode: "app_switch", pointer, pointerLabel, referenceCode, disclosure }`.

use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::promptpay::{build_promptpay_qr_payload, PromptPayQrParams};
use super::{evaluate_payment_access, extract_identity, extract_user_id, is_admin_user, json_error};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::payments::PaymentIntentRecord;

/// API alias of the wabidb payment-intent projection record. Serializes
/// camelCase exactly like the former JSONL rows, so the frontend contract
/// is unchanged.
pub type PaymentIntent = PaymentIntentRecord;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIntentInput {
    pub amount_minor: i64,
    pub currency: Option<String>,
    /// PromptPay phone or national ID of the *payee* (server operator).
    pub promptpay_proxy_id: Option<String>,
    pub note: Option<String>,
    pub provider: Option<String>,
    /// Rail-specific method id (e.g. `promptpay_qr`, `usdc_base`, `epc_qr`,
    /// `cashapp_pointer`) — required for the payments-* rails.
    pub method_id: Option<String>,
    /// 2-letter country scoping the request (TH / DE / US / …).
    pub country_code: Option<String>,
    /// Rail-specific payee pointer/account (wallet address, IBAN, $cashtag,
    /// ACH routing/account, …) — required for the payments-* rails.
    pub provider_ref: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmIntentInput {
    pub actual_amount_minor: Option<i64>,
    pub reference_note: Option<String>,
}

/// WABI-XXXX reconciliation code from an unambiguous alphabet (no 0/O,
/// 1/I, 8/B confusion) — the memo/remittance the payer must include so the
/// seller can match the incoming transfer to the intent. Not a secret; a
/// time+pid mix avoids pulling an RNG dependency into the server.
fn reference_code() -> String {
    const ALPHABET: &[u8] = b"2345679ACDEFGHJKMNPQRSTUVWXYZ";
    let mut code = String::with_capacity(9);
    code.push_str("WABI-");
    for _ in 0..4 {
        let idx = (rand_byte() as usize) % ALPHABET.len();
        code.push(ALPHABET[idx] as char);
    }
    code
}

fn rand_byte() -> u8 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    ((nanos ^ std::process::id()) >> 3) as u8
}

/// Default currency per payments-crypto chain when the request omits one.
fn default_chain_currency(chain: &str) -> &'static str {
    match chain {
        "usdc_base" | "usdc_solana" => "USDC",
        "usdt_tron" => "USDT",
        "btc" | "lightning" => "BTC",
        "monero" => "XMR",
        _ => "USD",
    }
}

// ---------------------------------------------------------------------------
// Legacy JSONL migration (pre-Phase-1 intent store)
// ---------------------------------------------------------------------------

const LEGACY_JSONL_MARKER_SUFFIX: &str = ".migrated";

fn legacy_intents_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("payments").join("intents.jsonl")
}

/// One-shot migration of the pre-Phase-1 `intents.jsonl` file. Replays each
/// row as a `payment_intent_created` event (skipping ids the projection
/// already knows) and renames the file to `intents.jsonl.migrated` so the
/// replay cannot double-import. Fire-and-forget from the routes constructor.
pub async fn migrate_legacy_intents(state: &Arc<AppState>) {
    let path = legacy_intents_path(&state.config.data_dir);
    if !path.exists() {
        return;
    }
    let Ok(file) = fs::File::open(&path) else {
        return;
    };
    let Ok(projection) = state.wdb.list_payment_intents(0, true).await else {
        return;
    };
    let known: std::collections::HashSet<String> =
        projection.into_iter().map(|i| i.id).collect();

    let mut migrated = 0usize;
    for line in std::io::BufReader::new(file).lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(intent) = serde_json::from_str::<PaymentIntentRecord>(&line) else {
            continue;
        };
        if known.contains(&intent.id) {
            continue;
        }
        if state.wdb.create_payment_intent(&intent).await.is_ok() {
            migrated += 1;
        }
    }
    let marker = path.with_file_name(format!(
        "intents.jsonl{}{}",
        LEGACY_JSONL_MARKER_SUFFIX,
        chrono::Utc::now().timestamp_millis()
    ));
    let _ = fs::rename(&path, &marker);
    if migrated > 0 {
        tracing::info!(
            "payments: migrated {} legacy intent(s) from intents.jsonl into the WabiDB projection",
            migrated
        );
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub async fn create_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CreateIntentInput>,
) -> Response {
    let (user_id, is_guest) = match extract_identity(&headers, &state.config.jwt_secret) {
        Ok(identity) => identity,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    // WS-3: enforce the persisted payments access policy + user blocks.
    let actor = evaluate_payment_access(&state, user_id, is_guest).await;
    if actor.get("canCreate").and_then(|v| v.as_bool()) != Some(true) {
        let reason = actor
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("Your account cannot create payments on this server.");
        return json_error(StatusCode::FORBIDDEN, reason);
    }
    if input.amount_minor <= 0 {
        return json_error(StatusCode::BAD_REQUEST, "amountMinor must be > 0");
    }
    let provider = input
        .provider
        .as_deref()
        .unwrap_or("promptpay")
        .to_ascii_lowercase();
    let method_id = input
        .method_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let country_code = input
        .country_code
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_uppercase());
    let provider_ref = input
        .provider_ref
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let id = format!("pi_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().timestamp_millis();
    let mut intent = PaymentIntent {
        id,
        user_id,
        provider: provider.clone(),
        amount_minor: input.amount_minor,
        currency: "THB".into(),
        status: "pending".into(),
        method_id: None,
        country_code: None,
        presentation_json: None,
        promptpay_proxy_id: None,
        promptpay_qr_payload: None,
        note: input.note,
        created_at: now,
        updated_at: now,
        confirmed_by: None,
        confirm_note: None,
    };

    match provider.as_str() {
        "promptpay" => {
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
            let qr = match build_promptpay_qr_payload(PromptPayQrParams {
                proxy_id: proxy.trim(),
                amount_minor: input.amount_minor,
                intent_id: &intent.id,
                merchant_name: &env_or("WABI_PROMPTPAY_MERCHANT_NAME", "WABI"),
                merchant_city: &env_or("WABI_PROMPTPAY_MERCHANT_CITY", "BANGKOK"),
            }) {
                Ok(p) => p,
                Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
            };
            intent.currency = input
                .currency
                .unwrap_or_else(|| "THB".into())
                .to_ascii_uppercase();
            intent.method_id = Some("promptpay_qr".into());
            intent.country_code = Some("TH".into());
            intent.promptpay_proxy_id = Some(proxy.trim().to_string());
            intent.promptpay_qr_payload = Some(qr);
        }

        "payments-crypto" => {
            #[cfg(feature = "wabi-payments-crypto")]
            {
                use wabi_payments_crypto::RenderParams;
                let chain = match method_id {
                    Some(c) if wabi_payments_crypto::chain_info(c).is_some() => c,
                    _ => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "methodId required: one of usdc_base, usdc_solana, usdt_tron, btc, lightning, monero",
                        )
                    }
                };
                let pointer = match provider_ref {
                    Some(p) => p,
                    None => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "providerRef required (wallet address / LNURL / BOLT12 offer / …)",
                        )
                    }
                };
                let reference_code = reference_code();
                let merchant_name = env_or("WABI_CRYPTO_MERCHANT_NAME", "WABI");
                let params = RenderParams {
                    chain,
                    pointer,
                    amount_minor: input.amount_minor,
                    reference_code: &reference_code,
                    merchant_name: &merchant_name,
                };
                let presentation =
                    match wabi_payments_crypto::presentation(&params) {
                        Ok(p) => p,
                        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
                    };
                intent.currency = input
                    .currency
                    .unwrap_or_else(|| default_chain_currency(chain).into())
                    .to_ascii_uppercase();
                intent.method_id = Some(chain.into());
                intent.country_code = country_code;
                intent.presentation_json = Some(presentation.to_string());
            }
            #[cfg(not(feature = "wabi-payments-crypto"))]
            {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "payments-crypto rail is not enabled in this build (compile with --features payments-rails)",
                );
            }
        }

        "payments-eu" => {
            #[cfg(feature = "wabi-payments-eu")]
            {
                use wabi_payments_eu::EpcQrParams;
                let iban = match provider_ref {
                    Some(i) => i,
                    None => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "providerRef required (the payee IBAN)",
                        )
                    }
                };
                let reference_code = reference_code();
                let payee_name = env_or("WABI_EU_PAYEE_NAME", "WABI");
                let bic = std::env::var("WABI_EU_BIC").ok();
                let bic = bic.as_deref().filter(|b| !b.trim().is_empty());
                let params = EpcQrParams {
                    payee_name: &payee_name,
                    iban,
                    bic,
                    amount_minor: input.amount_minor,
                    purpose: None,
                    reference: Some(&reference_code),
                    text: None,
                    info: None,
                };
                let presentation =
                    match wabi_payments_eu::presentation(&params, &reference_code) {
                        Ok(p) => p,
                        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
                    };
                intent.currency = input.currency.unwrap_or_else(|| "EUR".into());
                intent.method_id = Some("epc_qr".into());
                intent.country_code = country_code.or_else(|| Some("DE".into()));
                intent.presentation_json = Some(presentation.to_string());
            }
            #[cfg(not(feature = "wabi-payments-eu"))]
            {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "payments-eu rail is not enabled in this build (compile with --features payments-rails)",
                );
            }
        }

        "payments-us" => {
            #[cfg(feature = "wabi-payments-us")]
            {
                let rail = match method_id {
                    Some(r) => r,
                    None => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "methodId required: cashapp_pointer, venmo_handle, zelle_pointer, ach_details",
                        )
                    }
                };
                let pointer = match provider_ref {
                    Some(p) => p,
                    None => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "providerRef required ($cashtag / @handle / email or phone / routing-account)",
                        )
                    }
                };
                let reference_code = reference_code();
                let currency = input.currency.unwrap_or_else(|| "USD".into());
                let presentation = match wabi_payments_us::presentation(
                    rail,
                    pointer,
                    &reference_code,
                    input.amount_minor,
                    &currency,
                ) {
                    Ok(p) => p,
                    Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
                };
                intent.currency = currency.to_ascii_uppercase();
                intent.method_id = Some(rail.into());
                intent.country_code = country_code.or_else(|| Some("US".into()));
                intent.presentation_json = Some(presentation.to_string());
            }
            #[cfg(not(feature = "wabi-payments-us"))]
            {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "payments-us rail is not enabled in this build (compile with --features payments-rails)",
                );
            }
        }

        other => {
            return json_error(
                StatusCode::BAD_REQUEST,
                &format!("Unknown provider: {other}"),
            )
        }
    }

    if let Err(e) = state.wdb.create_payment_intent(&intent).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to persist intent: {}", e),
        );
    }
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
    let intents = match state.wdb.list_payment_intents(user_id, admin).await {
        Ok(intents) => intents,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to load intents: {}", e),
            )
        }
    };
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
    let existing = match state.wdb.get_payment_intent(&id).await {
        Ok(Some(i)) => i,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Intent not found"),
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to load intent: {}", e),
            )
        }
    };
    if existing.status != "pending" {
        return json_error(StatusCode::CONFLICT, "Intent is not pending");
    }
    match state
        .wdb
        .confirm_payment_intent(
            &id,
            admin_id,
            input.actual_amount_minor,
            input.reference_note,
        )
        .await
    {
        Ok(Some(intent)) => Json(json!({ "success": true, "intent": intent })).into_response(),
        Ok(None) => json_error(StatusCode::CONFLICT, "Intent is not pending"),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to confirm intent: {}", e),
        ),
    }
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
    let existing = match state.wdb.get_payment_intent(&id).await {
        Ok(Some(i)) => i,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Intent not found"),
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to load intent: {}", e),
            )
        }
    };
    if existing.status != "pending" {
        return json_error(StatusCode::CONFLICT, "Intent is not pending");
    }
    match state
        .wdb
        .reject_payment_intent(&id, admin_id, input.reference_note)
        .await
    {
        Ok(Some(intent)) => Json(json!({ "success": true, "intent": intent })).into_response(),
        Ok(None) => json_error(StatusCode::CONFLICT, "Intent is not pending"),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to reject intent: {}", e),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_code_shape() {
        for _ in 0..50 {
            let code = reference_code();
            assert!(code.starts_with("WABI-"));
            let suffix = &code[5..];
            assert_eq!(suffix.len(), 4);
            assert!(
                suffix
                    .bytes()
                    .all(|b| b"2345679ACDEFGHJKMNPQRSTUVWXYZ".contains(&b)),
                "code uses only the unambiguous alphabet: {code}"
            );
        }
    }

    #[test]
    fn default_chain_currencies() {
        assert_eq!(default_chain_currency("usdc_base"), "USDC");
        assert_eq!(default_chain_currency("usdt_tron"), "USDT");
        assert_eq!(default_chain_currency("btc"), "BTC");
        assert_eq!(default_chain_currency("monero"), "XMR");
        assert_eq!(default_chain_currency("nope"), "USD");
    }
}