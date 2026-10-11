//! Non-custodial payment intents (PromptPay-first, multi-rail since Phases 2-4).
//! Phase 1 (roadmap 2026-08-18): intents moved out of JSONL into the WabiDB
//! `payments` stream as `payment_intent_created` / `payment_intent_confirmed`
//! / `payment_intent_rejected` events, replayed into the payment projection
//! on restart. The request creator or an administrator records receipt
//! manually; these records are not provider-verified settlement. A one-shot
//! migration replays any legacy `intents.jsonl`
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

use super::json_error;
use super::promptpay::{build_promptpay_qr_payload, PromptPayQrParams};
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
    /// Explicit PromptPay phone or national ID of the payee.
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
    /// Account holder name required for an EPC transfer to this payee.
    pub payee_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmIntentInput {
    pub actual_amount_minor: Option<i64>,
    pub reference_note: Option<String>,
}

/// WABI-XXXXXXXX reconciliation code from an unambiguous alphabet (no 0/O,
/// 1/I, 8/B confusion) — the memo/remittance the payer must include so the
/// seller can match the incoming transfer to the intent. Not a secret; a
/// UUID randomness keeps concurrent requests independent.
fn reference_code() -> String {
    const ALPHABET: &[u8] = b"2345679ACDEFGHJKMNPQRSTUVWXYZ";
    let mut code = String::with_capacity(13);
    code.push_str("WABI-");
    for byte in Uuid::new_v4().as_bytes().iter().take(8) {
        let idx = (*byte as usize) % ALPHABET.len();
        code.push(ALPHABET[idx] as char);
    }
    code
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
    PathBuf::from(data_dir)
        .join("payments")
        .join("intents.jsonl")
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
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) => {
            tracing::error!("payments: cannot open legacy intents for migration: {error}");
            return;
        }
    };
    let projection = match state.wdb.list_payment_intents(0, true).await {
        Ok(projection) => projection,
        Err(error) => {
            tracing::error!("payments: cannot read current intents for legacy migration: {error}");
            return;
        }
    };
    let known: std::collections::HashSet<String> = projection.into_iter().map(|i| i.id).collect();

    let mut migrated = 0usize;
    let mut failed = false;
    for (index, line) in std::io::BufReader::new(file).lines().enumerate() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                tracing::error!(
                    "payments: cannot read legacy intent line {}: {error}",
                    index + 1
                );
                failed = true;
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let intent = match serde_json::from_str::<PaymentIntentRecord>(&line) {
            Ok(intent) => intent,
            Err(error) => {
                tracing::error!(
                    "payments: invalid legacy intent line {}: {error}",
                    index + 1
                );
                failed = true;
                continue;
            }
        };
        if known.contains(&intent.id) {
            continue;
        }
        match state.wdb.create_payment_intent(&intent).await {
            Ok(()) => migrated += 1,
            Err(error) => {
                tracing::error!(
                    "payments: failed to import legacy intent line {}: {error}",
                    index + 1
                );
                failed = true;
                break;
            }
        }
    }
    if failed {
        tracing::error!(
            "payments: legacy intent migration incomplete; original JSONL preserved for recovery"
        );
        return;
    }
    let marker = path.with_file_name(format!(
        "intents.jsonl{}{}",
        LEGACY_JSONL_MARKER_SUFFIX,
        chrono::Utc::now().timestamp_millis()
    ));
    if let Err(error) = fs::rename(&path, &marker) {
        tracing::error!(
            "payments: legacy intents imported but source could not be marked migrated: {error}"
        );
        return;
    }
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
    let auth = match super::authenticate_account(&headers, &state).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let user_id = auth.user_id;
    let admission = match super::access::admit_payment(&state, &auth).await {
        Ok(admission) => admission,
        Err(response) => return response,
    };
    let policy_guard = state.payment_policy_lock.clone().lock_owned().await;
    let policy = match super::access::load_access_policy_locked(&state, false).await {
        Ok(policy) => policy,
        Err(error) => return super::access_unavailable(&error),
    };
    // WS-3: enforce the persisted payments access policy + user blocks.
    let actor = match super::evaluate_payment_access_with_owner(
        &state,
        &policy,
        user_id,
        auth.is_guest,
        admission.is_owner,
    )
    .await
    {
        Ok(actor) => actor,
        Err(error) => return super::access_unavailable(&error),
    };
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
    if input.amount_minor > 9_007_199_254_740_991 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "amountMinor exceeds the supported exact integer limit",
        );
    }
    let provider = input
        .provider
        .as_deref()
        .unwrap_or("promptpay")
        .trim()
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
    let expected_currency = match provider.as_str() {
        "promptpay" => "THB",
        "payments-eu" => "EUR",
        "payments-us" => "USD",
        "payments-crypto" => default_chain_currency(method_id.unwrap_or_default()),
        _ => "",
    };
    if input
        .currency
        .as_deref()
        .is_some_and(|currency| !currency.trim().eq_ignore_ascii_case(expected_currency))
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "currency must match the selected payment method",
        );
    }
    if country_code.as_deref().is_some_and(|country| {
        country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_alphabetic())
    }) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "countryCode must be two ASCII letters",
        );
    }

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
            if method_id.is_some_and(|method| method != "promptpay_qr") {
                return json_error(StatusCode::BAD_REQUEST, "methodId must be promptpay_qr");
            }
            if country_code
                .as_deref()
                .is_some_and(|country| country != "TH")
            {
                return json_error(StatusCode::BAD_REQUEST, "PromptPay requires countryCode TH");
            }
            let proxy = input.promptpay_proxy_id.clone().unwrap_or_default();
            if proxy.trim().is_empty() {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "promptpayProxyId required for the intended recipient",
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
            intent.currency = "THB".into();
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
                let presentation = match wabi_payments_crypto::presentation(&params) {
                    Ok(p) => p,
                    Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
                };
                intent.currency = default_chain_currency(chain).into();
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
                if method_id.is_some_and(|method| method != "epc_qr") {
                    return json_error(StatusCode::BAD_REQUEST, "methodId must be epc_qr");
                }
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
                // The name must belong to this destination account, rather
                // than the operator's unrelated account or a made-up default.
                let payee_name = match input.payee_name.as_deref().map(str::trim) {
                    Some(name) if !name.is_empty() => name.to_owned(),
                    _ => {
                        return json_error(
                            StatusCode::BAD_REQUEST,
                            "payeeName required (the recipient's bank account name)",
                        )
                    }
                };
                let params = EpcQrParams {
                    payee_name: &payee_name,
                    iban,
                    bic: None,
                    amount_minor: input.amount_minor,
                    purpose: None,
                    reference: None,
                    text: Some(&reference_code),
                    info: None,
                };
                let presentation = match wabi_payments_eu::presentation(&params, &reference_code) {
                    Ok(p) => p,
                    Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
                };
                intent.currency = "EUR".into();
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
                if country_code
                    .as_deref()
                    .is_some_and(|country| country != "US")
                {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        "US payment methods require countryCode US",
                    );
                }
                let currency = "USD".to_owned();
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

    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            let _policy = policy_guard;
            if let Err(e) = state.wdb.create_payment_intent(&intent).await {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("failed to persist intent: {}", e),
                );
            }
            Json(json!({ "success": true, "intent": intent })).into_response()
        })
        .await
}

