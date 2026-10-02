//! Ordered denials must survive migration, replay and failed durable writes.
//! This fixture is not a complete instance checkpoint or promotion proof.
#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::json;
use std::{path::Path, sync::Arc};
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
    projections::auth_revocations::{Delta, Operation, EVENT, INDEX, READY, STREAM},
    sequencer::types::{CommandCommit, EventToWrite},
};

fn config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "auth-revocation-recovery-fixture-only".into(),
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

#[tokio::test]
async fn migration_and_new_denials_survive_event_replay_despite_a_stale_sidecar() {
    let directory = tempfile::tempdir().unwrap();
    let now = chrono::Utc::now().timestamp().max(1000) as u64;
    let legacy = json!({ "epoch":now-500, "jtis":{"stolen":u64::MAX}, "users":[7],
        "user_iat_revoked":{"8":now}, "user_jti_exemptions":{"8":["own"]} });
    let file = directory.path().join("revocations.json");
    std::fs::write(&file, legacy.to_string()).unwrap();
    let state = AppState::new(config(directory.path())).await.unwrap();
    assert!(state.is_token_revoked("stolen", 9, now as i64).await);
    assert!(state.is_token_revoked("ordinary", 7, now as i64).await);
    assert!(state.is_token_revoked("other", 8, now as i64 - 20).await);
    assert!(!state.is_token_revoked("own", 8, now as i64 - 20).await);
    state
        .revoke_user_other_sessions(8, "changed")
        .await
        .unwrap();
    state.clear_legacy_user_revocation(7).await.unwrap();
    state
        .revoke_token_with_exp("later-stolen".into(), i64::MAX)
        .await
        .unwrap();
    state
        .revoke_token_with_exp("later-stolen".into(), 1)
        .await
        .unwrap();
    assert_eq!(
        state.revocations.read().await.jtis["later-stolen"],
        i64::MAX as u64
    );
    let floor = state.revocations.read().await.user_iat_revoked[&8];
    assert!(!state.is_token_revoked("changed", 8, now as i64 - 20).await);
    assert!(state.is_token_revoked("own", 8, now as i64 - 20).await);
    assert!(!state.is_token_revoked("ordinary", 7, now as i64).await);
    let commit = state.wdb.engine().barrier().current();
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        legacy.to_string(),
        "canonical writes leave legacy import source unchanged"
    );
    drop(state);
    let stopped = writer_drain::wait_for_stopped_engine(&directory.path().join("wabidb")).await;
    std::fs::remove_file(directory.path().join("wabidb/projections/snapshot.json")).unwrap();
    std::fs::write(&file, "stale and malformed legacy file after migration").unwrap();
    drop(stopped);
    let reopened = writer_drain::app_state(&config(directory.path())).await.unwrap();
    assert_eq!(
        reopened.wdb.engine().barrier().current(),
        commit,
        "no second import of the stale file"
    );
    assert_eq!(
        reopened.revocations.read().await.user_iat_revoked[&8],
        floor
    );
    assert!(
        reopened
            .is_token_revoked("later-stolen", 9, now as i64)
            .await
    );
    assert!(reopened.is_token_revoked("own", 8, now as i64 - 20).await);
    assert!(
        !reopened
            .is_token_revoked("changed", 8, now as i64 - 20)
            .await
    );
    assert!(!reopened.is_token_revoked("ordinary", 7, now as i64).await);
    reopened.revoke_all_tokens().await.unwrap();
    assert!(reopened.is_token_revoked("changed", 8, now as i64).await);
}

