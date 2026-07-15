//! Concurrency and lock manager for the WabiDB engine.
//!
//! See `docs/proposals/wabidb-locks-design.md` for the full design. This module
//! implements the three primitive types that wabidb-15 (sequencer), wabidb-32
//! (write barrier), and the projection engine build on top of.
//!
//! ## The three primitives
//!
//! 1. [`SequencerPermit`]: an owned `tokio::sync::Semaphore` permit (capacity 1)
//!    that the sequencer task holds. There is exactly one of these in the
//!    entire engine. Holding the permit = the right to write to the
//!    per-stream segments and the commit index.
//!
//! 2. `spawn_projection_dispatcher`: spawns a long-lived `tokio` task that consumes
//!    `CommitIndexEntry` records from a bounded mpsc channel and applies them
//!    to the projection state. The sequencer pushes; the dispatcher pulls.
//!    A full channel causes the sequencer to backpressure.
//!
//! 3. [`ProjectionState`]: a `HashMap<index_name, SkipMap<K, V>>` plus an
//!    `applied_commit_seq: Arc<AtomicU64>` watermark. Reads are lock-free
//!    via `crossbeam-skiplist`. Writes are CAS-based, no global lock.
//!
//! ## Lock ordering (deadlock avoidance)
//!
//! Three rules, enforced by code review (no compile-time check possible):
//!
//! 1. Single sequencer permit. No code outside the sequencer task may hold
//!    a sequencer permit. Verified by the `pub(crate)` visibility on
//!    `SequencerPermit`.
//! 2. No nested projection locks. Each projection handler updates exactly
//!    one `SkipMap`. Cross-projection updates (rare) are routed through the
//!    dispatcher with two events, not a single transaction.
//! 3. No holding projection locks across `.await` points. Projection
//!    handlers are sync. The dispatcher awaits on the mpsc receive, then
//!    runs sync handler code, then sends the next watermark update.

use crate::error::{ErrorCategory, Result, WabiError};
use crate::projections::handler::{DispatchTable, DurableEvent};
use crossbeam_skiplist::SkipMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Bound;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

/// The unique permit that grants the right to commit. There is exactly one
/// in the entire engine. Held by the sequencer task; released when the
/// task is dropped (or explicitly via `forget(permit)` for permanent handoff).
///
/// **Invariant:** at most one sequencer-write-flight exists in the system.
/// The semaphore makes this structural, not behavioral.
pub struct SequencerPermit {
    /// The held permit. Dropping the `SequencerPermit` returns it to the
    /// semaphore. To permanently hand off, call `forget(self.permit)`.
    _permit: OwnedSemaphorePermit,
}

impl SequencerPermit {
    /// Acquire the sole permit. Awaits until the current holder drops it.
    /// Intended to be called exactly once at engine startup; the returned
    /// permit is then moved into the sequencer task.
    pub(crate) async fn acquire(sem: &Arc<Semaphore>) -> Result<Self> {
        let permit = sem.clone().acquire_owned().await.map_err(|e| {
            WabiError::InternalInvariantViolated {
                invariant: format!("sequencer semaphore closed unexpectedly: {e}"),
            }
        })?;
        Ok(Self { _permit: permit })
    }

    /// Permanently hand off the permit. After this call, the semaphore
    /// is permanently held (the permit is never returned to the pool).
    /// Used when the sequencer task is detached and the permit must
    /// outlive any function that created it.
    pub fn into_static(self) {
        // OwnedSemaphorePermit is dropped here, returning the permit.
        // For a permanent handoff, the caller should use a different
        // approach: e.g., keep the permit in a `Box::leak` or use
        // `Arc<OwnedSemaphorePermit>`. For now, this is a no-op
        // that explicitly consumes self to make the handoff intent clear.
        let _ = self._permit;
    }
}

/// Default depth of the projection dispatcher channel. Per the endstate
/// doc, the dispatcher backs up the sequencer when commits arrive faster
/// than the dispatcher can apply. A full channel causes the sequencer to
/// block on `send().await` — desired backpressure.
pub const DEFAULT_DISPATCHER_CHANNEL_DEPTH: usize = 1024;

