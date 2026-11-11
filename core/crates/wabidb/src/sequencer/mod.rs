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
//!    batch containing its `commit_seq` is fsync'd AND every projection event
//!    in that command has applied successfully.

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
use crate::engine::locks::{DispatchCommit, DispatchItem, ProjectionState, SequencerPermit};
use crate::error::{Result, WabiError};
use crate::format::record::RecordHeader;
pub use crate::sequencer::types::ReplayEnvelope;
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
fn stream_events_dir(data_dir: &Path, stream_kind: u8, stream_id: &str) -> Result<PathBuf> {
    let kind_dir = data_dir.join("streams").join(stream_kind_dir_name(stream_kind));
    Ok(resolve_stream_dir(&kind_dir, stream_id)?.join("events"))
}

// ---------------------------------------------------------------------------
// Stream id <-> directory name (Task 1.0j)
// ---------------------------------------------------------------------------
//
// Replay derives the stream id, and from it the stream key, from the
// directory name, so the name is semantically the id. Windows rejects `:`
// and other characters that real stream ids contain ("community-roster:v1"),
// so ids outside a small portable set are stored percent-encoded. Trees
// written before this change hold raw names; they are read and appended to
// as they are and never renamed (golden rule 5: dual decode, no rewrite).

/// Bytes an id may contain and still be its own directory name.
fn is_plain_dir_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

/// Windows device names, reserved with or without an extension. COM0 and
/// LPT0 are included because current Windows documentation lists them too.
fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    match upper.as_bytes() {
        b"CON" | b"PRN" | b"AUX" | b"NUL" => true,
        [b'C', b'O', b'M', digit] | [b'L', b'P', b'T', digit] => digit.is_ascii_digit(),
        _ => false,
    }
}

/// Encode a stream id as one directory name that is valid on Windows, macOS
/// and Linux.
///
/// An id made only of `[A-Za-z0-9._-]` that does not end in `.` and is not a
/// Windows device name is returned unchanged, so every existing portable
/// directory keeps its name. Otherwise every byte outside that set (always
/// including `%`), a trailing `.`, and the first byte of a device name are
/// written as `%XX` (uppercase hex). The result is ASCII, contains none of
/// `< > : " / \ | ? *`, no control bytes, no trailing dot or space, and is
/// never a device name. [`stream_id_from_dir_name`] is its exact inverse.
///
/// Callers still validate the id with
/// [`crate::stream_identity::is_safe_stream_id`]; an encoded name can be up
/// to three times the id's length.
pub fn stream_dir_name(stream_id: &str) -> String {
    use std::fmt::Write as _;
    let bytes = stream_id.as_bytes();
    let mut out = String::with_capacity(bytes.len() + 8);
    for (index, &byte) in bytes.iter().enumerate() {
        let trailing_dot = byte == b'.' && index + 1 == bytes.len();
        if is_plain_dir_byte(byte) && !trailing_dot {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    if is_windows_reserved_name(&out) {
        // A device name starts with an ASCII letter; escaping it is enough.
        let first = out.as_bytes()[0];
        out.replace_range(0..1, &format!("%{first:02X}"));
    }
    out
}

/// Exact inverse of [`stream_dir_name`]: `Some(id)` iff
/// `stream_dir_name(id) == dir_name`.
///
/// `None` means the name is not an encoding this build would write, e.g. a
/// raw directory from a tree written before Task 1.0j
/// (`community-roster:v1`). Readers walking directories must also accept
/// the raw name as an id; see [`stream_id_candidates`].
pub fn stream_id_from_dir_name(dir_name: &str) -> Option<String> {
    let bytes = dir_name.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = bytes.get(index + 1..index + 3)?;
                if !hex.iter().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(b)) {
                    return None;
                }
                decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
                index += 3;
            }
            byte if is_plain_dir_byte(byte) => {
                decoded.push(byte);
                index += 1;
            }
            _ => return None,
        }
    }
    let stream_id = String::from_utf8(decoded).ok()?;
    // Reject non-canonical spellings so the mapping stays injective.
    (stream_dir_name(&stream_id) == dir_name).then_some(stream_id)
}

/// Every stream id a directory named `dir_name` can hold: the raw name
/// (all trees written before Task 1.0j) and, when different, its decoding.
/// Callers pick the one whose [`crate::stream_identity::stream_id_hash`]
/// matches the record header or commit index; the raw name comes first.
pub fn stream_id_candidates(dir_name: &str) -> Vec<String> {
    let mut candidates = vec![dir_name.to_owned()];
    if let Some(decoded) = stream_id_from_dir_name(dir_name) {
        if decoded != dir_name {
            candidates.push(decoded);
        }
    }
    candidates
}

/// The directory under `parent` (`streams/<kind>`) that holds `stream_id`.
///
/// If a raw-named directory from an older tree exists, it is used, so a
/// stream is never split between its raw and encoded directories; only a
/// stream with no directory yet gets the encoded name. Windows never has
/// raw directories that differ from their encoding (they cannot be
/// created there), and probing a name with `:` would address an NTFS
/// alternate data stream, so the raw probe is skipped on Windows.
///
/// Two ids can collide on one name when one is spelled like the other's
/// encoding (`a%3Ab` vs `a:b`). A raw-named directory is then reused only
/// if its records are this stream's, and this fails rather than share an
/// encoded directory that holds the other stream's records.
pub fn resolve_stream_dir(parent: &Path, stream_id: &str) -> Result<PathBuf> {
    let encoded = stream_dir_name(stream_id);
    if encoded == stream_id {
        return Ok(parent.join(encoded));
    }
    let own = crate::stream_identity::stream_id_hash(stream_id);
    let raw = parent.join(stream_id);
    if !cfg!(windows) && raw.is_dir() {
        // An id like `a%3Ab` is also the encoding of `a:b`, so a directory
        // of that name may be `a:b`'s. Reuse it only when its records are
        // this stream's; an empty one holds nothing a new directory splits.
        let other_streams_encoding =
            stream_id_from_dir_name(stream_id).is_some_and(|other| other != stream_id);
        if !other_streams_encoding || first_record_stream_hash(&raw.join("events"))? == Some(own) {
            return Ok(raw);
        }
    }
    let path = parent.join(&encoded);
    if let Some(owner) = first_record_stream_hash(&path.join("events"))? {
        if owner != own && owner == crate::stream_identity::stream_id_hash(&encoded) {
            return Err(WabiError::InternalInvariantViolated {
                invariant: format!(
                    "stream directory {} belongs to the legacy stream of that raw name, \
                     not to {stream_id:?}; refusing to mix two streams",
                    path.display()
                ),
            });
        }
    }
    Ok(path)
}

