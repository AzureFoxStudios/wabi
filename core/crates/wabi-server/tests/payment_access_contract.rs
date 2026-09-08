//! Administrative UI → policy command → projection → access/creation contract.
//! All policy files, accounts and fault injection belong to temporary engines.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

const KEY: &str = "policy:payments_access";
const ADMIN_PATH: &str = "/admin/policies/payments_access";

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "payment-access-contract-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    )
}

fn router(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone()).with_state(state.clone())
}

async fn seed(state: &AppState) -> (u64, u64) {
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    (owner, member)
}

fn claims(uid: u64) -> JwtClaims {
    let now = chrono::Utc::now().timestamp();
    JwtClaims {
        sub: uid.to_string(),
        username: format!("user-{uid}"),
        is_guest: false,
        exp: now + 3600,
        iat: now,
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "access".into(),
    }
}

fn sign(state: &AppState, claims: &JwtClaims) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

fn token(state: &AppState, uid: u64) -> String {
    sign(state, &claims(uid))
}
fn policy(enabled: bool) -> Value {
    json!({ "enabled": enabled, "allowGuest": false, "allowedRoleNames": ["owner", "admin", "mod", "member"] })
}
fn normalized_policy(enabled: bool) -> Value {
    json!({ "enabled": enabled, "allowGuest": false, "allowedRoleNames": ["admin", "member", "mod", "owner"] })
}
fn intent() -> Value {
    json!({ "provider": "promptpay", "amountMinor": 100, "currency": "THB", "promptpayProxyId": "0812345678" })
}

async fn assign_role(state: &AppState, user: u64, role: &str) {
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "workspaceId": "default-workspace", "userId": user, "role": role
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        state
            .wdb
            .get_user_role("default-workspace", user)
            .await
            .unwrap()
            .as_deref(),
        Some(role)
    );
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(
                    body.map(|body| body.to_string()).unwrap_or_default(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn both_admin_routes_share_default_save_enforcement_and_restart() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, member) = seed(&state).await;
    let owner_token = token(&state, owner);
    let member_token = token(&state, member);
    let admin = request(&app, "GET", ADMIN_PATH, &owner_token, None).await;
    let public = request(&app, "GET", "/payments/access", "", None).await;
    assert_eq!(admin.1["config"], policy(true));
    assert_eq!(admin.1["defaults"], policy(true));
    assert_eq!(public.1["policy"], admin.1["config"]);
    assert_eq!(public.1["actor"]["canCreate"], false);
    assert_eq!(
        request(&app, "POST", ADMIN_PATH, &member_token, Some(policy(false)))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, "POST", ADMIN_PATH, &owner_token, Some(policy(false)))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/payments/access", &member_token, None)
            .await
            .1["actor"]["reasonCode"],
        "disabled"
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &member_token,
            Some(intent())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for (path, body) in [
        (
            ADMIN_PATH,
            json!({ "enabled": true, "allowedRoleNames": [] }),
        ),
        (
            "/payments/access",
            json!({ "policy": { "enabled": true, "allowedRoleNames": [] } }),
        ),
    ] {
        assert_eq!(
            request(&app, "POST", path, &owner_token, Some(body))
                .await
                .0,
            StatusCode::OK
        );
        let access = request(&app, "GET", "/payments/access", &owner_token, None)
            .await
            .1;
        assert_eq!(access["policy"]["allowedRoleNames"], json!([]));
        assert_eq!(access["actor"]["reasonCode"], "role");
        assert_eq!(
            request(
                &app,
                "POST",
                "/payments/intents",
                &owner_token,
                Some(intent())
            )
            .await
            .0,
            StatusCode::FORBIDDEN,
            "empty allowlist must not restore grants"
        );
    }
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/access",
            &owner_token,
            Some(json!({ "policy": { "enabled": true } }))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &owner_token, None).await.1["config"],
        policy(true)
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &member_token,
            Some(intent())
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "POST", ADMIN_PATH, &owner_token, Some(policy(false)))
            .await
            .0,
        StatusCode::OK
    );
    assert!(
        !tmp.path().join("admin_policies.json").exists(),
        "canonical saves must not create a second policy file"
    );
    drop(app);
    drop(state);
    let state = server(tmp.path()).await;
    let app = router(&state);
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &owner_token, None).await.1["config"],
        normalized_policy(false)
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &member_token,
            Some(intent())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn legacy_import_is_admin_owned_and_canonical_row_wins_forever() {
    let tmp = tempfile::TempDir::new().unwrap();
    let legacy =
        json!({ "payments_access": policy(false), "upload_limits": { "preserved": true } })
            .to_string();
    std::fs::write(tmp.path().join("admin_policies.json"), &legacy).unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, member) = seed(&state).await;
    let owner_token = token(&state, owner);
    for bearer in [String::new(), token(&state, member)] {
        let access = request(&app, "GET", "/payments/access", &bearer, None).await;
        assert_eq!(access.0, StatusCode::OK);
        assert_eq!(access.1["policy"], policy(false));
        assert!(
            state.wdb.get_payment_policy(KEY).await.unwrap().is_none(),
            "ordinary reads may not migrate"
        );
    }
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &owner_token, None).await.1["config"],
        policy(false)
    );
    assert_eq!(
        state.wdb.get_payment_policy(KEY).await.unwrap(),
        Some(policy(false))
    );
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("admin_policies.json")).unwrap(),
        legacy
    );
    std::fs::write(
        tmp.path().join("admin_policies.json"),
        json!({ "payments_access": policy(true) }).to_string(),
    )
    .unwrap();
    assert_eq!(
        request(&app, "GET", "/payments/access", &owner_token, None)
            .await
            .1["policy"],
        policy(false)
    );
    drop(app);
    drop(state);
    let state = server(tmp.path()).await;
    assert_eq!(
        request(&router(&state), "GET", ADMIN_PATH, &owner_token, None)
            .await
            .1["config"],
        policy(false)
    );
}

