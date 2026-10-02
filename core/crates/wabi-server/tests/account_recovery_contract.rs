//! Disposable main Wabi account recovery: canonical one-use state and a
//! compound ownership/revocation boundary, not a complete standby checkpoint.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
use tower::ServiceExt;
use wabi_server::{
    adapter::WdbAdapter,
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::{
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    projections::recovery_codes::{
        code_key, Delta, Operation, Value as CodeValue, EVENT, INDEX, READY, STREAM,
    },
    sequencer::types::{CommandCommit, EventToWrite},
};

fn config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "account-recovery-contract-fixture-only".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "fixture-site".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: path.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}

async fn reopen_server(path: &Path) -> AppState {
    // The last state owner closes writer admission, but the disk workers keep
    // the advisory lock until their admitted writes finish. Retry only that
    // bounded teardown; retain its inode and surface every other startup error.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match AppState::new(config(path)).await {
            Ok(state) => return state,
            Err(error)
                if error
                    .downcast_ref::<wabidb::error::WabiError>()
                    .is_some_and(|error| {
                        matches!(error, wabidb::error::WabiError::AlreadyRunning)
                    })
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => {
                panic!("could not reopen account fixture after writer teardown: {error:#}")
            }
        }
    }
}

fn digest(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}
async fn user(state: &AppState, name: &str) -> i64 {
    let uid = state
        .wdb
        .create_user(name, None, "fixture-password-hash")
        .await
        .unwrap() as i64;
    if state.needs_setup().await {
        state.claim_ownership(uid, name).await.unwrap();
    }
    uid
}
fn token(state: &AppState, uid: i64, stepup: bool) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: "fixture".into(),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}
async fn post(
    state: Arc<AppState>,
    path: &str,
    body: Value,
    credentials: Option<(String, String)>,
) -> (StatusCode, Value) {
    let app = create_api_router(state.clone()).with_state(state);
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some((access, stepup)) = credentials {
        request = request
            .header("authorization", format!("Bearer {access}"))
            .header("x-stepup-token", stepup);
    }
    let response = app
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    (status, body)
}
fn code_value(state: &AppState, code: &str) -> CodeValue {
    let key = code_key(&digest(code));
    wabidb::projections::recovery_codes::decode_value(
        &key,
        &state
            .wdb
            .engine()
            .projection_state()
            .get(INDEX, &key)
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn issued_and_consumed_codes_survive_replay_without_reimporting_a_stale_file() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_code = "legacy-owner-code";
    let file = dir.path().join("recovery_codes.json");
    let original = json!({ digest(legacy_code): 8 }).to_string();
    std::fs::write(&file, &original).unwrap();
    let state = AppState::new(config(dir.path())).await.unwrap();
    assert!(!state.consume_recovery_code(legacy_code, 9).await.unwrap());
    assert!(state.consume_recovery_code(legacy_code, 8).await.unwrap());
    let uid = user(&state, "owner").await;
    let codes = state.generate_recovery_codes(uid, 3).await.unwrap();
    assert_eq!(state.recovery_codes.read().await.len(), 3);
    assert!(state.consume_recovery_code(&codes[0], uid).await.unwrap());
    assert!(!state.consume_recovery_code(&codes[0], uid).await.unwrap());
    assert_eq!(
        code_value(&state, &codes[0]),
        CodeValue::Code {
            digest: digest(&codes[0]),
            user_id: uid,
            consumed: true
        }
    );
    let mut rows = Vec::new();
    state
        .wdb
        .engine()
        .projection_state()
        .for_each(INDEX, |_, bytes| rows.extend_from_slice(bytes));
    let stored = String::from_utf8(rows).unwrap();
    assert!(!stored.contains(&codes[0]));
    assert!(stored.contains(&digest(&codes[0])));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
    let commit = state.wdb.engine().barrier().current();
    drop(state);
    std::fs::remove_file(dir.path().join("wabidb/projections/snapshot.json")).unwrap();
    std::fs::write(&file, "stale malformed source").unwrap();
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(reopened.wdb.engine().barrier().current(), commit);
    assert!(!reopened
        .consume_recovery_code(legacy_code, 8)
        .await
        .unwrap());
    assert!(!reopened
        .consume_recovery_code(&codes[0], uid)
        .await
        .unwrap());
    assert!(reopened
        .consume_recovery_code(&codes[1], uid)
        .await
        .unwrap());
    assert_eq!(reopened.recovery_codes.read().await.len(), 1);
}

#[tokio::test]
async fn concurrent_requests_can_spend_a_code_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = user(&state, "owner").await;
    let code = state
        .generate_recovery_codes(uid, 1)
        .await
        .unwrap()
        .remove(0);
    let before = state.wdb.engine().barrier().current();
    let mut tasks = vec![];
    for _ in 0..32 {
        let state = state.clone();
        let code = code.clone();
        tasks.push(tokio::spawn(async move {
            state.consume_recovery_code(&code, uid).await.unwrap()
        }));
    }
    let mut successes = 0;
    for task in tasks {
        successes += usize::from(task.await.unwrap());
    }
    assert_eq!(successes, 1);
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    assert!(state.recovery_codes.read().await.is_empty());
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert!(!reopened.consume_recovery_code(&code, uid).await.unwrap());
}