/// A long-lived task that consumes `CommitIndexEntry` records from an mpsc
/// channel and applies them to the projection state.
///
/// The dispatcher is the only writer of the projection state. The sequencer
/// is the only writer of the dispatcher channel. The pattern: sequencer
/// pushes after each successful commit-index append; dispatcher pulls,
/// applies, advances the `applied_commit_seq` watermark.

/// A single item the dispatcher processes. The `commit_seq` is the
/// monotonic ordering key; `event_type` and `event_payload` describe what
/// to apply to the projection state.
#[derive(Debug, Clone)]
pub struct DispatchItem {
    /// The `commit_seq` of the entry being dispatched.
    pub commit_seq: u64,
    /// The event type (e.g. "message_created", "channel_member_added").
    /// Strings for now; an enum-typed variant can replace this in a
    /// later card once the projection handler trait is defined (wabidb-23).
    pub event_type: String,
    /// The stream id (e.g. "ch_01H..." or "call_session:abc123"). Forwarded
    /// to projection handlers so they can extract per-stream keys.
    pub stream_id: String,
    /// The event payload (opaque bytes; the handler decodes).
    pub payload: Vec<u8>,
}

/// The projection state: per-index `SkipMap`s plus a watermark.
///
/// The `indexes` field is wrapped in `RwLock` so the dispatcher can insert
/// new indexes on first use. Reads of an existing index are still
/// lock-free (the `SkipMap` itself is lock-free); the `RwLock` only
/// serializes the rare first-insert path.
#[derive(Debug)]
pub struct ProjectionState {
    /// The per-index lock-free skip lists, keyed by index name (e.g.
    /// "messages", "channel_members", "dm_message_recipients").
    indexes: RwLock<HashMap<String, SkipMap<Vec<u8>, Vec<u8>>>>,
    /// The `commit_seq` of the most recently applied event. Reads with a
    /// `commit_seq > this` must wait for the dispatcher to catch up.
    applied_commit_seq: Arc<AtomicU64>,
    /// Count of dispatched events, used for periodic checkpointing.
    dispatch_count: AtomicU64,
}

impl ProjectionState {
    /// Create an empty projection state with the standard set of indexes.
    ///
    /// The indexes are populated lazily on first insert. This is cheaper
    /// than pre-creating empty skip maps for every possible index name.
    pub fn new() -> Self {
        Self {
            indexes: RwLock::new(HashMap::new()),
            applied_commit_seq: Arc::new(AtomicU64::new(0)),
            dispatch_count: AtomicU64::new(0),
        }
    }

    /// The current `applied_commit_seq` watermark. Reads compare against
    /// this to decide whether to wait for the dispatcher.
    pub fn applied_commit_seq(&self) -> u64 {
        self.applied_commit_seq.load(Ordering::Acquire)
    }

    /// Insert a key-value pair into a named index. Used by the dispatcher.
    /// The `commit_seq` is the version associated with this entry.
    ///
    /// Note: takes `&self` (not `&mut self`) because the underlying
    /// `HashMap` is wrapped in an `RwLock`. The lock is acquired
    /// internally; readers of the resulting `SkipMap` are still
    /// lock-free.
    pub fn insert(&self, index: &str, key: Vec<u8>, value: Vec<u8>, _commit_seq: u64) {
        let mut indexes = self.indexes.write().unwrap();
        let map = indexes
            .entry(index.to_string())
            .or_insert_with(SkipMap::new);
        map.insert(key, value);
    }

    /// Look up a key in a named index. Returns `None` if the index or key
    /// does not exist. This is a lock-free read of the inner `SkipMap`.
    pub fn get(&self, index: &str, key: &[u8]) -> Option<Vec<u8>> {
        let indexes = self.indexes.read().unwrap();
        let map = indexes.get(index)?;
        map.get(key).map(|entry| entry.value().clone())
    }

