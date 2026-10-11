//! Payment authorization is rechecked at admission and retained through the
//! actual WabiDB command, even after HTTP cancellation. The routers deliberately
//! omit the general HTTP operation middleware: each payment surface owns its
//! admitted work, including the older administrative aliases.
#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use std::{path::Path, sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{
    api::{admin, payments},
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

const POLICY_KEY: &str = "policy:payments_access";
const WORKSPACE: &str = "default-workspace";

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "payments-admission-contract-only".into(),
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
            lore: LoreAddonConfig {
                enabled: false,
                ..Default::default()
            },
        })
        .await
        .unwrap(),
    )
}

fn router(state: &Arc<AppState>) -> Router {
    Router::new()
        .nest("/payments", payments::routes(state.clone()))
        .nest("/admin", admin::routes(state.clone()))
        .with_state(state.clone())
}

fn claims(user_id: u64) -> JwtClaims {
    let now = chrono::Utc::now().timestamp();
    JwtClaims {
        sub: user_id.to_string(),
        username: "owner".into(),
        is_guest: false,
        exp: now + 3600,
        iat: now,
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "access".into(),
    }
}

fn token(state: &AppState, claims: &JwtClaims) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

fn enabled_policy(enabled: bool) -> Value {
    json!({ "enabled": enabled, "allowGuest": false,
        "allowedRoleNames": ["admin", "member", "mod", "owner"] })
}

fn request_body() -> Value {
    json!({ "provider": "promptpay", "amountMinor": 100,
        "currency": "THB", "promptpayProxyId": "0812345678" })
}

