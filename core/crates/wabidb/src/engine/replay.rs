//! Event log replay: rebuild projection state from on-disk segments.
//!
//! On startup, `replay_projections()` reads every `.wseg` segment across all
//! streams, decrypts each record, unwraps the [`ReplayEnvelope`] to recover
//! `event_type` and `stream_id`, and dispatches the event through the same
//! projection handlers used in the live path.
//!
//! # Record format (after encryption change)
//!
//! Each `.wseg` record's encrypted payload is a JSON-serialized
//! `ReplayEnvelope { event_type, stream_id, payload }`. Records written before
//! the envelope change lack this structure. If an indexed post-snapshot
//! record cannot be decoded or applied, startup fails rather than losing it.
//!
//! # Commit index filtering (Council Review #1 §2.2, Option B)
//!
//! Records whose `commit_seq` has no entry in the global commit index are
//! orphans (writes that crashed before the index append). They are skipped:
//! the commit index is the source of truth for which commits exist, including
//! when it is empty. Unindexed bytes must never become a successful write.

use std::collections::HashMap;
use std::path::Path;

use tokio::sync::Mutex;

use crate::crypto::aes_gcm_record::decrypt_record;
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::{DispatchTable, DurableEvent};
use crate::sequencer::types::ReplayEnvelope;
use crate::stream_log::segment_reader::SegmentReader;

