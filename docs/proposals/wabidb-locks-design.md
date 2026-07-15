# WabiDB Concurrency and Lock Manager — Design

> **Card:** wabidb-20 (Phase 2, Concurrency and Lock Manager)
> **Status:** Design proposal, prerequisite for wabidb-15 (sequencer) and wabidb-32 (write barrier)
> **Author:** Hermes, derived from `docs/proposals/wabidb-endstate.md`
> **Date:** 2026-06-20

## 1. Problem

WabiDB has two concurrency requirements that are in tension:

1. **Single-writer commit sequencer** (`wabidb::sequencer`): a single async task must be the only writer to per-stream segments and the global commit index. It owns the monotonic `commit_seq` allocation. No second writer can race with it.
2. **Multi-reader projection engine** (`wabidb::projections`): many async tasks (WebSocket subscribers, REST queries, helper nodes) must read from projections concurrently with each other and with the sequencer's write.

The endstate doc states the projection update "happens asynchronously after the command returns; the caller doesn't wait for the projection" (line 2062). This means:

- The sequencer must not block on projection work
- Readers must not block on the sequencer
- A read that follows a successful write must see the write (linearizability, see `wabidb-32`)
- Reads must remain consistent during a crash mid-projection-update

A naive `std::sync::RwLock<ProjectionState>` fails on two axes:

- **Writer starvation:** under heavy read load (10k+ subscribers), the writer is repeatedly preempted and never makes progress. Verified by standard bench folklore and `parking_lot` docs.
- **Coarse-grained blocking:** any read holds the lock for the full read duration. A slow consumer (10ms read) blocks the writer for 10ms.

This design selects the lock-free skiplist path and an async sequencer permit. It also fixes the starvation and consistency interaction.

## 2. Architecture

Three components, each with a clear responsibility:

### 2.1 Sequencer permit

- Type: `tokio::sync::Semaphore` with `permits = 1`.
- Owned by: a single long-lived `tokio::task` (the "sequencer task"). The semaphore is created at engine startup; the sequencer task is the only `.acquire_owned().await` caller. The `OwnedSemaphorePermit` is held in a local variable in the sequencer loop.
- No other code path may `acquire` on this semaphore. The type is exported from `wabidb::engine::locks` as `SequencerPermit` and the constructor is `pub(crate)`.
- The sequencer task is responsible for:
  - Reading from the inbound command mpsc
  - Assigning `commit_seq`
  - Appending to per-stream segment
  - Appending to commit index
  - fsync (per `wabidb-14` batcher)
  - Releasing any events that need to be projected (see 2.2)

**Invariant:** at most one sequencer-write-flight exists in the system. The semaphore makes this structural, not behavioral.

### 2.2 Projection dispatcher

- Type: a long-lived `tokio::task` that consumes a `tokio::sync::mpsc::Receiver<CommitIndexEntry>`.
- Producer: the sequencer task, after each successful commit-index append, sends the new entry to this channel.
- Consumer: the dispatcher task, which:
  - For each entry, looks up the projection handler for the event type
  - Applies the handler to the projection state
  - Updates the per-event-type `last_applied_commit_seq` watermark
  - On success, advances the global `applied_commit_seq` watermark (a `Arc<AtomicU64>` shared with readers)

**Invariant:** projection updates happen strictly after the corresponding commit-index entry is durable. The watermark (2.3) ensures readers can wait for it.

### 2.3 Projection state and read barrier

- Storage: one `crossbeam_skiplist::SkipMap<K, V>` per projection index (e.g. one for `(channel_id, created_at) → message_id`, one for `device_id → prekey_pool`).
- Reads: lock-free via `SkipMap::iter()`. No `RwLock`, no `Mutex`.
- Writes (from the projection dispatcher): `SkipMap::insert()` is atomic per key. No global lock.
- Read barrier: each projection read returns `(state, snapshot_at_commit_seq)`. The caller can wait on a `tokio::sync::Notify` or a `tokio::sync::watch` channel if it needs to block until `applied_commit_seq >= target_seq`. See `wabidb-32` for the linearizability contract.