async fn request(
    app: Router,
    method: &str,
    path: &str,
    bearer: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {bearer}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    body.map(|value| value.to_string()).unwrap_or_default(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture did not reach its admission gate");
}

async fn fixture() -> (tempfile::TempDir, Arc<AppState>, Router, u64, u64) {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state
        .wdb
        .create_user("owner", None, "registered-fixture")
        .await
        .unwrap();
    let peer = state
        .wdb
        .create_user("peer", None, "registered-fixture")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let app = router(&state);
    // Drain the router's legacy migration before counting queued workers.
    drop(state.instance_operations.quiesce().await.unwrap());
    (dir, state, app, owner, peer)
}

#[tokio::test]
async fn payment_surfaces_recheck_credentials_after_waiting_for_membership() {
    let (_dir, state, app, owner, peer) = fixture().await;
    let paths = [
        ("GET", "/payments/access".into(), None),
        (
            "POST",
            "/payments/access".into(),
            Some(json!({ "policy": enabled_policy(false) })),
        ),
        ("GET", "/admin/policies/payments_access".into(), None),
        (
            "POST",
            "/admin/policies/payments_access".into(),
            Some(enabled_policy(false)),
        ),
        ("GET", "/payments/account-links".into(), None),
        (
            "POST",
            "/payments/account-links".into(),
            Some(json!({ "pluginId": "test", "providerAccountRef": "test-only" })),
        ),
        ("DELETE", "/payments/account-links/test".into(), None),
        (
            "POST",
            "/payments/donations".into(),
            Some(json!({ "config": { "enabled": true } })),
        ),
        ("GET", "/payments/user-blocks".into(), None),
        (
            "POST",
            "/payments/user-blocks".into(),
            Some(json!({ "userId": peer })),
        ),
        ("DELETE", format!("/payments/user-blocks/{peer}"), None),
        ("GET", "/admin/payments/blocks".into(), None),
        (
            "POST",
            "/admin/payments/blocks".into(),
            Some(json!({ "userId": peer })),
        ),
        ("DELETE", format!("/admin/payments/blocks/{peer}"), None),
        ("GET", "/payments/intents".into(), None),
        ("POST", "/payments/intents".into(), Some(request_body())),
        (
            "POST",
            "/payments/intents/missing/confirm".into(),
            Some(json!({})),
        ),
        (
            "POST",
            "/payments/intents/missing/reject".into(),
            Some(json!({})),
        ),
    ];
    for (method, path, body) in paths {
        let claims = claims(owner);
        let bearer = token(&state, &claims);
        let membership = state.membership_gate.clone().write_owned().await;
        let baseline = Arc::strong_count(&state.membership_gate);
        let request_app = app.clone();
        let request_path = path.clone();
        let pending = tokio::spawn(async move {
            request(request_app, method, &request_path, &bearer, body).await
        });
        // read_owned clones the membership gate before waiting. This proves
        // initial authentication completed, without a timing-based sleep.
        wait_until(|| Arc::strong_count(&state.membership_gate) > baseline).await;
        state
            .revoke_token_with_exp(claims.jti, claims.exp)
            .await
            .unwrap();
        drop(membership);
        let response = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            response.0,
            StatusCode::UNAUTHORIZED,
            "{method} {path}: {}",
            response.1
        );
    }
    assert!(state
        .wdb
        .get_payment_policy(POLICY_KEY)
        .await
        .unwrap()
        .is_none());
    assert!(state
        .wdb
        .list_payment_intents(0, true)
        .await
        .unwrap()
        .is_empty());
    assert!(state
        .wdb
        .list_payment_account_links(owner as i64)
        .await
        .unwrap()
        .is_empty());
    assert!(state
        .wdb
        .list_payment_user_blocks(WORKSPACE)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn administrative_aliases_recheck_owner_and_role_after_membership_wait() {
    let (_dir, state, app, owner, peer) = fixture().await;
    for (method, path, body) in [
        (
            "POST",
            "/payments/access".into(),
            Some(json!({ "policy": enabled_policy(false) })),
        ),
        ("GET", "/admin/policies/payments_access".into(), None),
        (
            "POST",
            "/admin/policies/payments_access".into(),
            Some(enabled_policy(false)),
        ),
        (
            "POST",
            "/payments/donations".into(),
            Some(json!({ "config": { "enabled": true } })),
        ),
        ("GET", "/payments/user-blocks".into(), None),
        (
            "POST",
            "/payments/user-blocks".into(),
            Some(json!({ "userId": peer })),
        ),
        ("DELETE", format!("/payments/user-blocks/{peer}"), None),
        ("GET", "/admin/payments/blocks".into(), None),
        (
            "POST",
            "/admin/payments/blocks".into(),
            Some(json!({ "userId": peer })),
        ),
        ("DELETE", format!("/admin/payments/blocks/{peer}"), None),
    ] {
        *state.owner_user_id.write().await = Some(owner as i64);
        state
            .wdb
            .ingest_event(
                "rbac",
                "assign_role",
                &json!({
                    "workspaceId": WORKSPACE, "userId": owner, "role": "Admin"
                }),
            )
            .await
            .unwrap();
        let bearer = token(&state, &claims(owner));
        let membership = state.membership_gate.clone().write_owned().await;
        let baseline = Arc::strong_count(&state.membership_gate);
        let request_app = app.clone();
        let request_path = path.clone();
        let pending = tokio::spawn(async move {
            request(request_app, method, &request_path, &bearer, body).await
        });
        wait_until(|| Arc::strong_count(&state.membership_gate) > baseline).await;
        *state.owner_user_id.write().await = Some(peer as i64);
        state
            .wdb
            .ingest_event(
                "rbac",
                "assign_role",
                &json!({
                    "workspaceId": WORKSPACE, "userId": owner, "role": "Member"
                }),
            )
            .await
            .unwrap();
        drop(membership);
        let response = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            response.0,
            StatusCode::FORBIDDEN,
            "{method} {path}: {}",
            response.1
        );
    }
    assert!(state
        .wdb
        .get_payment_policy(POLICY_KEY)
        .await
        .unwrap()
        .is_none());
    assert!(state
        .wdb
        .get_payment_policy("policy:payments_donations")
        .await
        .unwrap()
        .is_none());
    assert!(state
        .wdb
        .list_payment_user_blocks(WORKSPACE)
        .await
        .unwrap()
        .is_empty());
}

#[derive(Clone, Copy, Debug)]
enum Mutation {
    Policy,
    PolicyAlias,
    Import,
    ImportAlias,
    Link,
    Unlink,
    Donation,
    Block,
    BlockAlias,
    Unblock,
    UnblockAlias,
    Create,
    Confirm,
    Reject,
}

impl Mutation {
    fn policy_dependent(self) -> bool {
        matches!(
            self,
            Self::Policy
                | Self::PolicyAlias
                | Self::Import
                | Self::ImportAlias
                | Self::Block
                | Self::BlockAlias
                | Self::Unblock
                | Self::UnblockAlias
                | Self::Create
        )
    }
}

#[tokio::test]
async fn cancelled_payment_writes_hold_admission_until_durable_application_and_restart() {
    for mutation in [
        Mutation::Policy,
        Mutation::PolicyAlias,
        Mutation::Import,
        Mutation::ImportAlias,
        Mutation::Link,
        Mutation::Unlink,
        Mutation::Donation,
        Mutation::Block,
        Mutation::BlockAlias,
        Mutation::Unblock,
        Mutation::UnblockAlias,
        Mutation::Create,
        Mutation::Confirm,
        Mutation::Reject,
    ] {
        let (dir, state, app, owner, peer) = fixture().await;
        let claims = claims(owner);
        let bearer = token(&state, &claims);
        let existing = request(
            app.clone(),
            "POST",
            "/payments/intents",
            &bearer,
            Some(request_body()),
        )
        .await;
        assert_eq!(existing.0, StatusCode::OK);
        let intent_id = existing.1["intent"]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            request(
                app.clone(),
                "POST",
                "/payments/account-links",
                &bearer,
                Some(json!({ "pluginId": "existing", "providerAccountRef": "fixture-only" }))
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                app.clone(),
                "POST",
                "/payments/user-blocks",
                &bearer,
                Some(json!({ "userId": peer }))
            )
            .await
            .0,
            StatusCode::OK
        );
        if matches!(mutation, Mutation::Import | Mutation::ImportAlias) {
            std::fs::write(
                dir.path().join("admin_policies.json"),
                json!({ "payments_access": enabled_policy(false) }).to_string(),
            )
            .unwrap();
        }
        let (method, path, body) = match mutation {
            Mutation::Policy => (
                "POST",
                "/payments/access".into(),
                Some(json!({ "policy": enabled_policy(false) })),
            ),
            Mutation::PolicyAlias => (
                "POST",
                "/admin/policies/payments_access".into(),
                Some(enabled_policy(false)),
            ),
            Mutation::Import => ("GET", "/payments/access".into(), None),
            Mutation::ImportAlias => ("GET", "/admin/policies/payments_access".into(), None),
            Mutation::Link => (
                "POST",
                "/payments/account-links".into(),
                Some(json!({ "pluginId": "new", "providerAccountRef": "fixture-only" })),
            ),
            Mutation::Unlink => ("DELETE", "/payments/account-links/existing".into(), None),
            Mutation::Donation => (
                "POST",
                "/payments/donations".into(),
                Some(json!({ "config": { "enabled": true } })),
            ),
            Mutation::Block => (
                "POST",
                "/payments/user-blocks".into(),
                Some(json!({ "userId": peer, "reason": "replacement" })),
            ),
            Mutation::BlockAlias => (
                "POST",
                "/admin/payments/blocks".into(),
                Some(json!({ "userId": peer, "reason": "replacement" })),
            ),
            Mutation::Unblock => ("DELETE", format!("/payments/user-blocks/{peer}"), None),
            Mutation::UnblockAlias => ("DELETE", format!("/admin/payments/blocks/{peer}"), None),
            Mutation::Create => ("POST", "/payments/intents".into(), Some(request_body())),
            Mutation::Confirm => (
                "POST",
                format!("/payments/intents/{intent_id}/confirm"),
                Some(json!({})),
            ),
            Mutation::Reject => (
                "POST",
                format!("/payments/intents/{intent_id}/reject"),
                Some(json!({})),
            ),
        };
        let paused = state.instance_operations.quiesce().await.unwrap();
        let keys = state.wdb.engine().key_registry().clone().lock_owned().await;
        let request_app = app.clone();
        let pending =
            tokio::spawn(async move { request(request_app, method, &path, &bearer, body).await });
        // The owned payment worker is queued behind the checkpoint gate; its
        // future already owns every authorization guard before cancellation.
        wait_until(|| state.instance_operations.waiting_operations() == 1).await;
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        assert!(
            state.membership_gate.try_write().is_err(),
            "{mutation:?} released membership"
        );
        assert!(
            state.revocations.try_write().is_err(),
            "{mutation:?} released credential proof"
        );
        assert!(
            state.owner_user_id.try_write().is_err(),
            "{mutation:?} released owner proof"
        );
        drop(paused);
        if mutation.policy_dependent() {
            wait_until(|| state.payment_policy_lock.try_lock().is_err()).await;
        }
        let baseline = Arc::strong_count(&state.revocations);
        let revoke_state = state.clone();
        let revoke = tokio::spawn(async move {
            revoke_state
                .revoke_token_with_exp(claims.jti, claims.exp)
                .await
                .unwrap();
        });
        wait_until(|| Arc::strong_count(&state.revocations) > baseline).await;
        assert!(
            !revoke.is_finished(),
            "{mutation:?} revocation overtook the blocked payment write"
        );
        let membership_gate = state.membership_gate.clone();
        let membership = tokio::spawn(async move { membership_gate.write_owned().await });
        let owner_gate = state.owner_user_id.clone();
        let ownership = tokio::spawn(async move { owner_gate.write_owned().await });
        let policy_gate = state.payment_policy_lock.clone();
        let policy = mutation
            .policy_dependent()
            .then(|| tokio::spawn(async move { policy_gate.lock_owned().await }));
        tokio::task::yield_now().await;
        assert!(
            !membership.is_finished() && !ownership.is_finished(),
            "{mutation:?} mutation proof was lost"
        );
        if let Some(policy) = &policy {
            assert!(
                !policy.is_finished(),
                "{mutation:?} access change overtook the write"
            );
        }
        // Resume the real encrypted segment/index/projection path. Waiting
        // denial writers can finish only after the admitted HTTP write does.
        drop(keys);
        tokio::time::timeout(Duration::from_secs(5), revoke)
            .await
            .unwrap()
            .unwrap();
        drop(
            tokio::time::timeout(Duration::from_secs(5), membership)
                .await
                .unwrap()
                .unwrap(),
        );
        drop(
            tokio::time::timeout(Duration::from_secs(5), ownership)
                .await
                .unwrap()
                .unwrap(),
        );
        if let Some(policy) = policy {
            drop(
                tokio::time::timeout(Duration::from_secs(5), policy)
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        assert!(
            state.instance_operations.healthy_for_checkpoint(),
            "request cancellation interrupted the owned worker"
        );
        drop(state.instance_operations.quiesce().await.unwrap());
        verify(&state, mutation, owner, peer, &intent_id).await;
        let config = state.config.clone();
        drop(app);
        drop(state);
        let restarted = writer_drain::app_state(&config).await.unwrap();
        verify(&restarted, mutation, owner, peer, &intent_id).await;
    }
}

async fn verify(state: &AppState, mutation: Mutation, owner: u64, peer: u64, intent_id: &str) {
    match mutation {
        Mutation::Policy | Mutation::PolicyAlias | Mutation::Import | Mutation::ImportAlias => {
            assert_eq!(
                state.wdb.get_payment_policy(POLICY_KEY).await.unwrap(),
                Some(enabled_policy(false)),
                "{mutation:?}"
            );
        }
        Mutation::Link | Mutation::Unlink => {
            let links = state
                .wdb
                .list_payment_account_links(owner as i64)
                .await
                .unwrap();
            assert_eq!(
                links.len(),
                if matches!(mutation, Mutation::Link) {
                    2
                } else {
                    0
                },
                "{mutation:?}"
            );
        }
        Mutation::Donation => assert_eq!(
            state
                .wdb
                .get_payment_policy("policy:payments_donations")
                .await
                .unwrap()
                .unwrap()["enabled"],
            true
        ),
        Mutation::Block | Mutation::BlockAlias => assert_eq!(
            state
                .wdb
                .list_payment_user_blocks(WORKSPACE)
                .await
                .unwrap()
                .into_iter()
                .find(|block| block.user_id == peer as i64)
                .unwrap()
                .reason
                .as_deref(),
            Some("replacement")
        ),
        Mutation::Unblock | Mutation::UnblockAlias => assert!(state
            .wdb
            .list_payment_user_blocks(WORKSPACE)
            .await
            .unwrap()
            .into_iter()
            .find(|block| block.user_id == peer as i64)
            .is_none()),
        Mutation::Create => assert_eq!(
            state.wdb.list_payment_intents(0, true).await.unwrap().len(),
            2
        ),
        Mutation::Confirm | Mutation::Reject => {
            let intent = state
                .wdb
                .get_payment_intent(intent_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                intent.status,
                if matches!(mutation, Mutation::Confirm) {
                    "completed"
                } else {
                    "rejected"
                }
            );
            assert_eq!(intent.confirmed_by, Some(owner as i64));
        }
    }
}