/// Rebuild projection state by replaying events from the event log.
///
/// Walks every stream's `.wseg` segment files under `data_dir/streams/`,
/// decrypts each record, deserializes the [`ReplayEnvelope`], and dispatches
/// the event through the registered projection handlers.
///
/// Returns the highest `commit_seq` observed in ANY on-disk record —
/// including orphaned and skipped records. Callers use this to seed the
/// commit sequencer so a restart never reuses a seq that a previous
/// incarnation already encrypted with the same (deterministically derived)
/// stream key (AES-GCM nonce reuse, Council Review #1 §1.1).
///
/// Records with `commit_seq <= snapshot_watermark` are skipped — they are
/// already reflected in a loaded snapshot.
pub async fn replay_projections(
    data_dir: &Path,
    key_registry: &Mutex<StreamKeyRegistry>,
    bootstrap_key: &[u8; 32],
    projection_state: &ProjectionState,
    dispatch_table: &DispatchTable,
    barrier: &LinearizabilityBarrier,
    snapshot_watermark: u64,
) -> Result<u64> {
    let streams_dir = data_dir.join("streams");
    // --- Load the committed seq set (Option B orphan filter) ---
    let commit_index_dir = data_dir.join("global").join("commit-index");
    let committed: HashMap<_, _> =
        crate::commit_index::batcher::read_all_entries(&commit_index_dir)
            .map(|entries| entries.into_iter().map(|e| (e.commit_seq, e)).collect())?;
    let applied_seq = committed
        .keys()
        .copied()
        .max()
        .unwrap_or(0)
        .max(snapshot_watermark);
    if !tokio::fs::try_exists(&streams_dir).await? {
        if committed
            .values()
            .any(|e| e.commit_seq > snapshot_watermark && !e.event_refs.is_empty())
        {
            return Err(crate::error::WabiError::Corrupt {
                location: "streams directory".into(),
                detail: "not all indexed events could be recovered; streams directory missing"
                    .into(),
            });
        }
        barrier.advance(applied_seq)?;
        return Ok(applied_seq);
    }

    let mut highest_seq = applied_seq;
    let mut orphan_skipped: u64 = 0;
    let mut decrypt_skipped: u64 = 0;
    let mut replayed: u64 = 0;
    // Collect first, apply AFTER sorting by commit_seq. Directory iteration
    // order (category dir → stream dir → segment) is filesystem-dependent —
    // ext4 hash order differs per filesystem — and applying inline let a
    // later-seq event on one stream (e.g. `channel_deleted` on
    // `channels:{id}`) land BEFORE an earlier-seq event on another (the
    // shared `channels` stream's `channel_created`), which resurrected
    // deleted channels on restart ("zombie channels", observed live on
    // wabi.chat 2026-08-27). The sequencer assigns globally unique,
    // totally ordered commit_seqs; sorting restores exactly the order the
    // live dispatcher applied.
    let mut collected: Vec<(usize, DurableEvent)> = Vec::new();
    let mut recovered_events: HashMap<u64, std::collections::HashSet<usize>> = HashMap::new();
    let mut kind_reader = tokio::fs::read_dir(&streams_dir).await?;

    while let Some(kind_entry) = kind_reader.next_entry().await? {
        let kind_path = kind_entry.path();
        if !kind_path.is_dir() {
            continue;
        }

        let mut stream_reader = tokio::fs::read_dir(&kind_path).await?;

        while let Some(stream_entry) = stream_reader.next_entry().await? {
            let stream_path = stream_entry.path();
            if !stream_path.is_dir() {
                continue;
            }

            let stream_id = stream_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if stream_id.is_empty() {
                continue;
            }

            let events_dir = stream_path.join("events");
            if !tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
                continue;
            }

            // --- Ensure the stream encryption key exists ---
            {
                let mut registry = key_registry.lock().await;
                if !registry.has_stream(&stream_id) {
                    let mut hasher = blake3::Hasher::new();
                    hasher.update(b"wabi-stream-key-v1");
                    hasher.update(stream_id.as_bytes());
                    hasher.update(bootstrap_key);
                    let key_material = *hasher.finalize().as_bytes();
                    registry.create_stream(&stream_id, key_material)?;
                }
            }

            // --- Collect and sort segment paths ---
            let mut seg_entries: Vec<_> = Vec::new();
            {
                let mut seg_reader = tokio::fs::read_dir(&events_dir).await?;
                while let Some(seg) = seg_reader.next_entry().await? {
                    if seg.path().extension() == Some(std::ffi::OsStr::new("wseg")) {
                        seg_entries.push(seg);
                    }
                }
            }
            seg_entries.sort_by_key(|e| e.file_name());

            for seg_entry in &seg_entries {
                let seg_path = seg_entry.path();
                let mut reader = match SegmentReader::open(&seg_path).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(
                            "replay: skipping unreadable segment {}: {e}",
                            seg_path.display()
                        );
                        continue;
                    }
                };

                let records = match reader.read_records().await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(
                            "replay: skipping corrupt segment {}: {e}",
                            seg_path.display()
                        );
                        continue;
                    }
                };

                for rec in &records {
                    let commit_seq = rec.header.commit_seq;

                    // Track the max seq seen on disk BEFORE any filtering:
                    // even skipped/orphaned records consumed their nonce and
                    // must never be reused by a restarted sequencer.
                    highest_seq = highest_seq.max(commit_seq);

                    // Skip records that are already reflected in the snapshot.
                    if commit_seq <= snapshot_watermark {
                        continue;
                    }

                    // Option B: records absent from the commit index are
                    // orphans of partially-committed commands — skip them.
                    let Some(entry) = committed.get(&commit_seq) else {
                        orphan_skipped += 1;
                        continue;
                    };

                    let header_bytes = rec.header.encode();

                    // Look up the stream key for this commit_seq range.
                    let key = {
                        let registry = key_registry.lock().await;
                        match registry.get_active_key(&stream_id, commit_seq) {
                            Ok(sk) => sk.key_material,
                            Err(e) => {
                                tracing::warn!(
                                    "replay: no key for stream={stream_id} seq={commit_seq}: {e}"
                                );
                                continue;
                            }
                        }
                    };

                    // Decrypt.
                    let env_bytes = match decrypt_record(
                        &key,
                        commit_seq,
                        &header_bytes,
                        &rec.payload,
                    ) {
                        Ok(b) => b,
                        Err(e) => {
                            decrypt_skipped += 1;
                            tracing::debug!(
                                "replay: decrypt failed for stream={stream_id} seq={commit_seq}: {e}"
                            );
                            continue;
                        }
                    };

                    // Deserialize the replay envelope.
                    // Indexed decode failures are rejected by the completeness
                    // check below; old records need an explicit migration.
                    let envelope: ReplayEnvelope = match serde_json::from_slice(&env_bytes) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };

                    // Preserve the command's event order across streams.
                    // Sorting by seq alone leaves ties in filesystem order.
                    let segment_id = seg_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .and_then(|s| s.parse::<u64>().ok());
                    // Legacy writers cache by stream ID, not (kind, ID).
                    // Workspace/chat can share an ID with different kinds;
                    // match the physical record identity, not the directory kind.
                    let ordinal = entry
                        .event_refs
                        .iter()
                        .position(|r| {
                            r.stream_id_hash == rec.header.stream_id_hash
                                && Some(r.segment_id) == segment_id
                                && u64::from(r.offset) == rec.offset
                                && r.length as usize == rec.header.total_size()
                        })
                        .ok_or_else(|| crate::error::WabiError::Corrupt {
                            location: format!("commit {commit_seq}"),
                            detail: "segment record not referenced by its commit index entry"
                                .into(),
                        })?;
                    if !recovered_events
                        .entry(commit_seq)
                        .or_default()
                        .insert(ordinal)
                    {
                        return Err(crate::error::WabiError::Corrupt {
                            location: format!("commit {commit_seq} event {ordinal}"),
                            detail: "duplicate indexed event during replay".into(),
                        });
                    }
                    collected.push((
                        ordinal,
                        DurableEvent {
                            commit_seq,
                            stream_id: envelope.stream_id,
                            event_type: envelope.event_type,
                            payload: envelope.payload,
                        },
                    ));
                }
            }
        }
    }

    // Global total order (see `collected` above): sort by commit_seq, then
    // apply. DurableEvent derives nothing that orders it, so sort by field.
    // Never report readiness after silently losing part of a durable commit.
    for entry in committed
        .values()
        .filter(|e| e.commit_seq > snapshot_watermark)
    {
        if recovered_events
            .get(&entry.commit_seq)
            .map(|events| events.len())
            .unwrap_or(0)
            != entry.event_refs.len()
        {
            return Err(crate::error::WabiError::Corrupt {
                location: format!("commit {}", entry.commit_seq),
                detail: "not all indexed events could be recovered; repair required before startup"
                    .into(),
            });
        }
    }
    collected.sort_by_key(|(ordinal, event)| (event.commit_seq, *ordinal));
    for (_, event) in &collected {
        if let Some(handler) = dispatch_table.get(&event.event_type) {
            handler.apply(event, projection_state).map_err(|e| {
                crate::error::WabiError::Corrupt {
                    location: format!(
                        "projection {} at commit {}",
                        event.event_type, event.commit_seq
                    ),
                    detail: format!("replay failed: {e}; repair required before startup"),
                }
            })?;
        } else {
            // Match the live dispatcher's forward-compatible fallback.
            projection_state.insert(
                "events",
                event.event_type.as_bytes().to_vec(),
                event.payload.clone(),
                event.commit_seq,
            );
        }
        replayed += 1;
    }

    // Nonce allocation includes orphan sequences; application progress does not.
    barrier.advance(applied_seq)?;
    if orphan_skipped > 0 || decrypt_skipped > 0 {
        tracing::warn!(
            "replay: complete. applied={replayed} orphan_skipped={orphan_skipped} decrypt_skipped={decrypt_skipped} highest_seq={highest_seq}"
        );
    } else {
        tracing::info!("replayed projections up to commit_seq={highest_seq} (applied={replayed})");
    }
    Ok(highest_seq)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::bootstrap::BootstrapSource;
    use crate::crypto::stream_key_registry::StreamKeyRegistry;
    use crate::engine::locks::ProjectionState;
    use crate::engine::WabiDbConfig;
    use crate::format::record::RecordKind;
    use crate::projections::barrier::LinearizabilityBarrier;
    use crate::projections::handler::{DispatchTable, Projection};
    use crate::sequencer::types::{CommandCommit, EventToWrite};
    use std::sync::{Arc, Mutex};

    /// Records the commit_seq of every event a replay applies.
    struct RecordingProjection {
        order: Mutex<Vec<u64>>,
    }

    impl Projection for RecordingProjection {
        fn event_type(&self) -> &str {
            "test_event"
        }

        fn apply(&self, event: &DurableEvent, _state: &ProjectionState) -> Result<()> {
            self.order.lock().unwrap().push(event.commit_seq);
            Ok(())
        }
    }

    async fn commit(engine: &crate::engine::WabiDbEngine, seq: u64, stream: &str, kind: u8) {
        engine.get_or_create_stream_key(stream).await.unwrap();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        let cmd = CommandCommit {
            caller_user_id: seq,
            caller_device_id: format!("dev{seq}"),
            command_name: "test_cmd".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: stream.to_string(),
                event_type: "test_event".into(),
                stream_kind: kind,
                record_kind: RecordKind::Event,
                plaintext: vec![seq as u8],
            }],
            essential: false,
            response_tx: tx,
        };
        engine.run_command(cmd).await.unwrap();
    }

    /// Regression (2026-08-27, zombie channels on wabi.chat): replay MUST
    /// apply events in global commit_seq order regardless of directory
    /// iteration order. A delete committed at seq N+1 on `channels:{id}`
    /// (stream kind 1) used to apply before the create at seq N on the
    /// shared `channels` stream (kind 6) whenever the filesystem iterated
    /// the kind dirs that way, resurrecting the deleted channel on every
    /// restart. Interleave events across both kinds and assert order.
    #[tokio::test]
    async fn replay_applies_events_in_global_commit_seq_order() {
        let tmp = tempfile::tempdir().unwrap();
        let bootstrap = [0xABu8; 32];
        let config = WabiDbConfig {
            data_dir: tmp.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided(bootstrap),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let engine = crate::engine::WabiDbEngine::open(config).await.unwrap();

        // Interleave: shared "channels" stream (kind 6) and per-channel
        // "channels:ch_1" (kind 1) — exactly the create/delete split that
        // produced zombie channels.
        commit(&engine, 1, "channels", 6).await;
        commit(&engine, 2, "channels:ch_1", 1).await;
        commit(&engine, 3, "channels", 6).await;
        commit(&engine, 4, "channels:ch_1", 1).await;
        commit(&engine, 5, "channels:ch_2", 1).await;
        commit(&engine, 6, "channels", 6).await;
        drop(engine);

        // Replay into a fresh state with a recording dispatch table.
        let state = Arc::new(ProjectionState::new());
        let recorder = Arc::new(RecordingProjection {
            order: Mutex::new(Vec::new()),
        });
        let table = DispatchTable::new(vec![recorder.clone()]).unwrap();
        let registry = tokio::sync::Mutex::new(StreamKeyRegistry::new());
        let barrier = LinearizabilityBarrier::new(state.clone());

        let high = replay_projections(
            tmp.path(),
            &registry,
            &bootstrap,
            &state,
            &table,
            &barrier,
            0,
        )
        .await
        .unwrap();

        let order = recorder.order.lock().unwrap().clone();
        assert_eq!(order.len(), 6, "all events must replay: {order:?}");
        assert!(
            order.windows(2).all(|w| w[0] < w[1]),
            "replay applied events out of commit_seq order: {order:?}"
        );
        assert_eq!(*order.last().unwrap(), high);
    }
}
