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
//!
//! # Quarantined commits (Task 3.2)
//!
//! Commits listed in `global/quarantine.json` (see `engine::quarantine`) are
//! skipped whole, with a warn log naming each. Their records are passed over
//! like orphans, before decryption, so a quarantined commit needs none of its
//! events recovered to count as complete. A handler error or panic on any
//! other commit fails replay with a `Corrupt` error naming that commit.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};
use std::path::{Path, PathBuf};

use tokio::sync::Mutex;

use crate::commit_index::record::CommitIndexEntry;
use crate::crypto::aes_gcm_record::decrypt_record;
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::{DispatchTable, DurableEvent};
use crate::sequencer::types::ReplayEnvelope;
use crate::stream_log::segment_reader::{SegmentReader, ValidRecord};

/// Test hook: how many decoded events replay holds at once (Task 1.12).
///
/// A [`Token`](held_events::Token) lives beside every decoded event replay
/// keeps. A test calls [`track`](held_events::track) on its thread first;
/// tokens created on that thread count toward the returned counter, and
/// every other replay counts nothing.
#[cfg(test)]
pub(crate) mod held_events {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    pub(crate) struct Counter {
        held: AtomicUsize,
        peak: AtomicUsize,
    }

    impl Counter {
        /// The most tokens alive at once since `track`.
        pub(crate) fn peak(&self) -> usize {
            self.peak.load(Ordering::SeqCst)
        }
    }

    thread_local! {
        static TRACKED: RefCell<Option<Arc<Counter>>> = const { RefCell::new(None) };
    }

    /// Count tokens created on this thread from now on.
    pub(crate) fn track() -> Arc<Counter> {
        let counter = Arc::new(Counter::default());
        TRACKED.with(|t| *t.borrow_mut() = Some(counter.clone()));
        counter
    }

    pub(crate) struct Token(Option<Arc<Counter>>);

    impl Token {
        pub(crate) fn new() -> Self {
            let counter = TRACKED.with(|t| t.borrow().clone());
            if let Some(counter) = &counter {
                let held = counter.held.fetch_add(1, Ordering::SeqCst) + 1;
                counter.peak.fetch_max(held, Ordering::SeqCst);
            }
            Token(counter)
        }
    }

