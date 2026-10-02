use super::*;
use crate::{
    format::record::RecordKind,
    projections::workspace_writes::tests::{copy, events, guard, legacy_task_events, placement},
    sequencer::types::{CommandCommit, CommandOutcome, EventToWrite, RoomOwnerPrecondition},
};
use tokio::sync::oneshot;

const INDEXES: [&str; 10] = [
    "wiki_pages",
    "wiki_revisions",
    "forum_posts",
    "incidents",
    "gallery_works",
    "gallery_feedback",
    "project_tasks",
    "project_task_history",
    "project_runs",
    "project_workers",
];

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0xA6; 32]));
    config.allow_init = true;
    config
}

fn command(
    events: Vec<EventToWrite>,
    condition: Option<RoomOwnerPrecondition>,
) -> (CommandCommit, oneshot::Receiver<Result<CommandOutcome>>) {
    let (response_tx, response_rx) = oneshot::channel();
    (
        CommandCommit {
            caller_user_id: 1,
            caller_device_id: "workspace-admission-test".into(),
            command_name: "workspace_admission_test".into(),
            idempotency_key: None,
            room_owner_precondition: condition,
            events,
            essential: true,
            response_tx,
        },
        response_rx,
    )
}

async fn place(engine: &WabiDbEngine, room: &str, owner: &str, epoch: u64) {
    let event = placement(room, owner, epoch);
    engine
        .get_or_create_stream_key(&event.stream_id)
        .await
        .unwrap();
    engine
        .run_command(command(vec![event], None).0)
        .await
        .unwrap();
}

fn entries(dir: &std::path::Path) -> usize {
    crate::commit_index::batcher::read_all_entries(&dir.join("global/commit-index"))
        .unwrap()
        .len()
}

fn rows(state: &ProjectionState) -> Vec<(String, Vec<u8>, Vec<u8>)> {
    let mut rows = Vec::new();
    for index in INDEXES {
        state.for_each(index, |key, value| {
            rows.push((index.into(), key.to_vec(), value.to_vec()))
        });
    }
    rows.sort();
    rows
}

fn assert_refused(error: WabiError) {
    assert!(
        matches!(error, WabiError::Validation { command, .. } if command == "room_owner_precondition")
    );
}

#[tokio::test]
async fn all_workspace_events_refuse_raw_remote_and_unrelated_admission_without_commits() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    for room in ["ch_local", "ch_remote"] {
        engine.get_or_create_stream_key(room).await.unwrap();
    }
    place(&engine, "ch_local", "site-a", 1).await;
    place(&engine, "ch_remote", "site-b", 1).await;
    let before = engine.barrier().current();
    let count = entries(dir.path());
    let initial = rows(&engine.projection_state());
    for event in events("ch_remote")
        .into_iter()
        .chain(legacy_task_events("ch_remote"))
    {
        let mut remote = guard("ch_remote");
        remote.owner_node_id = "site-b".into();
        for condition in [None, Some(remote), Some(guard("ch_local"))] {
            assert_refused(
                engine
                    .run_command(command(vec![copy(&event)], condition).0)
                    .await
                    .unwrap_err(),
            );
        }
        // A valid local condition and matching local stream cannot conceal
        // a foreign room embedded in the workspace payload.
        let mut disguised = copy(&event);
        disguised.stream_id = "ch_local".into();
        assert_refused(
            engine
                .run_command(command(vec![disguised], Some(guard("ch_local"))).0)
                .await
                .unwrap_err(),
        );
        assert_eq!(engine.barrier().current(), before);
        assert_eq!(entries(dir.path()), count);
        assert_eq!(rows(&engine.projection_state()), initial);
    }
    for event in events("ch_local")
        .into_iter()
        .chain(legacy_task_events("ch_local"))
    {
        let mut malformed = copy(&event);
        malformed.plaintext.clear();
        let mut snapshot = copy(&event);
        snapshot.record_kind = RecordKind::Snapshot;
        let mut wrong_kind = copy(&event);
        wrong_kind.stream_kind = 1;
        for rejected in [malformed, snapshot, wrong_kind] {
            assert_refused(
                engine
                    .run_command(command(vec![rejected], Some(guard("ch_local"))).0)
                    .await
                    .unwrap_err(),
            );
        }
    }
    assert_eq!(engine.barrier().current(), before);
    assert_eq!(entries(dir.path()), count);
    assert_eq!(rows(&engine.projection_state()), initial);
    assert!(engine.is_healthy());
}

