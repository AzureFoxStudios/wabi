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
//!    `DispatchCommit` batches from a bounded mpsc channel and applies them
//!    to the projection state. The sequencer pushes; the dispatcher pulls.
//!    A full channel causes the sequencer to backpressure.
//!
//! 3. [`ProjectionState`]: a `HashMap<index_name, SkipMap<K, V>>` plus an
//!    watch-backed applied watermark. Index access uses an outer RwLock;
//!    SkipMap operations are lock-free internally. A separate application lock
//!    serializes whole-commit application with checkpoints, not ordinary reads.
//!
//! ## Lock ordering (deadlock avoidance)
//!
//! Three rules, enforced by code review (no compile-time check possible):
//!
//! 1. Single sequencer permit. No code outside the sequencer task may hold
//!    a sequencer permit. Verified by the `pub(crate)` visibility on
//!    `SequencerPermit`.
//! 2. Acquire the application lock before index locks. Handlers may update
//!    primary and secondary indexes, but must release index locks before
//!    accessing another index. Never call save_snapshot from a handler.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
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
    /// slot is never returned to the pool — the sequencer's write right
    /// outlives any single owner. Implemented by leaking the owned permit.
    pub fn into_static(self) {
        std::mem::forget(self._permit);
    }
}

/// Default depth of the projection dispatcher channel. Per the endstate
/// doc, the dispatcher backs up the sequencer when commits arrive faster
/// than the dispatcher can apply. A full channel causes the sequencer to
/// block on `send().await` — desired backpressure.
pub const DEFAULT_DISPATCHER_CHANNEL_DEPTH: usize = 1024;

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

/// One durable command. Application and checkpoint watermarks advance only
/// after every event succeeds. This is an in-memory protocol, not a disk format.
#[derive(Debug)]
pub struct DispatchCommit {
    pub commit_seq: u64,
    pub events: Vec<DispatchItem>,
    pub applied_tx: tokio::sync::oneshot::Sender<Result<()>>,
}

impl From<DispatchItem> for DispatchCommit {
    fn from(event: DispatchItem) -> Self {
        Self {
            commit_seq: event.commit_seq,
            events: vec![event],
            applied_tx: tokio::sync::oneshot::channel().0,
        }
    }
}

/// The projection state: per-index `SkipMap`s plus a watermark.
///
/// The `indexes` field is wrapped in `RwLock` so the dispatcher can insert
/// new indexes on first use. Reads of an existing index are still
/// lock-free (the `SkipMap` itself is lock-free); the `RwLock` only
/// serializes the rare first-insert path.
#[derive(Debug)]
pub struct ProjectionState {
    /// Serializes whole-commit application with snapshots (not ordinary reads).
    application: RwLock<()>,
    apply_failed: AtomicBool,
    /// The per-index lock-free skip lists, keyed by index name (e.g.
    /// "messages", "channel_members", "dm_message_recipients").
    indexes: RwLock<HashMap<String, SkipMap<Vec<u8>, Vec<u8>>>>,
    /// The `commit_seq` of the most recently fully applied command. Reads with a
    /// `commit_seq > this` must wait for the dispatcher to catch up.
    applied_commit_seq: tokio::sync::watch::Sender<u64>,
    /// Count of fully applied commands, used for periodic checkpointing.
    dispatch_count: AtomicU64,
}

impl ProjectionState {
    /// Create an empty projection state with the standard set of indexes.
    ///
    /// The indexes are populated lazily on first insert. This is cheaper
    /// than pre-creating empty skip maps for every possible index name.
    pub fn new() -> Self {
        Self {
            application: RwLock::new(()),
            apply_failed: AtomicBool::new(false),
            indexes: RwLock::new(HashMap::new()),
            applied_commit_seq: tokio::sync::watch::channel(0).0,
            dispatch_count: AtomicU64::new(0),
        }
    }

    /// The current `applied_commit_seq` watermark. Reads compare against
    /// this to decide whether to wait for the dispatcher.
    pub fn applied_commit_seq(&self) -> u64 {
        *self.applied_commit_seq.borrow()
    }

    pub(crate) fn subscribe_applied(&self) -> tokio::sync::watch::Receiver<u64> {
        self.applied_commit_seq.subscribe()
    }