    impl Drop for Token {
        fn drop(&mut self) {
            if let Some(counter) = &self.0 {
                counter.held.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

#[cfg(not(test))]
mod held_events {
    pub(crate) struct Token;

    impl Token {
        #[inline(always)]
        pub(crate) fn new() -> Self {
            Token
        }
    }
}

/// Register the deterministic stream key for `stream_id` unless present.
async fn ensure_derived_key(
    key_registry: &Mutex<StreamKeyRegistry>,
    stream_id: &str,
    bootstrap_key: &[u8; 32],
) -> Result<()> {
    let mut registry = key_registry.lock().await;
    if !registry.has_stream(stream_id) {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"wabi-stream-key-v1");
        hasher.update(stream_id.as_bytes());
        hasher.update(bootstrap_key);
        let key_material = *hasher.finalize().as_bytes();
        registry.create_stream(stream_id, key_material)?;
    }
    Ok(())
}

/// Rebuild projection state by replaying events from the event log.
///
/// Walks every stream's `.wseg` segment files under `data_dir/streams/`,
/// decrypts each record, deserializes the [`ReplayEnvelope`], and dispatches
/// the event through the registered projection handlers, merging the
/// streams in commit order (see the module docs).
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
    replay_projections_with(
        data_dir,
        key_registry,
        bootstrap_key,
        projection_state,
        dispatch_table,
        barrier,
        snapshot_watermark,
        false,
    )
    .await
}

/// [`replay_projections`], optionally also rebuilding the SQLite read model
/// from the whole log. With `rebuild_read_model`, the commits at or below
/// `snapshot_watermark` go only to the read-model part of each handler
/// (`Projection::apply_to_read_model`); every in-memory projection keeps
/// what the snapshot holds, exactly as without a rebuild. Commits above the
/// watermark go to every handler, as always.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn replay_projections_with(
    data_dir: &Path,
    key_registry: &Mutex<StreamKeyRegistry>,
    bootstrap_key: &[u8; 32],
    projection_state: &ProjectionState,
    dispatch_table: &DispatchTable,
    barrier: &LinearizabilityBarrier,
    snapshot_watermark: u64,
    rebuild_read_model: bool,
) -> Result<u64> {
    let mut voice_repair =
        crate::projections::voice_restrictions::LegacyVoiceRepair::from_snapshot(projection_state)?;
    // Refuse to start on an unreadable list rather than skip nothing.
    let quarantine = super::quarantine::load(data_dir)?;
    let streams_dir = data_dir.join("streams");
    // --- Load the committed seq set (Option B orphan filter) ---
    let commit_index_dir = data_dir.join("global").join("commit-index");
    let committed: BTreeMap<_, _> =
        crate::commit_index::batcher::read_all_entries(&commit_index_dir)
            .map(|entries| entries.into_iter().map(|e| (e.commit_seq, e)).collect())?;
    if let Some(repair) = voice_repair.as_mut() {
        // The legacy fallback retained only the last payload per event type,
        // not an inventory of affected pairs. Include every historical
        // kind-1 stream and require its complete indexed history.
        for entry in committed.values().filter(|e| e.commit_seq <= snapshot_watermark) {
            for reference in entry.event_refs.iter().filter(|r| r.stream_kind == 1) {
                repair.include_stream(reference.stream_id_hash);
            }
        }
    }
    let applied_seq = committed
        .keys()
        .copied()
        .max()
        .unwrap_or(0)
        .max(snapshot_watermark);
    if !tokio::fs::try_exists(&streams_dir).await? {
        if committed.values().filter(|e| !quarantine.contains(&e.commit_seq)).any(|e| {
            e.event_refs.iter().any(|r| {
                e.commit_seq > snapshot_watermark
                    || rebuild_read_model
                    || voice_repair
                        .as_ref()
                        .is_some_and(|repair| repair.includes(&r.stream_id_hash))
            })
        }) {
            return Err(crate::error::WabiError::Corrupt {
                location: "streams directory".into(),
                detail: "not all indexed events could be recovered; streams directory missing"
                    .into(),
            });
        }
        for seq in quarantine.iter().filter(|seq| committed.contains_key(seq)) {
            tracing::warn!(
                "replay: skipping quarantined commit {seq}; listed in global/quarantine.json"
            );
        }
        if let Some(repair) = voice_repair {
            repair.finish(projection_state)?;
        }
        barrier.advance(applied_seq)?;
        return Ok(applied_seq);
    }

    let mut tally = Tally {
        highest_seq: applied_seq,
        orphan_skipped: 0,
        decrypt_skipped: 0,
    };
    let mut applier = Applier {
        projection_state,
        dispatch_table,
        snapshot_watermark,
        rebuild_read_model,
        voice_repair,
        quarantine,
        repairs_finished: false,
        replayed: 0,
    };

    // --- Walk every stream directory once: register keys, list segments ---
    // Nothing is decoded or applied until every directory has registered
    // its keys.
    let mut cursors: Vec<StreamCursor> = Vec::new();
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

            let dir_name = stream_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if dir_name.is_empty() {
                continue;
            }

            let events_dir = stream_path.join("events");
            if !tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
                continue;
            }

            // The directory is either a raw stream id (every tree written
            // before Task 1.0j) or its Windows-safe encoding. Each record's
            // header names its stream by hash; use the candidate it names,
            // and the raw name otherwise, exactly as before.
            let candidates: Vec<(String, [u8; 16])> =
                crate::sequencer::stream_id_candidates(&dir_name)
                    .into_iter()
                    .map(|id| {
                        let hash = crate::stream_identity::stream_id_hash(&id);
                        (id, hash)
                    })
                    .collect();

            // --- Ensure the stream encryption keys exist ---
            // Every directory registers its stream's key here, even when a
            // snapshot covers all its records: later writes rely on it. The
            // registry is fresh at startup and keys are derived from the id,
            // so registering an unused candidate changes no other stream.
            for (stream_id, _) in &candidates {
                ensure_derived_key(key_registry, stream_id, bootstrap_key).await?;
            }

