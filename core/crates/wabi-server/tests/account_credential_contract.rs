//! Credential writes and delayed profile events must agree at the durable boundary.
use wabi_server::adapter::WdbAdapter;
use wabidb::{
    crypto::aes_gcm_record::decrypt_record,
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    sequencer::types::{CommandCommit, EventToWrite, ReplayEnvelope},
    stream_log::segment_reader::SegmentReader,
};

async fn account_fixture() -> (
    tempfile::TempDir,
    std::sync::Arc<wabi_server::state::AppState>,
    u64,
) {
    use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path();
    let state = std::sync::Arc::new(
        wabi_server::state::AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "credential-http-fixture-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "fixture".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist.txt").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    );
    let owner = state
        .wdb
        .create_user("http-owner", None, "owner-hash")
        .await
        .unwrap();
    state
        .claim_ownership(owner as i64, "http-owner")
        .await
        .unwrap();
    (directory, state, owner)
}

fn account_token(state: &wabi_server::state::AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &wabi_server::auth_extractor::JwtClaims {
            sub: uid.to_string(),
            username: "fixture".into(),
            is_guest: false,
            iat: now,
            exp: now + 3600,
            jti: "http-owner-session".into(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

async fn account_post(
    app: &axum::Router,
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> axum::http::StatusCode {
    use tower::ServiceExt;
    app.clone()
        .oneshot(
            axum::http::Request::post(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn overlong_admin_reset_and_bot_reset_are_denied_without_credential_changes() {
    let (_directory, state, owner) = account_fixture().await;
    let password = format!("{}OLD", "x".repeat(72));
    let hash = bcrypt::hash(&password, 4).unwrap();
    let target = state
        .wdb
        .create_user("http-reset-target", None, &hash)
        .await
        .unwrap();
    let bot = state
        .wdb
        .create_user("http-reset-bot", None, "bot-random-hash")
        .await
        .unwrap();
    let (opaque, _) = state.bot_registry.create(bot).await.unwrap();
    let token = account_token(&state, owner);
    let app = wabi_server::api::routes::create_api_router(state.clone()).with_state(state.clone());
    for password in [format!("{}NEW", "x".repeat(72)), "💬".repeat(19)] {
        assert_eq!(
            account_post(
                &app,
                &token,
                "/admin/users/reset-password",
                serde_json::json!({"targetUserId":target,"newPassword":password})
            )
            .await,
            axum::http::StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        state
            .wdb
            .get_user(target)
            .await
            .unwrap()
            .unwrap()
            .password_hash,
        hash
    );
    assert!(bcrypt::verify(&password, &hash).unwrap());
    assert!(
        !state
            .is_token_revoked(
                "target-session",
                target as i64,
                chrono::Utc::now().timestamp()
            )
            .await
    );
    assert_eq!(
        account_post(
            &app,
            &token,
            "/admin/users/reset-password",
            serde_json::json!({"targetUserId":bot,"newPassword":"known-human-password"})
        )
        .await,
        axum::http::StatusCode::FORBIDDEN
    );
    assert_eq!(
        state
            .wdb
            .get_user(bot)
            .await
            .unwrap()
            .unwrap()
            .password_hash,
        "bot-random-hash"
    );
    assert_eq!(state.bot_registry.authenticate(&opaque).await, Some(bot));
}

#[tokio::test]
async fn failed_bot_persistence_is_an_http_error_for_disable_and_rotation() {
    let (directory, state, owner) = account_fixture().await;
    let bot = state
        .wdb
        .create_user("http-persist-bot", None, "bot-random-hash")
        .await
        .unwrap();
    let (opaque, _) = state.bot_registry.create(bot).await.unwrap();
    let path = directory.path().join("bots.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let token = account_token(&state, owner);
    let app = wabi_server::api::routes::create_api_router(state.clone()).with_state(state.clone());
    for operation in ["disable", "rotate"] {
        assert_eq!(
            account_post(
                &app,
                &token,
                &format!("/bot/{operation}"),
                serde_json::json!({"botUserId":bot})
            )
            .await,
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(state.bot_registry.authenticate(&opaque).await, Some(bot));
    }
}

#[tokio::test]
async fn delayed_profile_event_cannot_restore_a_password_from_before_a_reset() {
    let directory = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(directory.path()).await.unwrap();
    let uid = store
        .create_user("profile-race", None, "old-password-hash")
        .await
        .unwrap();
    store
        .update_user(
            uid,
            wabidb::domain::UserUpdate {
                bio: Some("profile submitted before password reset".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    // Capture the real adapter-built event, then deliver that already-built
    // profile patch after a credential reset, as a delayed sequencer write.
    let stream = format!("user:{uid}");
    let segment = directory
        .path()
        .join("streams/other")
        .join(&stream)
        .join("events/00000001.wseg");
    let records = SegmentReader::open(segment)
        .await
        .unwrap()
        .read_records()
        .await
        .unwrap();
    let record = records.last().unwrap();
    let key = store
        .engine()
        .key_registry()
        .lock()
        .await
        .get_active_key(&stream, record.header.commit_seq)
        .unwrap()
        .key_material;
    let plaintext = decrypt_record(
        &key,
        record.header.commit_seq,
        &record.header.encode(),
        &record.payload,
    )
    .unwrap();
    let envelope: ReplayEnvelope = serde_json::from_slice(&plaintext).unwrap();
    assert_eq!(envelope.event_type, "user_updated");
    store
        .update_user(
            uid,
            wabidb::domain::UserUpdate {
                password_hash: Some("new-password-hash".into()),
                username: Some("new-login-name".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .engine()
        .run_command(CommandCommit {
            caller_user_id: uid,
            caller_device_id: "fixture".into(),
            command_name: "delayed_profile_patch".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: stream,
                event_type: envelope.event_type,
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: envelope.payload,
            }],
        })
        .await
        .unwrap();
    let user = store.get_user(uid).await.unwrap().unwrap();
    assert_eq!(
        user.password_hash, "new-password-hash",
        "profile writes must never carry a credential replacement"
    );
    assert_eq!(
        user.username, "new-login-name",
        "a bio-only patch must not restore a stale login name"
    );
    assert_eq!(
        user.bio.as_deref(),
        Some("profile submitted before password reset")
    );
}

#[tokio::test]
async fn concurrent_registration_and_rename_cannot_claim_another_login_name() {
    let directory = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(WdbAdapter::open(directory.path()).await.unwrap());
    let (first, second) = tokio::join!(
        store.create_user("CaseSensitive", None, "hash-one"),
        store.create_user("casesensitive", None, "hash-two"),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert_eq!(store.list_users().await.unwrap().len(), 1);
    let owner = store
        .get_user_by_username("CASESENSITIVE")
        .await
        .unwrap()
        .unwrap();
    let attacker = store
        .create_user("attacker", None, "attacker-hash")
        .await
        .unwrap();
    assert!(store
        .update_user(
            attacker,
            wabidb::domain::UserUpdate {
                username: Some("CaseSensitive".into()),
                ..Default::default()
            }
        )
        .await
        .is_err());
    assert_eq!(
        store
            .get_user_by_username("casesensitive")
            .await
            .unwrap()
            .unwrap()
            .user_id,
        owner.user_id
    );
    let (first, second) = tokio::join!(
        store.update_user(
            owner.user_id,
            wabidb::domain::UserUpdate {
                username: Some("newname".into()),
                ..Default::default()
            }
        ),
        store.update_user(
            attacker,
            wabidb::domain::UserUpdate {
                username: Some("NewName".into()),
                ..Default::default()
            }
        ),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(store
        .get_user_by_username("NEWNAME")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn ambiguous_legacy_login_names_fail_closed_without_breaking_record_decode() {
    let directory = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open(directory.path()).await.unwrap();
    let uid = store
        .create_user("legacy", None, "original-hash")
        .await
        .unwrap();
    let state = store.engine().projection_state();
    let bytes = state.get("users", &uid.to_be_bytes()).unwrap();
    let mut record = wabidb::projections::users::decode_record(&bytes).unwrap();
    record.user_id = uid + 1000;
    record.username = "LEGACY".into();
    state.insert(
        "users",
        record.user_id.to_be_bytes().to_vec(),
        wabidb::projections::users::encode_record(&record),
        store.engine().barrier().current(),
    );
    assert_eq!(store.list_users().await.unwrap().len(), 2);
    assert!(store.get_user_by_username("legacy").await.is_err());
}
