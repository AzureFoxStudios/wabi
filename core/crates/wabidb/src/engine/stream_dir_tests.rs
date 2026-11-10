//! Stream directory naming across platforms (Task 1.0j).
//!
//! Windows forbids `:` in file names, so a stream like `community-roster:v1`
//! is stored under an encoded directory name on new trees. Existing Linux
//! trees already hold the raw name and must keep replaying byte for byte,
//! and a stream must never be split between its raw and encoded directory.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::crypto::bootstrap::BootstrapSource;
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::ProjectionState;
use crate::engine::replay::replay_projections;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::error::Result;
use crate::format::record::RecordKind;
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::{DispatchTable, DurableEvent, Projection};
use crate::sequencer::types::{CommandCommit, EventToWrite};

const BOOTSTRAP: [u8; 32] = [0x5Au8; 32];
const ROSTER: &str = "community-roster:v1";
/// Percent-encoded form of `ROSTER` (`:` is 0x3A).
const ROSTER_ENCODED: &str = "community-roster%3Av1";
/// `stream_kind_dir_name(6)`.
const KIND: u8 = 6;
const KIND_DIR: &str = "other";

fn config(path: &Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.to_path_buf(), BootstrapSource::Provided(BOOTSTRAP));
    config.allow_init = true;
    config
}

/// A dropped engine keeps the advisory lock until its workers drain. Retry
/// only while that lock is still held; any other open error is a failure.
async fn open(path: &Path) -> WabiDbEngine {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match WabiDbEngine::open(config(path)).await {
            Ok(engine) => return engine,
            Err(error) if tokio::time::Instant::now() < deadline
                && error.to_string().to_lowercase().contains("lock") =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => panic!("engine open failed: {error}"),
        }
    }
}

async fn append(engine: &WabiDbEngine, payload: &[u8]) {
    engine.get_or_create_stream_key(ROSTER).await.unwrap();
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 1,
            caller_device_id: "stream-dir-device".into(),
            command_name: "stream_dir_probe".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: ROSTER.into(),
                event_type: "stream_dir_probe_event".into(),
                stream_kind: KIND,
                record_kind: RecordKind::Event,
                plaintext: payload.to_vec(),
            }],
            essential: true,
            response_tx,
        })
        .await
        .unwrap();
}

fn kind_dir(data: &Path) -> PathBuf {
    data.join("streams").join(KIND_DIR)
}

/// Every directory name under `streams/other/`, sorted.
fn stream_dir_names(data: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(kind_dir(data))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn segment_count(stream_dir: &Path) -> usize {
    std::fs::read_dir(stream_dir.join("events"))
        .unwrap()
        .filter(|entry| {
            entry.as_ref().unwrap().path().extension() == Some(std::ffi::OsStr::new("wseg"))
        })
        .count()
}

/// The key every reader must derive for `stream_id` (engine/replay.rs).
fn derived_key(stream_id: &str) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"wabi-stream-key-v1");
    hasher.update(stream_id.as_bytes());
    hasher.update(&BOOTSTRAP);
    *hasher.finalize().as_bytes()
}

struct Recorder(Mutex<Vec<(u64, String, Vec<u8>)>>);

impl Projection for Recorder {
    fn event_type(&self) -> &str {
        "stream_dir_probe_event"
    }

    fn apply(&self, event: &DurableEvent, _state: &ProjectionState) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .push((event.commit_seq, event.stream_id.clone(), event.payload.clone()));
        Ok(())
    }
}

/// Replay `data` from scratch; return (commit_seq, stream_id, payload) in
/// application order, and the key the registry derived for `ROSTER`.
async fn replay(data: &Path) -> (Vec<(u64, String, Vec<u8>)>, [u8; 32]) {
    let state = Arc::new(ProjectionState::new());
    let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
    let table = DispatchTable::new(vec![recorder.clone()]).unwrap();
    let registry = tokio::sync::Mutex::new(StreamKeyRegistry::new());
    let barrier = LinearizabilityBarrier::new(state.clone());
    replay_projections(data, &registry, &BOOTSTRAP, &state, &table, &barrier, 0)
        .await
        .unwrap();
    let key = registry
        .lock()
        .await
        .get_active_key(ROSTER, u64::MAX)
        .unwrap()
        .key_material;
    let events = recorder.0.lock().unwrap().clone();
    (events, key)
}

