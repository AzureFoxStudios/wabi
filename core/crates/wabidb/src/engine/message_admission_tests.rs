use super::*;
use crate::{
    format::record::RecordKind,
    projections::{
        message_lookup::{self, tests::record},
        messages::{encode_record, ChannelMessagesCleared},
        reactions::{self, Reaction},
        room_placement::{self, RoomPlacementRecord},
    },
    sequencer::types::{CommandCommit, CommandOutcome, EventToWrite, RoomOwnerPrecondition},
};
use tokio::sync::oneshot;

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0xA9; 32]));
    config.allow_init = true;
    config
}

fn event(kind: &str, stream: &str, plaintext: Vec<u8>) -> EventToWrite {
    EventToWrite {
        event_type: kind.into(),
        stream_id: stream.into(),
        plaintext,
        stream_kind: if kind == room_placement::EVENT { 6 } else { 1 },
        record_kind: RecordKind::Event,
    }
}

fn command(
    events: Vec<EventToWrite>,
    condition: Option<RoomOwnerPrecondition>,
) -> (CommandCommit, oneshot::Receiver<Result<CommandOutcome>>) {
    let (response_tx, response_rx) = oneshot::channel();
    (
        CommandCommit {
            caller_user_id: 1,
            caller_device_id: "message-admission-test".into(),
            command_name: "message_admission_test".into(),
            idempotency_key: None,
            room_owner_precondition: condition,
            events,
            essential: true,
            response_tx,
        },
        response_rx,
    )
}

fn reaction(id: &str) -> Reaction {
    Reaction {
        message_id: id.into(),
        user_id: 1,
        reaction_type: "thumbsup".into(),
        created_at_micros: 1,
        key_id: "v0".into(),
    }
}

fn guard(room: &str, owner: &str) -> RoomOwnerPrecondition {
    RoomOwnerPrecondition {
        channel_id: room.into(),
        owner_node_id: owner.into(),
        expected_epoch: Some(1),
    }
}

#[tokio::test]
async fn open_backfills_message_id_lookup_from_legacy_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    engine.get_or_create_stream_key("ch_a").await.unwrap();
    let row = record("ch_a", "msg_a");
    let outcome = engine
        .run_command(
            command(
                vec![event("message_created", "ch_a", encode_record(&row))],
                None,
            )
            .0,
        )
        .await
        .unwrap();
    assert_eq!(
        message_lookup::get(&engine.projection_state(), "msg_a").unwrap(),
        Some(row.clone())
    );
    drop(engine);

    let stopped = crate::tests::wait_for_stopped_engine(dir.path()).await;
    let (legacy, watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
    assert_eq!(watermark, outcome.commit_seq);
    legacy.remove(message_lookup::INDEX, &message_lookup::key("ch_a", "msg_a"));
    legacy.save_snapshot(dir.path()).unwrap();
    drop(stopped);
    let restarted = crate::tests::reopen_after_drop(config(dir.path()), None)
        .await
        .unwrap();
    let state = restarted.projection_state();
    assert_eq!(state.applied_commit_seq(), watermark);
    assert_eq!(message_lookup::get(&state, "msg_a").unwrap(), Some(row));
    let (persisted, saved_watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
    assert_eq!(saved_watermark, watermark);
    assert_eq!(persisted.index_len(message_lookup::INDEX), 1);
}

#[tokio::test]
async fn queued_message_parent_survives_rebind_refusal_and_event_replay() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    for stream in ["ch_a", "ch_b", "reactions:msg_a"] {
        engine.get_or_create_stream_key(stream).await.unwrap();
    }
    let row = record("ch_a", "msg_a");
    let (create, create_rx) = command(
        vec![event("message_created", "ch_a", encode_record(&row))],
        None,
    );
    let (rebind, rebind_rx) = command(
        vec![event(
            "message_created",
            "ch_b",
            encode_record(&record("ch_b", "msg_a")),
        )],
        None,
    );
    let (react, react_rx) = command(
        vec![event(
            "reaction_added",
            "reactions:msg_a",
            reactions::encode_reaction(&reaction("msg_a")),
        )],
        None,
    );
    let sender = engine.sequencer().unwrap().sender().clone();
    // No yield between enqueues: these share an ordinary group-commit window.
    sender.try_send(create).unwrap();
    sender.try_send(rebind).unwrap();
    sender.try_send(react).unwrap();
    let first = create_rx.await.unwrap().unwrap();
    assert!(
        matches!(rebind_rx.await.unwrap(), Err(WabiError::Validation { command, .. }) if command == "room_owner_precondition")
    );
    let last = react_rx.await.unwrap().unwrap();
    assert!(last.commit_seq > first.commit_seq);
    assert_eq!(engine.barrier().current(), last.commit_seq);
    assert_eq!(
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        message_lookup::get(&engine.projection_state(), "msg_a").unwrap(),
        Some(row.clone())
    );
    assert_eq!(
        reactions::ReactionsProjection::list_reactions(&engine.projection_state(), "msg_a")
            .unwrap(),
        vec![reaction("msg_a")]
    );
    drop(sender);
    drop(engine);
    let stopped = crate::tests::wait_for_stopped_engine(dir.path()).await;
    ProjectionState::remove_snapshot(dir.path());
    drop(stopped);
    let reopened = crate::tests::reopen_after_drop(config(dir.path()), None)
        .await
        .unwrap();
    assert_eq!(reopened.barrier().current(), last.commit_seq);
    assert_eq!(
        message_lookup::get(&reopened.projection_state(), "msg_a").unwrap(),
        Some(row)
    );
    assert_eq!(
        reactions::ReactionsProjection::list_reactions(&reopened.projection_state(), "msg_a")
            .unwrap(),
        vec![reaction("msg_a")]
    );
}

