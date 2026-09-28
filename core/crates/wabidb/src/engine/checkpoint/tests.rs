use super::*;
use crate::{format::record::RecordKind, sequencer::types::EventToWrite};
use std::{future::Future, task::Poll};
use tokio::sync::oneshot;

#[tokio::test]
async fn an_inactive_live_checkpoint_marker_alone_refuses_local_commits() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(LIVE_CHECKPOINT_MARKER), b"inactive").unwrap();
    let engine = open_engine(dir.path()).await;
    assert!(engine.local_writer_fenced().await);
    assert!(!engine.durable_writer_fenced());
    let (command, _) = command(b"must-not-commit");
    assert!(engine.run_command(command).await.is_err());
    assert_eq!(engine.barrier().current(), 0);
}

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0xC4; 32]));
    config.allow_init = true;
    config
}

fn command(payload: &[u8]) -> (CommandCommit, oneshot::Receiver<Result<CommandOutcome>>) {
    let (response_tx, response_rx) = oneshot::channel();
    (
        CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 1,
            caller_device_id: "checkpoint-fixture".into(),
            command_name: "checkpoint_fixture".into(),
            idempotency_key: None,
            essential: true,
            response_tx,
            events: vec![EventToWrite {
                stream_id: "checkpoint-fixture".into(),
                stream_kind: 1,
                event_type: "checkpoint_fixture_event".into(),
                record_kind: RecordKind::Event,
                plaintext: payload.to_vec(),
            }],
        },
        response_rx,
    )
}

async fn open_engine(path: &std::path::Path) -> Arc<WabiDbEngine> {
    let engine = Arc::new(WabiDbEngine::open(config(path)).await.unwrap());
    engine
        .get_or_create_stream_key("checkpoint-fixture")
        .await
        .unwrap();
    engine
}

#[tokio::test]
async fn pause_drains_a_commit_window_and_holds_the_next_window_until_release() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open_engine(dir.path()).await;
    let keys = engine.key_registry.lock().await;
    let (first, first_rx) = command(b"before-boundary");
    engine
        .sequencer()
        .unwrap()
        .sender()
        .try_send(first)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while engine.write_fence.try_write().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut pause = Box::pin(engine.pause_for_checkpoint());
    std::future::poll_fn(|cx| {
        assert!(pause.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    let (next, mut next_rx) = command(b"after-boundary");
    engine.sequencer().unwrap().sender().try_send(next).unwrap();
    drop(keys);
    let first = first_rx.await.unwrap().unwrap();
    let paused = pause.await.unwrap();
    assert_eq!(paused.applied_seq(), first.commit_seq);
    let entries =
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap();
    assert_eq!(
        paused.prefix_fingerprint(),
        crate::replication::commit_prefix_fingerprint(&entries, first.commit_seq)
    );
    assert!(matches!(
        next_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    paused
        .with_projection_checkpoint(|| {
            let (snapshot, watermark) =
                ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
            assert_eq!(watermark, first.commit_seq);
            assert_eq!(
                snapshot.get("events", b"checkpoint_fixture_event"),
                Some(b"before-boundary".to_vec())
            );
            Ok(())
        })
        .unwrap();
    assert!(!dir.path().join(WRITER_FENCE_MARKER).exists());
    drop(paused);
    assert!(next_rx.await.unwrap().unwrap().commit_seq > first.commit_seq);
    assert!(!engine.local_writer_fenced().await);
}

#[tokio::test]
async fn cancelling_a_waiting_engine_pause_restores_both_mutation_paths() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open_engine(dir.path()).await;
    let active = engine.write_fence.read().await;
    let mut pause = Box::pin(engine.pause_for_checkpoint());
    std::future::poll_fn(|cx| {
        assert!(pause.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(engine.replication_ingest.try_lock().is_err());
    drop(pause);
    assert!(engine.replication_ingest.try_lock().is_ok());
    drop(active);
    engine
        .run_command(command(b"still-writable").0)
        .await
        .unwrap();
    drop(engine.pause_for_checkpoint().await.unwrap());
}

#[tokio::test]
async fn paused_guard_keeps_the_engine_and_its_process_lock_alive() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open_engine(dir.path()).await;
    let weak = Arc::downgrade(&engine);
    let paused = engine.pause_for_checkpoint().await.unwrap();
    drop(engine);
    assert!(weak.upgrade().is_some());
    assert!(dir.path().join(".lock").exists());
    paused.with_projection_checkpoint(|| Ok(())).unwrap();
    drop(paused);
    assert!(weak.upgrade().is_none());
    assert!(!dir.path().join(".lock").exists());
    let reopened = open_engine(dir.path()).await;
    assert_eq!(reopened.barrier().current(), 0);
}

#[tokio::test]
async fn failed_application_cannot_replace_the_last_good_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open_engine(dir.path()).await;
    engine.run_command(command(b"healthy").0).await.unwrap();
    engine.projection_state.save_snapshot(dir.path()).unwrap();
    let before = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();
    let mut invalid = command(b"").0;
    invalid.events[0].event_type = "user_registered".into();
    assert!(engine.run_command(invalid).await.is_err());
    assert!(engine.pause_for_checkpoint().await.is_err());
    assert_eq!(
        std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap(),
        before
    );
}

#[tokio::test]
async fn an_applied_position_without_its_index_prefix_refuses_a_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open_engine(dir.path()).await;
    engine.barrier.advance(99).unwrap();
    assert!(matches!(engine.pause_for_checkpoint().await,
        Err(WabiError::Validation { command, .. }) if command == "checkpoint_boundary"));
}

#[tokio::test]
async fn pause_blocks_valid_inbound_replication_without_changing_the_receiver_fence() {
    let source_dir = tempfile::tempdir().unwrap();
    let source = open_engine(source_dir.path()).await;
    source
        .run_command(command(b"replicated-after-release").0)
        .await
        .unwrap();
    let entry = crate::commit_index::batcher::read_all_entries(
        &source_dir.path().join("global/commit-index"),
    )
    .unwrap()
    .remove(0);
    let relative = "streams/channel/checkpoint-fixture/events/00000001.wseg";
    let bytes = std::fs::read(source_dir.path().join(relative)).unwrap();
    let replica_dir = tempfile::tempdir().unwrap();
    std::fs::write(replica_dir.path().join(WRITER_FENCE_MARKER), b"fenced\n").unwrap();
    let replica = open_engine(replica_dir.path()).await;
    let paused = replica.pause_for_checkpoint().await.unwrap();
    let receiver = replica.clone();
    let incoming = tokio::spawn(async move {
        receiver
            .ingest_replicated_commit(entry, vec![("checkpoint-fixture".into(), 1, 1, bytes)])
            .await
    });
    assert!(replica.replication_ingest.try_lock().is_err());
    assert_eq!(replica.barrier.current(), 0);
    assert!(!replica_dir.path().join(relative).exists());
    assert!(replica.durable_writer_fenced());
    drop(paused);
    incoming.await.unwrap().unwrap();
    assert_eq!(replica.barrier.current(), source.barrier.current());
    assert_eq!(
        replica
            .projection_state
            .get("events", b"checkpoint_fixture_event"),
        Some(b"replicated-after-release".to_vec())
    );
    assert!(replica.local_writer_fenced().await);
}
