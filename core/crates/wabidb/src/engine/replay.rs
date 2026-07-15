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
//! the envelope change lack this structure; they are silently skipped when
//! deserialization fails.

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
/// Records with `commit_seq <= snapshot_watermark` are skipped — they are
/// already reflected in a loaded snapshot. Records that fail to decrypt or
/// deserialize (e.g. old-format segments written before the envelope change)
/// are silently skipped.
pub async fn replay_projections(
    data_dir: &Path,
    key_registry: &Mutex<StreamKeyRegistry>,
    bootstrap_key: &[u8; 32],
    projection_state: &ProjectionState,
    dispatch_table: &DispatchTable,
    barrier: &LinearizabilityBarrier,
    snapshot_watermark: u64,
) -> Result<()> {
    let streams_dir = data_dir.join("streams");
    if !tokio::fs::try_exists(&streams_dir).await.unwrap_or(false) {
        return Ok(());
    }

    let mut highest_seq = snapshot_watermark;
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
                        tracing::warn!("replay: skipping unreadable segment {}: {e}", seg_path.display());
                        continue;
                    }
                };

                let records = match reader.read_records().await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!("replay: skipping corrupt segment {}: {e}", seg_path.display());
                        continue;
                    }
                };

                for rec in &records {
                    let commit_seq = rec.header.commit_seq;

                    // Skip records that are already reflected in the snapshot.
                    if commit_seq <= snapshot_watermark {
                        continue;
                    }

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
                    let env_bytes = match decrypt_record(&key, commit_seq, &header_bytes, &rec.payload) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::debug!(
                                "replay: decrypt failed for stream={stream_id} seq={commit_seq}: {e}"
                            );
                            continue;
                        }
                    };

                    // Deserialize the replay envelope.
                    // Failure here means an old-format record (pre-envelope) —
                    // silently skip to maintain forward compatibility.
                    let envelope: ReplayEnvelope = match serde_json::from_slice(&env_bytes) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };

                    let event = DurableEvent {
                        commit_seq,
                        stream_id: envelope.stream_id,
                        event_type: envelope.event_type,
                        payload: envelope.payload,
                    };

                    if let Some(handler) = dispatch_table.get(&event.event_type) {
                        if let Err(e) = handler.apply(&event, projection_state) {
                            tracing::error!(
                                "replay: handler error for {} seq={commit_seq}: {e}",
                                event.event_type
                            );
                        }
                    }

                    highest_seq = highest_seq.max(commit_seq);
                }
            }
        }
    }

    if highest_seq > 0 {
        barrier.advance(highest_seq)?;
    }

    tracing::info!("replayed projections up to commit_seq={highest_seq}");
    Ok(())
}
