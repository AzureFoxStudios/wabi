use super::*;
use crate::{
    commands::{
        call_session_create, call_session_end, call_session_join, call_session_leave,
        call_signal_emit,
    },
    format::record::RecordKind,
    projections::{
        call_sessions,
        room_placement::{self, RoomPlacementRecord},
    },
    sequencer::types::{CommandCommit, EventToWrite, RoomOwnerPrecondition},
};

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0xA7; 32]));
    config.allow_init = true;
    config
}

fn guard(room: &str, owner: &str, epoch: Option<u64>) -> RoomOwnerPrecondition {
    RoomOwnerPrecondition {
        channel_id: room.into(),
        owner_node_id: owner.into(),
        expected_epoch: epoch,
    }
}

async fn place(engine: &WabiDbEngine, room: &str, owner: &str, epoch: u64) {
    let stream = room_placement::stream_id(room);
    engine.get_or_create_stream_key(&stream).await.unwrap();
    engine
        .run_command(CommandCommit {
            caller_user_id: 0,
            caller_device_id: "node-identity-test".into(),
            command_name: "test_placement".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            events: vec![EventToWrite {
                stream_id: stream,
                event_type: room_placement::EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: serde_json::to_vec(&RoomPlacementRecord {
                    schema_version: 1,
                    channel_id: room.into(),
                    epoch,
                    owner_node_id: owner.into(),
                    replica_node_ids: vec![],
                })
                .unwrap(),
            }],
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
        })
        .await
        .unwrap();
}

fn probe(condition: RoomOwnerPrecondition) -> CommandCommit {
    CommandCommit {
        caller_user_id: 0,
        caller_device_id: "node-identity-test".into(),
        command_name: "test_guarded_write".into(),
        idempotency_key: None,
        room_owner_precondition: Some(condition),
        events: vec![EventToWrite {
            stream_id: "node-probe".into(),
            event_type: "node_identity_probe".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: b"accepted".to_vec(),
        }],
        essential: true,
        response_tx: tokio::sync::oneshot::channel().0,
    }
}

fn assert_identity_refusal(error: WabiError) {
    assert!(
        matches!(error, WabiError::Validation { command, reason } if command == "room_owner_precondition" && reason.contains("local node identity"))
    );
}

fn entry_count(dir: &std::path::Path) -> usize {
    crate::commit_index::batcher::read_all_entries(&dir.join("global/commit-index"))
        .unwrap()
        .len()
}

#[tokio::test]
async fn invalid_node_id_refuses_open_before_creating_any_engine_files() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("not-created");
    for value in [
        "",
        "-site",
        "site/other",
        "site:other",
        " site",
        "sité",
        "site\n",
        &"a".repeat(65),
    ] {
        let error = WabiDbEngine::open_with_node_id(config(&path), value.into())
            .await
            .unwrap_err();
        assert!(
            matches!(error, WabiError::Validation { command, .. } if command == "configure_local_node")
        );
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn matching_remote_owner_and_epoch_cannot_impersonate_this_engine() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    assert_eq!(engine.local_node_id(), "site-a");
    engine.get_or_create_stream_key("node-probe").await.unwrap();
    place(&engine, "ch_local", "site-a", 1).await;
    place(&engine, "ch_remote", "site-b", 1).await;
    let before = engine.barrier().current();
    let entries = entry_count(dir.path());
    for condition in [
        guard("ch_remote", "site-b", Some(1)),
        guard("ch_unplaced", "site-b", None),
    ] {
        assert_identity_refusal(engine.run_command(probe(condition)).await.unwrap_err());
    }
    assert_eq!(engine.barrier().current(), before);
    assert_eq!(entry_count(dir.path()), entries);
    assert!(engine
        .projection_state()
        .get("events", b"node_identity_probe")
        .is_none());
    let accepted = engine
        .run_command(probe(guard("ch_local", "site-a", Some(1))))
        .await
        .unwrap();
    assert_eq!(engine.barrier().current(), accepted.commit_seq);
    assert_eq!(engine.local_node_id(), "site-a");
    assert_eq!(entry_count(dir.path()), entries + 1);
    assert_eq!(
        engine
            .projection_state()
            .get("events", b"node_identity_probe"),
        Some(b"accepted".to_vec())
    );
}

#[tokio::test]
async fn direct_call_initialization_cannot_select_a_different_engine_identity() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    let scope = "dm:user-1:user-2";
    let room = call_sessions::placement_room_id(scope, scope)
        .unwrap()
        .into_owned();
    let create = |owner: &str| {
        call_session_create::create_call_session(
            scope.into(),
            scope.into(),
            "audio-call".into(),
            1,
            2,
            "wabidb".into(),
            guard(&room, owner, None),
            &engine,
            engine.sequencer().unwrap(),
        )
    };
    assert_identity_refusal(create("site-b").await.unwrap_err());
    assert_eq!(entry_count(dir.path()), 0);
    assert!(engine
        .projection_state()
        .get(call_sessions::INDEX_NAME, scope.as_bytes())
        .is_none());
    assert!(engine
        .projection_state()
        .get(room_placement::INDEX, room.as_bytes())
        .is_none());
    create("site-a").await.unwrap();
    assert_eq!(entry_count(dir.path()), 1);
    let placement = room_placement::decode(
        &engine
            .projection_state()
            .get(room_placement::INDEX, room.as_bytes())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(placement.owner_node_id, engine.local_node_id());
    assert_eq!(placement.epoch, 1);
}

