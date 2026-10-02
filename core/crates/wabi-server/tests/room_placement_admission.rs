//! A placement for another node must stop local chat writes before commit.
//! This is a temporary-engine guard, not a room handoff or distributed lease.

#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use wabi_server::adapter::{ProjectTaskFields, WdbAdapter};
use wabi_server::upload_registry::{UploadKind, UploadRegistry};
use wabidb::{
    crypto::bootstrap::BootstrapSource,
    domain::{ChannelKind, MemberRole},
    engine::{wabi_store::WabiStore, WabiDbConfig},
    format::record::RecordKind,
    projections::room_placement::{decode, stream_id, RoomPlacementRecord, EVENT, INDEX},
    sequencer::types::{CommandCommit, EventToWrite, RoomOwnerPrecondition},
};

async fn place(store: &WdbAdapter, channel_id: &str, owner_node_id: &str) {
    let epoch = store
        .engine()
        .projection_state()
        .get(INDEX, channel_id.as_bytes())
        .map(|bytes| decode(&bytes).unwrap().epoch + 1)
        .unwrap_or(1);
    let stream = stream_id(channel_id);
    store
        .engine()
        .get_or_create_stream_key(&stream)
        .await
        .unwrap();
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    store
        .engine()
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 0,
            caller_device_id: "placement-admission-test".into(),
            command_name: "test_placement".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: stream,
                event_type: EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: serde_json::to_vec(&RoomPlacementRecord {
                    schema_version: 1,
                    channel_id: channel_id.into(),
                    epoch,
                    owner_node_id: owner_node_id.into(),
                    replica_node_ids: vec![],
                })
                .unwrap(),
            }],
            essential: true,
            response_tx,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn invalid_authority_identity_refuses_startup_before_creating_sidecars_or_storage() {
    use wabi_server::{
        config::{LoreAddonConfig, ServerConfig, ServerRole},
        state::AppState,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("not-created");
    let error = AppState::new(ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "invalid-node-test-only".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "site/other".into(),
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
    .err()
    .expect("invalid node identity must refuse startup");
    assert!(error.to_string().contains("invalid Authority node ID"));
    assert!(!path.exists());
}

#[tokio::test]
async fn direct_calls_keep_separate_placement_and_reject_remote_and_stale_owners() {
    use wabidb::projections::call_sessions;
    let dir = tempfile::tempdir().unwrap();
    let config = || {
        let mut config = WabiDbConfig::new(
            dir.path().to_path_buf(),
            BootstrapSource::Provided([0xD1; 32]),
        );
        config.allow_init = true;
        config
    };
    let store = WdbAdapter::open_with_config_and_node_id(config(), "site-a".into())
        .await
        .unwrap();
    let scope = "dm:user-1:user-2";
    let room_id = call_sessions::placement_room_id(scope, scope)
        .unwrap()
        .into_owned();
    let chat_id = "dm-user-1-user-2";
    // Even a chat placement on another owner must not own this independent call.
    place(&store, chat_id, "site-b").await;
    store
        .create_call_session(
            scope.into(),
            scope.into(),
            "audio-call".into(),
            1,
            2,
            "wabidb".into(),
        )
        .await
        .unwrap();
    let placement = decode(
        &store
            .engine()
            .projection_state()
            .get(INDEX, room_id.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(placement.owner_node_id, "site-a");
    assert_eq!(placement.epoch, 1);
    assert!(store.get_channel(chat_id).await.unwrap().is_none());
    assert!(store.get_channel(&room_id).await.unwrap().is_none());
    store
        .join_call_session(scope.into(), 1, "user-1".into(), true)
        .await
        .unwrap();
    store
        .join_call_session(scope.into(), 2, "user-2".into(), false)
        .await
        .unwrap();
    store
        .emit_call_signal(scope.into(), 1, "offer".into(), Some(2), "{}".into(), 1)
        .await
        .unwrap();
    let before = store.get_call_session(scope).await.unwrap();
    let participants = store.get_call_participants(scope).await.unwrap();
    place(&store, &room_id, "site-b").await;
    let position = store.engine().barrier().current();
    assert!(store
        .create_call_session(
            scope.into(),
            scope.into(),
            "audio-call".into(),
            1,
            2,
            "wabidb".into()
        )
        .await
        .is_err());
    assert!(store
        .join_call_session(scope.into(), 2, "user-2".into(), false)
        .await
        .is_err());
    assert!(store.leave_call_session(scope.into(), 1).await.is_err());
    assert!(store.end_call_session(scope.into(), 1).await.is_err());
    assert!(store
        .emit_call_signal(scope.into(), 1, "offer".into(), Some(2), "{}".into(), 2)
        .await
        .is_err());
    let stale = RoomOwnerPrecondition {
        channel_id: room_id.clone(),
        owner_node_id: "site-a".into(),
        expected_epoch: Some(1),
    };
    let engine = store.engine();
    assert!(wabidb::commands::call_session_end::end_call_session(
        scope.into(),
        1,
        stale,
        engine,
        engine.sequencer().unwrap(),
    )
    .await
    .is_err());
    assert_eq!(engine.barrier().current(), position);
    assert_eq!(store.get_call_session(scope).await.unwrap(), before);
    assert_eq!(
        store.get_call_participants(scope).await.unwrap(),
        participants
    );
    assert_eq!(store.get_call_signals(scope, 0).await.unwrap().len(), 1);
    // A raw new direct call cannot omit initialization even with an otherwise
    // valid unplaced owner condition.
    let unplaced = "dm:user-1:user-3";
    let unplaced_room = call_sessions::placement_room_id(unplaced, unplaced)
        .unwrap()
        .into_owned();
    let stream = format!("call_session:{unplaced}");
    engine.get_or_create_stream_key(&stream).await.unwrap();
    let (response_tx, _) = tokio::sync::oneshot::channel();
    assert!(engine
        .run_command(CommandCommit {
            room_owner_precondition: Some(RoomOwnerPrecondition {
                channel_id: unplaced_room.clone(),
                owner_node_id: "site-a".into(),
                expected_epoch: None,
            }),
            caller_user_id: 1,
            caller_device_id: "missing-direct-init-test".into(),
            command_name: "create_call_session".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: stream,
                event_type: "call_session_created".into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: serde_json::to_vec(&wabidb::domain::CallSession::new(
                    unplaced,
                    unplaced,
                    "audio-call",
                    1,
                    2,
                    "wabidb"
                ))
                .unwrap(),
            }],
            essential: true,
            response_tx,
        })
        .await
        .is_err());
    assert_eq!(engine.barrier().current(), position);
    assert!(store.get_call_session(unplaced).await.unwrap().is_none());
    assert!(engine
        .projection_state()
        .get(INDEX, unplaced_room.as_bytes())
        .is_none());
    drop(store);
    let stopped = writer_drain::wait_for_stopped_engine(dir.path()).await;
    std::fs::remove_file(dir.path().join("projections/snapshot.json")).unwrap();
    drop(stopped);
    let store = writer_drain::retry(
        || WdbAdapter::open_with_config_and_node_id(config(), "site-a".into()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    assert_eq!(store.get_call_session(scope).await.unwrap(), before);
    assert_eq!(
        decode(
            &store
                .engine()
                .projection_state()
                .get(INDEX, room_id.as_bytes())
                .unwrap()
        )
        .unwrap()
        .owner_node_id,
        "site-b"
    );
    assert!(store.end_call_session(scope.into(), 1).await.is_err());
    place(&store, &room_id, "site-a").await;
    store.end_call_session(scope.into(), 1).await.unwrap();
    store
        .create_call_session(
            scope.into(),
            scope.into(),
            "audio-call".into(),
            1,
            2,
            "wabidb".into(),
        )
        .await
        .unwrap();
    let reopened = decode(
        &store
            .engine()
            .projection_state()
            .get(INDEX, room_id.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reopened.epoch, 3);
    assert_eq!(reopened.owner_node_id, "site-a");
    assert_eq!(
        store
            .get_call_session(scope)
            .await
            .unwrap()
            .unwrap()
            .channel_id,
        scope
    );
}

#[tokio::test]
async fn call_writes_follow_parent_room_and_recheck_stale_owner_at_commit() {
    use wabidb::commands::{
        call_session_create, call_session_end, call_session_join, call_session_leave,
        call_signal_emit,
    };
    use wabidb::error::WabiError;

    fn rejected<T: std::fmt::Debug>(result: Result<T, WabiError>) {
        assert!(
            matches!(&result, Err(WabiError::Validation { command, .. })
                if command == "room_owner_precondition"),
            "{result:?}"
        );
    }

    let dir = tempfile::tempdir().unwrap();
    let mut config = WabiDbConfig::new(
        dir.path().to_path_buf(),
        BootstrapSource::Provided([0xC3; 32]),
    );
    config.allow_init = true;
    let store = WdbAdapter::open_with_config_and_node_id(config, "site-a".into())
        .await
        .unwrap();
    let room = store
        .create_channel("Call owner", ChannelKind::Voice, 1, false)
        .await
        .unwrap();
    let session = "placed-call";
    store
        .create_call_session(
            session.into(),
            room.clone(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
        )
        .await
        .unwrap();
    store
        .join_call_session(session.into(), 1, "stable-1".into(), true)
        .await
        .unwrap();
    store
        .emit_call_signal(session.into(), 1, "offer".into(), None, "{}".into(), 1)
        .await
        .unwrap();
    let original_session = store.get_call_session(session).await.unwrap().unwrap();
    let original_participants = store.get_call_participants(session).await.unwrap();
    let original_signals = store.get_call_signals(session, 0).await.unwrap();
    let stale = RoomOwnerPrecondition {
        channel_id: room.clone(),
        owner_node_id: "site-a".into(),
        expected_epoch: Some(1),
    };
    let safe_room = store
        .create_channel("Unrelated local room", ChannelKind::Voice, 1, false)
        .await
        .unwrap();
    let wrong = RoomOwnerPrecondition {
        channel_id: safe_room,
        owner_node_id: "site-a".into(),
        expected_epoch: Some(1),
    };
    place(&store, &room, "site-b").await;
    let position = store.engine().barrier().current();

    rejected(
        store
            .create_call_session(
                "remote-create".into(),
                room.clone(),
                "audio-call".into(),
                1,
                10,
                "webrtc".into(),
            )
            .await,
    );
    rejected(
        store
            .join_call_session(session.into(), 2, "stable-2".into(), false)
            .await,
    );
    rejected(store.leave_call_session(session.into(), 1).await);
    rejected(store.end_call_session(session.into(), 1).await);
    rejected(
        store
            .emit_call_signal(session.into(), 1, "answer".into(), None, "{}".into(), 2)
            .await,
    );

    // Bypass the adapter's early check with the previously observed condition.
    // Each low-level builder must carry it to the sequencer's durability gate.
    let engine = store.engine();
    let sequencer = engine.sequencer().unwrap();
    rejected(
        call_session_create::create_call_session(
            "stale-create".into(),
            room.clone(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            stale.clone(),
            engine,
            sequencer,
        )
        .await,
    );
    rejected(
        call_session_join::join_call_session(
            session.into(),
            2,
            "stable-2".into(),
            false,
            stale.clone(),
            engine,
            sequencer,
        )
        .await,
    );
    rejected(
        call_session_leave::leave_call_session(session.into(), 1, stale.clone(), engine, sequencer)
            .await,
    );
    rejected(
        call_session_end::end_call_session(session.into(), 1, stale.clone(), engine, sequencer)
            .await,
    );
    rejected(
        call_signal_emit::emit_call_signal(
            session.into(),
            1,
            "answer".into(),
            None,
            "{}".into(),
            2,
            stale,
            engine,
            sequencer,
        )
        .await,
    );
    rejected(
        call_session_create::create_call_session(
            "wrong-parent".into(),
            room.clone(),
            "audio-call".into(),
            1,
            10,
            "webrtc".into(),
            wrong.clone(),
            engine,
            sequencer,
        )
        .await,
    );
    rejected(
        call_session_join::join_call_session(
            session.into(),
            2,
            "stable-2".into(),
            false,
            wrong.clone(),
            engine,
            sequencer,
        )
        .await,
    );
    rejected(
        call_session_leave::leave_call_session(session.into(), 1, wrong.clone(), engine, sequencer)
            .await,
    );
    rejected(
        call_session_end::end_call_session(session.into(), 1, wrong.clone(), engine, sequencer)
            .await,
    );
    rejected(
        call_signal_emit::emit_call_signal(
            session.into(),
            1,
            "answer".into(),
            None,
            "{}".into(),
            2,
            wrong,
            engine,
            sequencer,
        )
        .await,
    );
    let (response_tx, _) = tokio::sync::oneshot::channel();
    rejected(
        engine
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "unguarded-call-test".into(),
                command_name: "unguarded_end".into(),
                idempotency_key: None,
                essential: true,
                response_tx,
                events: vec![EventToWrite {
                    stream_id: format!("call_session:{session}"),
                    event_type: "call_session_ended".into(),
                    stream_kind: 6,
                    record_kind: RecordKind::Event,
                    plaintext: serde_json::to_vec(&serde_json::json!({"session_id": session,
                "active": false, "ended_at_micros": 1, "last_updated_at_micros": 1}))
                    .unwrap(),
                }],
            })
            .await,
    );
    assert_eq!(engine.barrier().current(), position);
    assert!(store
        .get_call_session("remote-create")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_call_session("stale-create")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store.get_call_session(session).await.unwrap(),
        Some(original_session)
    );
    assert_eq!(
        store.get_call_participants(session).await.unwrap(),
        original_participants
    );
    assert_eq!(
        store.get_call_signals(session, 0).await.unwrap(),
        original_signals
    );

    place(&store, &room, "site-a").await;
    store
        .join_call_session(session.into(), 2, "stable-2".into(), false)
        .await
        .unwrap();
    store
        .emit_call_signal(session.into(), 2, "answer".into(), Some(1), "{}".into(), 2)
        .await
        .unwrap();
    store.leave_call_session(session.into(), 2).await.unwrap();
    store.end_call_session(session.into(), 1).await.unwrap();
    assert!(
        !store
            .get_call_session(session)
            .await
            .unwrap()
            .unwrap()
            .active
    );
    assert!(store
        .get_call_participants(session)
        .await
        .unwrap()
        .iter()
        .any(|p| p.user_id == 2 && p.left_at_micros.is_some()));
    assert_eq!(store.get_call_signals(session, 0).await.unwrap().len(), 2);

    let other_room = store
        .create_channel("Other room", ChannelKind::Voice, 1, false)
        .await
        .unwrap();
    let position = engine.barrier().current();
    assert!(store
        .create_call_session(
            session.into(),
            other_room,
            "audio-call".into(),
            1,
            10,
            "webrtc".into()
        )
        .await
        .is_err());
    assert_eq!(
        store
            .get_call_session(session)
            .await
            .unwrap()
            .unwrap()
            .channel_id,
        room
    );
    // No stored parent means no owner admission or fabricated commit receipt.
    assert!(matches!(
        store.leave_call_session("absent".into(), 1).await,
        Err(WabiError::NotFound { .. })
    ));
    assert!(matches!(
        store.end_call_session("absent".into(), 1).await,
        Err(WabiError::NotFound { .. })
    ));
    assert!(matches!(
        store
            .join_call_session("absent".into(), 1, "stable-1".into(), false)
            .await,
        Err(WabiError::NotFound { .. })
    ));
    assert!(matches!(
        store
            .emit_call_signal("absent".into(), 1, "offer".into(), None, "{}".into(), 3)
            .await,
        Err(WabiError::NotFound { .. })
    ));
    assert_eq!(engine.barrier().current(), position);
}

#[tokio::test]
async fn direct_call_http_uses_pair_scope_without_a_chat_and_preserves_authorization() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use std::sync::Arc;
    use tower::ServiceExt;
    use wabi_server::{
        api::routes::create_api_router,
        auth_extractor::JwtClaims,
        config::{LoreAddonConfig, ServerConfig, ServerRole},
        state::AppState,
    };
    async fn post(
        app: &Router,
        token: &str,
        path: &str,
        payload: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::post(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: dir.path().to_string_lossy().into_owned(),
            uploads_dir: dir.path().join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "direct-placement-test-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "site-a".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: dir.path().join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    );
    assert_eq!(state.wdb.engine().local_node_id(), state.config.node_id);
    let host = state
        .wdb
        .create_user("host", None, "registered-test-hash")
        .await
        .unwrap();
    let peer = state
        .wdb
        .create_user("peer", None, "registered-test-hash")
        .await
        .unwrap();
    let outsider = state
        .wdb
        .create_user("outsider", None, "registered-test-hash")
        .await
        .unwrap();
    let token = |uid: u64| {
        let now = chrono::Utc::now().timestamp();
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &JwtClaims {
                sub: uid.to_string(),
                username: "test-account".into(),
                is_guest: false,
                exp: now + 3600,
                iat: now,
                jti: uuid::Uuid::new_v4().to_string(),
                stepup: false,
                token_type: "access".into(),
            },
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap()
    };
    let host_token = token(host);
    let peer_token = token(peer);
    let mut names = [format!("user-{host}"), format!("user-{peer}")];
    names.sort();
    let scope = format!("dm:{}:{}", names[0], names[1]);
    let room_id = wabidb::projections::call_sessions::placement_room_id(&scope, &scope)
        .unwrap()
        .into_owned();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let creation = serde_json::json!({
        "session_id":scope, "channel_id":"unrelated-ui-hint", "call_type":"audio-call",
        "max_participants":10,"transport":"wabidb"
    });
    let created = post(&app, &host_token, "/calls/sessions", creation.clone()).await;
    assert_eq!(created.0, StatusCode::OK, "{:?}", created.1);
    assert!(created.1["commit_seq"].as_u64().is_some());
    assert!(state.wdb.list_channels(None).await.unwrap().is_empty());
    assert_eq!(
        state
            .wdb
            .get_call_session(&scope)
            .await
            .unwrap()
            .unwrap()
            .channel_id,
        scope
    );
    let first = decode(
        &state
            .wdb
            .engine()
            .projection_state()
            .get(INDEX, room_id.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first.owner_node_id, "site-a");
    assert_eq!(first.epoch, 1);
    let position = state.wdb.engine().barrier().current();
    assert_eq!(
        post(&app, &token(outsider), "/calls/sessions", creation.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(state.wdb.engine().barrier().current(), position);
    let joined = post(
        &app,
        &host_token,
        &format!("/calls/sessions/{scope}/join"),
        serde_json::json!({"stable_user_id":format!("user-{host}")}),
    )
    .await;
    assert_eq!(joined.0, StatusCode::OK, "{:?}", joined.1);
    place(&state.wdb, &room_id, "site-b").await;
    let position = state.wdb.engine().barrier().current();
    let mut pushes = state.call_session_push.subscribe();
    for (token, path, payload) in [
        (
            &peer_token,
            format!("/calls/sessions/{scope}/join"),
            serde_json::json!({"stable_user_id":format!("user-{peer}")}),
        ),
        (
            &host_token,
            format!("/calls/sessions/{scope}/leave"),
            serde_json::json!({}),
        ),
        (
            &host_token,
            format!("/calls/sessions/{scope}/end"),
            serde_json::json!({}),
        ),
        (
            &host_token,
            format!("/calls/sessions/{scope}/signals"),
            serde_json::json!({"signal_type":"offer","target_user_id":null,"payload":"{}"}),
        ),
    ] {
        let result = post(&app, token, &path, payload).await;
        assert_eq!(result.0, StatusCode::CONFLICT, "{path}: {:?}", result.1);
        assert_eq!(state.wdb.engine().barrier().current(), position);
    }
    // An authorized duplicate create is an honest no-op, even on a remote
    // owner; it must not create another durable receipt or publish an event.
    let duplicate = post(&app, &host_token, "/calls/sessions", creation.clone()).await;
    assert_eq!(duplicate.0, StatusCode::OK);
    assert!(duplicate.1["commit_seq"].is_null());
    assert_eq!(state.wdb.engine().barrier().current(), position);
    assert!(matches!(
        pushes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    place(&state.wdb, &room_id, "site-a").await;
    assert_eq!(
        post(
            &app,
            &host_token,
            &format!("/calls/sessions/{scope}/end"),
            serde_json::json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    // Reuse the deterministic session without resetting the owner epoch.
    let reopened = post(&app, &host_token, "/calls/sessions", creation).await;
    assert_eq!(reopened.0, StatusCode::OK, "{:?}", reopened.1);
    assert_eq!(
        decode(
            &state
                .wdb
                .engine()
                .projection_state()
                .get(INDEX, room_id.as_bytes())
                .unwrap()
        )
        .unwrap()
        .epoch,
        3
    );
}

#[tokio::test]
async fn rest_live_chat_and_call_writes_do_not_bypass_remote_room_owner() {
    use axum::{body::Body, http::Request};
    use std::sync::Arc;
    use tower::ServiceExt;
    use wabi_server::{
        api::routes::create_api_router,
        auth_extractor::JwtClaims,
        config::{LoreAddonConfig, ServerConfig, ServerRole},
        state::AppState,
    };
    use wabidb::domain::MemberRole;

    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: dir.path().to_string_lossy().into_owned(),
            uploads_dir: dir.path().join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "placement-admission-test-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "site-a".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: dir.path().join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    );
    assert_eq!(state.wdb.engine().local_node_id(), state.config.node_id);
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("Live room", ChannelKind::Text, member, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, member, MemberRole::Member)
        .await
        .unwrap();
    state
        .channel_auto_delete_label
        .write()
        .await
        .insert(channel.clone(), "live".into());
    let call_room = state
        .wdb
        .create_channel("Voice room", ChannelKind::Voice, member, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&call_room, member, MemberRole::Member)
        .await
        .unwrap();
    let session = format!("channel:{call_room}");
    state
        .wdb
        .create_call_session(
            session.clone(),
            call_room.clone(),
            "audio-call".into(),
            member,
            10,
            "wabidb".into(),
        )
        .await
        .unwrap();
    state
        .wdb
        .join_call_session(session.clone(), member, "stable-member".into(), true)
        .await
        .unwrap();
    let call_before = state.wdb.get_call_session(&session).await.unwrap();
    let participants_before = state.wdb.get_call_participants(&session).await.unwrap();
    let mut push = state.call_session_push.subscribe();
    place(&state.wdb, &channel, "site-b").await;
    place(&state.wdb, &call_room, "site-b").await;
    let position = state.wdb.engine().barrier().current();

    let now = chrono::Utc::now().timestamp();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: member.to_string(),
            username: "member".into(),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::post("/messages")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"channel_id": channel, "content": "must refuse"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    assert_eq!(
        status,
        axum::http::StatusCode::CONFLICT,
        "{}",
        String::from_utf8_lossy(&body)
    );
    assert!(state.session_messages.read().await.get(&channel).is_none());
    assert_eq!(state.wdb.engine().barrier().current(), position);
    for (path, payload) in [
        (
            "/calls/sessions".into(),
            serde_json::json!({
                "session_id": "must-not-create", "channel_id": call_room,
                "call_type": "audio-call", "max_participants": 10, "transport": "wabidb"
            }),
        ),
        (
            format!("/calls/sessions/{session}/leave"),
            serde_json::json!({}),
        ),
        (
            format!("/calls/sessions/{session}/end"),
            serde_json::json!({}),
        ),
        (
            format!("/calls/sessions/{session}/signals"),
            serde_json::json!({
                "signal_type": "offer", "target_user_id": null, "payload": "{}"
            }),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post(&path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        assert_eq!(
            status,
            axum::http::StatusCode::CONFLICT,
            "{path}: {}",
            String::from_utf8_lossy(&body)
        );
        assert_eq!(state.wdb.engine().barrier().current(), position);
    }
    assert!(state
        .wdb
        .get_call_session("must-not-create")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        state.wdb.get_call_session(&session).await.unwrap(),
        call_before
    );
    assert_eq!(
        state.wdb.get_call_participants(&session).await.unwrap(),
        participants_before
    );
    assert!(state
        .wdb
        .get_call_signals(&session, 0)
        .await
        .unwrap()
        .is_empty());
    assert!(matches!(
        push.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn private_room_creation_and_dm_reopen_keep_numbered_placement() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = WabiDbConfig::new(
        dir.path().to_path_buf(),
        BootstrapSource::Provided([0xB8; 32]),
    );
    config.allow_init = true;
    let store = WdbAdapter::open_with_config_and_node_id(config, "site-a".into())
        .await
        .unwrap();
    let alice = store.create_user("alice", None, "test-hash").await.unwrap();
    let bob = store.create_user("bob", None, "test-hash").await.unwrap();
    let dm_id = format!("dm-user-{alice}-user-{bob}");
    let members = vec![format!("user-{alice}"), format!("user-{bob}")];

    store
        .create_dm_channel(&dm_id, "DM", Some(&members), alice as i64)
        .await
        .unwrap();
    let first = decode(
        &store
            .engine()
            .projection_state()
            .get(INDEX, dm_id.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first.owner_node_id, "site-a");
    assert_eq!(first.epoch, 1);

    store.delete_dm_channel(&dm_id).await.unwrap();
    store
        .create_dm_channel(&dm_id, "DM reopened", Some(&members), alice as i64)
        .await
        .unwrap();
    let reopened = decode(
        &store
            .engine()
            .projection_state()
            .get(INDEX, dm_id.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(reopened.epoch, 2);

    let group_id = "group-placement-test";
    store
        .create_group(group_id, "Group", alice, &[alice, bob])
        .await
        .unwrap();
    let group = decode(
        &store
            .engine()
            .projection_state()
            .get(INDEX, group_id.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(group.owner_node_id, "site-a");
    assert_eq!(group.epoch, 1);
}

#[tokio::test]
async fn recorded_remote_owner_blocks_core_chat_mutations_before_commit() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = WabiDbConfig::new(
        dir.path().to_path_buf(),
        BootstrapSource::Provided([0xB7; 32]),
    );
    config.allow_init = true;
    let store = WdbAdapter::open_with_config_and_node_id(config, "site-a".into())
        .await
        .unwrap();

    let remote_room = store
        .create_channel("Remote owner", ChannelKind::Text, 1, false)
        .await
        .unwrap();
    let initial = decode(
        &store
            .engine()
            .projection_state()
            .get(INDEX, remote_room.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(initial.epoch, 1);
    assert_eq!(initial.owner_node_id, "site-a");
    let existing_message = store
        .send_message(&remote_room, 1, "before placement", false, &[])
        .await
        .unwrap();
    let remote_album = store
        .create_album("channel", &remote_room, "Before placement", 1)
        .await
        .unwrap();
    let remote_item = store
        .add_item(
            &remote_album,
            "https://example.invalid/image",
            "image",
            None,
            1,
        )
        .await
        .unwrap();
    place(&store, &remote_room, "site-b").await;
    let position = store.engine().barrier().current();

    assert!(store
        .send_message(&remote_room, 1, "must refuse", false, &[])
        .await
        .is_err());
    assert!(store
        .edit_message(&existing_message, 1, "must refuse")
        .await
        .is_err());
    assert!(store.delete_message(&existing_message, 1).await.is_err());
    assert!(store
        .add_reaction(&existing_message, 1, "thumbsup")
        .await
        .is_err());
    assert!(store
        .remove_reaction(&existing_message, 1, "thumbsup")
        .await
        .is_err());
    assert!(store.clear_channel_messages(&remote_room, 1).await.is_err());
    assert!(store
        .update_channel(&remote_room, &serde_json::json!({"name": "changed"}), 1)
        .await
        .is_err());
    assert!(store
        .add_channel_member(&remote_room, 2, MemberRole::Member)
        .await
        .is_err());
    assert!(store.remove_channel_member(&remote_room, 1).await.is_err());
    assert!(store.ban_user(&remote_room, 1, 2, "test").await.is_err());
    assert!(store.unban_user(&remote_room, 1, 2).await.is_err());
    assert!(store.mute_user(&remote_room, 1, 2, 0).await.is_err());
    assert!(store.unmute_user(&remote_room, 1, 2).await.is_err());
    assert!(store.deafen_user(&remote_room, 1, 2).await.is_err());
    assert!(store.undeafen_user(&remote_room, 1, 2).await.is_err());
    assert!(store
        .upsert_channel_retention(&remote_room, 1, 1)
        .await
        .is_err());
    assert!(store
        .upsert_member_role(&remote_room, 2, MemberRole::Member)
        .await
        .is_err());
    assert!(store
        .upsert_webhook(&remote_room, "test", "https://example.invalid/hook")
        .await
        .is_err());
    assert!(store
        .create_wiki_page(&remote_room, "Page", "Body", 1, "", "", 0)
        .await
        .is_err());
    assert!(store
        .create_forum_thread(&remote_room, "Body", 1, Some("Thread"), None, None)
        .await
        .is_err());
    assert!(store
        .create_incident(&remote_room, "Incident", "Details", "low", 1)
        .await
        .is_err());
    assert!(store
        .upload_gallery_work(
            &remote_room,
            "Work",
            "Caption",
            "https://example.invalid/work",
            "image/png",
            "art",
            false,
            1,
        )
        .await
        .is_err());
    let task_fields = ProjectTaskFields {
        notes: None, checklist: None, related_task_ids: None, human_estimate_minutes: Default::default(),
        title: "Task".into(),
        description: String::new(),
        status: "todo".into(),
        priority: "normal".into(),
        due_date_millis: None,
        assignee_user_id: None,
    };
    assert!(store
        .create_project_task(&remote_room, "remote-task", task_fields.clone(), 1)
        .await
        .is_err());
    assert!(store
        .put_whiteboard_doc(&format!("channel:{remote_room}"), "{}")
        .await
        .is_err());
    assert!(store
        .create_album("channel", &remote_room, "Must refuse", 1)
        .await
        .is_err());
    assert!(store
        .add_item(
            &remote_album,
            "https://example.invalid/other",
            "other",
            None,
            1
        )
        .await
        .is_err());
    assert!(store
        .delete_item(&remote_album, &remote_item, 1)
        .await
        .is_err());
    assert!(store
        .delete_album("channel", &remote_room, &remote_album, 1)
        .await
        .is_err());
    let registry_data = dir.path().join("upload-registry");
    let uploads = dir.path().join("uploads");
    std::fs::create_dir_all(&registry_data).unwrap();
    let registry = UploadRegistry::new_persistent(&registry_data).unwrap();
    assert!(registry
        .publish_bytes(
            &uploads,
            store.engine(),
            "remote-unguarded.bin",
            "remote-unguarded.bin",
            Some(remote_room.clone()),
            None,
            Some(1),
            UploadKind::Attachment,
            b"must refuse",
        )
        .await
        .is_err());
    assert!(registry
        .publish_bytes(
            &uploads,
            store.engine(),
            "remote-stale.bin",
            "remote-stale.bin",
            Some(remote_room.clone()),
            Some(RoomOwnerPrecondition {
                channel_id: remote_room.clone(),
                owner_node_id: "site-a".into(),
                expected_epoch: Some(1),
            }),
            Some(1),
            UploadKind::Attachment,
            b"must refuse",
        )
        .await
        .is_err());
    assert!(!uploads.join("remote-unguarded.bin").exists());
    assert!(!uploads.join("remote-stale.bin").exists());
    assert!(store.delete_channel(&remote_room, 1).await.is_err());
    assert!(store.get_channel(&remote_room).await.unwrap().is_some());
    assert_eq!(store.engine().barrier().current(), position);

    let local_room = store
        .create_channel("Local owner", ChannelKind::Text, 1, false)
        .await
        .unwrap();
    assert_eq!(
        decode(
            &store
                .engine()
                .projection_state()
                .get(INDEX, local_room.as_bytes())
                .unwrap()
        )
        .unwrap()
        .owner_node_id,
        "site-a"
    );
    assert!(store
        .send_message(&local_room, 1, "local write", false, &[])
        .await
        .is_ok());
    store
        .add_channel_member(&local_room, 1, MemberRole::Member)
        .await
        .unwrap();
    store.ban_user(&local_room, 1, 2, "test").await.unwrap();
    store
        .upsert_channel_retention(&local_room, 1, 1)
        .await
        .unwrap();
    store
        .create_wiki_page(&local_room, "Local page", "Body", 1, "", "", 0)
        .await
        .unwrap();
    store
        .create_project_task(&local_room, "local-task", task_fields, 1)
        .await
        .unwrap();
    store
        .put_whiteboard_doc(&format!("channel:{local_room}"), "{}")
        .await
        .unwrap();
    let local_album = store
        .create_album("channel", &local_room, "Local album", 1)
        .await
        .unwrap();
    let local_item = store
        .add_item(
            &local_album,
            "https://example.invalid/local",
            "local",
            None,
            1,
        )
        .await
        .unwrap();
    store
        .delete_item(&local_album, &local_item, 1)
        .await
        .unwrap();
    store
        .delete_album("channel", &local_room, &local_album, 1)
        .await
        .unwrap();
    registry
        .publish_bytes(
            &uploads,
            store.engine(),
            "local-room.bin",
            "local-room.bin",
            Some(local_room.clone()),
            Some(RoomOwnerPrecondition {
                channel_id: local_room.clone(),
                owner_node_id: "site-a".into(),
                expected_epoch: Some(1),
            }),
            Some(1),
            UploadKind::Attachment,
            b"local",
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(uploads.join("local-room.bin")).unwrap(),
        b"local"
    );

    drop(store);
    let stopped = writer_drain::wait_for_stopped_engine(dir.path()).await;
    let snapshot = dir.path().join("projections/snapshot.json");
    if snapshot.exists() {
        std::fs::remove_file(snapshot).unwrap();
    }
    drop(stopped);
    let mut reopened_config = WabiDbConfig::new(
        dir.path().to_path_buf(),
        BootstrapSource::Provided([0xB7; 32]),
    );
    reopened_config.allow_init = true;
    let reopened = writer_drain::retry(
        || WdbAdapter::open_with_config_and_node_id(reopened_config.clone(), "site-a".into()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    let remote_after_restart = decode(
        &reopened
            .engine()
            .projection_state()
            .get(INDEX, remote_room.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(remote_after_restart.epoch, 2);
    assert_eq!(remote_after_restart.owner_node_id, "site-b");
    assert_eq!(
        decode(
            &reopened
                .engine()
                .projection_state()
                .get(INDEX, local_room.as_bytes())
                .unwrap()
        )
        .unwrap()
        .owner_node_id,
        "site-a"
    );
}