#[tokio::test]
async fn concurrent_revocations_keep_all_denials_and_advance_the_same_user_floor() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(directory.path())).await.unwrap());
    let started_at = chrono::Utc::now().timestamp().max(0) as u64;
    let mut tasks = vec![];
    for n in 0..32 {
        let state = state.clone();
        tasks.push(tokio::spawn(async move {
            state
                .revoke_token_with_exp(format!("stolen-{n}"), i64::MAX)
                .await
                .unwrap();
            state.revoke_user(8).await.unwrap();
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let guards = state.revocations.read().await;
    assert_eq!(guards.jtis.len(), 32);
    let floor = guards.user_iat_revoked[&8];
    assert!(floor >= started_at + 32);
    drop(guards);
    let commit = state.wdb.engine().barrier().current();
    drop(state);
    let reopened = writer_drain::app_state(&config(directory.path())).await.unwrap();
    assert_eq!(reopened.wdb.engine().barrier().current(), commit);
    assert_eq!(reopened.revocations.read().await.jtis.len(), 32);
    assert_eq!(
        reopened.revocations.read().await.user_iat_revoked[&8],
        floor
    );
}

#[tokio::test]
async fn a_fenced_writer_does_not_publish_memory_denials_or_acknowledge_logout() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(directory.path())).await.unwrap());
    let uid = state
        .wdb
        .create_user("member", None, "fixture-hash")
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: "member".into(),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: "logout-fixture".into(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let before = state.wdb.engine().barrier().current();
    state.wdb.engine().fence_local_writer().await.unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/auth/logout")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_ne!(payload.get("success"), Some(&json!(true)));
    assert!(state.revoke_user(uid as i64).await.is_err());
    assert!(state
        .revoke_user_other_sessions(uid as i64, "own")
        .await
        .is_err());
    assert!(state.revoke_all_tokens().await.is_err());
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert!(state.revocations.read().await.jtis.is_empty());
    assert!(state.revocations.read().await.user_iat_revoked.is_empty());
    assert_eq!(state.revocations.read().await.epoch, 0);
}

#[tokio::test]
async fn invalid_legacy_revocations_refuse_startup_instead_of_resetting_security() {
    for value in [
        "broken json",
        "{\"jtis\":true}",
        "{\"unknownSecurityField\":[]}",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("revocations.json");
        std::fs::write(&file, value).unwrap();
        let error = AppState::new(config(directory.path())).await.err().unwrap();
        assert!(error
            .to_string()
            .contains("invalid legacy session revocations"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), value);
    }
}

#[tokio::test]
async fn an_interrupted_batched_import_resumes_without_exposing_partial_denials() {
    let directory = tempfile::tempdir().unwrap();
    let now = chrono::Utc::now().timestamp();
    let jtis: serde_json::Map<String, serde_json::Value> = (0..1100)
        .map(|n| (format!("legacy-{n}"), json!(i64::MAX)))
        .collect();
    std::fs::write(
        directory.path().join("revocations.json"),
        json!({
            "epoch":0,"jtis":jtis,"users":[7]
        })
        .to_string(),
    )
    .unwrap();
    let db = WdbAdapter::open(&directory.path().join("wabidb"))
        .await
        .unwrap();
    db.engine().get_or_create_stream_key(STREAM).await.unwrap();
    db.engine()
        .run_command(CommandCommit {
            caller_user_id: 0,
            caller_device_id: "interrupted-import-fixture".into(),
            command_name: "partial_auth_import".into(),
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
                    operations: vec![Operation::Token {
                        jti: "legacy-0".into(),
                        expires_at: i64::MAX as u64,
                    }],
                })
                .unwrap(),
            }],
        })
        .await
        .unwrap();
    assert!(db.engine().projection_state().get(INDEX, READY).is_none());
    drop(db);
    let state = writer_drain::app_state(&config(directory.path())).await.unwrap();
    assert_eq!(state.revocations.read().await.jtis.len(), 1100);
    assert!(state.is_token_revoked("legacy-0", 9, now).await);
    assert!(state.is_token_revoked("legacy-1099", 9, now).await);
    assert!(state.is_token_revoked("unlisted", 7, now).await);
    assert!(state
        .wdb
        .engine()
        .projection_state()
        .get(INDEX, READY)
        .is_some());
}

#[tokio::test]
async fn cancellation_after_admission_cannot_strand_a_committed_denial_outside_the_auth_view() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(directory.path())).await.unwrap());
    let held = state.revocations.write().await;
    let request_state = state.clone();
    let caller = tokio::spawn(async move {
        request_state
            .revoke_token_with_exp("cancelled-caller".into(), i64::MAX)
            .await
    });
    // The owned worker has been created but cannot acquire its auth-view guard.
    // This proves cancellation occurs after admission, independent of timing.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while Arc::strong_count(&state.revocations) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if state
                .revocations
                .read()
                .await
                .jtis
                .contains_key("cancelled-caller")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        state
            .is_token_revoked("cancelled-caller", 9, chrono::Utc::now().timestamp())
            .await
    );
    assert!(state
        .wdb
        .engine()
        .projection_state()
        .get(INDEX, b"token:cancelled-caller")
        .is_some());
    drop(state);
    let reopened = writer_drain::app_state(&config(directory.path())).await.unwrap();
    assert!(
        reopened
            .is_token_revoked("cancelled-caller", 9, chrono::Utc::now().timestamp())
            .await
    );
}