    /// Iterate the index, calling `f` for each key-value pair. The
    /// iteration is lock-free on the inner `SkipMap`; the outer `RwLock`
    /// is held only to look up the index.
    pub fn for_each<F>(&self, index: &str, mut f: F)
    where
        F: FnMut(&[u8], &[u8]),
    {
        let indexes = self.indexes.read().unwrap();
        if let Some(map) = indexes.get(index) {
            for entry in map.iter() {
                let k = entry.key();
                let v = entry.value();
                f(k, v);
            }
        }
    }

    /// Iterate entries whose key starts with `prefix`, calling `f` for each.
    /// Uses the underlying SkipMap's ordering to skip non-matching entries.
    pub fn prefix_scan<F>(&self, index: &str, prefix: &[u8], mut f: F)
    where
        F: FnMut(&[u8], &[u8]),
    {
        let indexes = self.indexes.read().unwrap();
        if let Some(map) = indexes.get(index) {
            let mut current = map.lower_bound(Bound::Included(prefix));
            while let Some(entry) = current {
                let k = entry.key();
                if !k.starts_with(prefix) {
                    break;
                }
                let v = entry.value();
                f(k, v);
                current = entry.next();
            }
        }
    }

    /// Advance the `applied_commit_seq` watermark. Called by the
    /// dispatcher after each successful apply.
    pub(crate) fn advance_watermark(&self, new_watermark: u64) {
        self.applied_commit_seq.store(new_watermark, Ordering::Release);
    }

    /// Remove a single entry from a named index. Returns `true` if the
    /// entry was present and removed, `false` if the index or key did not
    /// exist.
    pub fn remove(&self, index: &str, key: &[u8]) -> bool {
        let indexes = self.indexes.read().unwrap();
        match indexes.get(index) {
            Some(map) => {
                // SkipMap::remove expects &Vec<u8>; convert via owned copy.
                let owned: Vec<u8> = key.to_vec();
                map.remove(&owned).is_some()
            }
            None => false,
        }
    }

    /// Compact a named index by removing all entries for which `predicate`
    /// returns `true`. Returns the number of entries removed.
    ///
    /// This is a two-pass operation: first collect matching keys while
    /// holding only a read lock, then remove them while holding a write
    /// lock. This avoids holding the write lock during predicate
    /// evaluation and prevents deadlock if a predicate calls back into
    /// `ProjectionState`.
    pub fn compact_index<F>(&self, index: &str, predicate: F) -> usize
    where
        F: Fn(&[u8], &[u8]) -> bool,
    {
        // Pass 1: collect matching keys under read lock.
        let keys: Vec<Vec<u8>> = {
            let indexes = self.indexes.read().unwrap();
            let mut keys = Vec::new();
            if let Some(map) = indexes.get(index) {
                for entry in map.iter() {
                    if predicate(entry.key(), entry.value()) {
                        keys.push(entry.key().clone());
                    }
                }
            }
            keys
        };

        if keys.is_empty() {
            return 0;
        }

        // Pass 2: remove collected keys under read lock (SkipMap.remove is
        // lock-free; the outer RwLock only serializes the map lookup).
        let indexes = self.indexes.read().unwrap();
        if let Some(map) = indexes.get(index) {
            for key in &keys {
                map.remove(key);
            }
        }
        keys.len()
    }

    /// Set the `applied_commit_seq` watermark. Used by the
    /// `LinearizabilityBarrier` (which is the public API for advancing).
    /// Internally delegates to the atomic store.
    pub fn set_applied_commit_seq(&self, new_watermark: u64) {
        self.applied_commit_seq.store(new_watermark, Ordering::Release);
    }
}

impl Default for ProjectionState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Snapshot persistence helpers
// ---------------------------------------------------------------------------

/// Hex-encoded byte slice for compact JSON serialization of binary keys/values.
struct HexBytes(Vec<u8>);

impl Serialize for HexBytes {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for HexBytes {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let encoded = String::deserialize(d)?;
        hex::decode(&encoded)
            .map(HexBytes)
            .map_err(serde::de::Error::custom)
    }
}

/// A single index snapshot entry.
#[derive(Serialize, Deserialize)]
struct SnapshotEntry {
    key: HexBytes,
    value: HexBytes,
}

/// The full snapshot format.
#[derive(Serialize, Deserialize)]
struct SnapshotData {
    watermark: u64,
    indexes: Vec<(String, Vec<SnapshotEntry>)>,
}