#[tokio::test]
async fn all_workspace_events_accept_local_and_legacy_writes_and_replay_same_state() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    for room in ["ch_local", "ch_legacy"] {
        engine.get_or_create_stream_key(room).await.unwrap();
    }
    place(&engine, "ch_local", "site-a", 1).await;
    for (room, condition) in [("ch_local", Some(guard("ch_local"))), ("ch_legacy", None)] {
        for event in events(room).into_iter().chain(legacy_task_events(room)) {
            engine
                .run_command(command(vec![event], condition.clone()).0)
                .await
                .unwrap();
        }
    }
    let before = engine.barrier().current();
    let expected = rows(&engine.projection_state());
    assert_eq!(entries(dir.path()), 51); // One placement plus 2 × (23 events + 2 legacy task encodings).
    for index in INDEXES {
        assert!(engine.projection_state().index_len(index) >= 2, "{index}");
    }
    assert!(engine.is_healthy());
    drop(engine);
    let stopped = crate::tests::wait_for_stopped_engine(dir.path()).await;
    ProjectionState::remove_snapshot(dir.path());
    drop(stopped);
    let reopened = crate::tests::reopen_after_drop(config(dir.path()), Some("site-a"))
        .await
        .unwrap();
    assert_eq!(reopened.barrier().current(), before);
    assert_eq!(rows(&reopened.projection_state()), expected);
    assert_eq!(entries(dir.path()), 51);
    assert!(reopened.is_healthy());
}

#[tokio::test]
async fn queued_workspace_writes_recheck_the_earlier_applied_placement() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    engine.get_or_create_stream_key("ch_a").await.unwrap();
    place(&engine, "ch_a", "site-a", 1).await;
    let sender = engine.sequencer().unwrap().sender().clone();
    let (move_owner, move_rx) = command(vec![placement("ch_a", "site-b", 2)], None);
    let (stale, stale_rx) = command(vec![events("ch_a").remove(0)], Some(guard("ch_a")));
    let (unguarded, unguarded_rx) = command(vec![events("ch_a").remove(0)], None);
    // No yield: placement isolation must make both following writes observe
    // its complete application, whether they enter the same receive window.
    sender.try_send(move_owner).unwrap();
    sender.try_send(stale).unwrap();
    sender.try_send(unguarded).unwrap();
    let moved = move_rx.await.unwrap().unwrap();
    assert_refused(stale_rx.await.unwrap().unwrap_err());
    assert_refused(unguarded_rx.await.unwrap().unwrap_err());
    assert_eq!(engine.barrier().current(), moved.commit_seq);
    assert_eq!(entries(dir.path()), 2);
    assert!(rows(&engine.projection_state()).is_empty());
    place(&engine, "ch_a", "site-a", 3).await;
    let mut current = guard("ch_a");
    current.expected_epoch = Some(3);
    engine
        .run_command(command(vec![events("ch_a").remove(0)], Some(current)).0)
        .await
        .unwrap();
    assert_eq!(entries(dir.path()), 4);
    assert_eq!(engine.projection_state().index_len("wiki_pages"), 1);
    assert!(engine.is_healthy());
}

#[tokio::test]
async fn mixed_placement_and_workspace_writes_are_refused_as_whole_commands() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open_with_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    engine.get_or_create_stream_key("ch_a").await.unwrap();
    engine
        .get_or_create_stream_key(&placement("ch_a", "site-a", 1).stream_id)
        .await
        .unwrap();
    for event in events("ch_a") {
        for mixed in [
            vec![placement("ch_a", "site-a", 1), copy(&event)],
            vec![event, placement("ch_a", "site-a", 1)],
        ] {
            assert_refused(
                engine
                    .run_command(command(mixed, None).0)
                    .await
                    .unwrap_err(),
            );
        }
    }
    engine.get_or_create_stream_key("ch_b").await.unwrap();
    let mut unplaced = guard("ch_a");
    unplaced.expected_epoch = None;
    for event in events("ch_b") {
        // The first event has a valid unplaced local condition. The second
        // room cannot inherit it, and neither event may reach durability.
        let mixed = vec![events("ch_a").remove(0), event];
        assert_refused(
            engine
                .run_command(command(mixed, Some(unplaced.clone())).0)
                .await
                .unwrap_err(),
        );
    }
    assert_eq!(entries(dir.path()), 0);
    assert_eq!(engine.barrier().current(), 0);
    assert!(rows(&engine.projection_state()).is_empty());
    assert_eq!(engine.projection_state().index_len("room_placements"), 0);
    assert!(engine.is_healthy());
}