#[tokio::test]
async fn missing_legacy_entry_does_not_import_the_old_admin_default() {
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join("admin_policies.json"),
        r#"{"upload_limits":{"preserved":true}}"#,
    )
    .unwrap();
    let state = server(tmp.path()).await;
    let (owner, _) = seed(&state).await;
    assert_eq!(
        request(
            &router(&state),
            "GET",
            ADMIN_PATH,
            &token(&state, owner),
            None
        )
        .await
        .1["config"],
        policy(true)
    );
    assert!(state.wdb.get_payment_policy(KEY).await.unwrap().is_none());
}

#[tokio::test]
async fn invalid_saved_policy_and_storage_failures_never_enable_or_report_success() {
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(tmp.path().join("admin_policies.json"), "not-json").unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, member) = seed(&state).await;
    let owner = token(&state, owner);
    let member = token(&state, member);
    assert_eq!(
        request(&app, "GET", "/payments/access", &member, None)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(&app, "POST", "/payments/intents", &member, Some(intent()))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(&app, "POST", ADMIN_PATH, &owner, Some(policy(false)))
            .await
            .0,
        StatusCode::OK,
        "explicit valid save repairs legacy corruption"
    );
    state
        .wdb
        .upsert_payment_policy(KEY, &json!({ "enabled": "false" }))
        .await
        .unwrap();
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &owner, None).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(&app, "GET", "/payments/access", &member, None)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/access",
            &owner,
            Some(json!({ "policy": policy(false) }))
        )
        .await
        .0,
        StatusCode::OK
    );
    for invalid in [
        json!({ "enabled": "false" }),
        json!({ "allowGuest": 1 }),
        json!({ "allowedRoleNames": [true] }),
    ] {
        assert_eq!(
            request(&app, "POST", ADMIN_PATH, &owner, Some(invalid.clone()))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(
                &app,
                "POST",
                "/payments/access",
                &owner,
                Some(json!({ "policy": invalid }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    // Test-local irreversible stream-key destruction makes real WabiDB writes
    // fail before acknowledgement; no runtime fault hooks or live data.
    state
        .wdb
        .engine()
        .key_registry()
        .lock()
        .await
        .destroy_stream("payments")
        .unwrap();
    assert_eq!(
        request(&app, "POST", ADMIN_PATH, &owner, Some(policy(true)))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/access",
            &owner,
            Some(json!({ "policy": policy(true) }))
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/donations",
            &owner,
            Some(json!({ "config": { "enabled": true } }))
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE,
        "donation writes must also acknowledge real persistence"
    );
    assert_eq!(
        state.wdb.get_payment_policy(KEY).await.unwrap(),
        Some(normalized_policy(false)),
        "failed write must preserve acknowledged policy"
    );
}

#[tokio::test]
async fn concurrent_import_cannot_overwrite_an_explicit_admin_save() {
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(
        tmp.path().join("admin_policies.json"),
        json!({ "payments_access": policy(false) }).to_string(),
    )
    .unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, _) = seed(&state).await;
    let owner = token(&state, owner);
    let (import, save) = tokio::join!(
        request(&app, "GET", ADMIN_PATH, &owner, None),
        request(
            &app,
            "POST",
            "/payments/access",
            &owner,
            Some(json!({ "policy": policy(true) }))
        )
    );
    assert_eq!(import.0, StatusCode::OK);
    assert_eq!(save.0, StatusCode::OK);
    assert_eq!(
        state.wdb.get_payment_policy(KEY).await.unwrap(),
        Some(normalized_policy(true))
    );
}

#[tokio::test]
async fn admin_and_creation_reject_non_account_and_revoked_credentials() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, _) = seed(&state).await;
    let mut invalid_tokens = vec!["lore_scoped_tool_token".to_string()];
    for kind in ["refresh", "preauth", "lore"] {
        let mut claims = claims(owner);
        claims.token_type = kind.into();
        invalid_tokens.push(sign(&state, &claims));
    }
    let mut stepup = claims(owner);
    stepup.stepup = true;
    invalid_tokens.push(sign(&state, &stepup));
    let revoked = claims(owner);
    state
        .revoke_token_with_exp(revoked.jti.clone(), revoked.exp)
        .await;
    invalid_tokens.push(sign(&state, &revoked));
    for invalid in invalid_tokens {
        assert_eq!(
            request(&app, "GET", ADMIN_PATH, &invalid, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, "GET", "/admin/stats", &invalid, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, "POST", ADMIN_PATH, &invalid, Some(policy(false)))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &app,
                "POST",
                "/payments/access",
                &invalid,
                Some(json!({ "policy": policy(false) }))
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, "POST", "/payments/intents", &invalid, Some(intent()))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        for (method, path, body) in [
            ("GET", "/payments/account-links", None),
            (
                "POST",
                "/payments/account-links",
                Some(json!({ "pluginId": "test", "providerAccountRef": "test-only" })),
            ),
            ("DELETE", "/payments/account-links/test", None),
            (
                "POST",
                "/payments/donations",
                Some(json!({ "config": { "enabled": true } })),
            ),
            ("GET", "/payments/user-blocks", None),
            (
                "POST",
                "/payments/user-blocks",
                Some(json!({ "userId": owner })),
            ),
            ("DELETE", "/payments/user-blocks/1", None),
            (
                "POST",
                "/admin/payments/blocks",
                Some(json!({ "userId": owner })),
            ),
            ("DELETE", "/admin/payments/blocks/1", None),
            ("GET", "/payments/intents", None),
            ("POST", "/payments/intents/test/confirm", Some(json!({}))),
            ("POST", "/payments/intents/test/reject", Some(json!({}))),
        ] {
            assert_eq!(
                request(&app, method, path, &invalid, body).await.0,
                StatusCode::UNAUTHORIZED,
                "{method} {path} must reject non-account/revoked credentials"
            );
        }
        let public = request(&app, "GET", "/payments/access", &invalid, None).await;
        assert_eq!(public.1["actor"]["authenticated"], false);
        assert_eq!(public.1["actor"]["canCreate"], false);
    }
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &token(&state, owner), None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/account-links",
            &token(&state, owner),
            Some(json!({ "pluginId": "test", "providerAccountRef": "test-only" }))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/donations",
            &token(&state, owner),
            Some(json!({ "config": { "enabled": false } }))
        )
        .await
        .0,
        StatusCode::OK
    );
    let previously_valid = token(&state, owner);
    state.revoke_user(owner as i64).await;
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &previously_valid, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &previously_valid,
            Some(intent())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn actual_owner_moderator_and_guest_roles_drive_both_actor_and_creation() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, member) = seed(&state).await;
    let owner_token = token(&state, owner);
    let member_token = token(&state, member);
    assign_role(&state, member, "Moderator").await;
    for (role, allowed, denied) in [
        ("owner", &owner_token, &member_token),
        ("mod", &member_token, &owner_token),
    ] {
        assert_eq!(
            request(
                &app,
                "POST",
                ADMIN_PATH,
                &owner_token,
                Some(json!({ "enabled": true, "allowedRoleNames": [role] }))
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "GET", "/payments/access", allowed, None)
                .await
                .1["actor"]["canCreate"],
            true
        );
        assert_eq!(
            request(&app, "POST", "/payments/intents", allowed, Some(intent()))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "POST", "/payments/intents", denied, Some(intent()))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let guest = state.wdb.create_user("guest", None, "").await.unwrap();
    let mut guest_claims = claims(guest);
    guest_claims.is_guest = true;
    let guest_token = sign(&state, &guest_claims);
    assert_eq!(
        request(
            &app,
            "POST",
            ADMIN_PATH,
            &owner_token,
            Some(json!({ "enabled": true, "allowGuest": false, "allowedRoleNames": ["guest"] }))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &guest_token,
            Some(intent())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            ADMIN_PATH,
            &owner_token,
            Some(json!({ "enabled": true, "allowGuest": true, "allowedRoleNames": ["guest"] }))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/payments/access", &guest_token, None)
            .await
            .1["actor"]["roles"],
        json!(["guest"])
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &guest_token,
            Some(intent())
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn permanent_password_reset_protects_owner_and_self_and_revokes_target_session() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = server(tmp.path()).await;
    let app = router(&state);
    let (owner, member) = seed(&state).await;
    let admin = state
        .wdb
        .create_user("admin", None, "registered-test-hash")
        .await
        .unwrap();
    assign_role(&state, admin, "Admin").await;
    let role_owner = state
        .wdb
        .create_user("role-owner", None, "registered-test-hash")
        .await
        .unwrap();
    assign_role(&state, role_owner, "Owner").await;
    let admin_token = token(&state, admin);
    let member_claims = claims(member);
    state
        .revoke_user_other_sessions(member as i64, &member_claims.jti)
        .await;
    assert!(
        !state
            .is_token_revoked(&member_claims.jti, member as i64, member_claims.iat)
            .await,
        "own-password session is initially exempt"
    );
    for target in [admin, owner, role_owner] {
        assert_eq!(
            request(
                &app,
                "POST",
                "/admin/users/reset-password",
                &admin_token,
                Some(json!({ "targetUserId": target, "newPassword": "new-password-test" }))
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            state
                .wdb
                .get_user(target)
                .await
                .unwrap()
                .unwrap()
                .password_hash,
            "registered-test-hash"
        );
    }
    assert_eq!(
        request(&app, "GET", ADMIN_PATH, &admin_token, None).await.0,
        StatusCode::OK,
        "valid non-owner administrator remains allowed"
    );
    assert_eq!(request(&app, "POST", "/admin/users/reset-password", &admin_token, Some(json!({ "targetUserId": member, "newPassword": "new-password-test", "temporary": true }))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(request(&app, "POST", "/admin/users/reset-password", &admin_token, Some(json!({ "targetUserId": member, "newPassword": "new-password-test", "temporary": false }))).await.0, StatusCode::OK);
    let hash = state
        .wdb
        .get_user(member)
        .await
        .unwrap()
        .unwrap()
        .password_hash;
    assert!(bcrypt::verify("new-password-test", &hash).unwrap());
    assert!(
        state
            .is_token_revoked(&member_claims.jti, member as i64, member_claims.iat)
            .await
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/payments/intents",
            &sign(&state, &member_claims),
            Some(intent())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED,
        "later admin reset must retire the earlier own-password exemption"
    );
    // Force the same-second boundary deterministically, without racing the
    // wall clock or sleeping until a broken token becomes valid.
    let floor = (chrono::Utc::now().timestamp() + 120) as u64;
    state.revocations.write().await.user_iat_revoked.insert(member as i64, floor);
    let login = request(&app, "POST", "/auth/login", "", Some(json!({
        "username": "member", "password": "new-password-test"
    }))).await;
    assert_eq!(login.0, StatusCode::OK);
    let access = login.1["accessToken"].as_str().unwrap();
    let refresh = login.1["refreshToken"].as_str().unwrap();
    let access_claims = wabi_server::auth_extractor::decode_token(access, &state.config.jwt_secret).await.unwrap();
    assert_eq!(access_claims.iat as u64, floor);
    assert_eq!(request(&app, "POST", "/payments/intents", access, Some(intent())).await.0, StatusCode::OK, "freshly verified login must work immediately after reset");
    let rotated = request(&app, "POST", "/auth/refresh", "", Some(json!({ "refreshToken": refresh }))).await;
    assert_eq!(rotated.0, StatusCode::OK, "fresh refresh token must also work immediately");
    let rotated_access = rotated.1["accessToken"].as_str().unwrap();
    assert_eq!(request(&app, "POST", "/payments/intents", rotated_access, Some(intent())).await.0, StatusCode::OK);
    assert!(state.is_token_revoked(&member_claims.jti, member as i64, member_claims.iat).await, "new login must never lower the old cutoff");
    state.revoke_user(member as i64).await;
    assert_eq!(request(&app, "POST", "/payments/intents", rotated_access, Some(intent())).await.0, StatusCode::UNAUTHORIZED, "another reset must revoke the freshly clamped session too");
}
