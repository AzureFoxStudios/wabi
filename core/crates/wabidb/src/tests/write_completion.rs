//! Behavioral guarantees at the durable-command / projection boundary.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{oneshot, Notify};

use crate::engine::locks::{
    spawn_projection_dispatcher, DispatchCommit, DispatchItem, ProjectionState,
};
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::{DispatchTable, DurableEvent, Projection};
use crate::sequencer::types::{CommandCommit, EventToWrite};

fn config_at(path: &std::path::Path) -> WabiDbConfig {
    WabiDbConfig {
        data_dir: path.into(),
        bootstrap_source: crate::crypto::bootstrap::BootstrapSource::Provided([42; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        test_boot_wallclock_override: None,
    }
}

fn command(events: Vec<EventToWrite>) -> CommandCommit {
    CommandCommit {
        caller_user_id: 1,
        caller_device_id: "test".into(),
        command_name: "probe".into(),
        idempotency_key: None,
        essential: true,
        response_tx: oneshot::channel().0,
        events,
    }
}

fn write(stream: &str, payload: &[u8]) -> EventToWrite {
    EventToWrite {
        stream_id: stream.into(),
        stream_kind: 6,
        event_type: "probe".into(),
        record_kind: RecordKind::Event,
        plaintext: payload.to_vec(),
    }
}

fn event(seq: u64, stream: &str, payload: &[u8]) -> DispatchItem {
    DispatchItem {
        commit_seq: seq,
        event_type: "probe".into(),
        stream_id: stream.into(),
        payload: payload.to_vec(),
    }
}

fn commit(seq: u64, events: Vec<DispatchItem>) -> (DispatchCommit, oneshot::Receiver<Result<()>>) {
    let (applied_tx, rx) = oneshot::channel();
    (
        DispatchCommit {
            commit_seq: seq,
            events,
            applied_tx,
        },
        rx,
    )
}

struct Probe {
    entered: Arc<Notify>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl Projection for Probe {
    fn event_type(&self) -> &str {
        "probe"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.payload == b"block" {
            self.entered.notify_one();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        if event.payload == b"fail" {
            return Err(WabiError::Validation {
                command: "probe".into(),
                reason: "injected failure".into(),
            });
        }
        state.insert(
            "probe",
            event.stream_id.as_bytes().to_vec(),
            event.payload.clone(),
            event.commit_seq,
        );
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_event_commit_has_one_application_and_checkpoint_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(ProjectionState::new());
    let barrier = LinearizabilityBarrier::new(state.clone());
    let entered = Arc::new(Notify::new());
    let (release, blocked) = std::sync::mpsc::channel();
    let table = Arc::new(
        DispatchTable::new(vec![Arc::new(Probe {
            entered: entered.clone(),
            release: Mutex::new(blocked),
        })])
        .unwrap(),
    );
    let dispatcher = spawn_projection_dispatcher(
        state.clone(),
        table,
        Some(1),
        Some(dir.path().into()),
        Some(1),
    )
    .unwrap();
    let (batch, mut ack) = commit(
        1,
        vec![event(1, "first", b"written"), event(1, "last", b"block")],
    );
    dispatcher.sender.send(batch).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();

    assert!(state.get("probe", b"first").is_some());
    assert!(state.get("probe", b"last").is_none());
    assert_eq!(barrier.current(), 0);
    assert!(matches!(
        ack.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(!ProjectionState::snapshot_path(dir.path()).exists());

    let snapshot_state = state.clone();
    let snapshot_dir = dir.path().to_path_buf();
    let (snapshot_started, snapshot_running) = oneshot::channel();
    let mut snapshot = tokio::task::spawn_blocking(move || {
        snapshot_started.send(()).unwrap();
        snapshot_state.save_snapshot(&snapshot_dir)
    });
    snapshot_running.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut snapshot)
            .await
            .is_err()
    );

    // Exercise a waiter registered BEFORE application, with no manual advance.
    let wait = barrier.wait_for(1, Duration::from_secs(2));
    tokio::pin!(wait);
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut wait)
        .await
        .is_err());
    release.send(()).unwrap();
    ack.await.unwrap().unwrap();
    wait.await.unwrap();
    snapshot.await.unwrap().unwrap();
    assert!(state.get("probe", b"last").is_some());
    drop(dispatcher.sender);
    dispatcher.handle.unwrap().await.unwrap();
    let (snapshot, seq) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
    assert_eq!(seq, 1);
    assert!(snapshot.get("probe", b"first").is_some());
    assert!(snapshot.get("probe", b"last").is_some());
}

#[tokio::test]
async fn failed_apply_stops_the_prefix_and_preserves_the_last_good_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(ProjectionState::new());
    let (_, blocked) = std::sync::mpsc::channel();
    let table = Arc::new(
        DispatchTable::new(vec![Arc::new(Probe {
            entered: Arc::new(Notify::new()),
            release: Mutex::new(blocked),
        })])
        .unwrap(),
    );
    let dispatcher = spawn_projection_dispatcher(
        state.clone(),
        table,
        Some(3),
        Some(dir.path().into()),
        Some(1),
    )
    .unwrap();
    let (good, good_ack) = commit(1, vec![event(1, "good", b"good")]);
    let (bad, bad_ack) = commit(
        2,
        vec![event(2, "partial", b"written"), event(2, "bad", b"fail")],
    );
    let (later, later_ack) = commit(3, vec![event(3, "later", b"must not apply")]);
    dispatcher.sender.try_send(good).unwrap();
    dispatcher.sender.try_send(bad).unwrap();
    dispatcher.sender.try_send(later).unwrap();
    good_ack.await.unwrap().unwrap();
    let err = bad_ack.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("durable commit 2"));
    assert!(later_ack.await.is_err());
    dispatcher.handle.unwrap().await.unwrap();
    assert_eq!(state.applied_commit_seq(), 1);
    assert!(!state.is_healthy());
    assert!(state.get("probe", b"later").is_none());
    assert!(state.save_snapshot(dir.path()).is_err());
    let (snapshot, seq) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
    assert_eq!(seq, 1);
    assert!(snapshot.get("probe", b"partial").is_none());
}

#[tokio::test]
async fn lost_caller_and_empty_commit_do_not_lose_durable_work() {
    let state = Arc::new(ProjectionState::new());
    let barrier = LinearizabilityBarrier::new(state.clone());
    let dispatcher = spawn_projection_dispatcher(
        state.clone(),
        Arc::new(DispatchTable::new(vec![]).unwrap()),
        Some(2),
        None,
        None,
    )
    .unwrap();
    let (batch, ack) = commit(1, vec![event(1, "first", b"retained")]);
    drop(ack);
    dispatcher.sender.send(batch).await.unwrap();
    let (empty, ack) = commit(2, vec![]);
    dispatcher.sender.send(empty).await.unwrap();
    ack.await.unwrap().unwrap();
    assert_eq!(barrier.current(), 2);
    assert_eq!(state.get("events", b"probe"), Some(b"retained".to_vec()));
}

#[tokio::test]
async fn projection_failure_is_durable_but_never_successful_or_ready_on_restart() {
    let dir = tempfile::tempdir().unwrap();
    let config = || WabiDbConfig {
        data_dir: dir.path().into(),
        bootstrap_source: crate::crypto::bootstrap::BootstrapSource::Provided([42; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        test_boot_wallclock_override: None,
    };
    let engine = WabiDbEngine::open(config()).await.unwrap();
    engine.get_or_create_stream_key("bad").await.unwrap();
    let command = || CommandCommit {
        caller_user_id: 1,
        caller_device_id: "test".into(),
        command_name: "invalid-event".into(),
        idempotency_key: None,
        essential: true,
        response_tx: oneshot::channel().0,
        events: vec![EventToWrite {
            stream_id: "bad".into(),
            stream_kind: 6,
            event_type: "user_registered".into(),
            record_kind: RecordKind::Event,
            plaintext: vec![],
        }],
    };
    assert!(engine.is_healthy());
    assert!(engine.run_command(command()).await.is_err());
    assert!(!engine.is_healthy());
    assert!(engine.run_command(command()).await.is_err());
    assert_eq!(engine.barrier().current(), 0);
    assert_eq!(
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        1
    );
    drop(engine);
    assert!(!ProjectionState::snapshot_path(dir.path()).exists());
    // A bad durable record must not turn into success merely by restarting.
    for _ in 0..2 {
        let error = WabiDbEngine::open(config()).await.unwrap_err();
        assert!(error.to_string().contains("replay failed"), "{error}");
        assert!(
            !dir.path().join(".lock").exists(),
            "failed open leaked its lock"
        );
    }
}

#[tokio::test]
async fn restart_preserves_event_order_within_a_multi_stream_commit() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    engine.get_or_create_stream_key("a").await.unwrap();
    engine.get_or_create_stream_key("z").await.unwrap();
    for (first, last) in [("a", "z"), ("z", "a")] {
        engine
            .run_command(command(vec![
                write(first, b"before"),
                write(last, b"after"),
            ]))
            .await
            .unwrap();
        assert_eq!(
            engine.projection_state().get("events", b"probe"),
            Some(b"after".to_vec())
        );
    }
    drop(engine);
    ProjectionState::remove_snapshot(dir.path()); // force event-log replay
    let reopened = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    assert_eq!(
        reopened.projection_state().get("events", b"probe"),
        Some(b"after".to_vec())
    );
}

#[tokio::test]
async fn missing_indexed_event_refuses_startup_instead_of_restoring_partial_commit() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    engine.get_or_create_stream_key("a").await.unwrap();
    engine.get_or_create_stream_key("b").await.unwrap();
    engine
        .run_command(command(vec![write("a", b"first"), write("b", b"second")]))
        .await
        .unwrap();
    drop(engine);
    ProjectionState::remove_snapshot(dir.path());
    // Fault injection against this test's temporary segment only.
    std::fs::remove_file(dir.path().join("streams/other/b/events/00000001.wseg")).unwrap();
    let error = WabiDbEngine::open(config_at(dir.path())).await.unwrap_err();
    assert!(
        error.to_string().contains("not all indexed events"),
        "{error}"
    );
}

#[tokio::test]
async fn restart_accepts_shared_streams_used_by_different_workspace_surfaces() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    engine.get_or_create_stream_key("channel").await.unwrap();
    // Chat and workspace adapters can use the same channel ID with different
    // stream kinds. The existing writer cache is keyed by stream ID, so the
    // second reference can name a kind different from the physical directory.
    let mut chat = write("channel", b"chat");
    chat.stream_kind = 1;
    engine.run_command(command(vec![chat])).await.unwrap();
    engine
        .run_command(command(vec![write("channel", b"workspace")]))
        .await
        .unwrap();
    drop(engine);
    ProjectionState::remove_snapshot(dir.path());
    let reopened = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    assert_eq!(
        reopened.projection_state().get("events", b"probe"),
        Some(b"workspace".to_vec())
    );
    assert_eq!(reopened.barrier().current(), 2);
}