#[tokio::test]
async fn all_call_builders_refuse_the_recorded_remote_owner_without_committing() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    let scope = "dm:user-1:user-2";
    let room = call_sessions::placement_room_id(scope, scope)
        .unwrap()
        .into_owned();
    call_session_create::create_call_session(
        scope.into(),
        scope.into(),
        "audio-call".into(),
        1,
        2,
        "wabidb".into(),
        guard(&room, "site-a", None),
        &engine,
        engine.sequencer().unwrap(),
    )
    .await
    .unwrap();
    call_session_join::join_call_session(
        scope.into(),
        1,
        "user-1".into(),
        true,
        guard(&room, "site-a", Some(1)),
        &engine,
        engine.sequencer().unwrap(),
    )
    .await
    .unwrap();
    let session_before = engine
        .projection_state()
        .get(call_sessions::INDEX_NAME, scope.as_bytes());
    let participants_before = engine.projection_state().index_len("call_participants");
    place(&engine, &room, "site-b", 2).await;
    let before = engine.barrier().current();
    let entries = entry_count(dir.path());
    let remote = || guard(&room, "site-b", Some(2));
    assert_identity_refusal(
        call_session_create::create_call_session(
            scope.into(),
            scope.into(),
            "audio-call".into(),
            1,
            2,
            "wabidb".into(),
            remote(),
            &engine,
            engine.sequencer().unwrap(),
        )
        .await
        .unwrap_err(),
    );
    assert_identity_refusal(
        call_session_join::join_call_session(
            scope.into(),
            2,
            "user-2".into(),
            false,
            remote(),
            &engine,
            engine.sequencer().unwrap(),
        )
        .await
        .unwrap_err(),
    );
    assert_identity_refusal(
        call_session_leave::leave_call_session(
            scope.into(),
            1,
            remote(),
            &engine,
            engine.sequencer().unwrap(),
        )
        .await
        .unwrap_err(),
    );
    assert_identity_refusal(
        call_session_end::end_call_session(
            scope.into(),
            1,
            remote(),
            &engine,
            engine.sequencer().unwrap(),
        )
        .await
        .unwrap_err(),
    );
    assert_identity_refusal(
        call_signal_emit::emit_call_signal(
            scope.into(),
            1,
            "offer".into(),
            Some(2),
            "{}".into(),
            1,
            remote(),
            &engine,
            engine.sequencer().unwrap(),
        )
        .await
        .unwrap_err(),
    );
    assert_eq!(engine.barrier().current(), before);
    assert_eq!(entry_count(dir.path()), entries);
    assert_eq!(
        engine
            .projection_state()
            .get(call_sessions::INDEX_NAME, scope.as_bytes()),
        session_before
    );
    assert_eq!(
        engine.projection_state().index_len("call_participants"),
        participants_before
    );
    assert_eq!(engine.projection_state().index_len("call_signals"), 0);
    assert!(engine.is_healthy());
}

#[tokio::test]
async fn replay_preserves_remote_placement_without_granting_remote_write_identity() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    engine.get_or_create_stream_key("node-probe").await.unwrap();
    place(&engine, "ch_remote", "site-b", 1).await;
    let before = engine.barrier().current();
    drop(engine);
    let stopped = crate::tests::wait_for_stopped_engine(dir.path()).await;
    ProjectionState::remove_snapshot(dir.path());
    drop(stopped);
    let reopened = crate::tests::reopen_after_drop(config(dir.path()), Some("site-a"))
        .await
        .unwrap();
    assert_eq!(reopened.local_node_id(), "site-a");
    assert_eq!(reopened.barrier().current(), before);
    assert_identity_refusal(
        reopened
            .run_command(probe(guard("ch_remote", "site-b", Some(1))))
            .await
            .unwrap_err(),
    );
    assert_eq!(entry_count(dir.path()), 1);
    assert_eq!(reopened.barrier().current(), before);
    assert_eq!(
        room_placement::decode(
            &reopened
                .projection_state()
                .get(room_placement::INDEX, b"ch_remote")
                .unwrap()
        )
        .unwrap()
        .owner_node_id,
        "site-b"
    );
}

#[tokio::test]
async fn default_opener_selects_the_legacy_node_identity() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    assert_eq!(engine.local_node_id(), node_identity::DEFAULT_NODE_ID);
}