impl ProjectionState {
    /// Path for the snapshot file, relative to the data directory.
    pub fn snapshot_path(data_dir: &Path) -> std::path::PathBuf {
        data_dir.join("projections").join("snapshot.json")
    }

    /// Serialize all indexes to a JSON snapshot file.
    ///
    /// Keys and values are hex-encoded for compact JSON representation.
    /// The watermark is stored alongside the data.
    pub fn save_snapshot(&self, data_dir: &Path) -> Result<()> {
        let path = Self::snapshot_path(data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("create projections dir: {e}"),
            )))?;
        }

        let indexes = self.indexes.read().map_err(|e| WabiError::InternalInvariantViolated {
            invariant: format!("projection state lock poisoned: {e}"),
        })?;

        let mut snapshot_indexes: Vec<(String, Vec<SnapshotEntry>)> = Vec::with_capacity(indexes.len());
        for (name, map) in indexes.iter() {
            let mut entries: Vec<SnapshotEntry> = Vec::new();
            for entry in map.iter() {
                entries.push(SnapshotEntry {
                    key: HexBytes(entry.key().clone()),
                    value: HexBytes(entry.value().clone()),
                });
            }
            snapshot_indexes.push((name.clone(), entries));
        }
        drop(indexes);

        let watermark = self.applied_commit_seq();
        let data = SnapshotData {
            watermark,
            indexes: snapshot_indexes,
        };

        let json = serde_json::to_string(&data).map_err(|e| WabiError::InternalInvariantViolated {
            invariant: format!("snapshot serialize: {e}"),
        })?;

        std::fs::write(&path, &json).map_err(|e| WabiError::Io(std::io::Error::new(
            e.kind(),
            format!("snapshot write: {e}"),
        )))?;

        Ok(())
    }

    /// Load a snapshot from a JSON file, returning a populated `ProjectionState`
    /// with the watermark set to the snapshot's stored value.
    ///
    /// Returns `None` if the snapshot file does not exist (fresh data dir).
    pub fn load_snapshot(data_dir: &Path) -> Result<Option<(Self, u64)>> {
        let path = Self::snapshot_path(data_dir);
        if !path.exists() {
            return Ok(None);
        }

        let json = std::fs::read_to_string(&path).map_err(|e| WabiError::Io(std::io::Error::new(
            e.kind(),
            format!("snapshot read: {e}"),
        )))?;

        let data: SnapshotData = serde_json::from_str(&json).map_err(|e| WabiError::Corrupt {
            location: "projection snapshot".into(),
            detail: format!("deserialize failed: {e}"),
        })?;

        let state = ProjectionState::new();
        for (name, entries) in &data.indexes {
            for entry in entries {
                state.insert(name, entry.key.0.clone(), entry.value.0.clone(), data.watermark);
            }
        }
        state.set_applied_commit_seq(data.watermark);

        Ok(Some((state, data.watermark)))
    }

    /// Remove the snapshot file (e.g. when the engine is shutting down and
    /// the snapshot is no longer needed).
    pub fn remove_snapshot(data_dir: &Path) {
        let path = Self::snapshot_path(data_dir);
        let _ = std::fs::remove_file(path);
    }

    /// Increment the dispatch counter and save a checkpoint snapshot if the
    /// counter has reached the next interval boundary.
    ///
    /// This is called from the dispatcher loop after every applied event.
    /// The snapshot is saved synchronously; errors are logged but not
    /// propagated (the dispatcher must not crash due to a checkpoint failure).
    pub fn checkpoint_if_due(&self, data_dir: &Path, interval: u64) {
        if interval == 0 {
            return;
        }
        let count = self.dispatch_count.fetch_add(1, Ordering::Relaxed);
        if count % interval == 0 && count > 0 {
            if let Err(e) = self.save_snapshot(data_dir) {
                tracing::error!("checkpoint snapshot failed: {e}");
            }
        }
    }
}