pub async fn list_intents(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let auth = match super::authenticate_account(&headers, &state).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let user_id = auth.user_id;
    let admission = match super::access::admit_payment(&state, &auth).await {
        Ok(admission) => admission,
        Err(response) => return response,
    };
    let admin = admission.is_admin;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
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
        })
        .await
}

pub async fn confirm_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<ConfirmIntentInput>,
) -> Response {
    let auth = match super::authenticate_account(&headers, &state).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    if auth.is_guest {
        return json_error(
            StatusCode::FORBIDDEN,
            "A registered account is required to record receipt",
        );
    }
    let admission = match super::access::admit_payment(&state, &auth).await {
        Ok(admission) => admission,
        Err(response) => return response,
    };
    let admin = admission.is_admin;
    let operation_state = state.clone();
    admission.run(&operation_state, async move {
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
    // The request creator is the receiving party in this non-custodial
    // handshake. Recording receipt is an assertion, never provider evidence.
    if existing.user_id != auth.user_id && !admin {
        return json_error(StatusCode::FORBIDDEN, "Only the request creator or an administrator can record receipt");
    }
    if existing.status != "pending" {
        return json_error(StatusCode::CONFLICT, "Intent is not pending");
    }
    if input.actual_amount_minor.is_some_and(|amount| amount != existing.amount_minor) {
        return json_error(StatusCode::BAD_REQUEST, "actualAmountMinor must match the original request; partial or excess payments require a separate record");
    }
    match state
        .wdb
        .confirm_payment_intent(
            &id,
            auth.user_id,
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
    }).await
}

pub async fn reject_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<ConfirmIntentInput>,
) -> Response {
    let auth = match super::authenticate_account(&headers, &state).await {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    if auth.is_guest {
        return json_error(
            StatusCode::FORBIDDEN,
            "A registered account is required to close requests",
        );
    }
    let admission = match super::access::admit_payment(&state, &auth).await {
        Ok(admission) => admission,
        Err(response) => return response,
    };
    let admin = admission.is_admin;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
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
            if existing.user_id != auth.user_id && !admin {
                return json_error(
                    StatusCode::FORBIDDEN,
                    "Only the request creator or an administrator can close requests",
                );
            }
            if existing.status != "pending" {
                return json_error(StatusCode::CONFLICT, "Intent is not pending");
            }
            match state
                .wdb
                .reject_payment_intent(&id, auth.user_id, input.reference_note)
                .await
            {
                Ok(Some(intent)) => {
                    Json(json!({ "success": true, "intent": intent })).into_response()
                }
                Ok(None) => json_error(StatusCode::CONFLICT, "Intent is not pending"),
                Err(e) => json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("failed to reject intent: {}", e),
                ),
            }
        })
        .await
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
            assert_eq!(suffix.len(), 8);
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

    #[tokio::test]
    async fn partial_legacy_migration_preserves_original_and_retry_marks_complete_import() {
        use crate::config::{LoreAddonConfig, ServerConfig, ServerRole};
        let temp = tempfile::TempDir::new().unwrap();
        let data_dir = temp.path().to_string_lossy().into_owned();
        let state = Arc::new(
            AppState::new(ServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                data_dir: data_dir.clone(),
                uploads_dir: temp.path().join("uploads").to_string_lossy().into_owned(),
                jwt_secret: "payment-migration-test".into(),
                turn_enabled: false,
                turn_uri: None,
                turn_secret: None,
                node_id: "payment-migration-test".into(),
                is_primary: true,
                server_role: ServerRole::Authority,
                authority_url: None,
                admin_user_ids: vec![],
                blacklist_file: temp
                    .path()
                    .join("blacklist.txt")
                    .to_string_lossy()
                    .into_owned(),
                max_body_size: None,
                mesh_enabled: false,
                mesh_peers: vec![],
                lore: LoreAddonConfig {
                    enabled: false,
                    ..Default::default()
                },
            })
            .await
            .unwrap(),
        );
        let path = legacy_intents_path(&data_dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let valid = serde_json::json!({
            "id": "pi_legacy_migration", "userId": 7, "provider": "promptpay",
            "amountMinor": 100, "currency": "THB", "status": "pending",
            "promptpayProxyId": "0812345678", "promptpayQrPayload": null,
            "note": null, "createdAt": 1000, "updatedAt": 1000,
            "confirmedBy": null, "confirmNote": null
        })
        .to_string();
        let source = format!("{valid}\ninvalid legacy record\n");
        fs::write(&path, &source).unwrap();
        migrate_legacy_intents(&state).await;
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            source,
            "incomplete import must retain source byte for byte"
        );
        assert!(state
            .wdb
            .get_payment_intent("pi_legacy_migration")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1,
            "no migrated marker on partial import"
        );
        // Operator repairs the malformed source; existing accepted records
        // are skipped, and the complete source is archived only now.
        fs::write(&path, format!("{valid}\n")).unwrap();
        migrate_legacy_intents(&state).await;
        assert!(!path.exists());
        assert_eq!(
            state.wdb.list_payment_intents(0, true).await.unwrap().len(),
            1
        );
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
}