    pub fn is_healthy(&self) -> bool {
        !self.apply_failed.load(Ordering::Acquire) && !self.application.is_poisoned()
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

    /// Run `f` with the `SkipMap` for a named index. The create path takes a
    /// write lock, but if the index already exists we serve `f` under a *read*
    /// lock: `SkipMap` inserts are lock-free on `&self`, so the hot apply path
    /// (every message insert hits the secondary index) never contends on a
    /// write lock. This is the perf fix for "secondary index taking a write
    /// lock on read-heavy apply".
    pub fn with_index<F, R>(&self, index: &str, f: F) -> R
    where
        F: FnOnce(&SkipMap<Vec<u8>, Vec<u8>>) -> R,
    {
        // Fast path: index already exists → run under a shared read lock.
        {
            let indexes = self.indexes.read().unwrap();
            if let Some(map) = indexes.get(index) {
                return f(map);
            }
        }
        // Slow path (rare): index does not exist yet → create under write lock.
        let mut indexes = self.indexes.write().unwrap();
        let map = indexes
            .entry(index.to_string())
            .or_insert_with(SkipMap::new);
        f(map)
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

    /// Reverse-iterate entries whose key starts with `prefix` (highest key
    /// first), calling `f` for each until `f` returns `false` or the prefix
    /// range is exhausted. Enables O(visited) tail queries — e.g. "last N
    /// messages in a channel" visits N records instead of decoding the whole
    /// channel (t_ee2420fe). Requires keys whose lexicographic order matches
    /// the semantic order (fixed-width encodings).
    pub fn prefix_scan_reverse<F>(&self, index: &str, prefix: &[u8], mut f: F)
    where
        // Return false from `f` to stop early.
        F: FnMut(&[u8], &[u8]) -> bool,
    {
        let indexes = self.indexes.read().unwrap();
        if let Some(map) = indexes.get(index) {
            // Start at the last entry strictly below prefix-with-last-byte-
            // incremented (the exclusive upper bound of the prefix range).
            let mut upper = prefix.to_vec();
            let carry = match upper.last_mut() {
                Some(last) => {
                    let (next, overflow) = last.overflowing_add(1);
                    *last = next;
                    overflow
                }
                None => true,
            };
            let mut current = if carry || upper.is_empty() {
                // 0xff suffix overflowed or empty prefix: unbounded above,
                // start from the map's maximum.
                map.iter().next_back()
            } else {
                let upper_ref: &Vec<u8> = &upper;
                map.upper_bound(Bound::Excluded(upper_ref))
            };
            while let Some(entry) = current {
                let k = entry.key();
                if !k.starts_with(prefix) {
                    break;
                }
                let v = entry.value();
                if !f(k, v) {
                    break;
                }
                current = entry.prev();
            }
        }
    }

    /// Advance the `applied_commit_seq` watermark. Called by the
    /// dispatcher after each successful apply.
    ///
    /// Monotonic: a lower value never overwrites a higher one. Without
    /// this guard, replay to a high watermark followed by a write at a
    /// lower seq would regress the linearizability barrier.
    pub(crate) fn advance_watermark(&self, new_watermark: u64) {
        self.applied_commit_seq.send_if_modified(|current| {
            if new_watermark > *current {
                *current = new_watermark;
                true
            } else {
                false
            }
        });
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
    /// Notifies every barrier bound to this state.
    ///
    /// Monotonic: same guarantee as [`Self::advance_watermark`] — the
    /// watermark can only move forward.
    pub fn set_applied_commit_seq(&self, new_watermark: u64) {
        self.advance_watermark(new_watermark);
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
        let _application =
            self.application
                .write()
                .map_err(|_| WabiError::InternalInvariantViolated {
                    invariant: "cannot snapshot a failed projection application".into(),
                })?;
        if !self.is_healthy() {
            return Err(WabiError::InternalInvariantViolated {
                invariant: "cannot snapshot partial state after projection failure".into(),
            });
        }
        let path = Self::snapshot_path(data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                WabiError::Io(std::io::Error::new(
                    e.kind(),
                    format!("create projections dir: {e}"),
                ))
            })?;
        }

        // The application lock makes rows and watermark one commit boundary.
        // Watermark-first alone is insufficient for multi-event commands:
        // checkpointing a partial commit can replay non-idempotent effects twice.
        let watermark = self.applied_commit_seq();

        let indexes = self
            .indexes
            .read()
            .map_err(|e| WabiError::InternalInvariantViolated {
                invariant: format!("projection state lock poisoned: {e}"),
            })?;

        let mut snapshot_indexes: Vec<(String, Vec<SnapshotEntry>)> =
            Vec::with_capacity(indexes.len());
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

        let data = SnapshotData {
            watermark,
            indexes: snapshot_indexes,
        };

        let json =
            serde_json::to_string(&data).map_err(|e| WabiError::InternalInvariantViolated {
                invariant: format!("snapshot serialize: {e}"),
            })?;

        // Never truncate the last good checkpoint in place. Application and
        // snapshot writers share the lock above, so this temp path has one owner.
        use std::io::Write;
        let temp_path = path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp_path, &path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }

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

        let json = std::fs::read_to_string(&path).map_err(|e| {
            WabiError::Io(std::io::Error::new(e.kind(), format!("snapshot read: {e}")))
        })?;

        let data: SnapshotData = serde_json::from_str(&json).map_err(|e| WabiError::Corrupt {
            location: "projection snapshot".into(),
            detail: format!("deserialize failed: {e}"),
        })?;

        let state = ProjectionState::new();
        for (name, entries) in &data.indexes {
            for entry in entries {
                state.insert(
                    name,
                    entry.key.0.clone(),
                    entry.value.0.clone(),
                    data.watermark,
                );
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
    /// This is called from the dispatcher loop after every complete commit.
    /// The snapshot is saved synchronously; errors are logged but not
    /// propagated (the dispatcher must not crash due to a checkpoint failure).
    pub fn checkpoint_if_due(&self, data_dir: &Path, interval: u64) {
        if interval == 0 {
            return;
        }
        let count = self.dispatch_count.fetch_add(1, Ordering::Relaxed) + 1;
        if count % interval == 0 {
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
    pub sender: mpsc::Sender<DispatchCommit>,
    /// Handle to the dispatcher task. Take this to await graceful shutdown.
    pub handle: Option<JoinHandle<()>>,
}

/// Spawn the dispatcher task. Returns the `DispatcherHandle` whose
/// `sender` is what the sequencer pushes to.
///
/// `channel_depth` defaults to `DEFAULT_DISPATCHER_CHANNEL_DEPTH`.
///
/// If `checkpoint_interval` is `Some(n)`, the dispatcher will write a
/// snapshot file every `n` fully applied commits. The snapshot is saved to
/// `data_dir/projections/snapshot.json`. Pass `None` (or 0) to disable.
pub fn spawn_projection_dispatcher(
    state: Arc<ProjectionState>,
    table: Arc<DispatchTable>,
    channel_depth: Option<usize>,
    checkpoint_data_dir: Option<std::path::PathBuf>,
    checkpoint_interval: Option<u64>,
) -> Result<DispatcherHandle> {
    let depth = channel_depth.unwrap_or(DEFAULT_DISPATCHER_CHANNEL_DEPTH);
    let (tx, rx) = mpsc::channel::<DispatchCommit>(depth);

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

/// Receives whole commits, applies all events, advances the watermark and
/// acknowledges application. Any handler failure halts the applied prefix.
///
/// If `checkpoint_data_dir` is `Some`, a snapshot is written every
/// `checkpoint_interval` complete commits for faster restart.
async fn run_dispatcher(
    mut receiver: mpsc::Receiver<DispatchCommit>,
    state: Arc<ProjectionState>,
    table: Arc<DispatchTable>,
    checkpoint_data_dir: Option<std::path::PathBuf>,
    checkpoint_interval: u64,
) {
    while let Some(commit) = receiver.recv().await {
        // Synchronous handlers never hold this lock across an await.
        let application = state
            .application
            .write()
            .expect("projection application lock poisoned");
        for item in commit.events {
            if let Some(handler) = table.get(&item.event_type) {
                let event = DurableEvent {
                    commit_seq: item.commit_seq,
                    stream_id: item.stream_id.clone(),
                    event_type: item.event_type.clone(),
                    payload: item.payload.clone(),
                };
                if let Err(e) = handler.apply(&event, &state) {
                    state.apply_failed.store(true, Ordering::Release);
                    let invariant = format!(
                        "durable commit {} projection {} failed: {e}; engine halted, repair required before retry",
                        commit.commit_seq, item.event_type
                    );
                    let error = WabiError::InternalInvariantViolated { invariant };
                    tracing::error!("{error}");
                    // The durable log cannot be rolled back. Do not acknowledge
                    // success, checkpoint partial state, or advance past this hole.
                    let _ = commit.applied_tx.send(Err(error));
                    return;
                }
            } else {
                // Fallback: insert into generic "events" index for unregistered
                // event types (forward-compatible with older dispatch items).
                let key = item.event_type.as_bytes().to_vec();
                let value = item.payload.clone();
                state.insert("events", key, value, item.commit_seq);
            }
        }
        state.advance_watermark(commit.commit_seq);
        drop(application);

        // Losing the caller does not cancel a durable commit's application.
        let _ = commit.applied_tx.send(Ok(()));

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

    /// Zombie-channel regression (2026-08-27, live on wabi.chat): a shutdown
    /// snapshot must never claim MORE coverage than its rows actually hold.
    /// The old code copied the rows first and read the watermark second, so a
    /// delete applied in between was counted as applied (watermark) but
    /// missing from the rows — replay then skipped it forever and the
    /// deleted channel resurrected after restart.
    ///
    /// Deterministic tail of the race: with the rows copied at an ARBITRARY
    /// point, the only safe order is watermark-then-rows. We stress save vs
    /// apply concurrently and assert the invariant on every restore: if the
    /// restored watermark covers the delete (seq 2), the deleted key must be
    /// absent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn snapshot_never_overclaims_watermark_coverage() {
        let dir = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(ProjectionState::new());
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Applier: cycle N inserts `zombie-N` (seq N), then removes it and
        // advances to seq N+1 — monotonic, like the real dispatcher. Once a
        // key's delete is covered by the watermark it can never legitimately
        // reappear.
        let applier = {
            let state = state.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                let mut n: u64 = 0;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    n += 1;
                    let key = format!("zombie-{n}");
                    state.insert("channels", key.as_bytes().to_vec(), b"active".to_vec(), n);
                    state.set_applied_commit_seq(n);
                    state.remove("channels", key.as_bytes());
                    state.set_applied_commit_seq(n + 1);
                    tokio::task::yield_now().await;
                }
            })
        };

        // Snapshotter: race save/load against the applier. A restore is an
        // OVERCLAIM if it holds zombie-N while its watermark is ≥ N+1 (the
        // delete was counted as applied but its row removal missed the copy).
        let mut violations: Vec<(String, u64)> = Vec::new();
        for _ in 0..400 {
            if state.save_snapshot(dir.path()).is_err() {
                continue;
            }
            if let Ok(Some((restored, watermark))) = ProjectionState::load_snapshot(dir.path()) {
                let indexes = restored.indexes.read().unwrap();
                if let Some(map) = indexes.get("channels") {
                    for entry in map.iter() {
                        let key = String::from_utf8_lossy(entry.key()).to_string();
                        if let Some(n) = key.strip_prefix("zombie-") {
                            let n: u64 = n.parse().unwrap_or(0);
                            if watermark >= n + 1 {
                                violations.push((key, watermark));
                            }
                        }
                    }
                }
            }
            ProjectionState::remove_snapshot(dir.path());
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        applier.await.unwrap();
        assert!(
            violations.is_empty(),
            "snapshot overclaimed coverage (deleted rows restored with \
             watermark covering their delete): {violations:?}"
        );
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

        let removed =
            state.compact_index("test", |_key, value| value == b"dead" || value == b"gone");
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
        let handle =
            spawn_projection_dispatcher(Arc::clone(&state), table, Some(16), None, None).unwrap();

        for i in 1..=5 {
            handle
                .sender
                .send(
                    DispatchItem {
                        commit_seq: i,
                        event_type: format!("evt{i}"),
                        stream_id: format!("stream_{i}").into(),
                        payload: format!("payload{i}").into_bytes(),
                    }
                    .into(),
                )
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
        let handle =
            spawn_projection_dispatcher(Arc::clone(&state), table, Some(256), None, None).unwrap();

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
                    .send(
                        DispatchItem {
                            commit_seq: i,
                            event_type: format!("write{i}"),
                            stream_id: format!("writer_{i}").into(),
                            payload: vec![],
                        }
                        .into(),
                    )
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
        use crate::projections::messages::{
            encode_key, encode_record, MessageRecord, MessagesProjection,
        };
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
            is_spoiler: false,
            files: vec![],
        };
        let payload = encode_record(&msg);
        // Writer-stamped ids are kept as-is (only empty legacy ids fall back
        // to msg_{commit_seq:x}), so the lookup key uses the stamped id.
        let key = encode_key("ch_01", "msg_01");

        handle
            .sender
            .send(
                DispatchItem {
                    commit_seq: 1,
                    event_type: "message_created".into(),
                    stream_id: "ch_msg".into(),
                    payload,
                }
                .into(),
            )
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
        assert!(
            events_entry.is_none(),
            "message should NOT be in 'events' index"
        );
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
        assert!(
            !waiter.is_finished(),
            "waiter should be blocked on the held permit"
        );

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