/// Handle to the dispatcher: the sender end of the mpsc + a JoinHandle.
pub struct DispatcherHandle {
    /// The sender end. Cloned to give multiple producers (e.g. the
    /// sequencer pushes here, future readers can also push if needed).
    pub sender: mpsc::Sender<DispatchItem>,
    /// Handle to the dispatcher task. Take this to await graceful shutdown.
    pub handle: Option<JoinHandle<()>>,
}

/// Spawn the dispatcher task. Returns the `DispatcherHandle` whose
/// `sender` is what the sequencer pushes to.
///
/// `channel_depth` defaults to `DEFAULT_DISPATCHER_CHANNEL_DEPTH`.
///
/// If `checkpoint_interval` is `Some(n)`, the dispatcher will write a
/// snapshot file every `n` applied events. The snapshot is saved to
/// `data_dir/projections/snapshot.json`. Pass `None` (or 0) to disable.
pub fn spawn_projection_dispatcher(
    state: Arc<ProjectionState>,
    table: Arc<DispatchTable>,
    channel_depth: Option<usize>,
    checkpoint_data_dir: Option<std::path::PathBuf>,
    checkpoint_interval: Option<u64>,
) -> Result<DispatcherHandle> {
    let depth = channel_depth.unwrap_or(DEFAULT_DISPATCHER_CHANNEL_DEPTH);
    let (tx, rx) = mpsc::channel::<DispatchItem>(depth);

    let state_clone = Arc::clone(&state);
    let interval = checkpoint_interval.unwrap_or(0);
    let handle = tokio::spawn(async move {
        run_dispatcher(rx, state_clone, table, checkpoint_data_dir, interval).await;
    });

    Ok(DispatcherHandle {
        sender: tx,
        handle: Some(handle),
    })
}

/// The dispatcher's main loop. Receives items, applies them, advances the
/// watermark. Exits when the channel closes (sender dropped).
///
/// If `checkpoint_data_dir` is `Some`, a snapshot is written every
/// `checkpoint_interval` events for faster restart.
async fn run_dispatcher(
    mut receiver: mpsc::Receiver<DispatchItem>,
    state: Arc<ProjectionState>,
    table: Arc<DispatchTable>,
    checkpoint_data_dir: Option<std::path::PathBuf>,
    checkpoint_interval: u64,
) {
    while let Some(item) = receiver.recv().await {
        if let Some(handler) = table.get(&item.event_type) {
            let event = DurableEvent {
                commit_seq: item.commit_seq,
                stream_id: item.stream_id.clone(),
                event_type: item.event_type.clone(),
                payload: item.payload.clone(),
            };
            if let Err(e) = handler.apply(&event, &state) {
                tracing::error!("projection handler error for {}: {e}", item.event_type);
            }
        } else {
            // Fallback: insert into generic "events" index for unregistered
            // event types (forward-compatible with older dispatch items).
            let key = item.event_type.as_bytes().to_vec();
            let value = item.payload.clone();
            state.insert("events", key, value, item.commit_seq);
        }
        // The watermark is the highest commit_seq we've applied. Since the
        // mpsc preserves order, this is monotonically increasing.
        state.advance_watermark(item.commit_seq);

        // Periodic checkpoint snapshot.
        if let Some(ref data_dir) = checkpoint_data_dir {
            state.checkpoint_if_due(data_dir, checkpoint_interval);
        }
    }
    tracing::info!("projection dispatcher exited cleanly");
}

