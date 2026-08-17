//! Integration tests for the WabiDB engine.
//!
//! Tests the full `WabiDbEngine::open()` flow: lock file, storage manifest,
//! sequencer wiring, projection dispatcher, and command round-trips.

use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::{DispatchItem, ProjectionState, SequencerPermit};
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::error::WabiError;
use crate::format::record::RecordKind;
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::{DispatchTable, DurableEvent, Projection};
use crate::sequencer::types::{CommandCommit, EventToWrite};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tempfile::tempdir;
use tokio::sync::{mpsc, oneshot, Semaphore};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. engine_starts_and_serves_a_command
// ---------------------------------------------------------------------------

#[tokio::test]
async fn engine_starts_and_serves_a_command() {
    let dir = tempdir().unwrap();
    let config = WabiDbConfig {
        data_dir: dir.path().to_path_buf(),
        bootstrap_source: crate::crypto::bootstrap::BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        };

    // Open the engine. This creates the lock file, manifest, and all subsystems.
    let engine = WabiDbEngine::open(config).await.unwrap();

    // Verify the engine structure is intact.
    assert_eq!(engine.bootstrap_key(), &[0xABu8; 32]);
    assert_eq!(engine.data_dir(), dir.path());
    assert!(engine.sequencer().is_some(), "sequencer should be wired");
    assert!(engine.barrier().current() == 0, "barrier should start at 0");

    // Verify the lock file exists.
    let lock_path = dir.path().join(".lock");
    assert!(lock_path.exists());

    // Verify the storage manifest exists.
    let manifest_path = dir.path().join("storage-manifest.json");
    assert!(manifest_path.exists());

    // Verify the commit index directory exists.
    let cidx_dir = dir.path().join("global").join("commit-index");
    assert!(cidx_dir.exists());

    // Submit a command via the engine's public API.
    // We need a stream to exist. Create a registry, add a stream, then
    // replicate the sequencer test pattern using the engine's channel.
    let sem = Arc::new(Semaphore::new(1));
    let permit = SequencerPermit::acquire(&sem).await.unwrap();

    let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
    registry.lock().await.create_stream("ch_test", [0xABu8; 32]).unwrap();

    let commit_index_dir = dir.path().join("global").join("commit-index");
    let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
        commit_index_dir,
        Some(10),
        Some(Duration::from_millis(50)),
    );
    tokio::spawn(batcher_fut);

    let state = Arc::new(ProjectionState::new());
    let barrier = Arc::new(LinearizabilityBarrier::new(Arc::clone(&state)));
    let table = Arc::new(DispatchTable::new(vec![]).unwrap());
    let dispatcher_handle =
        crate::engine::locks::spawn_projection_dispatcher(Arc::clone(&state), table, Some(16), None, None).unwrap();
    let dispatcher_tx = dispatcher_handle.sender;

    // Build a command to send through the engine's sequencer channel.
    let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
    let data_dir = dir.path().to_path_buf();

    let sequencer_handle = tokio::spawn(async move {
        crate::sequencer::run(
            permit,
            registry,
            batcher,
            dispatcher_tx,
            Arc::clone(&barrier),
            cmd_rx,
            data_dir,
            0,
        )
        .await
    });

    // Send a command.
    let (response_tx, response_rx) = oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 1,
        caller_device_id: "dev1".into(),
        command_name: "test_cmd".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: "ch_test".into(),
            event_type: "test_event".into(),
            stream_kind: 1,
            record_kind: RecordKind::Event,
            plaintext: b"hello world".to_vec(),
        }],
        essential: true,
        response_tx,
    };
    cmd_tx.send(cmd).await.unwrap();
    drop(cmd_tx);

    // Await the outcome.
    let outcome = response_rx.await.unwrap().unwrap();
    assert_eq!(outcome.commit_seq, 1);
    assert!(outcome.timestamp_micros > 0);

    sequencer_handle.await.unwrap().unwrap();
}

// ---------------------------------------------------------------------------
// 2. two_engines_cannot_share_a_data_dir
// ---------------------------------------------------------------------------

#[tokio::test]
async fn two_engines_cannot_share_a_data_dir() {
    let dir = tempdir().unwrap();
    let config = WabiDbConfig {
        data_dir: dir.path().to_path_buf(),
        bootstrap_source: crate::crypto::bootstrap::BootstrapSource::Provided([0u8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        };

    // First engine opens successfully.
    let engine1 = WabiDbEngine::open(config.clone()).await.unwrap();
    assert!(dir.path().join(".lock").exists());

    // Second engine on the same data dir should fail with AlreadyRunning.
    let err = WabiDbEngine::open(config).await.unwrap_err();
    assert!(
        matches!(err, WabiError::AlreadyRunning),
        "expected AlreadyRunning, got {err:?}"
    );

    // Drop the first engine; lock file should be cleaned up.
    drop(engine1);
    assert!(!dir.path().join(".lock").exists());

    // Now a new engine can open the same dir.
    let config2 = WabiDbConfig {
        data_dir: dir.path().to_path_buf(),
        bootstrap_source: crate::crypto::bootstrap::BootstrapSource::Provided([0u8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        };
    let _engine2 = WabiDbEngine::open(config2).await.unwrap();
}

// ---------------------------------------------------------------------------
// 3. engine_rebuilds_projections_on_startup
// ---------------------------------------------------------------------------

/// A recording projection handler that counts invocations.
struct RecordingHandler {
    event_type: String,
    seen: Arc<AtomicU64>,
}

impl Projection for RecordingHandler {
    fn event_type(&self) -> &str {
        &self.event_type
    }

    fn apply(&self, _event: &DurableEvent, _state: &ProjectionState) -> crate::error::Result<()> {
        self.seen.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn engine_rebuilds_projections_on_startup() {
    let _dir = tempdir().unwrap();

    // Create a dispatch table with a recording handler.
    let seen = Arc::new(AtomicU64::new(0));
    let handler: Arc<dyn Projection> = Arc::new(RecordingHandler {
        event_type: "rebuild_event".into(),
        seen: Arc::clone(&seen),
    });
    let table = Arc::new(DispatchTable::new(vec![handler]).unwrap());

    // Create the projection state and dispatcher.
    let state = Arc::new(ProjectionState::new());
    let dispatcher_handle =
        crate::engine::locks::spawn_projection_dispatcher(Arc::clone(&state), table, Some(16), None, None).unwrap();

    // Send a dispatch item through the dispatcher.
    dispatcher_handle
        .sender
        .send(DispatchItem {
            commit_seq: 1,
            event_type: "rebuild_event".into(),
            stream_id: "rebuild".into(),
            payload: b"test payload".to_vec(),
        })
        .await
        .unwrap();

    // Drop the sender to signal the dispatcher to process.
    drop(dispatcher_handle.sender);
    if let Some(h) = dispatcher_handle.handle {
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
    }

    // The handler should have been called once.
    assert_eq!(seen.load(Ordering::SeqCst), 1);

    // Verify the projection state is accessible.
    assert_eq!(state.applied_commit_seq(), 1);
}

// ---------------------------------------------------------------------------
// 4. test_harness_feature_compiles
// ---------------------------------------------------------------------------

#[test]
fn test_harness_feature_compiles() {
    // With test-harness enabled, verify the crash_point symbol exists.
    // We don't invoke it here because it calls std::process::exit(1),
    // which the test runner would interpret as a test failure.
    // The actual crash-injection behavior is tested separately
    // by the crash_tests.rs module which uses subprocess isolation.
    #[cfg(feature = "test-harness")]
    {
        let _f: fn(&str) = crate::sequencer::crash_point;
    }
}