#[tokio::test]
async fn same_stream_multi_event_command_is_rejected_before_nonce_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    engine.get_or_create_stream_key("a").await.unwrap();
    let error = engine
        .run_command(command(vec![write("a", b"first"), write("a", b"second")]))
        .await
        .unwrap_err();
    assert!(matches!(error, WabiError::Validation { .. }));
    assert!(crate::commit_index::batcher::read_all_entries(
        &dir.path().join("global/commit-index")
    )
    .unwrap()
    .is_empty());
    assert!(!dir.path().join("streams/other/a/events").exists());
    let good = engine
        .run_command(command(vec![write("a", b"valid")]))
        .await
        .unwrap();
    assert_eq!(good.commit_seq, 2); // rejected seq is burned
    assert!(engine.is_healthy());
}

#[tokio::test]
async fn first_uncommitted_write_is_not_resurrected_and_its_nonce_is_not_reused() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    engine.get_or_create_stream_key("a").await.unwrap();
    // The first stream is written; the second has no key, so no index entry
    // is submitted. This produces a real orphan without mutating disk fixtures.
    assert!(engine
        .run_command(command(vec![
            write("a", b"orphan"),
            write("missing-key", b"never written")
        ]))
        .await
        .is_err());
    assert!(crate::commit_index::batcher::read_all_entries(
        &dir.path().join("global/commit-index")
    )
    .unwrap()
    .is_empty());
    drop(engine);
    let reopened = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
    assert_eq!(reopened.projection_state().get("events", b"probe"), None);
    assert_eq!(reopened.barrier().current(), 0);
    reopened.get_or_create_stream_key("a").await.unwrap();
    let good = reopened
        .run_command(command(vec![write("a", b"committed")]))
        .await
        .unwrap();
    assert_eq!(good.commit_seq, 2);
}