            // --- Collect and sort segment paths ---
            // Ascending segment id is the order the writer created them in.
            let mut seg_paths: Vec<(Option<u64>, PathBuf)> = Vec::new();
            {
                let mut seg_reader = tokio::fs::read_dir(&events_dir).await?;
                while let Some(seg) = seg_reader.next_entry().await? {
                    let path = seg.path();
                    if path.extension() == Some(std::ffi::OsStr::new("wseg")) {
                        seg_paths.push((segment_id(&path), path));
                    }
                }
            }
            seg_paths.sort();

            cursors.push(StreamCursor {
                dir: stream_path,
                candidates,
                segments: seg_paths.into_iter().collect(),
                current: None,
                buffered: VecDeque::new(),
                head: None,
            });
        }
    }

    // --- Merge the streams in global (commit_seq, ordinal) order ---
    // Directory iteration order (category dir → stream dir) is
    // filesystem-dependent — ext4 hash order differs per filesystem — and
    // applying each directory in turn let a later-seq event on one stream
    // (e.g. `channel_deleted` on `channels:{id}`) land BEFORE an earlier-seq
    // event on another (the shared `channels` stream's `channel_created`),
    // which resurrected deleted channels on restart ("zombie channels",
    // observed live on wabi.chat 2026-08-27). The sequencer assigns globally
    // unique, totally ordered commit_seqs and appends each stream's records
    // in that order, so a k-way merge over one cursor per stream directory
    // restores exactly the order the live dispatcher applied, while holding
    // only one decoded event per stream plus the commit being assembled.
    let mut heap: BinaryHeap<Reverse<(u64, usize, usize)>> = BinaryHeap::new();
    for (index, cursor) in cursors.iter_mut().enumerate() {
        if let Some(event) = cursor
            .next_event(&applier, &committed, key_registry, &mut tally)
            .await?
        {
            heap.push(Reverse((event.event.commit_seq, event.ordinal, index)));
            cursor.head = Some(event);
        }
    }

    let mut index_entries = committed.values().peekable();
    // Events of the commit being assembled, in ordinal order. A commit is
    // applied only once every one of its events has been recovered.
    let mut commit: Vec<Decoded> = Vec::new();
    loop {
        let next = heap.pop().map(|Reverse(key)| key);
        if let Some(first) = commit.first() {
            let seq = first.event.commit_seq;
            if next.map(|(next_seq, _, _)| next_seq) != Some(seq) {
                // Every later record sorts after `seq`: the commit is whole.
                applier.complete_commit(&mut index_entries, seq, std::mem::take(&mut commit))?;
            }
        }
        let Some((commit_seq, ordinal, index)) = next else {
            break;
        };
        let cursor = &mut cursors[index];
        let event = cursor.head.take().ok_or_else(|| {
            crate::error::WabiError::InternalInvariantViolated {
                invariant: "replay merge entry has no stream head".into(),
            }
        })?;
        if let Some(following) = cursor
            .next_event(&applier, &committed, key_registry, &mut tally)
            .await?
        {
            let key = (following.event.commit_seq, following.ordinal);
            if key == (commit_seq, ordinal) {
                return Err(duplicate_event(commit_seq, ordinal));
            }
            // The merge is only correct if each directory is in commit
            // order. Never guess: refuse startup if one is not.
            if key < (commit_seq, ordinal) {
                return Err(crate::error::WabiError::Corrupt {
                    location: format!("stream directory {}", cursor.dir.display()),
                    detail: format!(
                        "indexed records out of commit order (commit {} after commit {commit_seq}); \
                         repair required before startup",
                        key.0
                    ),
                });
            }
            heap.push(Reverse((key.0, key.1, index)));
            cursor.head = Some(following);
        }
        // Another directory holding the same indexed record.
        if commit.last().is_some_and(|last| last.ordinal == ordinal) {
            return Err(duplicate_event(commit_seq, ordinal));
        }
        commit.push(event);
    }

    // Never report readiness after silently losing part of a durable commit.
    for entry in index_entries {
        applier.check_recovered(entry, 0)?;
    }
    applier.finish_repairs()?;
    let replayed = applier.replayed;
    let Tally {
        highest_seq,
        orphan_skipped,
        decrypt_skipped,
    } = tally;

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

/// Raw records one stream cursor reads per file open. The segment file is
/// closed between batches, so a tree with many streams never holds one open
/// file per stream; buffered memory is at most this many raw records per
/// stream directory.
const READ_AHEAD_RECORDS: usize = 32;

