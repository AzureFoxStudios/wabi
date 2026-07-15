//! Commit sequencer — single global ordering point for all writes.
//!
//! See `docs/wabidb-kanban.md` card wabidb-15 and `docs/architecture/wabidb-council-reviews.md`
//! Council Review #1 §2.2-2.4 for the design rationale.
//!
//! ## Invariants (Council Review #1)
//!
//! 1. **Option B rollback (§2.2):** stream records written but not referenced
//!    by the commit index are orphans (allowed). The sequencer never physically
//!    truncates on partial failure.
//! 2. **Burned-seq never reused (§2.4):** a `commit_seq` assigned to a command
//!    whose writes fail is never reused.
//! 3. **Durability-await (§2.3):** `run_command` does not return `Ok` until the
//!    batch containing its `commit_seq` is fsync'd.

pub mod event_envelope;
pub mod run_command;
pub mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::commit_index::batcher::BatcherHandle;
use crate::commit_index::record::{CommitIndexEntry, StreamRef};
use crate::crypto::aes_gcm_record::{encrypt_record, TAG_LEN};
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::{DispatchItem, SequencerPermit};
pub use crate::sequencer::types::ReplayEnvelope;
use crate::error::{Result, WabiError};
use crate::format::record::RecordHeader;
use crate::projections::barrier::LinearizabilityBarrier;
use crate::stream_log::segment_writer::SegmentWriter;

pub use types::*;

// ---------------------------------------------------------------------------
// Stream kind → directory name mapping
// ---------------------------------------------------------------------------

pub fn stream_kind_dir_name(kind: u8) -> &'static str {
    match kind {
        1 => "channel",
        2 => "dm",
        3 => "whiteboard",
        4 => "place",
        5 => "kanban",
        _ => "other",
    }
}

/// Compute the events directory path for a given stream.
fn stream_events_dir(data_dir: &Path, stream_kind: u8, stream_id: &str) -> PathBuf {
    let kind_dir = stream_kind_dir_name(stream_kind);
    data_dir
        .join("streams")
        .join(kind_dir)
        .join(stream_id)
        .join("events")
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/// First 16 bytes of BLAKE3(stream_id).
fn stream_id_hash(stream_id: &str) -> [u8; 16] {
    let hash = blake3::hash(stream_id.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&hash.as_bytes()[..16]);
    out
}

/// First 16 bytes of BLAKE3(device_id).
fn device_id_hash(device_id: &str) -> [u8; 16] {
    let hash = blake3::hash(device_id.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&hash.as_bytes()[..16]);
    out
}

/// First 16 bytes of BLAKE3(name).
fn name_hash(name: &str) -> [u8; 16] {
    let hash = blake3::hash(name.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&hash.as_bytes()[..16]);
    out
}

/// Full BLAKE3 of `(user_id || device_id || client_request_id)` for idempotency.
fn idempotency_key_hash(caller_user_id: u64, caller_device_id: &str, client_request_id: &str) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&caller_user_id.to_le_bytes());
    hasher.update(caller_device_id.as_bytes());
    hasher.update(client_request_id.as_bytes());
    *hasher.finalize().as_bytes()
}

// ---------------------------------------------------------------------------
// Segment number from path
// ---------------------------------------------------------------------------

/// Extract the segment sequence number from a `.wseg` file path.
///
/// A path like `.../00000001.wseg` yields `1`.
fn segment_id_from_path(path: &Path) -> Result<u64> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| WabiError::InternalInvariantViolated {
            invariant: format!("segment path has no valid stem: {}", path.display()),
        })?;
    stem.parse::<u64>().map_err(|_| WabiError::InternalInvariantViolated {
        invariant: format!("segment stem is not a number: {stem}"),
    })
}

// ---------------------------------------------------------------------------
// Writer cache entry
// ---------------------------------------------------------------------------

struct WriterEntry {
    writer: SegmentWriter,
}

// ---------------------------------------------------------------------------
// Run — the sequencer's main event loop
// ---------------------------------------------------------------------------

