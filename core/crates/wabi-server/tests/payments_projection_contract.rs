//! Payments Phase 1 contract (roadmap 2026-08-18):
//! - intents are persisted as events (created → confirmed/rejected), NOT JSONL
//! - intents survive a full engine restart (replay from the stream log)
//! - non-admins can create intents but cannot confirm/reject
//! - account links upsert/delete against the projection
//! - policy rows (payments_access) persist

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

fn register_request(username: &str) -> Request<Body> {
    let body = serde_json::json!({ "username": username, "password": "password123" }).to_string();
    Request::post("/auth/register")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap()
}

async fn register(app: &axum::Router, username: &str) -> String {
    let response = app
        .clone()
        .oneshot(register_request(username))
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

fn promptpay_create() -> Value {
    serde_json::json!({
        "provider": "promptpay",
        "amountMinor": 20000,
        "currency": "THB",
        "promptpayProxyId": "0812345678",
        "note": "poster commission"
    })
}

#[tokio::test]
async fn intent_created_listed_confirmed_and_persisted() {
    let (tmp, app) = fresh_server().await;
    let owner = register(&app, "alice").await; // first registrant = owner/admin
    let member = register(&app, "bob").await;

    // Non-admin can create an intent…
    let create = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &member, Some(promptpay_create())))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK, "non-admin create must succeed");
    let created: Value = body_json(create).await;
    assert_eq!(created["success"], true);
    let intent_id = created["intent"]["id"].as_str().unwrap().to_string();
    assert!(intent_id.starts_with("pi_"), "id: {intent_id}");
    assert_eq!(created["intent"]["status"], "pending");
    assert_eq!(created["intent"]["amountMinor"], 20000);
    assert!(created["intent"]["promptpayQrPayload"].is_string());

    // …but cannot confirm or reject.
    let member_confirm = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/payments/intents/{intent_id}/confirm"),
            &member,
            Some(serde_json::json!({ "referenceNote": "nope" })),
        ))
        .await
        .unwrap();
    assert_eq!(member_confirm.status(), StatusCode::FORBIDDEN);

    // Owner lists both own + all intents (admin view); member sees own only.
    let owner_list = app
        .clone()
        .oneshot(authed("GET", "/payments/intents", &owner, None))
        .await
        .unwrap();
    let owner_list: Value = body_json(owner_list).await;
    assert_eq!(owner_list["intents"].as_array().unwrap().len(), 1);

    let member_list = app
        .clone()
        .oneshot(authed("GET", "/payments/intents", &member, None))
        .await
        .unwrap();
    let member_list: Value = body_json(member_list).await;
    assert_eq!(member_list["intents"].as_array().unwrap().len(), 1);

    // Owner confirms (manual bank-statement check), then re-confirm is 409.
    let confirm = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/payments/intents/{intent_id}/confirm"),
            &owner,
            Some(serde_json::json!({ "actualAmountMinor": 20000, "referenceNote": "seen on statement" })),
        ))
        .await
        .unwrap();
    assert_eq!(confirm.status(), StatusCode::OK);
    let confirmed: Value = body_json(confirm).await;
    assert_eq!(confirmed["intent"]["status"], "completed");
    assert_eq!(confirmed["intent"]["confirmedBy"], 1);

    let re_confirm = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/payments/intents/{intent_id}/confirm"),
            &owner,
            Some(serde_json::json!({})),
        ))
        .await
        .unwrap();
    assert_eq!(re_confirm.status(), StatusCode::CONFLICT, "re-confirm must conflict");

    // Drop the server entirely and reopen on the same data dir: the intent
    // must replay from the stream log into the projection (no JSONL).
    drop(app);
    let config = test_config(tmp.path());
    let state = Arc::new(AppState::new(config).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state);
    let list_after_restart = app
        .clone()
        .oneshot(authed("GET", "/payments/intents", &owner, None))
        .await
        .unwrap();
    let list_after_restart: Value = body_json(list_after_restart).await;
    let intents = list_after_restart["intents"].as_array().unwrap();
    assert_eq!(intents.len(), 1, "intent must survive restart via event replay");
    assert_eq!(intents[0]["id"], intent_id);
    assert_eq!(intents[0]["status"], "completed");
}