/// Segment number from a `NNNNNNNN.wseg` path, if it has one.
fn segment_id(path: &Path) -> Option<u64> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|s| s.parse::<u64>().ok())
}

fn duplicate_event(commit_seq: u64, ordinal: usize) -> crate::error::WabiError {
    crate::error::WabiError::Corrupt {
        location: format!("commit {commit_seq} event {ordinal}"),
        detail: "duplicate indexed event during replay".into(),
    }
}

/// The text of a caught panic payload, when it carries one.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

/// Counts every record header replay sees, applied or not.
struct Tally {
    /// Highest commit_seq on disk, orphans included (nonce safety).
    highest_seq: u64,
    orphan_skipped: u64,
    decrypt_skipped: u64,
}

/// A decoded event waiting in the merge, with its index in its commit.
struct Decoded {
    ordinal: usize,
    event: DurableEvent,
    _held: held_events::Token,
}

/// The segment a cursor is reading.
struct CurrentSegment {
    path: PathBuf,
    id: Option<u64>,
    /// Byte offset of the next unread record.
    resume_at: u64,
    /// The valid prefix has been read to its end.
    exhausted: bool,
}

/// One stream directory's position in the replay merge.
struct StreamCursor {
    dir: PathBuf,
    candidates: Vec<(String, [u8; 16])>,
    /// Segments not yet started, ascending.
    segments: VecDeque<(Option<u64>, PathBuf)>,
    current: Option<CurrentSegment>,
    /// Raw records read ahead from `current`.
    buffered: VecDeque<ValidRecord>,
    /// The next decoded event of this directory, if any.
    head: Option<Decoded>,
}

impl StreamCursor {
    /// The next valid record of this directory, with its segment id.
    async fn next_record(&mut self) -> Option<(ValidRecord, Option<u64>)> {
        loop {
            let Some(segment) = self.current.as_mut() else {
                let (id, path) = self.segments.pop_front()?;
                self.current = Some(CurrentSegment {
                    path,
                    id,
                    resume_at: 0,
                    exhausted: false,
                });
                continue;
            };
            if let Some(record) = self.buffered.pop_front() {
                return Some((record, segment.id));
            }
            if segment.exhausted {
                self.current = None;
                continue;
            }
            let mut reader = match SegmentReader::open_at(&segment.path, segment.resume_at).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(
                        "replay: skipping unreadable segment {}: {e}",
                        segment.path.display()
                    );
                    segment.exhausted = true;
                    continue;
                }
            };
            while self.buffered.len() < READ_AHEAD_RECORDS {
                match reader.next_record().await {
                    Ok(Some(record)) => self.buffered.push_back(record),
                    Ok(None) => {
                        segment.exhausted = true;
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "replay: skipping corrupt segment {} from offset {}: {e}",
                            segment.path.display(),
                            reader.cursor()
                        );
                        segment.exhausted = true;
                        break;
                    }
                }
            }
            segment.resume_at = reader.cursor();
        }
    }

    /// The next record of this directory that replay must apply or show a
    /// repair pass, decrypted and decoded. Every record read on the way
    /// counts toward `tally`.
    async fn next_event(
        &mut self,
        applier: &Applier<'_>,
        committed: &BTreeMap<u64, CommitIndexEntry>,
        key_registry: &Mutex<StreamKeyRegistry>,
        tally: &mut Tally,
    ) -> Result<Option<Decoded>> {
        while let Some((rec, segment_id)) = self.next_record().await {
            let commit_seq = rec.header.commit_seq;

            // Track the max seq seen on disk BEFORE any filtering:
            // even skipped/orphaned records consumed their nonce and
            // must never be reused by a restarted sequencer.
            tally.highest_seq = tally.highest_seq.max(commit_seq);

            // Old snapshots could acknowledge ignored membership or
            // voice restrictions. Recover their required history;
            // unrelated events remain covered by the snapshot.
            if !applier.wanted(commit_seq, &rec.header.stream_id_hash) {
                continue;
            }

            // Option B: records absent from the commit index are
            // orphans of partially-committed commands — skip them.
            let Some(entry) = committed.get(&commit_seq) else {
                tally.orphan_skipped += 1;
                continue;
            };

            let header_bytes = rec.header.encode();
            let stream_id = self
                .candidates
                .iter()
                .find(|(_, hash)| *hash == rec.header.stream_id_hash)
                .unwrap_or(&self.candidates[0])
                .0
                .as_str();

            // Look up the stream key for this commit_seq range.
            let key = {
                let registry = key_registry.lock().await;
                match registry.get_active_key(stream_id, commit_seq) {
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
                    tally.decrypt_skipped += 1;
                    tracing::debug!(
                        "replay: decrypt failed for stream={stream_id} seq={commit_seq}: {e}"
                    );
                    continue;
                }
            };

            // Deserialize the replay envelope.
            // Indexed decode failures are rejected by the completeness
            // check; old records need an explicit migration.
            let envelope: ReplayEnvelope = match serde_json::from_slice(&env_bytes) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Preserve the command's event order across streams.
            // Ordering by seq alone leaves ties in filesystem order.
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
                    detail: "segment record not referenced by its commit index entry".into(),
                })?;
            return Ok(Some(Decoded {
                ordinal,
                event: DurableEvent {
                    commit_seq,
                    stream_id: envelope.stream_id,
                    event_type: envelope.event_type,
                    payload: envelope.payload,
                },
                _held: held_events::Token::new(),
            }));
        }
        Ok(None)
    }
}