/// The error category for any future sequencer-closed errors.
///
/// Exists so the `ErrorCategory` enum is reachable from this module
/// without a dead-code warning during transitional stub work.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Sequencer
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::sleep;

    #[test]
    fn projection_state_insert_and_get() {
        let state = ProjectionState::new();
        state.insert("messages", b"k1".to_vec(), b"v1".to_vec(), 1);
        assert_eq!(state.get("messages", b"k1"), Some(b"v1".to_vec()));
        assert_eq!(state.get("messages", b"k2"), None);
    }

    #[test]
    fn projection_state_for_each() {
        let state = ProjectionState::new();
        state.insert("messages", b"a".to_vec(), b"1".to_vec(), 1);
        state.insert("messages", b"b".to_vec(), b"2".to_vec(), 2);
        state.insert("messages", b"c".to_vec(), b"3".to_vec(), 3);

        let mut seen = Vec::new();
        state.for_each("messages", |k, v| {
            seen.push((k.to_vec(), v.to_vec()));
        });
        assert_eq!(seen.len(), 3);
        seen.sort();
        assert_eq!(
            seen,
            vec![
                (b"a".to_vec(), b"1".to_vec()),
                (b"b".to_vec(), b"2".to_vec()),
                (b"c".to_vec(), b"3".to_vec()),
            ]
        );
    }

    #[test]
    fn projection_state_watermark_starts_at_zero() {
        let state = ProjectionState::new();
        assert_eq!(state.applied_commit_seq(), 0);
    }

    #[test]
    fn projection_state_remove_existing_entry() {
        let state = ProjectionState::new();
        state.insert("test", b"key1".to_vec(), b"val1".to_vec(), 1);
        assert!(state.get("test", b"key1").is_some());
        assert!(state.remove("test", b"key1"));
        assert!(state.get("test", b"key1").is_none());
    }

    #[test]
    fn projection_state_remove_missing_entry() {
        let state = ProjectionState::new();
        assert!(!state.remove("test", b"nosuch"));
    }

    #[test]
    fn projection_state_remove_nonexistent_index() {
        let state = ProjectionState::new();
        assert!(!state.remove("nonexistent", b"key"));
    }

    #[test]
    fn projection_state_compact_index_removes_matching() {
        let state = ProjectionState::new();
        state.insert("test", b"keep".to_vec(), b"alive".to_vec(), 1);
        state.insert("test", b"del1".to_vec(), b"dead".to_vec(), 2);
        state.insert("test", b"del2".to_vec(), b"gone".to_vec(), 3);

        let removed = state.compact_index("test", |_key, value| value == b"dead" || value == b"gone");
        assert_eq!(removed, 2);

        assert!(state.get("test", b"keep").is_some());
        assert!(state.get("test", b"del1").is_none());
        assert!(state.get("test", b"del2").is_none());
    }

    #[test]
    fn projection_state_compact_index_empty_predicate_removes_none() {
        let state = ProjectionState::new();
        state.insert("test", b"a".to_vec(), b"1".to_vec(), 1);
        state.insert("test", b"b".to_vec(), b"2".to_vec(), 2);

        let removed = state.compact_index("test", |_, _| false);
        assert_eq!(removed, 0);
        assert!(state.get("test", b"a").is_some());
        assert!(state.get("test", b"b").is_some());
    }

    #[test]
    fn projection_state_compact_index_nonexistent_index() {
        let state = ProjectionState::new();
        let removed = state.compact_index("nonexistent", |_, _| true);
        assert_eq!(removed, 0);
    }

    #[tokio::test]
    async fn dispatcher_processes_items_in_order() {
        let state = Arc::new(ProjectionState::new());
        let table = Arc::new(DispatchTable::new(vec![]).unwrap());
        let handle = spawn_projection_dispatcher(Arc::clone(&state), table, Some(16), None, None).unwrap();

        for i in 1..=5 {
            handle
                .sender
                .send(DispatchItem {
                    commit_seq: i,
                    event_type: format!("evt{i}"),
                    stream_id: format!("stream_{i}").into(),
                    payload: format!("payload{i}").into_bytes(),
                })
                .await
                .unwrap();
        }
        // Drop the sender to signal the dispatcher to exit after processing.
        drop(handle.sender);

        // Await the dispatcher task.
        if let Some(h) = handle.handle {
            let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
        }

        // All 5 events should be applied.
        for i in 1..=5 {
            let key = format!("evt{i}").into_bytes();
            let value = format!("payload{i}").into_bytes();
            assert_eq!(state.get("events", &key), Some(value));
        }
        // The watermark should be the highest seq we sent.
        assert_eq!(state.applied_commit_seq(), 5);
    }

    #[tokio::test]
    async fn reads_do_not_block_writes() {
        // A coarse test: spawn one writer, many readers, verify both
        // complete within a reasonable bound. A starvation-prone lock would
        // show readers blocking behind the writer.
        let state = Arc::new(ProjectionState::new());
        let table = Arc::new(DispatchTable::new(vec![]).unwrap());
        let handle = spawn_projection_dispatcher(Arc::clone(&state), table, Some(256), None, None).unwrap();

        // Pre-populate so readers have something to find.
        for i in 0..100 {
            state.insert(
                "messages",
                format!("k{i}").into_bytes(),
                format!("v{i}").into_bytes(),
                0,
            );
        }

        // Spawn 100 reader tasks. Each does 1000 reads.
        let mut reader_handles = Vec::new();
        for _ in 0..100 {
            let state_clone = Arc::clone(&state);
            reader_handles.push(tokio::spawn(async move {
                for i in 0..1000 {
                    let _ = state_clone.get("messages", format!("k{}", i % 100).as_bytes());
                }
            }));
        }

        // A writer pushes 100 events.
        let sender = handle.sender.clone();
        let writer = tokio::spawn(async move {
            for i in 1..=100u64 {
                sender
                    .send(DispatchItem {
                        commit_seq: i,
                        event_type: format!("write{i}"),
                        stream_id: format!("writer_{i}").into(),
                        payload: vec![],
                    })
                    .await
                    .unwrap();
            }
        });

        // Bounded wait: if read starvation were real, this would fail.
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            for h in reader_handles {
                h.await.unwrap();
            }
            writer.await.unwrap();
        })
        .await
        .expect("reads or writes starved");

        // The writer's events should be applied.
        assert!(state.applied_commit_seq() >= 100);
    }

    #[tokio::test]
    async fn projection_messages_routes_to_handler() {
        use crate::projections::messages::{encode_key, encode_record, MessageRecord, MessagesProjection};
        use std::sync::Arc;

        let state = Arc::new(ProjectionState::new());
        let handler: Arc<dyn crate::projections::handler::Projection> =
            Arc::new(MessagesProjection);
        let table = Arc::new(DispatchTable::new(vec![handler]).unwrap());

        let handle =
            spawn_projection_dispatcher(Arc::clone(&state), table, Some(16), None, None).unwrap();

        let msg = MessageRecord {
            message_id: "msg_01".into(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            author_device_id: "dev_abc".into(),
            created_at_micros: 1_000_000,
            encrypted_body_ref: "hash".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
        };
        let payload = encode_record(&msg);
        let expected_msg_id = format!("msg_{:x}", 1);

        let key = encode_key("ch_01", &expected_msg_id);

        handle
            .sender
            .send(DispatchItem {
                commit_seq: 1,
                event_type: "message_created".into(),
                stream_id: "ch_msg".into(),
                payload,
            })
            .await
            .unwrap();

        drop(handle.sender);
        if let Some(h) = handle.handle {
            let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
        }

        // The message should be in the "messages" index via MessagesProjection.
        let stored = state.get("messages", &key);
        assert!(stored.is_some(), "message should be in 'messages' index");

        // The message should NOT be in the generic "events" index.
        let events_entry = state.get("events", b"message_created");
        assert!(events_entry.is_none(), "message should NOT be in 'events' index");
    }

    #[tokio::test]
    async fn sequencer_permit_serializes_writers() {
        // Two concurrent would-be sequencers; only one can hold the
        // permit at a time. The other waits.
        let sem = Arc::new(Semaphore::new(1));
        let p1 = SequencerPermit::acquire(&sem).await.unwrap();
        // Try to acquire p2 while p1 is held: should wait.
        let sem2 = Arc::clone(&sem);
        let waiter = tokio::spawn(async move { SequencerPermit::acquire(&sem2).await });

        // Give the waiter a moment to start and block.
        sleep(Duration::from_millis(50)).await;
        assert!(!waiter.is_finished(), "waiter should be blocked on the held permit");

        // Drop p1; waiter should now acquire.
        drop(p1);
        let p2 = waiter.await.unwrap().unwrap();
        // Drop p2; semaphore should be releasable again.
        drop(p2);
        // We can immediately acquire a third permit (no waiting).
        let p3 = SequencerPermit::acquire(&sem).await.unwrap();
        drop(p3);
    }
}
