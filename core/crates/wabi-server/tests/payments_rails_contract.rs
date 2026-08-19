//! Payments rails Phases 2-4 contract (roadmap 2026-08-18) — feature-gated
//! on `payments-rails` (compile with `--features payments-rails`):
//! - `/addons` lists payments-crypto / payments-eu / payments-us when enabled
//! - intents on the crypto/EU/US rails persist `methodId`, `countryCode`,
//!   and a `presentationJson` blob rendered by the frontend intent card
//! - invalid pointers are rejected with 400 without writing an event

#![cfg(feature = "payments-rails")]

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

use wabi_server::api::routes::create_api_router;
use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
use wabi_server::state::AppState;

fn test_config(data_dir: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data_dir.to_string_lossy().into_owned(),
        uploads_dir: data_dir.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "test-jwt-secret".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "node-test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data_dir.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/var/wabi/lore".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        },
    }
}

async fn fresh_server() -> (tempfile::TempDir, axum::Router) {
    let tmp = tempfile::TempDir::new().unwrap();
    let config = test_config(tmp.path());
    let state = Arc::new(AppState::new(config).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state);
    (tmp, app)
}

async fn register(app: &axum::Router, username: &str) -> String {
    let body =
        serde_json::json!({ "username": username, "password": "password123" }).to_string();
    let response = app
        .clone()
        .oneshot(
            Request::post("/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert_eq!(status, StatusCode::OK, "register {username}: {text}");
    let json: Value = serde_json::from_str(&text).unwrap();
    json["token"].as_str().unwrap().to_string()
}

fn authed(method: &str, path: &str, token: &str, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder
        .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
        .unwrap()
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn addons_endpoint_lists_payments_rails() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp; // keep the temp data dir alive for the engine
    let addons: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/addons", "", None))
            .await
            .unwrap(),
    )
    .await;
    let ids: Vec<&str> = addons["addons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"payments-crypto"), "ids: {ids:?}");
    assert!(ids.contains(&"payments-eu"), "ids: {ids:?}");
    assert!(ids.contains(&"payments-us"), "ids: {ids:?}");
}

#[tokio::test]
async fn crypto_rail_intent_round_trip() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp;
    let owner = register(&app, "alice").await;

    let create = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-crypto",
                "methodId": "usdc_base",
                "providerRef": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "amountMinor": 250000,
                "currency": "USDC",
                "note": "poster"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK, "crypto intent must create");
    let created: Value = body_json(create).await;
    assert_eq!(created["intent"]["provider"], "payments-crypto");
    assert_eq!(created["intent"]["methodId"], "usdc_base");
    assert_eq!(created["intent"]["currency"], "USDC");
    let presentation = created["intent"]["presentationJson"].as_str().unwrap();
    let presentation: Value = serde_json::from_str(presentation).unwrap();
    assert_eq!(presentation["mode"], "qr");
    assert_eq!(
        presentation["qrData"],
        "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453"
    );
    assert!(presentation["referenceCode"]
        .as_str()
        .unwrap()
        .starts_with("WABI-"));

    let intent_id = created["intent"]["id"].as_str().unwrap().to_string();
    let confirm = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/payments/intents/{intent_id}/confirm"),
            &owner,
            Some(serde_json::json!({ "referenceNote": "tx on ledger" })),
        ))
        .await
        .unwrap();
    assert_eq!(confirm.status(), StatusCode::OK);
    let confirmed: Value = body_json(confirm).await;
    assert_eq!(confirmed["intent"]["status"], "completed");
}

#[tokio::test]
async fn eu_rail_intent_builds_epc_payload() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp;
    let owner = register(&app, "alice").await;

    let create = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-eu",
                "methodId": "epc_qr",
                "providerRef": "DE33100205000001194700",
                "amountMinor": 2700,
                "currency": "EUR",
                "countryCode": "DE"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK, "eu intent must create");
    let created: Value = body_json(create).await;
    assert_eq!(created["intent"]["provider"], "payments-eu");
    assert_eq!(created["intent"]["methodId"], "epc_qr");
    assert_eq!(created["intent"]["countryCode"], "DE");
    let presentation: Value =
        serde_json::from_str(created["intent"]["presentationJson"].as_str().unwrap()).unwrap();
    assert_eq!(presentation["mode"], "qr");
    let qr_data = presentation["qrData"].as_str().unwrap();
    assert!(qr_data.starts_with("BCD\n002\n1\nSCT\n"), "qr: {qr_data}");
    assert!(qr_data.contains("\nDE33100205000001194700\n"), "qr: {qr_data}");
    assert!(qr_data.lines().any(|l| l == "EUR27"), "amount must be minimal-form: {qr_data}");
    assert!(!qr_data.contains("EUR27.00"), "amount must be minimal-form: {qr_data}");
    assert!(
        qr_data.lines().last().unwrap().starts_with("WABI-"),
        "structured reference is the last element: {qr_data}"
    );
    assert!(presentation["referenceCode"]
        .as_str()
        .unwrap()
        .starts_with("WABI-"));
}

#[tokio::test]
async fn us_rail_intent_carries_disclosure() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp;
    let owner = register(&app, "alice").await;

    let create = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-us",
                "methodId": "zelle_pointer",
                "providerRef": "mika@example.com",
                "amountMinor": 5000,
                "currency": "USD"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK, "us intent must create");
    let created: Value = body_json(create).await;
    assert_eq!(created["intent"]["provider"], "payments-us");
    assert_eq!(created["intent"]["methodId"], "zelle_pointer");
    assert_eq!(created["intent"]["countryCode"], "US");
    let presentation: Value =
        serde_json::from_str(created["intent"]["presentationJson"].as_str().unwrap()).unwrap();
    assert_eq!(presentation["mode"], "app_switch");
    assert_eq!(presentation["pointer"], "mika@example.com");
    assert!(presentation["disclosure"]
        .as_str()
        .unwrap()
        .contains("legal name"));
    assert!(presentation["referenceCode"]
        .as_str()
        .unwrap()
        .starts_with("WABI-"));
}

#[tokio::test]
async fn invalid_rail_inputs_rejected_without_events() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp;
    let owner = register(&app, "alice").await;

    // Bad crypto pointer (not a Base address).
    let bad_crypto = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-crypto",
                "methodId": "usdc_base",
                "providerRef": "not-an-address",
                "amountMinor": 100
            })),
        ))
        .await
        .unwrap();
    assert_eq!(bad_crypto.status(), StatusCode::BAD_REQUEST);

    // Unknown chain.
    let bad_chain = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-crypto",
                "methodId": "usdc_fantom",
                "providerRef": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "amountMinor": 100
            })),
        ))
        .await
        .unwrap();
    assert_eq!(bad_chain.status(), StatusCode::BAD_REQUEST);

    // Invalid IBAN (checksum off by one).
    let bad_iban = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-eu",
                "providerRef": "DE33100205000001194701",
                "amountMinor": 100
            })),
        ))
        .await
        .unwrap();
    assert_eq!(bad_iban.status(), StatusCode::BAD_REQUEST);

    // Unknown US rail.
    let bad_rail = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({
                "provider": "payments-us",
                "methodId": "wero",
                "providerRef": "x",
                "amountMinor": 100
            })),
        ))
        .await
        .unwrap();
    assert_eq!(bad_rail.status(), StatusCode::BAD_REQUEST);

    // Nothing was persisted: the owner's intent list is empty.
    let list: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/intents", &owner, None))
            .await
            .unwrap(),
    )
    .await;
    assert!(list["intents"].as_array().unwrap().is_empty());
}