/// Applies whole commits in order: pre-snapshot events go to the repair
/// passes, post-snapshot events to the projections.
struct Applier<'a> {
    projection_state: &'a ProjectionState,
    dispatch_table: &'a DispatchTable,
    snapshot_watermark: u64,
    /// Also rebuild the read model from the commits at or below the watermark.
    rebuild_read_model: bool,
    voice_repair: Option<crate::projections::voice_restrictions::LegacyVoiceRepair>,
    /// Commits the operator quarantined: never recovered or applied.
    quarantine: BTreeSet<u64>,
    repairs_finished: bool,
    replayed: u64,
}

impl Applier<'_> {
    /// Whether a record of `stream_hash` at `commit_seq` must be recovered:
    /// a record replay [needs](Self::needed), unless its commit is
    /// quarantined.
    fn wanted(&self, commit_seq: u64, stream_hash: &[u8; 16]) -> bool {
        !self.quarantine.contains(&commit_seq) && self.needed(commit_seq, stream_hash)
    }

    /// Every post-snapshot record, and the pre-snapshot history a repair
    /// pass asks for.
    fn needed(&self, commit_seq: u64, stream_hash: &[u8; 16]) -> bool {
        commit_seq > self.snapshot_watermark
            || self.rebuild_read_model
            || self
                .voice_repair
                .as_ref()
                .is_some_and(|repair| repair.includes(stream_hash))
    }

    /// Fail unless exactly the wanted events of `entry` were recovered.
    /// Called once per index entry, in commit order.
    fn check_recovered(&self, entry: &CommitIndexEntry, recovered: usize) -> Result<()> {
        if self.quarantine.contains(&entry.commit_seq)
            && entry
                .event_refs
                .iter()
                .any(|r| self.needed(entry.commit_seq, &r.stream_id_hash))
        {
            tracing::warn!(
                "replay: skipping quarantined commit {} (events={}); listed in global/quarantine.json",
                entry.commit_seq,
                entry.event_refs.len()
            );
        }
        let expected = entry
            .event_refs
            .iter()
            .filter(|r| self.wanted(entry.commit_seq, &r.stream_id_hash))
            .count();
        if recovered != expected {
            return Err(crate::error::WabiError::Corrupt {
                location: format!("commit {}", entry.commit_seq),
                detail: "not all indexed events could be recovered; repair required before startup"
                    .into(),
            });
        }
        Ok(())
    }

    /// Check commit `commit_seq` and every indexed commit before it, then
    /// hand its events, in ordinal order, to the repairs or projections.
    fn complete_commit<'e>(
        &mut self,
        index_entries: &mut std::iter::Peekable<impl Iterator<Item = &'e CommitIndexEntry>>,
        commit_seq: u64,
        events: Vec<Decoded>,
    ) -> Result<()> {
        // Indexed commits with nothing on disk sort before this one.
        while let Some(entry) = index_entries.next_if(|e| e.commit_seq < commit_seq) {
            self.check_recovered(entry, 0)?;
        }
        let entry = index_entries
            .next()
            .filter(|e| e.commit_seq == commit_seq)
            .ok_or_else(|| crate::error::WabiError::InternalInvariantViolated {
                invariant: format!("replayed commit {commit_seq} is not next in the commit index"),
            })?;
        self.check_recovered(entry, events.len())?;

        if commit_seq <= self.snapshot_watermark {
            // Without a read-model rebuild every recovered record is one a
            // repair pass asked for; with one, filter by what each asks for.
            for Decoded { event, .. } in &events {
                let hash: [u8; 16] = blake3::hash(event.stream_id.as_bytes()).as_bytes()[..16]
                    .try_into()
                    .unwrap();
                if let Some(repair) = self.voice_repair.as_mut() {
                    if !self.rebuild_read_model || repair.includes(&hash) {
                        repair.observe(event)?;
                    }
                }
            }
            if self.rebuild_read_model {
                for Decoded { event, .. } in &events {
                    if let Some(handler) = self.dispatch_table.get(&event.event_type) {
                        self.apply_one(handler.as_ref(), event, true)?;
                    }
                }
            }
            return Ok(());
        }

        // All pre-snapshot history has been observed: commits arrive in order.
        self.finish_repairs()?;
        for Decoded { event, .. } in &events {
            if let Some(handler) = self.dispatch_table.get(&event.event_type) {
                self.apply_one(handler.as_ref(), event, false)?;
            } else {
                // Match the live dispatcher's forward-compatible fallback.
                self.projection_state.insert(
                    "events",
                    event.event_type.as_bytes().to_vec(),
                    event.payload.clone(),
                    event.commit_seq,
                );
            }
            self.replayed += 1;
        }
        Ok(())
    }

    /// Apply one event to the projections, or with `read_model_only` only
    /// its read-model part (`Projection::apply_to_read_model`). A panic must
    /// not escape open(); the partly applied state is discarded with the
    /// failed open.
    fn apply_one(
        &self,
        handler: &dyn crate::projections::handler::Projection,
        event: &DurableEvent,
        read_model_only: bool,
    ) -> Result<()> {
        let applied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if read_model_only {
                handler.apply_to_read_model(event, self.projection_state)
            } else {
                handler.apply(event, self.projection_state)
            }
        }));
        let failure = match applied {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(e)) => format!("replay failed: {e}"),
            Err(panic) => format!("handler panicked: {}", panic_message(&*panic)),
        };
        Err(crate::error::WabiError::Corrupt {
            location: format!("projection {} at commit {}", event.event_type, event.commit_seq),
            detail: format!(
                "{failure}; repair required before startup (copy the data \
                 directory, then `wabidb-cli quarantine --seq {}` skips this commit)",
                event.commit_seq
            ),
        })
    }

    /// Finish the repair passes once, before the first post-snapshot event.
    fn finish_repairs(&mut self) -> Result<()> {
        if self.repairs_finished {
            return Ok(());
        }
        self.repairs_finished = true;
        if let Some(repair) = self.voice_repair.take() {
            repair.finish(self.projection_state)?;
        }
        Ok(())
    }
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
            room_owner_precondition: None,
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

    fn test_config(path: &std::path::Path, bootstrap: [u8; 32]) -> WabiDbConfig {
        WabiDbConfig {
            data_dir: path.to_path_buf(),
            bootstrap_source: BootstrapSource::Provided(bootstrap),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        }
    }

    /// Three streams in three kind directories. Two engine incarnations, so
    /// every stream has two segments; the second commit is one command that
    /// writes all three streams.
    const THREE: [(&str, u8); 3] = [("channels", 6), ("channels:ch_1", 1), ("dm:a", 2)];

    async fn commit_all(engine: &crate::engine::WabiDbEngine, streams: &[(&str, u8)]) {
        for (stream, _) in streams {
            engine.get_or_create_stream_key(stream).await.unwrap();
        }
        let (tx, _rx) = tokio::sync::oneshot::channel();
        let cmd = CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 1,
            caller_device_id: "dev".into(),
            command_name: "test_cmd".into(),
            idempotency_key: None,
            events: streams
                .iter()
                .map(|(stream, kind)| EventToWrite {
                    stream_id: stream.to_string(),
                    event_type: "test_event".into(),
                    stream_kind: *kind,
                    record_kind: RecordKind::Event,
                    plaintext: stream.as_bytes().to_vec(),
                })
                .collect(),
            essential: false,
            response_tx: tx,
        };
        engine.run_command(cmd).await.unwrap();
    }

    /// Write `per_incarnation` single-stream commits round-robin over
    /// `THREE`, in each of two engine incarnations (so two segments per
    /// stream). Returns the number of events written.
    async fn write_interleaved(path: &std::path::Path, bootstrap: [u8; 32], per_incarnation: u64) -> u64 {
        let mut written = 0;
        for _ in 0..2 {
            let engine = crate::tests::reopen_after_drop(test_config(path, bootstrap), None)
                .await
                .unwrap();
            for i in 0..per_incarnation {
                let (stream, kind) = THREE[(i % 3) as usize];
                commit(&engine, i, stream, kind).await;
                written += 1;
            }
            drop(engine);
            drop(crate::tests::wait_for_stopped_engine(path).await);
        }
        written
    }

    async fn replay_recording(
        path: &std::path::Path,
        bootstrap: [u8; 32],
        snapshot_watermark: u64,
    ) -> (Result<u64>, Vec<u64>) {
        let state = Arc::new(ProjectionState::new());
        let recorder = Arc::new(RecordingProjection {
            order: Mutex::new(Vec::new()),
        });
        let table = DispatchTable::new(vec![recorder.clone()]).unwrap();
        let registry = tokio::sync::Mutex::new(StreamKeyRegistry::new());
        let barrier = LinearizabilityBarrier::new(state.clone());
        let high = replay_projections(
            path,
            &registry,
            &bootstrap,
            &state,
            &table,
            &barrier,
            snapshot_watermark,
        )
        .await;
        let order = recorder.order.lock().unwrap().clone();
        (high, order)
    }

    /// Task 1.12: three streams in three kind directories, commit_seqs
    /// interleaved across them, two segments per stream and one commit
    /// that spans all three. Replay applies exactly commit_seq order.
    #[tokio::test]
    async fn replay_applies_three_interleaved_streams_in_commit_seq_order() {
        let tmp = tempfile::tempdir().unwrap();
        let bootstrap = [0xA1u8; 32];
        let mut expected = Vec::new();
        let mut seq = 0;
        for incarnation in 0..2u64 {
            let engine =
                crate::tests::reopen_after_drop(test_config(tmp.path(), bootstrap), None)
                    .await
                    .unwrap();
            for i in 0..7u64 {
                if incarnation == 0 && i == 3 {
                    commit_all(&engine, &THREE).await;
                    seq += 1;
                    expected.extend([seq; 3]);
                    continue;
                }
                let (stream, kind) = THREE[((i * 2 + incarnation) % 3) as usize];
                commit(&engine, i, stream, kind).await;
                seq += 1;
                expected.push(seq);
            }
            drop(engine);
            drop(crate::tests::wait_for_stopped_engine(tmp.path()).await);
        }

        let (high, order) = replay_recording(tmp.path(), bootstrap, 0).await;
        assert_eq!(order, expected, "replay order must be commit_seq order");
        assert_eq!(high.unwrap(), seq);
    }

    /// Records the stream of every event a replay applies.
    struct StreamRecorder(Mutex<Vec<String>>);

    impl Projection for StreamRecorder {
        fn event_type(&self) -> &str {
            "test_event"
        }

        fn apply(&self, event: &DurableEvent, _state: &ProjectionState) -> Result<()> {
            self.0.lock().unwrap().push(event.stream_id.clone());
            Ok(())
        }
    }

    /// Events of one commit apply in the command's event order, whatever
    /// order their stream directories are walked in.
    #[tokio::test]
    async fn replay_applies_one_commits_events_in_command_order() {
        let tmp = tempfile::tempdir().unwrap();
        let bootstrap = [0xA2u8; 32];
        let streams = [THREE[2], THREE[0], THREE[1]];
        {
            let engine = crate::tests::reopen_after_drop(test_config(tmp.path(), bootstrap), None)
                .await
                .unwrap();
            commit_all(&engine, &streams).await;
            commit_all(&engine, &THREE).await;
        }
        drop(crate::tests::wait_for_stopped_engine(tmp.path()).await);

        let state = Arc::new(ProjectionState::new());
        let recorder = Arc::new(StreamRecorder(Mutex::new(Vec::new())));
        let table = DispatchTable::new(vec![recorder.clone()]).unwrap();
        let registry = tokio::sync::Mutex::new(StreamKeyRegistry::new());
        let barrier = LinearizabilityBarrier::new(state.clone());
        replay_projections(tmp.path(), &registry, &bootstrap, &state, &table, &barrier, 0)
            .await
            .unwrap();
        let expected: Vec<String> = streams
            .iter()
            .chain(THREE.iter())
            .map(|(stream, _)| stream.to_string())
            .collect();
        assert_eq!(*recorder.0.lock().unwrap(), expected);
    }

    /// Task 1.12: replay must not hold every post-snapshot event at once.
    /// The decoded events alive at any moment are bounded by a small
    /// constant times the number of stream directories, not by the total.
    #[tokio::test]
    async fn replay_holds_decoded_events_bounded_by_stream_count() {
        let tmp = tempfile::tempdir().unwrap();
        let bootstrap = [0xA3u8; 32];
        // More records per segment than one read-ahead batch.
        let total = write_interleaved(tmp.path(), bootstrap, 150).await;

        let held = held_events::track();
        let (high, order) = replay_recording(tmp.path(), bootstrap, 0).await;
        let peak = held.peak();
        assert_eq!(high.unwrap(), total);
        assert_eq!(order, (1..=total).collect::<Vec<_>>());
        let streams = THREE.len();
        assert!(
            peak <= 2 * streams,
            "replay held {peak} decoded events at once for {streams} streams and {total} events"
        );
    }

    /// Move the "channels" stream's segment 1 behind its segment 2 and point
    /// its commit at the new name: every reference stays exact, only the
    /// order of the directory's indexed records changes.
    async fn move_first_segment_last(path: &std::path::Path) {
        let events = path.join("streams/other/channels/events");
        let index_dir = path.join("global").join("commit-index");
        let mut entries = crate::commit_index::batcher::read_all_entries(&index_dir).unwrap();
        std::fs::rename(events.join("00000001.wseg"), events.join("00000003.wseg")).unwrap();
        let first = entries.iter_mut().find(|e| e.commit_seq == 1).unwrap();
        assert_eq!(first.event_refs[0].segment_id, 1);
        first.event_refs[0].segment_id = 3;
        std::fs::remove_dir_all(&index_dir).unwrap();
        std::fs::create_dir_all(&index_dir).unwrap();
        let (batcher, run) = crate::commit_index::batcher::new_batcher(index_dir.clone(), None, None);
        let task = tokio::spawn(run);
        for entry in entries {
            batcher.submit(entry).unwrap();
        }
        batcher.flush_now().await.unwrap();
        drop(batcher);
        task.await.unwrap().unwrap();
    }

    /// Task 1.12: the k-way merge relies on each stream directory holding
    /// its indexed records in commit order. A directory whose indexed
    /// records are out of order must refuse startup, not misapply.
    #[tokio::test]
    async fn replay_refuses_stream_directory_out_of_commit_order() {
        // One stream: seq 2 (segment 2) is read before seq 1 (now segment 3).
        let tmp = tempfile::tempdir().unwrap();
        let bootstrap = [0xA4u8; 32];
        write_interleaved(tmp.path(), bootstrap, 1).await;
        move_first_segment_last(tmp.path()).await;
        let (result, applied) = replay_recording(tmp.path(), bootstrap, 0).await;
        let error = result.unwrap_err();
        assert!(
            matches!(error, crate::error::WabiError::Corrupt { .. })
                && error.to_string().contains("out of commit order"),
            "{error}"
        );
        assert!(applied.is_empty(), "applied {applied:?} before refusing");

        // Three streams: commit 1 is due before its record is reached, so
        // it is reported missing. Either way startup refuses.
        let tmp = tempfile::tempdir().unwrap();
        write_interleaved(tmp.path(), bootstrap, 3).await;
        move_first_segment_last(tmp.path()).await;
        let (result, _) = replay_recording(tmp.path(), bootstrap, 0).await;
        let error = result.unwrap_err();
        assert!(
            matches!(error, crate::error::WabiError::Corrupt { .. })
                && error.to_string().contains("repair required before startup"),
            "{error}"
        );
    }
}