#[tokio::test]
async fn reject_flow_and_unknown_intent() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp; // keep the temp data dir alive for the engine
    let owner = register(&app, "alice").await;

    let create = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &owner, Some(promptpay_create())))
        .await
        .unwrap();
    let created: Value = body_json(create).await;
    let intent_id = created["intent"]["id"].as_str().unwrap().to_string();

    let reject = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/payments/intents/{intent_id}/reject"),
            &owner,
            Some(serde_json::json!({ "referenceNote": "never arrived" })),
        ))
        .await
        .unwrap();
    assert_eq!(reject.status(), StatusCode::OK);
    let rejected: Value = body_json(reject).await;
    assert_eq!(rejected["intent"]["status"], "rejected");

    let unknown = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents/pi_does_not_exist/confirm",
            &owner,
            Some(serde_json::json!({})),
        ))
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    let bad_amount = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/intents",
            &owner,
            Some(serde_json::json!({ "amountMinor": 0, "promptpayProxyId": "0812345678" })),
        ))
        .await
        .unwrap();
    assert_eq!(bad_amount.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn account_links_upsert_list_delete_and_scope() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp; // keep the temp data dir alive for the engine
    let alice = register(&app, "alice").await;
    let bob = register(&app, "bob").await;

    let link_payload = serde_json::json!({
        "pluginId": "promptpay",
        "providerAccountRef": "0812345678",
        "displayLabel": "PromptPay main"
    });
    let create = app
        .clone()
        .oneshot(authed("POST", "/payments/account-links", &alice, Some(link_payload)))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK);
    let created: Value = body_json(create).await;
    assert_eq!(created["link"]["pluginId"], "promptpay");
    assert_eq!(created["link"]["providerAccountRef"], "0812345678");

    // Upsert overwrites the same plugin row.
    let update = serde_json::json!({
        "pluginId": "promptpay",
        "providerAccountRef": "0999999999"
    });
    let updated = app
        .clone()
        .oneshot(authed("POST", "/payments/account-links", &alice, Some(update)))
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);

    // Each user sees only their own links.
    let alice_links: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/account-links", &alice, None))
            .await
            .unwrap(),
    )
    .await;
    let bob_links: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/account-links", &bob, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(alice_links["links"].as_array().unwrap().len(), 1);
    assert_eq!(
        alice_links["links"][0]["providerAccountRef"],
        "0999999999",
        "upsert must overwrite, not duplicate"
    );
    assert!(bob_links["links"].as_array().unwrap().is_empty());

    // Delete removes it.
    let deleted = app
        .clone()
        .oneshot(authed(
            "DELETE",
            "/payments/account-links/promptpay",
            &alice,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    let after: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/account-links", &alice, None))
            .await
            .unwrap(),
    )
    .await;
    assert!(after["links"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn payment_access_policy_persists() {
    let (tmp, app) = fresh_server().await;
    let owner = register(&app, "alice").await;

    // Default policy before any save (WS-3: default is enabled — the policy
    // is an admin kill-switch/restrictor, matching pre-enforcement behavior).
    let before: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/access", &owner, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(before["policy"]["enabled"], true);

    // Owner saves a policy; a non-admin cannot.
    let member = register(&app, "bob").await;
    let forbidden = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/access",
            &member,
            Some(serde_json::json!({ "policy": { "enabled": true } })),
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let saved = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/access",
            &owner,
            Some(serde_json::json!({ "policy": { "enabled": true } })),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    // Restart: policy row must survive (event-sourced projection).
    drop(app);
    let config = test_config(tmp.path());
    let state = Arc::new(AppState::new(config).await.unwrap());
    let app = create_api_router(state.clone()).with_state(state);
    let after: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/access", &owner, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(after["policy"]["enabled"], true, "policy must survive restart");
}

#[tokio::test]
async fn payment_access_policy_enforced_in_create_intent() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp; // keep the temp data dir alive for the engine
    let owner = register(&app, "alice").await;
    let member = register(&app, "bob").await;

    // Default policy (enabled): a member can create, and /access says so.
    let create_ok = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &member, Some(promptpay_create())))
        .await
        .unwrap();
    assert_eq!(create_ok.status(), StatusCode::OK, "default policy must allow members");
    let access: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/access", &member, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(access["actor"]["canCreate"], true, "actor must be server-computed");
    assert_eq!(access["actor"]["roles"].as_array().unwrap().contains(&serde_json::json!("member")), true);
    // Registration order does NOT guarantee small sequential ids (first-boot
    // seeding consumes some) — read the member's real id from the actor.
    let member_id = access["actor"]["userId"].as_i64().unwrap();

    // Kill-switch: owner disables payments → member create is 403.
    let disable = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/access",
            &owner,
            Some(serde_json::json!({ "policy": { "enabled": false } })),
        ))
        .await
        .unwrap();
    assert_eq!(disable.status(), StatusCode::OK);
    let create_disabled = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &member, Some(promptpay_create())))
        .await
        .unwrap();
    assert_eq!(create_disabled.status(), StatusCode::FORBIDDEN, "disabled policy must 403");
    let disabled_json: Value = body_json(create_disabled).await;
    assert_eq!(disabled_json["error"], "Payments are disabled on this server.");

    // Role restriction: enabled but members not allowed.
    let restrict = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/access",
            &owner,
            Some(serde_json::json!({ "policy": { "enabled": true, "allowedRoleNames": ["admin"] } })),
        ))
        .await
        .unwrap();
    assert_eq!(restrict.status(), StatusCode::OK);
    let create_role = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &member, Some(promptpay_create())))
        .await
        .unwrap();
    assert_eq!(create_role.status(), StatusCode::FORBIDDEN, "role gate must 403");

    // Restore the default role list → creation works again.
    let restore = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/access",
            &owner,
            Some(serde_json::json!({ "policy": { "enabled": true, "allowedRoleNames": ["owner", "admin", "mod", "member"] } })),
        ))
        .await
        .unwrap();
    assert_eq!(restore.status(), StatusCode::OK);

    // User blocks: block the member → 403 with the blocked reason.
    let block = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/user-blocks",
            &owner,
            Some(serde_json::json!({ "userId": member_id, "reason": "abuse" })),
        ))
        .await
        .unwrap();
    assert_eq!(block.status(), StatusCode::OK);
    let create_blocked = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &member, Some(promptpay_create())))
        .await
        .unwrap();
    assert_eq!(create_blocked.status(), StatusCode::FORBIDDEN, "blocked user must 403");
    let blocked_json: Value = body_json(create_blocked).await;
    assert_eq!(blocked_json["error"], "You are blocked from creating payments on this server.");
    let blocked_access: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/access", &member, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(blocked_access["actor"]["blocked"], true);
    assert_eq!(blocked_access["actor"]["canCreate"], false);

    // Clearing the block restores creation.
    let clear = app
        .clone()
        .oneshot(authed(
            "DELETE",
            &format!("/payments/user-blocks/{member_id}"),
            &owner,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(clear.status(), StatusCode::OK);
    let create_unblocked = app
        .clone()
        .oneshot(authed("POST", "/payments/intents", &member, Some(promptpay_create())))
        .await
        .unwrap();
    assert_eq!(create_unblocked.status(), StatusCode::OK, "cleared block must restore creation");
}

#[tokio::test]
async fn payment_user_blocks_admin_only() {
    let (_tmp, app) = fresh_server().await;
    let _ = &_tmp; // keep the temp data dir alive for the engine
    let owner = register(&app, "alice").await;
    let member = register(&app, "bob").await;

    // Non-admin cannot block.
    let forbidden = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/user-blocks",
            &member,
            Some(serde_json::json!({ "userId": 2, "reason": "spam" })),
        ))
        .await
        .unwrap();
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

    let blocked = app
        .clone()
        .oneshot(authed(
            "POST",
            "/payments/user-blocks",
            &owner,
            Some(serde_json::json!({ "userId": 2, "reason": "spam" })),
        ))
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::OK);
    let blocked_json: Value = body_json(blocked).await;
    assert_eq!(blocked_json["block"]["userId"], 2);

    let list: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/user-blocks", &owner, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(list["blocks"].as_array().unwrap().len(), 1);

    let cleared = app
        .clone()
        .oneshot(authed(
            "DELETE",
            "/payments/user-blocks/2",
            &owner,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);
    let after: Value = body_json(
        app.clone()
            .oneshot(authed("GET", "/payments/user-blocks", &owner, None))
            .await
            .unwrap(),
    )
    .await;
    assert!(after["blocks"].as_array().unwrap().is_empty());
}