/// Build a tree exactly as a pre-1.0j Linux Authority left it: the stream
/// directory carries the raw id, colon included. The segment and index
/// bytes do not depend on the directory name, so writing through the engine
/// and renaming an encoded directory (if this build produced one) to the
/// raw name gives the same on-disk state the old code wrote.
async fn legacy_raw_fixture(data: &Path) {
    let engine = open(data).await;
    append(&engine, b"first").await;
    drop(engine);
    let encoded = kind_dir(data).join(ROSTER_ENCODED);
    if encoded.exists() {
        std::fs::rename(&encoded, kind_dir(data).join(ROSTER)).unwrap();
    }
    assert_eq!(stream_dir_names(data), vec![ROSTER.to_string()]);
}

/// Test (2): a raw `community-roster:v1` directory replays the same events,
/// in the same order, under the key derived from the raw stream id.
#[cfg(unix)]
#[tokio::test]
async fn legacy_raw_colon_directory_replays_with_raw_id_and_key() {
    let tmp = tempfile::tempdir().unwrap();
    legacy_raw_fixture(tmp.path()).await;

    let (events, key) = replay(tmp.path()).await;
    assert_eq!(events, vec![(1, ROSTER.to_string(), b"first".to_vec())]);
    assert_eq!(key, derived_key(ROSTER));
    // Replay reads; it never renames or migrates the legacy directory.
    assert_eq!(stream_dir_names(tmp.path()), vec![ROSTER.to_string()]);
}

/// Test (3): appending to a stream whose raw directory exists keeps writing
/// there. Both events replay in commit order from that one directory.
#[cfg(unix)]
#[tokio::test]
async fn append_to_legacy_raw_directory_never_splits_the_stream() {
    let tmp = tempfile::tempdir().unwrap();
    legacy_raw_fixture(tmp.path()).await;

    let engine = open(tmp.path()).await;
    append(&engine, b"second").await;
    drop(engine);

    assert_eq!(
        stream_dir_names(tmp.path()),
        vec![ROSTER.to_string()],
        "the append must reuse the raw directory, not create an encoded one"
    );
    assert_eq!(segment_count(&kind_dir(tmp.path()).join(ROSTER)), 2);

    // Reopen through the engine (startup replay) and replay independently.
    drop(open(tmp.path()).await);
    let (events, key) = replay(tmp.path()).await;
    assert_eq!(
        events,
        vec![
            (1, ROSTER.to_string(), b"first".to_vec()),
            (2, ROSTER.to_string(), b"second".to_vec()),
        ]
    );
    assert_eq!(key, derived_key(ROSTER));
}

/// Test (4): a fresh tree writes the Windows-safe encoded directory, and
/// replay maps it back to the original stream id and key.
#[tokio::test]
async fn fresh_tree_writes_encoded_directory_and_replays_it() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = open(tmp.path()).await;
    append(&engine, b"first").await;
    append(&engine, b"second").await;
    drop(engine);

    assert_eq!(stream_dir_names(tmp.path()), vec![ROSTER_ENCODED.to_string()]);

    drop(open(tmp.path()).await);
    let (events, key) = replay(tmp.path()).await;
    assert_eq!(
        events,
        vec![
            (1, ROSTER.to_string(), b"first".to_vec()),
            (2, ROSTER.to_string(), b"second".to_vec()),
        ]
    );
    assert_eq!(key, derived_key(ROSTER));
}

/// Replay registers the key of every stream directory it finds, even when a
/// snapshot already covers all its records, because later writes rely on
/// it. An encoded directory must register the decoded stream id's key.
#[tokio::test]
async fn encoded_directory_registers_decoded_key_when_snapshot_covers_records() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = open(tmp.path()).await;
    append(&engine, b"first").await;
    drop(engine);
    assert_eq!(stream_dir_names(tmp.path()), vec![ROSTER_ENCODED.to_string()]);

    let state = Arc::new(ProjectionState::new());
    let table = DispatchTable::new(vec![]).unwrap();
    let registry = tokio::sync::Mutex::new(StreamKeyRegistry::new());
    let barrier = LinearizabilityBarrier::new(state.clone());
    replay_projections(tmp.path(), &registry, &BOOTSTRAP, &state, &table, &barrier, 1)
        .await
        .unwrap();
    let registry = registry.lock().await;
    assert_eq!(
        registry.get_active_key(ROSTER, 2).unwrap().key_material,
        derived_key(ROSTER)
    );
}