#[tokio::test]
async fn corrupt_message_snapshot_refuses_open_without_replacing_it_or_leaking_lock() {
    for wrong_pointer in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
        engine.get_or_create_stream_key("ch_a").await.unwrap();
        let row = record("ch_a", "msg_a");
        engine
            .run_command(
                command(
                    vec![event("message_created", "ch_a", encode_record(&row))],
                    None,
                )
                .0,
            )
            .await
            .unwrap();
        drop(engine);
        let stopped = crate::tests::wait_for_stopped_engine(dir.path()).await;
        let (damaged, watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
        if wrong_pointer {
            // The lookup and primary counts still match; counts alone cannot
            // certify that a snapshot's pointers are valid.
            damaged.insert(
                message_lookup::INDEX,
                message_lookup::key("ch_a", "msg_a"),
                b"wrong-target".to_vec(),
                watermark,
            );
        } else {
            damaged.remove(
                "messages",
                &crate::projections::messages::encode_key("ch_a", "msg_a"),
            );
            damaged.insert(
                "messages",
                b"wrong-key".to_vec(),
                encode_record(&row),
                watermark,
            );
        }
        damaged.save_snapshot(dir.path()).unwrap();
        let before = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();
        drop(stopped);
        let error = crate::tests::reopen_after_drop(config(dir.path()), None)
            .await
            .unwrap_err();
        assert!(
            matches!(error, WabiError::Corrupt { location, .. } if location == message_lookup::INDEX)
        );
        assert_eq!(
            std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap(),
            before
        );
        assert!(dir.path().join(".lock").exists());
        assert!(super::locks::try_acquire_process_lock(&dir.path().join(".lock"))
            .unwrap()
            .is_some());
    }
}

#[tokio::test]
async fn failed_preparation_does_not_admit_a_queued_reaction() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    // Deliberately omit the message stream key, causing prepare_command to fail.
    engine
        .get_or_create_stream_key("reactions:msg_a")
        .await
        .unwrap();
    let (create, create_rx) = command(
        vec![event(
            "message_created",
            "ch_missing",
            encode_record(&record("ch_missing", "msg_a")),
        )],
        None,
    );
    let (react, react_rx) = command(
        vec![event(
            "reaction_added",
            "reactions:msg_a",
            reactions::encode_reaction(&reaction("msg_a")),
        )],
        None,
    );
    let sender = engine.sequencer().unwrap().sender().clone();
    sender.try_send(create).unwrap();
    sender.try_send(react).unwrap();
    assert!(matches!(
        create_rx.await.unwrap(),
        Err(WabiError::UnknownStreamKey { .. })
    ));
    assert!(
        matches!(react_rx.await.unwrap(), Err(WabiError::Validation { command, .. }) if command == "room_owner_precondition")
    );
    assert_eq!(engine.barrier().current(), 0);
    assert_eq!(engine.projection_state().index_len("messages"), 0);
    assert_eq!(engine.projection_state().index_len("reactions"), 0);
    assert_eq!(
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        0
    );
    assert!(engine.is_healthy());
}