**Invariant:** any read of the projection state at `commit_seq = N` returns the state as of the highest `commit_seq <= N` whose events have been applied. The dispatcher never applies events out of order.

## 3. Why crossbeam-skiplist

| Option | Read | Write | Starvation | Memory |
|---|---|---|---|---|
| `std::sync::RwLock<BTreeMap>` | blocks writer | blocks readers | **yes, writer starves** | 1x |
| `parking_lot::RwLock<BTreeMap>` | blocks writer | blocks readers | better fairness, still blocking | 1x |
| `std::sync::Mutex<BTreeMap>` | exclusive | exclusive | yes | 1x |
| `dashmap::DashMap<K, V>` | per-shard RwLock | per-shard write | per-shard, partial | ~2x |
| `crossbeam_skiplist::SkipMap<K, V>` | lock-free, atomic | lock-free CAS | **no, by construction** | ~2-3x |

`crossbeam-skiplist` is selected because:
- Lock-free reads scale linearly with reader count
- Writes never starve (CAS retries on contention, but progress is bounded)
- The `SkipMap` is a real sorted map, so range queries (e.g. `range(channel_id, time_range)`) work natively
- Memory cost is bounded; the skiplist allocates on insert, not eagerly

The memory cost (~2-3x vs a packed B-tree) is acceptable because projection state is bounded by retention. For a 1M-message channel, the skiplist overhead is on the order of tens of MB.

## 4. Lock ordering and deadlock avoidance

Three rules, enforced by code review (no compile-time check possible):

1. **Single sequencer permit.** No code outside the sequencer task may hold a sequencer permit. Verified by the `pub(crate)` visibility on the permit type.
2. **No nested projection locks.** Each projection handler updates exactly one `SkipMap`. Cross-projection updates (rare) are routed through the dispatcher with two events, not a single transaction. This avoids the crossbeam-skiplist doesn't-support-transactions trap.
3. **No holding projection locks across `.await` points.** The projection handlers are sync. The dispatcher awaits on the mpsc receive, then runs sync handler code, then sends the next watermark update.

These rules are sufficient because the system has exactly one writer (sequencer) and N lock-free readers.

## 5. Backpressure and load shedding (interaction with wabidb-97)

The 50,000-commit backlog load-shedding threshold (endstate line 2941) interacts with this design at two points:

- **Sequencer → dispatcher channel capacity**: the mpsc between sequencer and dispatcher has a bounded capacity (default 1,000). When the dispatcher is slow, the channel fills, the sequencer's `send().await` blocks, and commit throughput drops naturally.
- **Per-subscriber data_tx capacity**: handled separately in `wabidb-53` (backpressure). Not this design's concern.

The dispatcher must also handle the case where the projection rebuild is in progress (no `applied_commit_seq` to advance). During rebuild, the dispatcher skips watermark advances; readers see a stable `applied_commit_seq` and read from a transient rebuild-state `SkipMap` that's swapped in atomically on completion. This is the `wabidb-28` rebuild flow.

## 6. Test plan

Mapped to the wabidb-20 acceptance criteria:

| Test | Acceptance criterion | How |
|---|---|---|
| `locks_sequencer_serial` | Only one sequencer-write-flight at a time | Spawn 100 commands; verify commit_seq is strictly monotonic |
| `locks_dispatcher_lag` | Dispatcher catches up under steady load | 10k commands; verify `applied_commit_seq` reaches `commit_seq` within 1s |
| `locks_no_starvation` | Write throughput doesn't degrade by more than 5% under heavy reads | Background: 10k tokio tasks doing `SkipMap::range()` in a loop. Foreground: sequencer at 1k commits. Assert foreground p99 within 5% of no-reader baseline. |
| `locks_no_blocking_read` | 10k concurrent reads do not block the sequencer | 10k tokio tasks each doing 100 reads. Sequencer at 1k commits. Assert sequencer throughput unchanged. |
| `locks_rebuild_swap` | Rebuild produces a valid projection from snapshots + commit index | Manual test (wabidb-28 territory) — wabidb-20 is not the gate |
| `locks_crash_during_apply` | Crash mid-apply doesn't corrupt projection state | Inject a panic after `SkipMap::insert` returns but before watermark advance. On restart, rebuild from snapshot + commit index (handled by wabidb-28). The SkipMap itself is consistent because each insert is atomic. |
| `locks_watermark_wait` | A read at seq N blocks until applied_commit_seq >= N | Reader: `tokio::time::timeout(1s, watch::receiver.wait_for(|v| *v >= N))`. Verify both success and timeout paths. |