/// Run the commit sequencer.
///
/// This function holds the [`SequencerPermit`] for its entire lifetime, ensuring
/// at most one sequencer exists in the system. It owns the [`StreamKeyRegistry`]
/// directly (not behind `Arc`). The registry is consulted (via `&self`) on every
/// write to retrieve the active encryption key for each stream.
///
/// The loop processes one `CommandCommit` at a time:
///
/// 1. Assign a monotonic `commit_seq` (burned on failure per §2.4).
/// 2. For each event: encrypt with the stream's key, write to the stream's
///    `.wseg` segment via [`SegmentWriter`], record a [`StreamRef`].
/// 3. Build a [`CommitIndexEntry`] and submit to the [`BatcherHandle`].
/// 4. Wait for the batcher to fsync the entry (durability-await, §2.3).
/// 5. Advance the [`LinearizabilityBarrier`] so readers see the new data.
/// 6. Send a [`DispatchItem`] to the projection dispatcher. If the
///    dispatcher's channel is full and the command is non-essential, reject
///    with `EngineBusy` instead of blocking.
/// 7. Send the result back via `response_tx`.
///
/// # Errors
///
/// The function returns an error only if the batcher future exits or the
/// command channel closes unexpectedly. Per-event failures are reported
/// through the command's `response_tx` and the loop continues.
pub async fn run(
    _permit: SequencerPermit,
    key_registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>>,
    batcher: BatcherHandle,
    dispatcher_tx: mpsc::Sender<DispatchItem>,
    barrier: Arc<LinearizabilityBarrier>,
    mut command_rx: mpsc::Receiver<CommandCommit>,
    data_dir: PathBuf,
) -> Result<()> {
    let mut writers: HashMap<String, WriterEntry> = HashMap::new();
    let mut next_commit_seq: u64 = 1;

    while let Some(command) = command_rx.recv().await {
        let commit_seq = next_commit_seq;
        next_commit_seq = commit_seq.checked_add(1).ok_or_else(|| {
            crate::error::WabiError::InternalInvariantViolated {
                invariant: "commit_seq overflow: 2^64 events committed".into(),
            }
        })?;

        let timestamp_micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;

        let result = process_command(
            &key_registry,
            &mut writers,
            &batcher,
            &dispatcher_tx,
            &barrier,
            &data_dir,
            &command,
            commit_seq,
            timestamp_micros,
        )
        .await;

        let _ = command.response_tx.send(result);
    }

    // Graceful shutdown: close all open writers.
    for (_stream_id, entry) in writers.drain() {
        let _ = entry.writer.close().await;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Process one command
// ---------------------------------------------------------------------------

async fn process_command(
    key_registry: &Arc<tokio::sync::Mutex<StreamKeyRegistry>>,
    writers: &mut HashMap<String, WriterEntry>,
    batcher: &BatcherHandle,
    dispatcher_tx: &mpsc::Sender<DispatchItem>,
    barrier: &LinearizabilityBarrier,
    data_dir: &Path,
    command: &CommandCommit,
    commit_seq: u64,
    timestamp_micros: i64,
) -> Result<CommandOutcome> {
    // --- 1. Encrypt and write each event to its stream segment ------------
    let mut event_refs: Vec<StreamRef> = Vec::with_capacity(command.events.len());
    let mut payload_hashes: Vec<[u8; 32]> = Vec::with_capacity(command.events.len());

    // Boundary 0: crash before any write (commit_seq assigned but nothing on disk).
    crash_point("crash_before_any_write");

    for event in &command.events {
        let stream_hash = stream_id_hash(&event.stream_id);

        // Get the encryption key for this stream at this commit_seq.
        let key = {
            let registry = key_registry.lock().await;
            registry.get_active_key(&event.stream_id, commit_seq)?.clone()
        };

        // Build the replay envelope: event_type + stream_id + payload.
        let envelope = serde_json::to_vec(&ReplayEnvelope {
            event_type: event.event_type.clone(),
            stream_id: event.stream_id.clone(),
            payload: event.plaintext.clone(),
        })
        .map_err(|e| WabiError::Validation {
            command: command.command_name.clone(),
            reason: format!("replay envelope serialization failed: {e}"),
        })?;

        // Payload length = envelope + GCM tag.
        let payload_len = envelope
            .len()
            .checked_add(TAG_LEN)
            .ok_or_else(|| WabiError::Validation {
                command: command.command_name.clone(),
                reason: "payload overflow with GCM tag".into(),
            })? as u32;

        // Build the record header (payload_crc32c = 0; GCM tag is the integrity check).
        let header =
            RecordHeader::new(event.record_kind, commit_seq, stream_hash, payload_len, 0);
        let header_bytes = header.encode();

        // Encrypt: returns ciphertext || gcm_tag.
        let ciphertext = encrypt_record(&key.key_material, commit_seq, &header_bytes, &envelope)?;

        // Compute BLAKE3 of the encrypted payload for the commit index.
        let payload_hash = blake3::hash(&ciphertext);
        payload_hashes.push(*payload_hash.as_bytes());

        // Get or create the segment writer for this stream.
        let events_dir = stream_events_dir(data_dir, event.stream_kind, &event.stream_id);
        let entry = get_or_create_writer(writers, &event.stream_id, &events_dir).await?;

        // Write the record.
        let offset = entry.writer.append(&header, &ciphertext).await?;

        // Record the StreamRef.
        let segment_id = segment_id_from_path(entry.writer.path())?;
        event_refs.push(StreamRef {
            stream_id_hash: stream_hash,
            stream_kind: event.stream_kind,
            segment_id,
            offset: offset as u32,
            length: header.total_size() as u32,
        });

        // Boundary 1: crash after this stream's segment is written but before
        // the next stream's segment (or before the commit index). Tests orphan
        // skip when a multi-stream command is partially committed.
        crash_point("crash_mid_stream_write");

        // Rotate segment if full.
        if entry.writer.is_full() {
            let closed = writers.remove(&event.stream_id);
            if let Some(entry) = closed {
                entry.writer.close().await?;
            }
        }
    }

    // --- 2. Build and submit the commit index entry -----------------------
    // Boundary 2: crash after all stream segments are written but before
    // the commit index entry is appended (tests Option B orphan skip).
    crash_point("crash_before_index_fsync");
    let caller_device_id_hash = device_id_hash(&command.caller_device_id);
    let command_name_hash = name_hash(&command.command_name);
    let idempotency_hash = command.idempotency_key.as_ref().map(|key| {
        idempotency_key_hash(command.caller_user_id, &command.caller_device_id, key)
    });

    let entry = CommitIndexEntry {
        commit_seq,
        timestamp_micros,
        caller_user_id: command.caller_user_id,
        caller_device_id_hash,
        command_name_hash,
        has_idempotency_key: command.idempotency_key.is_some(),
        idempotency_key_hash: idempotency_hash,
        event_refs,
        payload_hashes,
    };

    batcher.submit(entry)?;

    // Durability-await: wait for the batcher to fsync this entry.
    batcher.flush_now().await?;

    // --- 3. Advance the linearizability barrier ---------------------------
    // Boundary 3: crash after the commit index is fsynced but before the
    // projection is updated (tests durability-await correctness).
    crash_point("crash_after_index_fsync");
    barrier.advance(commit_seq)?;

    // --- 4. Send to the projection dispatcher ----------------------------
    for event in &command.events {
        let dispatch_item = DispatchItem {
            commit_seq,
            event_type: event.event_type.clone(),
            stream_id: event.stream_id.clone(),
            payload: event.plaintext.clone(),
        };

        if command.essential {
            // Essential commands block until the dispatcher has room.
            dispatcher_tx.send(dispatch_item).await.map_err(|_| {
                WabiError::InternalInvariantViolated {
                    invariant: "dispatcher channel closed".into(),
                }
            })?;
        } else {
            // Non-essential: try without blocking. If the channel is full,
            // reject with EngineBusy (degraded mode per wabidb-97).
            match dispatcher_tx.try_send(dispatch_item) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    return Err(WabiError::EngineBusy {
                        retry_after_ms: 100,
                    });
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    return Err(WabiError::InternalInvariantViolated {
                        invariant: "dispatcher channel closed".into(),
                    });
                }
            }
        }
    }

    // Boundary 4: crash after the projection dispatcher receives the event
    // but before `Ok` is sent back to the caller (tests idempotency replay).
    crash_point("crash_after_projection_update");

    Ok(CommandOutcome {
        commit_seq,
        timestamp_micros,
    })
}