#[cfg(feature = "test-harness")]
#[tokio::test]
async fn completion_crash_child() {
    let Some(path) = std::env::var_os("WABI_COMPLETION_CRASH_DIR") else {
        return;
    };
    let engine = WabiDbEngine::open(config_at(std::path::Path::new(&path)))
        .await
        .unwrap();
    for stream in ["a", "b"] {
        engine.get_or_create_stream_key(stream).await.unwrap();
    }
    engine
        .run_command(command(vec![write("a", b"first"), write("b", b"last")]))
        .await
        .unwrap();
    panic!("crash boundary did not fire");
}

#[cfg(feature = "test-harness")]
#[tokio::test]
async fn process_crashes_recover_only_complete_indexed_commands() {
    for (boundary, committed, next_seq) in [
        ("crash_before_any_write", false, 1),
        ("crash_mid_stream_write", false, 2),
        ("crash_before_index_fsync", false, 2),
        ("crash_after_index_fsync", true, 2),
        ("crash_after_projection_update", true, 2),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::write_completion::completion_crash_child",
                "--nocapture",
            ])
            .env("WABI_COMPLETION_CRASH_DIR", dir.path())
            .env("WABIDB_CRASH_AT", boundary)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(1),
            "{boundary}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!ProjectionState::snapshot_path(dir.path()).exists());
        // Open must reclaim the dead child's engine lock without manual removal.
        let engine = WabiDbEngine::open(config_at(dir.path())).await.unwrap();
        assert_eq!(
            engine.projection_state().get("events", b"probe"),
            committed.then(|| b"last".to_vec()),
            "{boundary}"
        );
        assert_eq!(
            engine.barrier().current(),
            u64::from(committed),
            "{boundary}"
        );
        let entries =
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap();
        assert_eq!(entries.len(), usize::from(committed), "{boundary}");
        if committed {
            assert_eq!(entries[0].event_refs.len(), 2);
        }
        engine.get_or_create_stream_key("a").await.unwrap();
        let next = engine
            .run_command(command(vec![write("a", b"next")]))
            .await
            .unwrap();
        assert_eq!(next.commit_seq, next_seq, "{boundary}");
    }
}