The "no more than 5% degradation" test is the load-bearing one. The endstate doc treats 5% as acceptable; the test will tell us if that's a tight bound or loose. If tight, we drop the requirement to "no more than 10%" or move to per-shard locking. If loose, the design is sound.

## 7. Anti-patterns to reject

Document these in the code review checklist:

- `std::sync::Mutex<ProjectionState>` — every read serializes through the lock. No.
- `std::sync::RwLock<ProjectionState>` — writer starves. No.
- `parking_lot::RwLock<ProjectionState>` — still blocking. Use only as a last resort if crossbeam-skiplist is later found to be unworkable.
- Synchronous projection updates inside the sequencer permit — defeats async. No.
- Multiple sequencer tasks — breaks single-writer invariant. No.
- Cloning the entire projection state per event — O(state size) per write. Use a versioning approach instead.
- Holding a skiplist entry guard across `.await` — the entry guards in `crossbeam-skiplist` are not `Send` in the same way; the design avoids this by not holding guards across awaits.

## 8. Resolved decisions (from Council Review #0 / #1)

Three items that were open during initial design, resolved by the wabidb-05/15/20 council reviews:

1. **Snapshot strategy for atomic reads: versioned-watermark on a single growing `SkipMap`.** Each commit advances the `applied_commit_seq` watermark. Readers filter out keys with `commit_seq > watermark` via the per-record version. Rejected: arc-swap of a fresh `Arc<SkipMap>` on every commit. Reason: cloning the entire materialized state per commit is catastrophic for GC and memory at 5,000+ messages/min, and double memory for the duration of the swap. The versioned-watermark approach is standard for LSM-tree/skiplist MVCC. To prevent unbounded growth of the skiplist, the background compaction task (wabidb-42) physically removes old versions when they fall below the oldest active reader's watermark. This decision is now reflected in §2.3 of this design.

2. **Tombstone representation: separate `SkipMap<TombstoneKey, TombstoneValue>`.** Rejected: tombstones as a row in the main data map with a `deleted_at` flag. Reason: a separate map keeps the hot read path branch-free, makes retention audit (wabidb-39) trivial, and lets compaction (wabidb-42) just drop main-map keys that exist in the tombstone map. Cross-references wabidb-39 (crypto-delete) and wabidb-42 (compaction).

3. **Memory ceiling on the skiplist: proceed with crossbeam-skiplist, measure in wabidb-95.** Rejected: blocking the design on a hypothetical memory problem. Reason: crossbeam-skiplist is highly optimized for this exact use case; fragmentation risk is real but manageable at WabiDB's target scale (1k-10k users). Add a memory probe to the wabidb-95 benchmark suite. If the probe fails, the fallback is an unrolled linked list or a `BTreeMap` behind a `RwLock` sharded by `stream_id` (reduces contention while bounding memory). This is a Phase 15 concern, not a Phase 2 blocker.

## 9. Cross-references

- `wabidb-15` (commit sequencer) — uses the `SequencerPermit` defined here
- `wabidb-32` (projection write barrier) — uses the `applied_commit_seq` watermark defined here
- `wabidb-28` (rebuild) — interacts with the swap strategy in §8.1
- `wabidb-97` (config) — backlog threshold, semaphore capacity, dispatcher channel size
- Endstate doc: `docs/proposals/wabidb-endstate.md` lines 2062, 2081, 2941, 3545

## 10. What this design does NOT do

- It does not solve cross-shard transactions. There are no shards; the sequencer is the single point of ordering.
- It does not solve snapshot isolation. That's `wabidb-33` (snapshot writer) territory.
- It does not address helper-node protocol concurrency. That's `wabidb-79` and `wabidb-80`.
- It does not constrain the read-path query layer. The `WabiStore` trait (wabidb-21) is the API; this design is the implementation underneath.