// ---------------------------------------------------------------------------
// Writer cache helper
// ---------------------------------------------------------------------------

/// Return the existing writer for `stream_id`, or open a new segment.
async fn get_or_create_writer<'a>(
    writers: &'a mut HashMap<String, WriterEntry>,
    stream_id: &str,
    events_dir: &Path,
) -> Result<&'a mut WriterEntry> {
    if !writers.contains_key(stream_id) {
        let writer = SegmentWriter::open(events_dir, stream_id.to_string()).await?;
        writers.insert(
            stream_id.to_string(),
            WriterEntry { writer },
        );
    }
    // SAFETY: we just ensured the entry exists.
    Ok(writers.get_mut(stream_id).unwrap())
}

// ---------------------------------------------------------------------------
// Crash-injection hooks (wabidb-72 / test-harness feature)
// ---------------------------------------------------------------------------

/// Crash-injection point for power-loss testing.
///
/// When the `test-harness` feature is enabled AND the `WABIDB_CRASH_AT`
/// environment variable is set to `name`, this function calls
/// `std::process::exit(1)` to simulate a crash at that exact point.
/// In production builds (or when the env var doesn't match) it is a no-op.
///
/// # Usage
///
/// Place calls to this function at strategic points in the commit path.
/// The test harness passes `WABIDB_CRASH_AT=<name>` to the child process,
/// runs the operation, and expects the child to crash at that point.
/// After the crash, the parent reopens the engine and asserts recovery
/// invariants.
///
/// # Safety
///
/// In test-harness mode this calls `std::process::exit(1)`, which does
/// not run destructors. This is intentional — a real crash drops no state.
pub fn crash_point(name: &str) {
    #[cfg(feature = "test-harness")]
    {
        if let Ok(target) = std::env::var("WABIDB_CRASH_AT") {
            if target == name {
                tracing::warn!("CRASH INJECTION: {name}");
                use std::io::Write;
                let _ = std::io::stderr().flush();
                std::process::exit(1);
            }
        }
    }
    let _ = name;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{RecordHeader, RecordKind};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{oneshot, Semaphore};

    use crate::engine::locks::ProjectionState;
    /// Build a simple command for testing.
    fn make_cmd(
        seq_prefix: u64,
        essential: bool,
        stream_id: &str,
        stream_kind: u8,
        plaintext: &[u8],
    ) -> (CommandCommit, oneshot::Receiver<Result<CommandOutcome>>) {
        let (tx, rx) = oneshot::channel();
        let cmd = CommandCommit {
            caller_user_id: seq_prefix,
            caller_device_id: format!("dev{seq_prefix}"),
            command_name: "test_cmd".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: stream_id.to_string(),
                event_type: "test_event".into(),
                stream_kind,
                record_kind: RecordKind::Event,
                plaintext: plaintext.to_vec(),
            }],
            essential,
            response_tx: tx,
        };
        (cmd, rx)
    }

    /// Helper: start the sequencer in a spawned task, then send the given
    /// commands, then wait for the sequencer to finish.
    async fn run_sequencer_with_commands(
        data_dir: PathBuf,
        key_registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>>,
        commands: Vec<CommandCommit>,
    ) -> Result<()> {
        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        // Create batcher.
        let commit_index_dir = data_dir.join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir)
            .await
            .unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        // Create dispatcher.
        let (dispatcher_tx, _dispatcher_rx) = mpsc::channel::<DispatchItem>(1024);

        // Create barrier.
        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(state));

        // Build command channel.
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(1024);

        // Spawn the sequencer in a separate task so we can send commands
        // without blocking.
        let sequencer_handle = tokio::spawn(async move {
            run(
                permit,
                key_registry,
                batcher,
                dispatcher_tx,
                barrier,
                cmd_rx,
                data_dir,
            )
            .await
        });

        // Now send all commands (the channel is large enough).
        for cmd in commands {
            cmd_tx.send(cmd).await.unwrap();
        }
        drop(cmd_tx);

        // Wait for the sequencer to finish.
        sequencer_handle.await.unwrap()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 1. happy_path
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_test", [0xABu8; 32])
            .unwrap();

        let (cmd, rx) = make_cmd(1, true, "ch_test", 1, b"hello");
        let result = run_sequencer_with_commands(
            dir.path().to_path_buf(),
            registry,
            vec![cmd],
        )
        .await;

        assert!(result.is_ok(), "sequencer exited with error: {result:?}");

        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.commit_seq, 1);
        assert!(outcome.timestamp_micros > 0);
    }

    // -----------------------------------------------------------------------
    // 2. atomic_commit_happy_path (100 commands)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn atomic_commit_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_100", [0xABu8; 32])
            .unwrap();

        let n = 100u64;
        let mut cmds = Vec::with_capacity(n as usize);
        let mut rxs = Vec::with_capacity(n as usize);
        for i in 0..n {
            let (cmd, rx) = make_cmd(i + 1, true, "ch_100", 1, b"payload");
            cmds.push(cmd);
            rxs.push(rx);
        }

        let result = run_sequencer_with_commands(
            dir.path().to_path_buf(),
            registry,
            cmds,
        )
        .await;
        assert!(result.is_ok(), "sequencer exited with error: {result:?}");

        for (i, rx) in rxs.into_iter().enumerate() {
            let outcome = rx.await.unwrap().unwrap();
            assert_eq!(
                outcome.commit_seq,
                (i + 1) as u64,
                "command {} got wrong commit_seq",
                i
            );
        }
    }

    // -----------------------------------------------------------------------
    // 3. burned_seq_on_failure
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn burned_seq_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_ok", [0xABu8; 32])
            .unwrap();
        // Don't create "ch_bad" so the first command fails with UnknownStreamKey.

        let (bad_cmd, bad_rx) = make_cmd(1, true, "ch_bad", 1, b"fail");
        let (good_cmd, good_rx) = make_cmd(2, true, "ch_ok", 1, b"success");

        let result = run_sequencer_with_commands(
            dir.path().to_path_buf(),
            registry,
            vec![bad_cmd, good_cmd],
        )
        .await;
        assert!(result.is_ok(), "sequencer exited with error: {result:?}");

        // First command should fail (unknown stream key).
        let bad_outcome = bad_rx.await.unwrap();
        assert!(
            bad_outcome.is_err(),
            "expected first command to fail, got {bad_outcome:?}"
        );

        // Second command should succeed with commit_seq=2 (seq 1 was burned).
        let good_outcome = good_rx.await.unwrap().unwrap();
        assert_eq!(
            good_outcome.commit_seq, 2,
            "burned seq 1 should not be reused; got seq {}",
            good_outcome.commit_seq
        );
    }

    // -----------------------------------------------------------------------
    // 4. orphan_records_tolerated
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn orphan_records_tolerated() {
        let dir = tempfile::tempdir().unwrap();

        // Manually write an orphan record to create a pre-existing segment.
        let orphan_dir = dir
            .path()
            .join("streams")
            .join("channel")
            .join("ch_orphan")
            .join("events");
        tokio::fs::create_dir_all(&orphan_dir).await.unwrap();
        let mut orphan_writer =
            SegmentWriter::open(&orphan_dir, "ch_orphan".into())
                .await
                .unwrap();
        let orphan_header = RecordHeader::new(
            RecordKind::Event,
            999, // commit_seq not in any commit index
            [0xBBu8; 16],
            4,
            0,
        );
        orphan_writer
            .append(&orphan_header, b"orph")
            .await
            .unwrap();
        orphan_writer.close().await.unwrap();

        // Now run the sequencer with a legitimate stream.
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_ok", [0xABu8; 32])
            .unwrap();

        let (cmd, rx) = make_cmd(1, true, "ch_ok", 1, b"real");
        let result = run_sequencer_with_commands(
            dir.path().to_path_buf(),
            registry,
            vec![cmd],
        )
        .await;
        assert!(result.is_ok(), "sequencer exited with error: {result:?}");

        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.commit_seq, 1);
    }

    // -----------------------------------------------------------------------
    // 5. dispatcher_backpressure
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn dispatcher_backpressure() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_bp", [0xABu8; 32])
            .unwrap();

        // Create dispatcher with a tiny channel that we fill.
        let (dispatcher_tx, _rx) = mpsc::channel::<DispatchItem>(1);

        // Fill the channel.
        dispatcher_tx
            .try_send(DispatchItem {
                commit_seq: 0,
                event_type: "filler".into(),
                stream_id: "filler".into(),
                payload: vec![],
            })
            .unwrap();

        // The channel is now full. Non-essential command should get EngineBusy.
        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir)
            .await
            .unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(state));

        let (cmd, rx) = make_cmd(1, false, "ch_bp", 1, b"non-essential");
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
        cmd_tx.send(cmd).await.unwrap();
        drop(cmd_tx);

        let sequencer_result = run(
            permit,
            registry,
            batcher,
            dispatcher_tx,
            barrier,
            cmd_rx,
            dir.path().to_path_buf(),
        )
        .await;
        assert!(sequencer_result.is_ok());

        let outcome = rx.await.unwrap();
        assert!(
            matches!(outcome, Err(WabiError::EngineBusy { .. })),
            "expected EngineBusy for non-essential command with full dispatcher, got {outcome:?}"
        );
    }

    // -----------------------------------------------------------------------
    // 6. essential_command_under_backpressure
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn essential_command_under_backpressure() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_ess", [0xABu8; 32])
            .unwrap();

        // Use a channel with enough capacity (essential commands must not be
        // rejected). We send to a slow receiver to verify the essential path
        // doesn't return EngineBusy.
        let (dispatcher_tx, _dispatcher_rx) = mpsc::channel::<DispatchItem>(16);

        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir)
            .await
            .unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(state));

        let (cmd, rx) = make_cmd(1, true, "ch_ess", 1, b"essential");
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
        cmd_tx.send(cmd).await.unwrap();
        drop(cmd_tx);

        let handle = tokio::spawn(async move {
            run(
                permit,
                registry,
                batcher,
                dispatcher_tx,
                barrier,
                cmd_rx,
                dir.path().to_path_buf(),
            )
            .await
        });

        // The essential command should succeed (the dispatcher channel has room).
        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.commit_seq, 1);

        handle.await.unwrap().unwrap();
    }

    // -----------------------------------------------------------------------
    // 7. durability_await
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn durability_await() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry.lock().await
            .create_stream("ch_durable", [0xABu8; 32])
            .unwrap();

        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir)
            .await
            .unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir.clone(),
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        let (dispatcher_tx, _dispatcher_rx) = mpsc::channel::<DispatchItem>(16);
        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(state));

        let (cmd, rx) = make_cmd(1, true, "ch_durable", 1, b"data");
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
        cmd_tx.send(cmd).await.unwrap();
        drop(cmd_tx);

        let result = run(
            permit,
            registry,
            batcher,
            dispatcher_tx,
            barrier,
            cmd_rx,
            dir.path().to_path_buf(),
        )
        .await;
        assert!(result.is_ok());

        // The command should return Ok (durability guarantee met).
        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.commit_seq, 1);

        // Verify the batcher actually wrote a file.
        let entries =
            crate::commit_index::batcher::read_all_entries(&commit_index_dir).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].commit_seq, 1);
    }

    // -----------------------------------------------------------------------
    // 8. no_two_sequencers
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn no_two_sequencers() {
        let sem = Arc::new(Semaphore::new(1));
        let p1 = SequencerPermit::acquire(&sem).await.unwrap();

        let sem2 = Arc::clone(&sem);
        let waiter = tokio::spawn(async move { SequencerPermit::acquire(&sem2).await });

        // The second acquisition should not be immediately available.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "second sequencer should be blocked by the held permit"
        );

        // Drop the first permit; the waiter should now acquire.
        drop(p1);
        let p2 = waiter.await.unwrap().unwrap();
        drop(p2);
    }
}