#[tokio::test]
async fn durable_message_writes_cannot_omit_or_substitute_an_actual_room_guard() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    let row = record("ch_actual", "msg_a");
    engine.get_or_create_stream_key("ch_actual").await.unwrap();
    engine
        .run_command(
            command(
                vec![event("message_created", "ch_actual", encode_record(&row))],
                None,
            )
            .0,
        )
        .await
        .unwrap();
    for (room, owner) in [("ch_actual", "site-b"), ("ch_other", "site-a")] {
        let stream = room_placement::stream_id(room);
        engine.get_or_create_stream_key(&stream).await.unwrap();
        engine
            .run_command(
                command(
                    vec![event(
                        room_placement::EVENT,
                        &stream,
                        serde_json::to_vec(&RoomPlacementRecord {
                            schema_version: 1,
                            channel_id: room.into(),
                            epoch: 1,
                            owner_node_id: owner.into(),
                            replica_node_ids: vec![],
                        })
                        .unwrap(),
                    )],
                    None,
                )
                .0,
            )
            .await
            .unwrap();
    }
    let before = engine.barrier().current();
    let entries =
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len();
    let payloads = [
        (
            "message_created",
            "ch_actual",
            encode_record(&record("ch_actual", "msg_new")),
        ),
        ("message_edited", "ch_actual", encode_record(&row)),
        ("message_deleted", "ch_actual", encode_record(&row)),
        (
            "channel_messages_cleared",
            "ch_actual",
            serde_json::to_vec(&ChannelMessagesCleared {
                channel_id: "ch_actual".into(),
                cleared_at_micros: 2,
            })
            .unwrap(),
        ),
        (
            "reaction_added",
            "reactions:msg_a",
            reactions::encode_reaction(&reaction("msg_a")),
        ),
        (
            "reaction_removed",
            "reactions:msg_a:thumbsup:removed",
            reactions::encode_reaction(&reaction("msg_a")),
        ),
    ];
    for (kind, stream, payload) in payloads {
        engine.get_or_create_stream_key(stream).await.unwrap();
        for condition in [
            None,
            Some(guard("ch_other", "site-a")),
            Some(guard("ch_actual", "site-a")),
            Some(guard("ch_actual", "site-b")),
        ] {
            let error = engine
                .run_command(command(vec![event(kind, stream, payload.clone())], condition).0)
                .await
                .unwrap_err();
            assert!(
                matches!(error, WabiError::Validation { command, .. } if command == "room_owner_precondition"),
                "{kind}"
            );
        }
    }
    engine.get_or_create_stream_key("ch_other").await.unwrap();
    for placement_first in [false, true] {
        let placement = event(
            room_placement::EVENT,
            &room_placement::stream_id("ch_other"),
            serde_json::to_vec(&RoomPlacementRecord {
                schema_version: 1,
                channel_id: "ch_other".into(),
                epoch: 2,
                owner_node_id: "site-b".into(),
                replica_node_ids: vec![],
            })
            .unwrap(),
        );
        let write = event(
            "message_created",
            "ch_other",
            encode_record(&record("ch_other", "msg_other")),
        );
        let events = if placement_first {
            vec![placement, write]
        } else {
            vec![write, placement]
        };
        let error = engine
            .run_command(command(events, Some(guard("ch_other", "site-a"))).0)
            .await
            .unwrap_err();
        assert!(
            matches!(error, WabiError::Validation { command, .. } if command == "room_owner_precondition")
        );
    }
    assert_eq!(engine.barrier().current(), before);
    assert_eq!(
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        entries
    );
    assert_eq!(
        message_lookup::get(&engine.projection_state(), "msg_a").unwrap(),
        Some(row)
    );
    assert_eq!(
        message_lookup::get(&engine.projection_state(), "msg_new").unwrap(),
        None
    );
    assert_eq!(engine.projection_state().index_len("reactions"), 0);
    assert_eq!(
        message_lookup::get(&engine.projection_state(), "msg_other").unwrap(),
        None
    );
    assert!(engine.is_healthy());
}