#[tokio::test]
async fn http_recovery_spends_the_code_restores_owner_and_revokes_sessions_in_one_commit() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let original_owner = user(&state, "original-owner").await;
    let other_owner = user(&state, "other-owner").await;
    let code = state
        .generate_recovery_codes(original_owner, 1)
        .await
        .unwrap()
        .remove(0);
    state.wdb.claim_owner(other_owner as u64).await.unwrap();
    *state.owner_user_id.write().await = Some(other_owner);
    for _ in 0..3 {
        state
            .revoke_user_other_sessions(original_owner, "previous-exemption")
            .await
            .unwrap();
    }
    let future_floor = state.revocations.read().await.user_iat_revoked[&original_owner];
    let old_iat = chrono::Utc::now().timestamp() - 60;
    assert!(
        !state
            .is_token_revoked("previous-exemption", original_owner, old_iat)
            .await
    );
    let before = state.wdb.engine().barrier().current();
    let (status, body) = post(
        state.clone(),
        "/auth/recover",
        json!({"code":code, "userId":other_owner}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_ne!(body.get("success"), Some(&json!(true)));
    assert_eq!(state.wdb.engine().barrier().current(), before);
    let (status, body) = post(
        state.clone(),
        "/auth/recover",
        json!({"code":code, "userId":original_owner}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], true);
    assert_eq!(body["owner_user_id"], original_owner);
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(original_owner as u64)
    );
    assert_eq!(*state.owner_user_id.read().await, Some(original_owner));
    assert!(state.revocations.read().await.epoch > future_floor);
    assert!(
        state
            .is_token_revoked("previous-exemption", original_owner, old_iat)
            .await
    );
    let (status, _) = post(
        state.clone(),
        "/auth/recover",
        json!({"code":code, "userId":original_owner}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    drop(state);
    std::fs::remove_file(dir.path().join("wabidb/projections/snapshot.json")).unwrap();
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(reopened.wdb.engine().barrier().current(), before + 1);
    assert_eq!(*reopened.owner_user_id.read().await, Some(original_owner));
    assert!(
        reopened
            .is_token_revoked("previous-exemption", original_owner, old_iat)
            .await
    );
    assert!(!reopened
        .recover_owner_with_code(&code, original_owner)
        .await
        .unwrap());
}

#[tokio::test]
async fn a_fenced_writer_cannot_issue_spend_or_acknowledge_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = user(&state, "owner").await;
    let other = user(&state, "other-owner").await;
    state.wdb.claim_owner(uid as u64).await.unwrap();
    *state.owner_user_id.write().await = Some(uid);
    let code = state
        .generate_recovery_codes(uid, 1)
        .await
        .unwrap()
        .remove(0);
    let access = token(&state, uid, false);
    let stepup = token(&state, uid, true);
    let before = state.wdb.engine().barrier().current();
    state.wdb.engine().fence_local_writer().await.unwrap();
    assert!(state.generate_recovery_codes(uid, 5).await.is_err());
    assert!(state.consume_recovery_code(&code, uid).await.is_err());
    *state.owner_user_id.write().await = Some(other);
    let (status, body) = post(
        state.clone(),
        "/auth/recover",
        json!({"code":code, "userId":uid}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_ne!(body.get("success"), Some(&json!(true)));
    assert_eq!(*state.owner_user_id.read().await, Some(other));
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(uid as u64)
    );
    assert_eq!(state.revocations.read().await.epoch, 0);
    *state.owner_user_id.write().await = Some(uid);
    let (status, body) = post(
        state.clone(),
        "/admin/recovery-codes",
        json!({}),
        Some((access, stepup)),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_ne!(body.get("success"), Some(&json!(true)));
    assert!(body.get("codes").is_none());
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert_eq!(state.recovery_codes.read().await.len(), 1);
    assert_eq!(
        code_value(&state, &code),
        CodeValue::Code {
            digest: digest(&code),
            user_id: uid,
            consumed: false
        }
    );
}

async fn wait_for_worker(state: &AppState, baseline: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while Arc::strong_count(&state.recovery_codes) <= baseline {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn instance_pause_holds_real_http_logout_until_release() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = user(&state, "owner").await;
    let access = token(&state, uid, false);
    let claims = jsonwebtoken::decode::<JwtClaims>(
        &access,
        &jsonwebtoken::DecodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    )
    .unwrap()
    .claims;
    let before = state.wdb.engine().barrier().current();
    let paused = state.instance_operations.quiesce().await.unwrap();
    let request = state.clone();
    let caller = tokio::spawn(async move {
        post(
            request,
            "/auth/logout",
            json!({}),
            Some((access, String::new())),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while state.instance_operations.waiting_operations() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!caller.is_finished());
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert!(!state
        .revocations
        .read()
        .await
        .jtis
        .contains_key(&claims.jti));
    drop(paused);
    let (status, body) = tokio::time::timeout(std::time::Duration::from_secs(3), caller)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], true);
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    assert!(state.is_token_revoked(&claims.jti, uid, claims.iat).await);
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert!(
        reopened
            .is_token_revoked(&claims.jti, uid, claims.iat)
            .await
    );
}

#[tokio::test]
async fn instance_pause_drains_an_owned_recovery_worker_after_http_cancellation() {
    use std::{future::Future, task::Poll};

    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = user(&state, "original-owner").await;
    let other = user(&state, "other-owner").await;
    let code = state
        .generate_recovery_codes(uid, 1)
        .await
        .unwrap()
        .remove(0);
    assert!(state.set_owner_durably(other, Some(uid)).await.unwrap());
    let before = state.wdb.engine().barrier().current();
    let held = state.recovery_codes.write().await;
    let baseline = Arc::strong_count(&state.recovery_codes);
    let request = state.clone();
    let request_code = code.clone();
    let caller = tokio::spawn(async move {
        post(
            request,
            "/auth/recover",
            json!({"code":request_code, "userId":uid}),
            None,
        )
        .await
    });
    wait_for_worker(&state, baseline).await;
    // Poll once to enqueue the pause behind the admitted HTTP/owned worker.
    // The code-map guard gives a deterministic boundary, not a timed sleep.
    let mut pause = Box::pin(state.instance_operations.quiesce());
    std::future::poll_fn(|cx| {
        assert!(pause.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    std::future::poll_fn(|cx| {
        assert!(pause.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert_eq!(*state.owner_user_id.read().await, Some(other));
    drop(held);
    let paused = tokio::time::timeout(std::time::Duration::from_secs(3), pause)
        .await
        .unwrap()
        .unwrap();
    // Pause cannot finish until canonical state and its auth view agree.
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    assert_eq!(*state.owner_user_id.read().await, Some(uid));
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(uid as u64)
    );
    let epoch = state.revocations.read().await.epoch;
    assert!(epoch > 0);
    assert!(state.recovery_codes.read().await.is_empty());
    assert_eq!(
        code_value(&state, &code),
        CodeValue::Code {
            digest: digest(&code),
            user_id: uid,
            consumed: true,
        }
    );
    drop(paused);
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(*reopened.owner_user_id.read().await, Some(uid));
    assert_eq!(reopened.revocations.read().await.epoch, epoch);
    assert!(!reopened.recover_owner_with_code(&code, uid).await.unwrap());
}

#[tokio::test]
async fn instance_pause_drains_a_cancelled_http_handler_before_its_database_write() {
    use std::{future::Future, task::Poll};

    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let before = state.wdb.engine().barrier().current();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let entered = Arc::new(tokio::sync::Mutex::new(Some(entered_tx)));
    let release = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
    let handler_state = state.clone();
    // A real handler with no account publication subworker. This isolates the
    // middleware's ownership of general database work after caller cancellation.
    let app = axum::Router::new()
        .route(
            "/fixture-write",
            axum::routing::post(move || {
                let state = handler_state.clone();
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.lock().await.take().unwrap().send(()).unwrap();
                    release.lock().await.take().unwrap().await.unwrap();
                    state
                        .wdb
                        .create_user("completed-after-cancellation", None, "fixture-hash")
                        .await
                        .unwrap();
                    StatusCode::NO_CONTENT
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            wabi_server::instance_operations::middleware,
        ));
    let caller =
        tokio::spawn(app.oneshot(Request::post("/fixture-write").body(Body::empty()).unwrap()));
    entered_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let mut pause = Box::pin(state.instance_operations.quiesce());
    std::future::poll_fn(|cx| {
        assert!(pause.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(state.wdb.engine().barrier().current(), before);
    release_tx.send(()).unwrap();
    let paused = tokio::time::timeout(std::time::Duration::from_secs(3), pause)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    assert!(state
        .wdb
        .list_users()
        .await
        .unwrap()
        .iter()
        .any(|u| u.username == "completed-after-cancellation"));
    drop(paused);
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert!(reopened
        .wdb
        .list_users()
        .await
        .unwrap()
        .iter()
        .any(|u| u.username == "completed-after-cancellation"));
}

#[tokio::test]
async fn a_cancelled_recovery_request_still_publishes_all_committed_account_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = user(&state, "owner").await;
    let code = state
        .generate_recovery_codes(uid, 1)
        .await
        .unwrap()
        .remove(0);
    let held = state.recovery_codes.write().await;
    let baseline = Arc::strong_count(&state.recovery_codes);
    let request = state.clone();
    let request_code = code.clone();
    let caller =
        tokio::spawn(async move { request.recover_owner_with_code(&request_code, uid).await });
    wait_for_worker(&state, baseline).await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !state
                .recovery_codes
                .read()
                .await
                .contains_key(&digest(&code))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*state.owner_user_id.read().await, Some(uid));
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(uid as u64)
    );
    let epoch = state.revocations.read().await.epoch;
    assert!(epoch > 0);
    assert_eq!(
        code_value(&state, &code),
        CodeValue::Code {
            digest: digest(&code),
            user_id: uid,
            consumed: true
        }
    );
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(*reopened.owner_user_id.read().await, Some(uid));
    assert_eq!(reopened.revocations.read().await.epoch, epoch);
    assert!(!reopened.recover_owner_with_code(&code, uid).await.unwrap());
}

#[tokio::test]
async fn cancelled_issuance_and_consumption_keep_the_auth_view_in_sync() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = user(&state, "owner").await;
    let code = state
        .generate_recovery_codes(uid, 1)
        .await
        .unwrap()
        .remove(0);
    for issue in [true, false] {
        let held = state.recovery_codes.write().await;
        let baseline = Arc::strong_count(&state.recovery_codes);
        let request = state.clone();
        let request_code = code.clone();
        let caller = tokio::spawn(async move {
            if issue {
                request.generate_recovery_codes(uid, 2).await.map(|_| ())
            } else {
                request
                    .consume_recovery_code(&request_code, uid)
                    .await
                    .map(|_| ())
            }
        });
        wait_for_worker(&state, baseline).await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        drop(held);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if state.recovery_codes.read().await.len() == if issue { 3 } else { 2 } {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    let expected = state.recovery_codes.read().await.clone();
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(*reopened.recovery_codes.read().await, expected);
    assert!(!reopened.consume_recovery_code(&code, uid).await.unwrap());
}

#[tokio::test]
async fn interrupted_legacy_import_resumes_in_bounded_batches_without_publishing_partial_state() {
    let dir = tempfile::tempdir().unwrap();
    let legacy: HashMap<String, i64> = (0..1100)
        .map(|n| (digest(&format!("legacy-{n}")), 8))
        .collect();
    let file = dir.path().join("recovery_codes.json");
    let original = serde_json::to_string(&legacy).unwrap();
    std::fs::write(&file, &original).unwrap();
    let db = WdbAdapter::open(&dir.path().join("wabidb")).await.unwrap();
    db.engine().get_or_create_stream_key(STREAM).await.unwrap();
    db.engine()
        .run_command(CommandCommit {
            caller_user_id: 0,
            caller_device_id: "partial-import".into(),
            command_name: "partial-import".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: STREAM.into(),
                event_type: EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: serde_json::to_vec(&Delta {
                    schema_version: 1,
                    migration: true,
                    operations: vec![Operation::Issue {
                        digest: digest("legacy-0"),
                        user_id: 8,
                    }],
                })
                .unwrap(),
            }],
        })
        .await
        .unwrap();
    assert!(db.engine().projection_state().get(INDEX, READY).is_none());
    drop(db);
    let state = reopen_server(dir.path()).await;
    assert_eq!(*state.recovery_codes.read().await, legacy);
    assert!(state
        .wdb
        .engine()
        .projection_state()
        .get(INDEX, READY)
        .is_some());
    assert_eq!(std::fs::read_to_string(file).unwrap(), original);
    assert!(state.consume_recovery_code("legacy-0", 8).await.unwrap());
}

#[tokio::test]
async fn malformed_duplicate_and_unsafe_legacy_sources_refuse_startup() {
    let hash = digest("legacy");
    for value in [
        "broken json".into(),
        "[]".into(),
        "{\"plaintext\":1}".into(),
        format!("{{\"{hash}\":0}}"),
        format!("{{\"{hash}\":true}}"),
        format!("{{\"{hash}\":1,\"{hash}\":2}}"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recovery_codes.json");
        std::fs::write(&file, &value).unwrap();
        let error = AppState::new(config(dir.path())).await.err().unwrap();
        assert!(error.to_string().contains("invalid legacy recovery codes"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), value);
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("recovery_codes.json")).unwrap();
    assert!(AppState::new(config(dir.path()))
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("bounded regular file"));
    #[cfg(unix)]
    {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.json");
        std::fs::write(&source, "{}").unwrap();
        std::os::unix::fs::symlink(&source, dir.path().join("recovery_codes.json")).unwrap();
        assert!(AppState::new(config(dir.path()))
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("bounded regular file"));
        assert_eq!(std::fs::read_to_string(source).unwrap(), "{}");
    }
}

#[tokio::test]
async fn invalid_counts_and_missing_accounts_cannot_issue_codes_or_recover_phantom_owners() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("recovery_codes.json"),
        json!({ digest("orphan-code"): 1000000 }).to_string(),
    )
    .unwrap();
    let state = AppState::new(config(dir.path())).await.unwrap();
    let uid = user(&state, "member").await;
    let before = state.wdb.engine().barrier().current();
    for (uid, count) in [(uid, 0), (uid, 33), (-1, 1), (1000000, 1)] {
        assert!(state.generate_recovery_codes(uid, count).await.is_err());
    }
    assert!(state
        .recover_owner_with_code("orphan-code", 1000000)
        .await
        .is_err());
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert_eq!(*state.owner_user_id.read().await, Some(uid));
    assert_eq!(state.revocations.read().await.epoch, 0);
    assert_eq!(state.recovery_codes.read().await.len(), 1);
}

#[tokio::test]
async fn stale_and_fenced_owner_changes_do_not_publish_memory_or_issue_new_codes() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(config(dir.path())).await.unwrap();
    let original = user(&state, "owner").await;
    let other = user(&state, "other").await;
    assert!(state
        .set_owner_durably(other, Some(original))
        .await
        .unwrap());
    let before = state.wdb.engine().barrier().current();
    assert!(!state
        .set_owner_durably(original, Some(original))
        .await
        .unwrap());
    assert!(state.generate_recovery_codes(original, 5).await.is_err());
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert!(state.recovery_codes.read().await.is_empty());
    state.wdb.engine().fence_local_writer().await.unwrap();
    assert!(state
        .set_owner_durably(original, Some(other))
        .await
        .is_err());
    assert_eq!(*state.owner_user_id.read().await, Some(other));
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(other as u64)
    );
    assert_eq!(state.wdb.engine().barrier().current(), before);
}

#[tokio::test]
async fn cancelled_owner_assignment_still_publishes_the_durable_owner() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let original = user(&state, "owner").await;
    let other = user(&state, "other").await;
    let held = state.owner_user_id.write().await;
    let baseline = Arc::strong_count(&state.owner_user_id);
    let request = state.clone();
    let caller =
        tokio::spawn(async move { request.set_owner_durably(other, Some(original)).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while Arc::strong_count(&state.owner_user_id) <= baseline {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if *state.owner_user_id.read().await == Some(other) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(other as u64)
    );
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(*reopened.owner_user_id.read().await, Some(other));
}

#[tokio::test]
async fn cancelled_first_owner_claim_still_publishes_its_durable_owner() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let uid = state
        .wdb
        .create_user("first-owner", None, "fixture-password-hash")
        .await
        .unwrap() as i64;
    assert!(state.needs_setup().await);
    let held = state.owner_user_id.write().await;
    let baseline = Arc::strong_count(&state.owner_user_id);
    let request = state.clone();
    let caller = tokio::spawn(async move { request.claim_ownership(uid, "first-owner").await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while Arc::strong_count(&state.owner_user_id) <= baseline {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if *state.owner_user_id.read().await == Some(uid) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(uid as u64)
    );
    assert!(!state.claim_ownership(uid, "first-owner").await.unwrap());
    drop(state);
    let reopened = reopen_server(dir.path()).await;
    assert_eq!(*reopened.owner_user_id.read().await, Some(uid));
    assert!(!reopened.needs_setup().await);
}

#[tokio::test]
async fn a_transfer_waiting_behind_code_recovery_cannot_override_the_recovered_owner() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let original = user(&state, "original").await;
    let other = user(&state, "other").await;
    let recipient = user(&state, "recipient").await;
    let code = state
        .generate_recovery_codes(original, 1)
        .await
        .unwrap()
        .remove(0);
    assert!(state
        .set_owner_durably(other, Some(original))
        .await
        .unwrap());
    let before = state.wdb.engine().barrier().current();
    let held = state.owner_user_id.write().await;
    let recovering = state.clone();
    let recovery =
        tokio::spawn(async move { recovering.recover_owner_with_code(&code, original).await });
    // Recovery is admitted and owns its code/revocation guards while queued
    // first behind the owner guard. The stale transfer is queued afterward.
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.revocations.try_read().is_ok() || state.recovery_codes.try_read().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let assigning = state.clone();
    let assignment =
        tokio::spawn(async move { assigning.set_owner_durably(recipient, Some(other)).await });
    drop(held);
    assert!(recovery.await.unwrap().unwrap());
    assert!(!assignment.await.unwrap().unwrap());
    assert_eq!(*state.owner_user_id.read().await, Some(original));
    assert_eq!(
        state.wdb.get_owner_user_id().await.unwrap(),
        Some(original as u64)
    );
    assert_eq!(state.wdb.engine().barrier().current(), before + 1);
    assert!(state.revocations.read().await.epoch > 0);
}