/// Stream hash of the first record in the lowest-numbered non-empty segment.
fn first_record_stream_hash(events_dir: &Path) -> Result<Option<[u8; 16]>> {
    use std::io::Read as _;
    let mut segments = match std::fs::read_dir(events_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension() == Some(std::ffi::OsStr::new("wseg")))
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    segments.sort();
    let mut header = [0u8; crate::format::record::HEADER_LEN as usize];
    for segment in segments {
        let mut file = std::fs::File::open(&segment)?;
        if file.read_exact(&mut header).is_ok() {
            if let Ok(decoded) = RecordHeader::decode(&header) {
                return Ok(Some(decoded.stream_id_hash));
            }
        }
    }
    Ok(None)
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
fn idempotency_key_hash(
    caller_user_id: u64,
    caller_device_id: &str,
    client_request_id: &str,
) -> [u8; 32] {
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
    let stem = path.file_stem().and_then(|s| s.to_str()).ok_or_else(|| {
        WabiError::InternalInvariantViolated {
            invariant: format!("segment path has no valid stem: {}", path.display()),
        }
    })?;
    stem.parse::<u64>()
        .map_err(|_| WabiError::InternalInvariantViolated {
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
/// `initial_commit_seq` is the highest `commit_seq` ever assigned by ANY prior
/// incarnation of the engine (recovered at open from the commit index, the
/// on-disk segments, and the snapshot watermark). The first new commit gets
/// `initial_commit_seq + 1`. Because the AES-GCM nonce is derived from
/// `commit_seq` and stream keys are deterministically re-derived across
/// restarts, reusing a seq after a restart would repeat a (key, nonce) pair —
/// Council Review #1 §1.1: "safe as long as the global sequencer never resets."
///
/// The loop processes one `CommandCommit` at a time:
///
/// 1. Assign a monotonic `commit_seq` (burned on failure per §2.4).
/// 2. For each event: encrypt with the stream's key, write to the stream's
///    `.wseg` segment via [`SegmentWriter`], record a [`StreamRef`].
/// 3. Flush (fsync) every segment writer touched by this command, so the
///    bytes the commit index references are durable BEFORE the index entry
///    is fsynced (WAL ordering).
/// 4. Build a [`CommitIndexEntry`] and submit to the [`BatcherHandle`].
/// 5. Wait for the batcher to fsync the entry (durability-await, §2.3).
///    This is a **group commit**: the loop drains every already-queued
///    command into a window (up to [`GROUP_COMMIT_WINDOW`]), submits all of
///    their index entries, and issues ONE durability-await per window, so the
///    commit INDEX is fsynced at most once per window instead of once per
///    command (test: `sequencer::tests::group_commit_shares_fsyncs_under_concurrency`).
///    Each command still fsyncs every segment it touched (step 3), so segment
///    fsyncs are not shared; no test checks that half.
/// 6. Send one [`DispatchCommit`] containing all command events, in order.
/// 7. Await successful application of the whole commit. The dispatcher advances
///    the applied watermark only after all events succeed.
/// 8. Send the result back via `response_tx`.
///
/// # Ordering / durability contract
///
/// Commands are finalized strictly in commit_seq order after the window's
/// fsync completes, and no `response_tx` is resolved before the fsync that
/// covers that command's index entry AND the dispatcher acknowledges application.
/// Preparation failures burn their sequence and may leave unindexed orphans.
/// A post-durability application failure halts the writer: it is not a rollback
/// or a safe-to-retry busy response. Other commands in the window may be durable.
///
/// # Errors
///
/// Batcher failures or failed/lost projection acknowledgments halt the loop.
/// Closing the command channel normally drains admitted work, then exits.
pub async fn run(
    _permit: SequencerPermit,
    key_registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>>,
    batcher: BatcherHandle,
    dispatcher_tx: mpsc::Sender<DispatchCommit>,
    mut command_rx: mpsc::Receiver<CommandCommit>,
    data_dir: PathBuf,
    initial_commit_seq: u64,
    write_fence: Arc<tokio::sync::RwLock<bool>>,
    projection_state: Arc<ProjectionState>,
    local_node_id: String,
) -> Result<()> {
    crate::engine::node_identity::validate(&local_node_id)?;
    let mut writers: HashMap<String, WriterEntry> = HashMap::new();
    let mut next_commit_seq: u64 = initial_commit_seq.saturating_add(1).max(1);
    let mut deferred: Option<CommandCommit> = None;

    loop {
        let first = match deferred.take() {
            Some(command) => command,
            None => match command_rx.recv().await {
                Some(command) => command,
                None => break,
            },
        };
        // ---- Group-commit window: drain everything already queued --------
        // `recv` waited for work; `try_recv` only takes what is ready NOW,
        // so an idle system keeps windows small (latency stays low) while a
        // burst collapses into one fsync.
        let mut window = Vec::with_capacity(GROUP_COMMIT_WINDOW);
        // State-control commands are their own windows. Later admission must
        // see their applied room bindings or account revocation floors.
        let room_control_boundary = has_room_control_event(&first);
        window.push(first);
        if !room_control_boundary {
            while window.len() < GROUP_COMMIT_WINDOW {
                match command_rx.try_recv() {
                    Ok(command) if has_room_control_event(&command) => {
                        deferred = Some(command);
                        break;
                    }
                    Ok(command) => window.push(command),
                    Err(_) => break,
                }
            }
        }

        // Hold the read side through preparation, durability, projection
        // application and acknowledgments. A fence takes the write side, so
        // its successful return is a boundary after all prior local commits.
        let admission = write_fence.read().await;
        if *admission {
            for command in window {
                let _ = command.response_tx.send(Err(WabiError::WriterFenced));
            }
            continue;
        }

        // ---- Stage A: prepare + submit index entries (in seq order) ------
        let mut prepared: Vec<PreparedCommand> = Vec::with_capacity(window.len());
        let mut pending_message_parents = HashMap::new();
        for command in window {
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

            if let Some(ref precondition) = command.room_owner_precondition {
                if let Err(error) = crate::projections::room_placement::preflight_room_owner(
                    precondition,
                    &projection_state,
                    &local_node_id,
                ) {
                    let _ = command.response_tx.send(Err(error));
                    continue;
                }
            }

            if let Err(error) = crate::projections::workspace_writes::preflight_command(
                &command.events,
                command.room_owner_precondition.as_ref(),
                &projection_state,
            ) {
                let _ = command.response_tx.send(Err(error));
                continue;
            }

            // Track prepared message parents within the fsync group instead
            // of isolating every message creation into a separate fsync.
            let created_message_parents = match crate::projections::room_writes::preflight_command(
                &command.events,
                command.room_owner_precondition.as_ref(),
                &projection_state,
                &pending_message_parents,
                commit_seq,
            ) {
                Ok(parents) => parents,
                Err(error) => {
                    let _ = command.response_tx.send(Err(error));
                    continue;
                }
            };

            if let Err(error) = crate::projections::call_sessions::preflight_room_writes(
                &command.events,
                command.room_owner_precondition.as_ref(),
                &projection_state,
            ) {
                let _ = command.response_tx.send(Err(error));
                continue;
            }

            // A placement must never become durable if its stream, payload or
            // epoch would fail the projection. Isolation above makes this
            // check observe every preceding applied placement command.
            if let Err(error) = crate::projections::room_placement::preflight_command(
                &command.events,
                commit_seq,
                &projection_state,
            ) {
                let _ = command.response_tx.send(Err(error));
                continue;
            }

            if let Err(error) = crate::projections::auth_revocations::preflight(
                &command.events, &projection_state, timestamp_micros.max(0) as u64 / 1_000_000,
            ) {
                let _ = command.response_tx.send(Err(error));
                continue;
            }

            if let Err(error) = crate::projections::users::preflight_command(&command.events, &projection_state) {
                let _ = command.response_tx.send(Err(error));
                continue;
            }

            if let Err(error) = crate::projections::recovery_codes::preflight(
                &command.events, &projection_state,
            ) {
                let _ = command.response_tx.send(Err(error));
                continue;
            }

            match prepare_command(
                &key_registry,
                &mut writers,
                &batcher,
                &data_dir,
                &command,
                commit_seq,
                timestamp_micros,
            )
            .await
            {
                Ok(()) => {
                    pending_message_parents.extend(created_message_parents);
                    prepared.push(PreparedCommand {
                        commit_seq,
                        timestamp_micros,
                        command,
                    });
                }
                // Failure burns the seq and reports to the caller; the
                // sequencer keeps running (unchanged behavior).
                Err(e) => {
                    let _ = command.response_tx.send(Err(e));
                }
            }
        }

        // ---- ONE durability-await per window (group commit) --------------
        // The batcher's fsync is prefix-durable: when it returns, EVERY
        // entry submitted so far — including this whole window — is stable.
        if !prepared.is_empty() {
            batcher.flush_now().await?;
        }

        // ---- Stage B: finalize in commit order ----------------------------
        let mut prepared = prepared.into_iter();
        while let Some(current) = prepared.next() {
            let result = finalize_command(
                &dispatcher_tx,
                &current.command,
                current.commit_seq,
                current.timestamp_micros,
            )
            .await;
            let failure = result.as_ref().err().map(ToString::to_string);
            let _ = current.command.response_tx.send(result);
            if let Some(invariant) = failure {
                // No later commit may overtake a durable but unapplied one.
                for pending in prepared {
                    let pending_error = WabiError::InternalInvariantViolated {
                        invariant: format!(
                            "durable commit {} not applied because commit {} failed; engine halted, repair required before retry",
                            pending.commit_seq, current.commit_seq
                        ),
                    };
                    let _ = pending.command.response_tx.send(Err(pending_error));
                }
                return Err(WabiError::InternalInvariantViolated { invariant });
            }
        }
        drop(admission);
    }

    // Graceful shutdown: close all open writers.
    for (_stream_id, entry) in writers.drain() {
        let _ = entry.writer.close().await;
    }

    Ok(())
}

fn has_room_control_event(command: &CommandCommit) -> bool {
    command.events.iter().any(|event| {
        matches!(
            event.event_type.as_str(),
            crate::projections::room_placement::EVENT
                | crate::projections::room_placement::INIT_EVENT
                | "call_session_created"
                | "user_registered"
                | "user_updated"
                | "user_deleted"
                | "owner_claimed"
                | crate::projections::auth_revocations::EVENT
                | crate::projections::recovery_codes::EVENT
        )
    })
}

// ---------------------------------------------------------------------------
// Process one command — split into prepare (pre-fsync) and finalize (post-fsync)
// so group commit can submit many entries before the single durability-await.
// ---------------------------------------------------------------------------

/// Max commands per group-commit window. A burst larger than this still
/// collapses to ceil(N / WINDOW) commit-index fsyncs instead of N.
const GROUP_COMMIT_WINDOW: usize = 32;

/// A command whose index entry has been submitted to the batcher but whose
/// durability-await has not yet completed. Finalization (projection application,
/// watermark advance, ack) happens after the window's shared flush.
struct PreparedCommand {
    commit_seq: u64,
    timestamp_micros: i64,
    command: CommandCommit,
}

async fn prepare_command(
    key_registry: &Arc<tokio::sync::Mutex<StreamKeyRegistry>>,
    writers: &mut HashMap<String, WriterEntry>,
    batcher: &BatcherHandle,
    data_dir: &Path,
    command: &CommandCommit,
    commit_seq: u64,
    timestamp_micros: i64,
) -> Result<()> {
    // The current encrypted record format uses commit_seq as the nonce for
    // each stream key. Two events in the same stream within one command
    // would reuse that (key, nonce). Reject before writing any bytes.
    let mut streams = std::collections::HashSet::new();
    for event in &command.events {
        if !crate::stream_identity::is_safe_stream_id(&event.stream_id) {
            return Err(WabiError::Validation {
                command: command.command_name.clone(),
                reason: "stream ID is not a bounded single directory component".into(),
            });
        }
        if !streams.insert(&event.stream_id) {
            return Err(WabiError::Validation {
                command: command.command_name.clone(),
                reason: "a command may write at most one event per stream (nonce uniqueness)"
                    .into(),
            });
        }
    }
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
            registry
                .get_active_key(&event.stream_id, commit_seq)?
                .clone()
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
        let payload_len =
            envelope
                .len()
                .checked_add(TAG_LEN)
                .ok_or_else(|| WabiError::Validation {
                    command: command.command_name.clone(),
                    reason: "payload overflow with GCM tag".into(),
                })? as u32;

        // Build the record header (payload_crc32c = 0; GCM tag is the integrity check).
        let header = RecordHeader::new(event.record_kind, commit_seq, stream_hash, payload_len, 0);
        let header_bytes = header.encode();

        // Encrypt: returns ciphertext || gcm_tag.
        let ciphertext = encrypt_record(&key.key_material, commit_seq, &header_bytes, &envelope)?;

        // Compute BLAKE3 of the encrypted payload for the commit index.
        let payload_hash = blake3::hash(&ciphertext);
        payload_hashes.push(*payload_hash.as_bytes());

        // Get or create the segment writer for this stream.
        let entry = get_or_create_writer(writers, data_dir, event).await?;

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

    // --- 1.5 Flush segment writers BEFORE the commit index append -------
    // The commit index fsync is the durability point of the commit; every
    // segment byte it references must be on stable storage first (WAL
    // ordering). Without this, a power loss after the index fsync can leave
    // an acknowledged commit pointing at page-cache-only segment bytes.
    // (Writers rotated out above were closed, which flushes them.)
    for event in &command.events {
        if let Some(entry) = writers.get_mut(&event.stream_id) {
            entry.writer.flush().await?;
        }
    }

    // --- 2. Build and submit the commit index entry -----------------------
    // Boundary 2: crash after all stream segments are written but before
    // the commit index entry is appended (tests Option B orphan skip).
    crash_point("crash_before_index_fsync");
    let caller_device_id_hash = device_id_hash(&command.caller_device_id);
    let command_name_hash = name_hash(&command.command_name);
    let idempotency_hash = command
        .idempotency_key
        .as_ref()
        .map(|key| idempotency_key_hash(command.caller_user_id, &command.caller_device_id, key));

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

    // Durability-await happens ONCE PER WINDOW in `run()` — see group commit.
    // Boundary 3 fires after the shared fsync, inside finalize_command.

    Ok(())
}

/// Post-fsync finalization: dispatch a whole command, await application,
/// and produce the ack. The dispatcher owns the applied watermark.
/// Runs strictly in commit_seq order after the window's fsync completes.
async fn finalize_command(
    dispatcher_tx: &mpsc::Sender<DispatchCommit>,
    command: &CommandCommit,
    commit_seq: u64,
    timestamp_micros: i64,
) -> Result<CommandOutcome> {
    // Boundary 3: crash after the commit index is fsynced but before the
    // projection is updated (tests durability-await correctness).
    crash_point("crash_after_index_fsync");

    // --- 4. Send to the projection dispatcher ----------------------------
    let (applied_tx, applied_rx) = tokio::sync::oneshot::channel();
    let events = command
        .events
        .iter()
        .map(|event| DispatchItem {
            commit_seq,
            event_type: event.event_type.clone(),
            stream_id: event.stream_id.clone(),
            payload: event.plaintext.clone(),
        })
        .collect();
    // Every command here is durable, regardless of priority. Backpressure
    // must wait; EngineBusy is only safe BEFORE admission to the sequencer.
    dispatcher_tx
        .send(DispatchCommit {
            commit_seq,
            events,
            applied_tx,
        })
        .await
        .map_err(|_| WabiError::InternalInvariantViolated {
            invariant: format!(
                "durable commit {commit_seq} could not reach projection dispatcher; engine halted"
            ),
        })?;
    applied_rx
        .await
        .map_err(|_| WabiError::InternalInvariantViolated {
            invariant: format!(
                "durable commit {commit_seq} lost projection acknowledgment; engine halted"
            ),
        })??;

    // Boundary 4: crash after the projection dispatcher applies the commit
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
    data_dir: &Path,
    event: &EventToWrite,
) -> Result<&'a mut WriterEntry> {
    let stream_id = event.stream_id.as_str();
    if !writers.contains_key(stream_id) {
        // Resolve the directory only when opening a writer: the raw/encoded
        // choice is made once per segment, not on every append.
        let events_dir = stream_events_dir(data_dir, event.stream_kind, stream_id)?;
        let writer = SegmentWriter::open(&events_dir, stream_id.to_string()).await?;
        writers.insert(stream_id.to_string(), WriterEntry { writer });
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
                // Write a crash signal file BEFORE exiting. This lets the
                // parent distinguish an intentional crash at this boundary
                // from a fallback panic ("child did not crash") or unrelated
                // failure. Without this, any non-zero exit satisfies the
                // parent's status check — a false positive.
                if let Ok(dir) = std::env::var("WABIDB_DATA_DIR") {
                    let signal_path = std::path::Path::new(&dir).join("crash_signal.txt");
                    let _ = std::fs::write(&signal_path, name);
                }
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
mod stream_dir_name_tests {
    use super::*;

    /// Server stream ids that contain `:` (Task 1.0j). Several are written on
    /// first boot, which is why the Authority could not start on Windows.
    const COLON_IDS: &[&str] = &[
        "community-roster:v1",
        "service-access:v1",
        "rbac:default-workspace",
        "user:42",
        "channel_members:ch_1",
        "call_session:ch_1",
        "channels:ch_1",
        "reactions:msg_1:👍🏽:removed",
    ];

    const WINDOWS_FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    fn assert_windows_safe(id: &str, name: &str) {
        assert!(!name.is_empty(), "{id:?} encoded to an empty name");
        assert!(
            !name.contains(WINDOWS_FORBIDDEN),
            "{id:?} -> {name:?} contains a character Windows forbids"
        );
        assert!(
            !name.bytes().any(|b| b < 0x20 || b == 0x7f),
            "{id:?} -> {name:?} contains a control byte"
        );
        assert!(
            !name.ends_with('.') && !name.ends_with(' '),
            "{id:?} -> {name:?} ends in a dot or space"
        );
        assert!(
            !is_windows_reserved_name(name),
            "{id:?} -> {name:?} is a Windows device name"
        );
        assert!(name.is_ascii(), "{id:?} -> {name:?} is not ASCII");
    }

    fn assert_round_trip(id: &str) -> String {
        let name = stream_dir_name(id);
        assert_eq!(
            stream_id_from_dir_name(&name).as_deref(),
            Some(id),
            "{id:?} -> {name:?} does not decode back"
        );
        assert_windows_safe(id, &name);
        name
    }

    #[test]
    fn colon_ids_round_trip_to_windows_safe_names() {
        for id in COLON_IDS {
            let name = assert_round_trip(id);
            assert_ne!(&name, id, "{id:?} must be encoded");
        }
        assert_eq!(stream_dir_name("community-roster:v1"), "community-roster%3Av1");
    }

    #[test]
    fn every_forbidden_and_control_character_is_encoded_reversibly() {
        let mut specials: Vec<char> = WINDOWS_FORBIDDEN.to_vec();
        specials.extend(['%', ' ', '\0', '\t', '\n', '\u{1f}', '\u{7f}', 'é', '👍']);
        for special in specials {
            for id in [
                format!("{special}"),
                format!("a{special}b"),
                format!("{special}lead"),
                format!("trail{special}"),
            ] {
                let name = assert_round_trip(&id);
                assert_ne!(name, id, "{id:?} must be encoded");
            }
        }
    }

    #[test]
    fn portable_ids_keep_their_existing_directory_name() {
        for id in ["channels", "server_meta", "room-1", "ch_test", "legacy.room-1", "a", "con-x", "COM10", "LPTX", "CONSOLE"] {
            assert_eq!(stream_dir_name(id), id);
            assert_eq!(stream_id_from_dir_name(id).as_deref(), Some(id));
            assert_windows_safe(id, id);
        }
    }

    #[test]
    fn device_names_and_trailing_dots_are_encoded() {
        for id in [
            "CON", "con", "Prn", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "COM0", "LPT0",
            "NUL.txt", "con.tar.gz", "aux.", "trailing.", "dots..", ".", "..", "CON.",
        ] {
            let name = assert_round_trip(id);
            assert_ne!(name, id, "{id:?} must be encoded");
        }
        assert_eq!(stream_dir_name("CON"), "%43ON");
        assert_eq!(stream_dir_name("nul.txt"), "%6Eul.txt");
        assert_eq!(stream_dir_name("trailing."), "trailing%2E");
        assert_eq!(stream_dir_name(".."), ".%2E");
    }

    #[test]
    fn decoding_is_canonical_so_the_mapping_is_injective() {
        // Raw legacy names are not encodings; readers use them as they are.
        for raw in ["community-roster:v1", "a b", "x%", "x%3", "x%zz", "x%3a", "%41", "CON", "end."] {
            assert_eq!(stream_id_from_dir_name(raw), None, "{raw:?}");
        }
        // `%` is always escaped, so `a%3Ab` and `a:b` get distinct names.
        assert_eq!(stream_dir_name("a:b"), "a%3Ab");
        assert_eq!(stream_dir_name("a%3Ab"), "a%253Ab");
        assert_eq!(stream_id_from_dir_name("a%253Ab").as_deref(), Some("a%3Ab"));
    }

    #[test]
    fn directory_candidates_accept_raw_and_encoded_names() {
        assert_eq!(stream_id_candidates("community-roster:v1"), vec!["community-roster:v1"]);
        assert_eq!(
            stream_id_candidates("community-roster%3Av1"),
            vec!["community-roster%3Av1", "community-roster:v1"]
        );
        assert_eq!(stream_id_candidates("channels"), vec!["channels"]);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_prefers_an_existing_raw_directory_and_encodes_new_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path();
        assert_eq!(resolve_stream_dir(parent, "a:b").unwrap(), parent.join("a%3Ab"));
        std::fs::create_dir(parent.join("a:b")).unwrap();
        assert_eq!(resolve_stream_dir(parent, "a:b").unwrap(), parent.join("a:b"));
        assert_eq!(resolve_stream_dir(parent, "plain").unwrap(), parent.join("plain"));
    }

    #[tokio::test]
    async fn resolve_refuses_an_encoded_directory_owned_by_a_legacy_raw_stream() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path();
        // A legacy raw id spelled exactly like the encoding of "a:b".
        let legacy = "a%3Ab";
        let events = parent.join(legacy).join("events");
        let mut writer = SegmentWriter::open(&events, legacy.into()).await.unwrap();
        let header = RecordHeader::new(
            crate::format::record::RecordKind::Event,
            1,
            crate::stream_identity::stream_id_hash(legacy),
            4,
            0,
        );
        writer.append(&header, b"data").await.unwrap();
        writer.close().await.unwrap();

        assert!(resolve_stream_dir(parent, "a:b").is_err());
        // The legacy stream itself still resolves to its raw directory.
        if !cfg!(windows) {
            assert_eq!(resolve_stream_dir(parent, legacy).unwrap(), parent.join(legacy));
        }
    }

    #[tokio::test]
    async fn resolve_does_not_reuse_another_streams_encoded_directory_as_raw() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path();
        // A new tree: "a:b" wrote its encoded directory "a%3Ab".
        let events = resolve_stream_dir(parent, "a:b").unwrap().join("events");
        assert_eq!(events, parent.join("a%3Ab").join("events"));
        let mut writer = SegmentWriter::open(&events, "a:b".into()).await.unwrap();
        let header = RecordHeader::new(
            crate::format::record::RecordKind::Event,
            1,
            crate::stream_identity::stream_id_hash("a:b"),
            4,
            0,
        );
        writer.append(&header, b"data").await.unwrap();
        writer.close().await.unwrap();

        // A later stream whose literal id is "a%3Ab" must get its own
        // encoded directory, not share the one "a:b" owns.
        assert_eq!(resolve_stream_dir(parent, "a%3Ab").unwrap(), parent.join("a%253Ab"));
        assert_eq!(resolve_stream_dir(parent, "a:b").unwrap(), parent.join("a%3Ab"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{RecordHeader, RecordKind};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{oneshot, Semaphore};

    use crate::engine::locks::ProjectionState;
    use crate::projections::barrier::LinearizabilityBarrier;

    fn test_dispatcher() -> mpsc::Sender<DispatchCommit> {
        crate::engine::locks::spawn_projection_dispatcher(
            Arc::new(ProjectionState::new()),
            Arc::new(crate::projections::handler::DispatchTable::new(vec![]).unwrap()),
            Some(16),
            None,
            None,
        )
        .unwrap()
        .sender
    }
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
            room_owner_precondition: None,
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
        tokio::fs::create_dir_all(&commit_index_dir).await.unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        // Create dispatcher.
        let dispatcher_tx = test_dispatcher();

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
                cmd_rx,
                data_dir,
                0,
                Arc::new(tokio::sync::RwLock::new(false)),
                Arc::new(ProjectionState::new()),
                "node-1".into(),
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
    async fn completion_waits_for_projection_application() {
        let state = Arc::new(ProjectionState::new());
        let barrier = Arc::new(LinearizabilityBarrier::new(state));
        let (dispatcher_tx, mut dispatcher_rx) = mpsc::channel(1);
        let (cmd, _rx) = make_cmd(1, true, "ch_delayed", 1, b"not visible yet");
        let completion = finalize_command(&dispatcher_tx, &cmd, 1, 1);
        tokio::pin!(completion);

        tokio::select! {
            biased;
            result = &mut completion => panic!("acknowledged before application: {result:?}"),
            item = dispatcher_rx.recv() => {
                assert_eq!(barrier.current(), 0, "dispatch is not application");
                item.unwrap().applied_tx.send(Ok(())).unwrap();
            }
        }
        assert_eq!(completion.await.unwrap().commit_seq, 1);
    }

    #[tokio::test]
    async fn happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_test", [0xABu8; 32])
            .unwrap();

        let (cmd, rx) = make_cmd(1, true, "ch_test", 1, b"hello");
        let result =
            run_sequencer_with_commands(dir.path().to_path_buf(), registry, vec![cmd]).await;

        assert!(result.is_ok(), "sequencer exited with error: {result:?}");

        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.commit_seq, 1);
        assert!(outcome.timestamp_micros > 0);
    }

    #[tokio::test]
    async fn fence_waits_for_prior_application_and_rejects_queued_commands() {
        use std::future::Future;
        use std::task::Poll;

        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("fenced-room", [7; 32])
            .unwrap();
        let index_dir = dir.path().join("global/commit-index");
        tokio::fs::create_dir_all(&index_dir).await.unwrap();
        let (batcher, batcher_task) =
            crate::commit_index::batcher::new_batcher(index_dir, None, None);
        tokio::spawn(batcher_task);
        let permit = SequencerPermit::acquire(&Arc::new(Semaphore::new(1)))
            .await
            .unwrap();
        let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<DispatchCommit>(1);
        let (tx, rx) = mpsc::channel::<CommandCommit>(2);
        let gate = Arc::new(tokio::sync::RwLock::new(false));
        let sequencer = tokio::spawn(run(
            permit,
            registry,
            batcher,
            dispatch_tx,
            rx,
            dir.path().into(),
            0,
            gate.clone(),
            Arc::new(ProjectionState::new()),
            "node-1".into(),
        ));

        let (first, first_ack) = make_cmd(1, true, "fenced-room", 6, b"first");
        tx.send(first).await.unwrap();
        let pending_application = dispatch_rx.recv().await.unwrap();
        let mut fence_waiter = Box::pin(gate.write());
        std::future::poll_fn(|cx| match fence_waiter.as_mut().poll(cx) {
            Poll::Pending => Poll::Ready(()),
            Poll::Ready(_) => panic!("fence crossed an unacknowledged commit"),
        })
        .await;

        let (second, second_ack) = make_cmd(2, true, "fenced-room", 6, b"second");
        tx.send(second).await.unwrap();
        pending_application.applied_tx.send(Ok(())).unwrap();
        assert_eq!(first_ack.await.unwrap().unwrap().commit_seq, 1);
        let mut fenced = fence_waiter.await;
        *fenced = true;
        drop(fenced);
        assert!(matches!(second_ack.await.unwrap(), Err(WabiError::WriterFenced)));
        drop(tx);
        sequencer.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn failed_application_stops_a_durable_group_without_dispatching_later_commands() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("group", [42; 32])
            .unwrap();
        let index_dir = dir.path().join("global/commit-index");
        tokio::fs::create_dir_all(&index_dir).await.unwrap();
        let (batcher, batcher_task) =
            crate::commit_index::batcher::new_batcher(index_dir.clone(), None, None);
        tokio::spawn(batcher_task);
        let permit = SequencerPermit::acquire(&Arc::new(Semaphore::new(1)))
            .await
            .unwrap();
        let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<DispatchCommit>(1);
        let (tx, rx) = mpsc::channel(2);
        let (first, first_ack) = make_cmd(1, true, "group", 6, b"first");
        let (later, later_ack) = make_cmd(2, true, "group", 6, b"later");
        tx.try_send(first).unwrap();
        tx.try_send(later).unwrap();
        let sequencer = tokio::spawn(run(
            permit,
            registry,
            batcher,
            dispatch_tx,
            rx,
            dir.path().into(),
            0,
            Arc::new(tokio::sync::RwLock::new(false)),
            Arc::new(ProjectionState::new()),
            "node-1".into(),
        ));
        let batch = dispatch_rx.recv().await.unwrap();
        assert_eq!(batch.commit_seq, 1);
        let entries = crate::commit_index::batcher::read_all_entries(&index_dir).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.commit_seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        batch
            .applied_tx
            .send(Err(WabiError::InternalInvariantViolated {
                invariant: "injected apply failure".into(),
            }))
            .unwrap();
        assert!(first_ack.await.unwrap().is_err());
        let error = later_ack.await.unwrap().unwrap_err();
        assert!(
            error.to_string().contains("durable commit 2 not applied"),
            "{error}"
        );
        assert!(sequencer.await.unwrap().is_err());
        assert!(dispatch_rx.recv().await.is_none());
        assert!(tx.is_closed());
    }

    // -----------------------------------------------------------------------
    // 2. atomic_commit_happy_path (100 commands)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn atomic_commit_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
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

        let result = run_sequencer_with_commands(dir.path().to_path_buf(), registry, cmds).await;
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
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
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
    // 3a. initial_commit_seq seeds the counter (restart safety)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn initial_commit_seq_seeds_counter() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_seed", [0xABu8; 32])
            .unwrap();

        // Simulate a restart after 100 prior commits: the engine passes the
        // recovered high-water mark and the sequencer must continue above it.
        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir).await.unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        let dispatcher_tx = test_dispatcher();

        let (cmd, rx) = make_cmd(1, true, "ch_seed", 1, b"after restart");
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
        cmd_tx.send(cmd).await.unwrap();
        drop(cmd_tx);

        let handle = tokio::spawn(async move {
            run(
                permit,
                registry,
                batcher,
                dispatcher_tx,
                cmd_rx,
                dir.path().to_path_buf(),
                100,
                Arc::new(tokio::sync::RwLock::new(false)),
                Arc::new(ProjectionState::new()),
                "node-1".into(),
            )
            .await
        });

        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(
            outcome.commit_seq, 101,
            "sequencer must continue above the recovered high-water mark"
        );

        handle.await.unwrap().unwrap();
    }

    // -----------------------------------------------------------------------
    // 5. group commit: concurrent commands share fsyncs
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn group_commit_shares_fsyncs_under_concurrency() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_gc", [0xABu8; 32])
            .unwrap();

        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir).await.unwrap();
        // Small max_age so a straggler window can't stall on the deadline.
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir.clone(),
            Some(10),
            Some(Duration::from_millis(25)),
        );
        tokio::spawn(batcher_fut);

        let dispatcher_tx = test_dispatcher();

        let n = 24u64;
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(256);

        let handle = tokio::spawn(async move {
            run(
                permit,
                registry,
                batcher,
                dispatcher_tx,
                cmd_rx,
                dir.path().to_path_buf(),
                0,
                Arc::new(tokio::sync::RwLock::new(false)),
                Arc::new(ProjectionState::new()),
                "node-1".into(),
            )
            .await
        });

        // N independent producers fire concurrently, like real chat traffic.
        let mut rxs = Vec::new();
        let mut senders = Vec::new();
        for i in 0..n {
            let (cmd, rx) = make_cmd(i + 1, true, "ch_gc", 1, b"burst");
            rxs.push(rx);
            let tx = cmd_tx.clone();
            senders.push(tokio::spawn(async move {
                tx.send(cmd).await.unwrap();
            }));
        }
        drop(cmd_tx);
        for s in senders {
            s.await.unwrap();
        }

        for (i, rx) in rxs.into_iter().enumerate() {
            let outcome = rx.await.unwrap().unwrap();
            assert_eq!(outcome.commit_seq, (i + 1) as u64, "seq order must hold");
        }
        handle.await.unwrap().unwrap();

        // Occupancy proof: with the old submit+flush_now-per-command loop,
        // 24 concurrent commands produced 24 non-empty flushes. Group commit
        // must collapse them into strictly fewer.
        let (flushes, _last_batch) =
            crate::commit_index::batcher::flush_stats::get(&commit_index_dir);
        assert!(
            flushes < n as usize,
            "group commit failed: {n} commands caused {flushes} flushes (expected < {n})"
        );
        // A final one-entry straggler says nothing about earlier windows.
        // Fewer nonempty flushes than commands proves at least one shared
        // fsync without assuming the scheduler's final batch occupancy.
    }

    // -----------------------------------------------------------------------
    // 6. dispatcher backpressure
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
        let mut orphan_writer = SegmentWriter::open(&orphan_dir, "ch_orphan".into())
            .await
            .unwrap();
        let orphan_header = RecordHeader::new(
            RecordKind::Event,
            999, // commit_seq not in any commit index
            [0xBBu8; 16],
            4,
            0,
        );
        orphan_writer.append(&orphan_header, b"orph").await.unwrap();
        orphan_writer.close().await.unwrap();

        // Now run the sequencer with a legitimate stream.
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_ok", [0xABu8; 32])
            .unwrap();

        let (cmd, rx) = make_cmd(1, true, "ch_ok", 1, b"real");
        let result =
            run_sequencer_with_commands(dir.path().to_path_buf(), registry, vec![cmd]).await;
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
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_bp", [0xABu8; 32])
            .unwrap();

        // Create dispatcher with a tiny channel that we fill.
        let (dispatcher_tx, mut dispatch_rx) = mpsc::channel::<DispatchCommit>(1);

        // Fill the channel.
        dispatcher_tx
            .try_send(
                DispatchItem {
                    commit_seq: 0,
                    event_type: "filler".into(),
                    stream_id: "filler".into(),
                    payload: vec![],
                }
                .into(),
            )
            .unwrap();

        // A durable non-essential command must wait, never return EngineBusy.
        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir).await.unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        let (cmd, rx) = make_cmd(1, false, "ch_bp", 1, b"non-essential");
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
        cmd_tx.send(cmd).await.unwrap();
        drop(cmd_tx);

        let sequencer = run(
            permit,
            registry,
            batcher,
            dispatcher_tx,
            cmd_rx,
            dir.path().to_path_buf(),
            0,
            Arc::new(tokio::sync::RwLock::new(false)),
            Arc::new(ProjectionState::new()),
            "node-1".into(),
        );
        tokio::pin!(sequencer);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut sequencer)
                .await
                .is_err()
        );
        // The command is already indexed but is still waiting for capacity.
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap()
                .len(),
            1
        );
        dispatch_rx.recv().await.unwrap(); // release the filler slot
        tokio::select! {
            biased;
            result = &mut sequencer => panic!("finished without application: {result:?}"),
            commit = dispatch_rx.recv() => {
                commit.unwrap().applied_tx.send(Ok(())).unwrap();
            }
        }
        sequencer.await.unwrap();

        assert_eq!(rx.await.unwrap().unwrap().commit_seq, 1);
    }

    // -----------------------------------------------------------------------
    // 6. essential_command_under_backpressure
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn essential_command_under_backpressure() {
        let dir = tempfile::tempdir().unwrap();
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_ess", [0xABu8; 32])
            .unwrap();

        // Use a channel with enough capacity (essential commands must not be
        // rejected). We send to a slow receiver to verify the essential path
        // doesn't return EngineBusy.
        let dispatcher_tx = test_dispatcher();

        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir).await.unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir,
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

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
                cmd_rx,
                dir.path().to_path_buf(),
                0,
                Arc::new(tokio::sync::RwLock::new(false)),
                Arc::new(ProjectionState::new()),
                "node-1".into(),
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
        let registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>> =
            Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));
        registry
            .lock()
            .await
            .create_stream("ch_durable", [0xABu8; 32])
            .unwrap();

        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await.unwrap();

        let commit_index_dir = dir.path().join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir).await.unwrap();
        let (batcher, batcher_fut) = crate::commit_index::batcher::new_batcher(
            commit_index_dir.clone(),
            Some(10),
            Some(Duration::from_millis(50)),
        );
        tokio::spawn(batcher_fut);

        let dispatcher_tx = test_dispatcher();

        let (cmd, rx) = make_cmd(1, true, "ch_durable", 1, b"data");
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(16);
        cmd_tx.send(cmd).await.unwrap();
        drop(cmd_tx);

        let result = run(
            permit,
            registry,
            batcher,
            dispatcher_tx,
            cmd_rx,
            dir.path().to_path_buf(),
            0,
            Arc::new(tokio::sync::RwLock::new(false)),
            Arc::new(ProjectionState::new()),
            "node-1".into(),
        )
        .await;
        assert!(result.is_ok());

        // The command should return Ok (durability guarantee met).
        let outcome = rx.await.unwrap().unwrap();
        assert_eq!(outcome.commit_seq, 1);

        // Verify the batcher actually wrote a file.
        let entries = crate::commit_index::batcher::read_all_entries(&commit_index_dir).unwrap();
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
