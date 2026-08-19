# WabiDB Kanban — Complete Expanded Card Set

> **Date drafted:** 2026-06-19
> **Last updated:** 2026-06-28
> **Source:** `docs/proposals/wabidb-endstate.md` + architectural risk analysis
> **Scope:** All implementation work for the v1 WabiDB engine. Every card has acceptance criteria, verification commands, and a daytime/overnight tag.

> **Status:** 799 tests passing (656 wabidb + 99 cargo workspace + 44 wabi-server). Replay engine + persistence policy implemented. **Latest session (2026-06-28):** Added `ReplayEnvelope` write-path, `replay_projections()` with snapshot watermark skip, JSON snapshot save/load/checkpoint (every 1000 events via dispatcher), 4 noop handler stubs (`reaction_removed`, `member_joined`, `member_left`, `channel_renamed`). **Updated status tracking (2026-06-28):** Re-audited all 99 cards against actual source tree to produce realistic completion counts. **Latest session (2026-08-18):** Payments projection landed — `projections/payments.rs` (8 event types, 4 indexes), payments registry registration in `build_type_registry()`, 13 `WabiStore` payment methods (`payment_account_link`/`payment_intent`/`payment_policy`/`payment_user_block`), plus `WdbAdapter` impls; wabi-server payments API rewired off JSONL onto the store (intents, account links, user blocks, policy) with a one-shot `intents.jsonl` migration. 10 new wabidb unit tests + 5 new wabi-server integration tests (`tests/payments_projection_contract.rs`). Full suite green: wabidb 861 lib tests, wabi-server 98 unit + 214 integration (107 onboarding + 5 payments + 2×2 others). See `docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md` §6b. **Latest session (2026-08-18):** Payments Phases 2-4 landed — three optional rails as addon crates (`wabi-payments-crypto`, `wabi-payments-eu` [EPC069-12 v3.1, no CRC — verified against the official PDF], `wabi-payments-us`; 6/8/7 tests) wired into wabi-server under the `payments-rails` cargo feature (cfg-gated `/addons` capability entries, provider-routed intent creation in `api/payments/intents.rs` with `WABI_CRYPTO_MERCHANT_NAME`/`WABI_EU_PAYEE_NAME`/`WABI_EU_BIC` envs, shared `reference_code()` helper) + 5 rail-contract integration tests; frontend capability-gated checkout (catalog, route presets, per-rail connection labels, app_switch intent card, external-confirmation status). Verified: workspace green (default + `--features payments-rails`), `bun run check` 0 errors. See plan doc §6c. **WS-3 enforcement (2026-08-18, ZCode):** `create_intent` now enforces the payments access policy + user blocks (`evaluate_payment_access`, 403 blocked/disabled/role/guest; JWT is_guest decoded); `/payments/access` returns a server-computed actor; default policy flipped to enabled (kill-switch semantics — plan §6d); +1 integration test, 6/6 payments contract tests green.

## Conventions

- **ID format:** `wabidb-NN` (sequential within component group)
- **Component:** which major area of the engine
- **Tag:**
  - `DAYTIME` — needs human judgment, do with the user in a session
  - `OVERNIGHT` — safe for cron, mechanical, no judgment
  - `MIXED` — daytime session starts the work, overnight cron continues verification
- **Size:**
  - `S` = 1-4 hours
  - `M` = 1-2 days
  - `L` = 3+ days
- **Depends on:** cards that must complete first (or be in flight with a clear interface)
- **Scope:** 1-3 lines on what's in / what's out
- **Files:** where the work lands (relative to `core/crates/wabidb/`)
- **Acceptance:** testable conditions for done
- **Verify:** the command(s) to run to check
- **Notes:** gotchas, prior decisions, traps to avoid

---

## Phase 1: Storage Foundation

### wabidb-01: Cargo project setup
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** —
- **Scope:** Create `core/crates/wabidb/` as a Rust library crate. Set up `Cargo.toml` with workspace dependency declarations for `blake3`, `aes-gcm`, `crc32c`, `tokio`, `serde`, `tracing`. Create empty `src/lib.rs` and module skeleton.
- **Files:** `core/crates/wabidb/Cargo.toml`, `core/crates/wabidb/src/lib.rs`
- **Acceptance:** `cargo check -p wabidb` succeeds.
- **Verify:** `cd /var/home/Ronin/wabi && cargo check -p wabidb`

### wabidb-02: Storage format spec doc
- **Component:** Foundation
- **Tag:** OVERNIGHT
- **Size:** M
- **Depends on:** —
- **Scope:** Write `core/crates/wabidb/docs/STORAGE_FORMAT.md` specifying byte-by-byte on-disk record format. Magic, format version, header layout, CRC32C, payload framing, segment rotation.
- **Files:** `core/crates/wabidb/docs/STORAGE_FORMAT.md`
- **Acceptance:** Doc covers all byte offsets and constants.
- **Verify:** Doc exists.

### wabidb-03: Error types
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** —
- **Scope:** Define `WabiError` enum covering all error categories. Implements `std::error::Error + Send + Sync`.
- **Files:** `core/crates/wabidb/src/error.rs`
- **Acceptance:** Type compiles, has structured variants.
- **Verify:** `cargo check -p wabidb`

### wabidb-04: Custom byte primitives
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-02
- **Scope:** Implement record header read/write, CRC32C verification, magic check.
- **Files:** `core/crates/wabidb/src/format/record.rs`
- **Acceptance:** Round-trip test passes. CRC mismatch rejects.
- **Verify:** `cargo test -p wabidb --lib format::record`

### wabidb-05: Per-stream encryption primitive
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-03
- **Scope:** Implement AES-256-GCM with `commit_seq` as the nonce. AAD is the `RecordHeader` (magic, version, kind, `commit_seq`, length).
- **Files:** `core/crates/wabidb/src/crypto/aes_gcm_record.rs`
- **Acceptance:** Encrypt/decrypt round-trip. Bit flip in ciphertext fails authentication. Bit flip in AAD fails authentication. `commit_seq` is unique per (key, stream) pair. `header_crc32c` is computed before encryption; GCM tag covers the header as passed to the AES-GCM API.
- **Verify:** `cargo test -p wabidb --lib crypto::aes_gcm_record`
- **Notes:** Nonce safety: AES-GCM catastrophic failure on (key, nonce) reuse. The safety requirement is `commit_seq` strictly monotonic *within a single stream*. This holds because the global sequencer assigns monotonic `commit_seq` and each stream receives a strictly increasing subset. On key rotation, the new key MUST NOT reuse `commit_seq` values used by the old key; safe because the global sequencer never resets. `StreamKeyRegistry` must record `max_commit_seq` on rotation and the sequencer must never encrypt a record with `commit_seq` <= a key's `min_commit_seq`. Nonce construction: 8-byte u64 padded to 12 bytes wraps at 2^64. Document the wrap limit in code comments. If a 96-bit internal counter is trivially implementable, prefer it; reserve one byte for algorithm versioning. See `docs/architecture/wabidb-council-reviews.md` Council Review #1 §1.1-1.3.

### wabidb-06: Stream segment writer
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-04, wabidb-05
- **Scope:** Append-only file writer for a single stream segment. fsync, segment rotation at 64 MiB.
- **Files:** `core/crates/wabidb/src/stream_log/segment_writer.rs`
- **Acceptance:** Write 1000 records, read back, all match.
- **Verify:** `cargo test -p wabidb --lib stream_log::segment_writer`

### wabidb-07: Stream segment reader
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-04, wabidb-05
- **Scope:** Read records from a stream segment. Skip bad CRCs, stop at EOF. **Orphaned records (records with a valid `commit_seq` that does not exist in the commit index) are skipped, not truncated, not panicked on.** The commit index is the sole source of truth for which records exist.
- **Files:** `core/crates/wabidb/src/stream_log/segment_reader.rs`
- **Acceptance:** Read 1000 records. Corrupted record skipped. Orphaned record skipped silently. Truncated segment doesn't panic. Reader never physically truncates the segment file; truncation is `wabidb-08` (recovery) and `wabidb-42` (compaction) responsibility, not this card's.
- **Verify:** `cargo test -p wabidb --lib stream_log::segment_reader`
- **Notes:** This is Option B rollback semantics from Council Review #1 §2.2. The endstate doc says "stream records written but not referenced by the commit index are orphans (ignored on recovery)" — this card makes that explicit. A record with `commit_seq=100` present in the segment but absent from the commit index is treated as if it doesn't exist; reads silently skip past it. This is the only safe behavior; truncating could destroy subsequent valid commits. See `docs/architecture/wabidb-council-reviews.md`.

### wabidb-08: Segment recovery (scan-and-truncate)
- **Component:** Foundation
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-07
- **Scope:** On stream open, scan segment. Truncate at first invalid record. Update file size on disk.
- **Files:** `core/crates/wabidb/src/stream_log/recovery.rs`
- **Acceptance:** Corrupted tail is truncated, valid prefix preserved.
- **Verify:** `cargo test -p wabidb --lib stream_log::recovery`

### wabidb-09: StreamKeyRegistry
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-03
- **Scope:** In-memory registry of stream encryption keys. Create, get, rotate, destroy.
- **Files:** `core/crates/wabidb/src/crypto/stream_key_registry.rs`
- **Acceptance:** Destroyed key returns NotFound, decryption fails.
- **Verify:** `cargo test -p wabidb --lib crypto::stream_key_registry`

### wabidb-10: Storage manifest format
- **Component:** Foundation
- **Tag:** OVERNIGHT
- **Size:** M
- **Depends on:** wabidb-02
- **Scope:** Write `docs/STORAGE_MANIFEST.md` specifying backup manifest schema.
- **Files:** `core/crates/wabidb/docs/STORAGE_MANIFEST.md`
- **Acceptance:** Doc covers all manifest fields.

### wabidb-11: Engine initialization and bootstrap key loading (NEW)
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-09
- **Scope:** Implement the startup sequence for `WabiDbEngine::open(config)`. Read the storage manifest, verify directories. Load the root encryption key from operator bootstrap source (passphrase prompt, env var, or OS keychain). Derive stream keys. If data dir is empty, initialize structure and write `storage-manifest.json`.
- **Files:** `core/crates/wabidb/src/engine/mod.rs`, `core/crates/wabidb/src/crypto/bootstrap.rs`
- **Acceptance:** Engine opens existing dir and loads keys. Engine initializes empty dir. Fails cleanly if passphrase is wrong.
- **Verify:** `cargo test -p wabidb --lib engine::bootstrap`
- **Notes:** The root key never touches disk. Must handle OS keychain integration gracefully if unavailable.

### wabidb-12: Directory fsync utility (NEW)
- **Component:** Foundation
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-03
- **Scope:** Implement a cross-platform utility to fsync a directory handle after file renames/creations. This is critical for crash consistency on POSIX systems (rename is atomic, but not durable without dir fsync).
- **Files:** `core/crates/wabidb/src/storage/fsync.rs`
- **Acceptance:** Utility compiles and exposes `fsync_dir(path)`. Tested on Linux.
- **Verify:** `cargo test -p wabidb --lib storage::fsync`
- **Notes:** Missing directory fsyncs is the #1 cause of custom database corruption on power loss.

## Phase 2: Commit Infrastructure

### wabidb-13: Global commit index record format
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-04
- **Scope:** Commit index entry record format. Append-only, fsync'd in batches.
- **Files:** `core/crates/wabidb/src/commit_index/record.rs`
- **Acceptance:** Round-trip test. CRC mismatch rejects.
- **Verify:** `cargo test -p wabidb --lib commit_index::record`

### wabidb-14: Commit index fsync batcher
- **Component:** Commit
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-13
- **Scope:** Batch incoming commit entries. Flush when batch size (10) or age (50ms) hits threshold. fsync the file.
- **Files:** `core/crates/wabidb/src/commit_index/batcher.rs`
- **Acceptance:** Submits durable within 50ms. Crash mid-batch loses only pending entries.
- **Verify:** `cargo test -p wabidb --lib commit_index::batcher`

### wabidb-15: Commit sequencer
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** wabidb-14, wabidb-08
- **Scope:** Single global ordering point. Receives `CommandCommit`, assigns monotonic `commit_seq`, writes to stream_log, appends to commit index, fsyncs. **Adopts Option B rollback (Council Review #1 §2.2):** orphaned records on disk are allowed; the commit index is the sole source of truth; physical truncation only in `wabidb-42` (compaction) or `wabidb-39` (retention). **Burned `commit_seq` invariant:** a `commit_seq` assigned to a command whose writes fail is never reused. **Durability await:** `run_command` must not return `Ok` until the batch containing its `commit_seq` is fsync'd. **Backpressure:** the bounded mpsc to the projection dispatcher (default capacity 1024) must be monitored; when full, the engine enters degraded mode (`wabidb-97` load-shedding), rejecting non-essential commands rather than deadlocking.
- **Files:** `core/crates/wabidb/src/sequencer/mod.rs`
- **Acceptance:** 1000 commands get unique seqs in order. Mid-flight failure leaves no commit-index entry; orphaned stream records are tolerated (not errors). The same `commit_seq` is never assigned twice across a crash-recovery cycle. A command only returns `Ok` after the commit-index batch containing its seq is fsync'd. Bounded mpsc to dispatcher: when full, `run_command` returns `EngineBusy` (non-essential commands) or `EssentialAllowed` (essential commands like `send_message`).
- **Verify:** `cargo test -p wabidb --lib sequencer`; manual 10k commits without stalls
- **Notes:** The burned-seq invariant is also what keeps AES-GCM nonces safe (Council Review #1 §2.4). A burned seq is never used with any stream's key, so nonce reuse is impossible even on rollback. The durability-await requirement (Council Review #1 §2.3) is non-negotiable: lying to the client about durability is a correctness bug, not a performance one. If batch latency is too high, tune the batch size (`wabidb-97`); never return `Ok` early. See `docs/architecture/wabidb-council-reviews.md` for the full review.

### wabidb-16: DurableEvent + CommandOutcome types
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-03
- **Scope:** Define `DurableEvent`, `CommandOutcome`, `CommandCommit`.
- **Files:** `core/crates/wabidb/src/sequencer/types.rs`
- **Acceptance:** Types compile. Round-trip serialization.
- **Verify:** `cargo check -p wabidb`

### wabidb-17: run_command wrapper
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-15, wabidb-16
- **Scope:** Single entry point for mutations. Idempotency, auth, execution, sequencer handoff, cache result.
- **Files:** `core/crates/wabidb/src/commands/runner.rs`
- **Acceptance:** Idempotency replay works. Auth failure writes nothing.
- **Verify:** `cargo test -p wabidb --lib commands::runner`

### wabidb-18: command_idempotency table
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-17
- **Scope:** Projection table for idempotency cache.
- **Files:** `core/crates/wabidb/src/commands/idempotency.rs`
- **Acceptance:** Insert, lookup, delete by expires_at.
- **Verify:** `cargo test -p wabidb --lib commands::idempotency`

### wabidb-19: consumer_offsets table
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-17
- **Scope:** Projection table for reliable consumer checkpoints.
- **Files:** `core/crates/wabidb/src/subscription/consumer_offsets.rs`
- **Acceptance:** Insert, update, resume from offset.
- **Verify:** `cargo test -p wabidb --lib subscription::consumer_offsets`

### wabidb-20: Concurrency and Lock Manager (NEW)
- **Component:** Commit
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** wabidb-15
- **Scope:** Implement the concurrency model for the single-writer commit sequencer and multi-reader projections. The sequencer holds an exclusive write lock (or async permit) during the append + index update. Projections must be updated safely. If projections are updated inline, they block the sequencer. If updated asynchronously, a `RwLock` or crossbeam-skiplist is needed for the projection state.
- **Files:** `core/crates/wabidb/src/engine/locks.rs`
- **Acceptance:** 10,000 concurrent read queries do not block the commit sequencer. Write throughput does not degrade by more than 5% under heavy read load.
- **Verify:** `cargo test -p wabidb --lib engine::locks -- --test-threads=4`
- **Notes:** If you use std `RwLock`, writes will starve under heavy reads. Consider `parking_lot::RwLock` or a lock-free skiplist for indexes.

## Phase 3: WabiStore Trait (the API boundary)

### wabidb-21: WabiStore trait definition
- **Component:** Storage API
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-16
- **Scope:** Define `WabiStore` trait. Domain methods only, no segment-level access.
- **Files:** `core/crates/wabidb/src/storage/api.rs`
- **Acceptance:** Trait compiles with doc comments.
- **Verify:** `cargo doc -p wabidb`

### wabidb-22: WabiStore implementation skeleton
- **Component:** Storage API
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-21
- **Scope:** Implement `WabiStore` on `WabiStoreImpl` routing to components.
- **Files:** `core/crates/wabidb/src/storage/impl.rs`
- **Acceptance:** Methods compile, smoke test passes.
- **Verify:** `cargo check -p wabidb`

## Phase 4: Projection Engine

### wabidb-23: Projection handler trait
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-21
- **Scope:** Define `Projection` trait. Dispatch table for event_type.
- **Files:** `core/crates/wabidb/src/projections/handler.rs`
- **Acceptance:** Trait compiles.
- **Verify:** `cargo check -p wabidb`

### wabidb-24: messages projection
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-23
- **Scope:** Handlers for `message_created`, `message_edited`, `message_deleted`. Maintains `(channel_id, created_at DESC)` index.
- **Files:** `core/crates/wabidb/src/projections/messages.rs`
- **Acceptance:** 10 messages inserted, query returns them sorted.
- **Verify:** `cargo test -p wabidb --lib projections::messages`

### wabidb-25: reactions projection
- **Component:** Projection
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-24
- **Scope:** Handlers for `reaction_added`, `reaction_removed`.
- **Files:** `core/crates/wabidb/src/projections/reactions.rs`
- **Acceptance:** Aggregation query returns correct emoji counts.
- **Verify:** `cargo test -p wabidb --lib projections::reactions`

### wabidb-26: dm_messages projection
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-24
- **Scope:** Handler for `dm_message_created`. Updates `dm_messages` and `dm_message_recipients`.
- **Files:** `core/crates/wabidb/src/projections/dm_messages.rs`
- **Acceptance:** Send DM with 2 devices, query returns 2 rows in recipients.
- **Verify:** `cargo test -p wabidb --lib projections::dm_messages`

### wabidb-27: dm_message_recipients projection
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-26
- **Scope:** Handler for `dm_message_recipient_consumed`.
- **Files:** `core/crates/wabidb/src/projections/dm_recipients.rs`
- **Acceptance:** Mark consumed, query reflects it.
- **Verify:** `cargo test -p wabidb --lib projections::dm_recipients`

### wabidb-28: whiteboard_patches projection
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-24
- **Scope:** Handler for `whiteboard_patch_applied`. Source-of-truth `base_version` enforcement.
- **Files:** `core/crates/wabidb/src/projections/whiteboard_patches.rs`
- **Acceptance:** Stale `base_version` returns ConflictError.
- **Verify:** `cargo test -p wabidb --lib projections::whiteboard_patches`

### wabidb-29: channels + channel_members projection
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-24
- **Scope:** Handlers for channel lifecycle events.
- **Files:** `core/crates/wabidb/src/projections/channels.rs`
- **Acceptance:** Create, add member, remove member flows work.
- **Verify:** `cargo test -p wabidb --lib projections::channels`

### wabidb-30: Fixed skiplist/B-tree indexes
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** —
- **Scope:** Custom sorted indexes for the projection engine.
- **Files:** `core/crates/wabidb/src/projections/indexes/fixed_indexes.rs`
- **Acceptance:** 10,000 entries, range scan sorted. Lookup O(log n).
- **Verify:** `cargo bench -p wabidb indexes -- --quick`
- **Notes:** Consider using `crossbeam-skiplist` instead of writing from scratch to save time and ensure lock-free reads.

### wabidb-31: rebuild_indexes from snapshots + commit index
- **Component:** Projection
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-30
- **Scope:** Procedure to drop projection state and rebuild from canonical sources.
- **Files:** `core/crates/wabidb/src/projections/rebuild.rs`
- **Acceptance:** 1000 events dropped and rebuilt, state matches.
- **Verify:** `cargo test -p wabidb --lib projections::rebuild`

### wabidb-32: Projection Write Barrier (NEW)
- **Component:** Projection
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-24, wabidb-20
- **Scope:** Implement the barrier between the commit sequencer and the projection engine. The sequencer must not return `Ok` to the caller until the event is fsync'd. However, the projection update can be synchronous or async. If async, the sequencer must wait for the projection to catch up to `commit_seq N` before allowing a read at `commit_seq N` (linearizability).
- **Files:** `core/crates/wabidb/src/projections/barrier.rs`
- **Acceptance:** A read following a successful write is guaranteed to see the written data. No torn reads.
- **Verify:** `cargo test -p wabidb --lib projections::barrier`
- **Notes:** If reads can be stale, frontend sync logic will break. You need a read-write consistency barrier.

## Phase 5: Snapshot Manager

### wabidb-33: Snapshot writer
- **Component:** Snapshot
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-23
- **Scope:** Write per-stream snapshot records anchoring projection rebuilds.
- **Files:** `core/crates/wabidb/src/snapshots/writer.rs`
- **Acceptance:** Snapshot at event 100, replay 101-200 works.
- **Verify:** `cargo test -p wabidb --lib snapshots::writer`

### wabidb-34: Snapshot reloader
- **Component:** Snapshot
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-33
- **Scope:** Load latest snapshot, replay post-snapshot events.
- **Files:** `core/crates/wabidb/src/snapshots/loader.rs`
- **Acceptance:** Reload state matches live state.
- **Verify:** `cargo test -p wabidb --lib snapshots::loader`

### wabidb-35: Per-stream snapshot policy
- **Component:** Snapshot
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-33
- **Scope:** Trigger snapshots every 10k events or 24 hours.
- **Files:** `core/crates/wabidb/src/snapshots/policy.rs`
- **Acceptance:** Policy triggers correctly.
- **Verify:** `cargo test -p wabidb --lib snapshots::policy`

### wabidb-36: whiteboard_snapshots + history tables
- **Component:** Snapshot
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-33
- **Scope:** Projection tables for whiteboard snapshots and history.
- **Files:** `core/crates/wabidb/src/projections/whiteboard_snapshots.rs`
- **Acceptance:** Schema matches, retention reap works.
- **Verify:** `cargo test -p wabidb --lib projections::whiteboard_snapshots`

## Phase 6: Retention Engine

### wabidb-37: expires_at indexes
- **Component:** Retention
- **Tag:** OVERNIGHT
- **Size:** S
- **Depends on:** wabidb-21
- **Scope:** Add `expires_at` columns and indexes to all user-data tables.
- **Files:** `core/crates/wabidb/src/retention/expires_index.rs`
- **Acceptance:** Schema dump shows `idx_*_expires`.
- **Verify:** `cargo test -p wabidb --lib retention::expires_index`

### wabidb-38: Per-stream TTL reaper
- **Component:** Retention
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-37
- **Scope:** Background task scanning `expires_at` indices. Deletes rows, logs to audit_log.
- **Files:** `core/crates/wabidb/src/retention/reaper.rs`
- **Acceptance:** 100 expired rows deleted, audit_log has 100 entries.
- **Verify:** `cargo test -p wabidb --lib retention::reaper`

### wabidb-39: Cryptographic deletion (key destruction + tombstone)
- **Component:** Retention
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-09, wabidb-38
- **Scope:** Drop stream segments, destroy encryption key, append tombstone to commit index.
- **Files:** `core/crates/wabidb/src/retention/crypto_delete.rs`
- **Acceptance:** Stream gone, key gone, commit index has tombstone. Read returns NotFound.
- **Verify:** `cargo test -p wabidb --lib retention::crypto_delete`

### wabidb-40: retention_policies table
- **Component:** Retention
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-37
- **Scope:** Per-scope policy storage.
- **Files:** `core/crates/wabidb/src/retention/policies.rs`
- **Acceptance:** Insert policies for global, channel, dm_user scopes.
- **Verify:** `cargo test -p wabidb --lib retention::policies`

### wabidb-41: Per-scope policy evaluation
- **Component:** Retention
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-40
- **Scope:** Evaluate policy on row creation. Recompute `expires_at` on policy change.
- **Files:** `core/crates/wabidb/src/retention/evaluate.rs`
- **Acceptance:** Policy update to 7 days updates unexpired rows correctly.
- **Verify:** `cargo test -p wabidb --lib retention::evaluate`

### wabidb-42: Segment Compaction and GC (NEW)
- **Component:** Retention
- **Tag:** MIXED
- **Size:** L
- **Depends on:** wabidb-33, wabidb-39
- **Scope:** The design mentions compaction merges small segments and removes dead records. Implement the compaction job for a stream: read all valid records, write to a new segment, fsync, atomically replace old segments in manifest, delete old segment files. Must run without blocking writes to that stream (or block very briefly).
- **Files:** `core/crates/wabidb/src/retention/compaction.rs`
- **Acceptance:** A stream with 10 segments, 5 of which contain deleted/tombstoned records, is compacted into 1 segment. No data loss. Writes to stream succeed during compaction (or block for < 10ms).
- **Verify:** `cargo test -p wabidb --lib retention::compaction`
- **Notes:** This is essential for long-running streams. Without it, disk usage grows unbounded even if data is logically deleted.

## Phase 7: Ephemeral Bus

### wabidb-43: EmissionDurability enum
- **Component:** Ephemeral
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-16
- **Scope:** Define `EmissionDurability` enum. Compile-time boundary via sealed trait.
- **Files:** `core/crates/wabidb/src/ephemeral/durability.rs`
- **Acceptance:** Compiler rejects `EphemeralMemoryOnly` in `CommandCommit`.
- **Verify:** `cargo check -p wabidb`

### wabidb-44: EphemeralBus
- **Component:** Ephemeral
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-43
- **Scope:** In-memory broadcast using `tokio::sync::broadcast`. Drop slow subscribers.
- **Files:** `core/crates/wabidb/src/ephemeral/bus.rs`
- **Acceptance:** 2 subscribers receive 100 events. Slow subscriber gets Lagged.
- **Verify:** `cargo test -p wabidb --lib ephemeral::bus`

### wabidb-45: Ephemeral event dispatch
- **Component:** Ephemeral
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-44
- **Scope:** Dispatch ephemeral events to ephemeral subscribers, bypassing durable log.
- **Files:** `core/crates/wabidb/src/ephemeral/dispatch.rs`
- **Acceptance:** Durable subscribers don't see ephemeral events.
- **Verify:** `cargo test -p wabidb --lib ephemeral::dispatch`

## Phase 8: Subscription Engine

### wabidb-46: Topic enum + grammar
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-03
- **Scope:** Define `Topic` enum with serialize/deserialize. Reject colons in stream id.
- **Files:** `core/crates/wabidb/src/subscription/topic.rs`
- **Acceptance:** Round-trip all variants. Reject colons.
- **Verify:** `cargo test -p wabidb --lib subscription::topic`

### wabidb-47: TopicAcl trait
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-46
- **Scope:** Define `TopicAcl` trait. Default impl checks membership.
- **Files:** `core/crates/wabidb/src/subscription/acl.rs`
- **Acceptance:** User can subscribe to own inbox, not others.
- **Verify:** `cargo test -p wabidb --lib subscription::acl`

### wabidb-48: Live fanout (in-memory subscribers)
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-47
- **Scope:** Match durable events to live subscribers, enqueue on mpsc.
- **Files:** `core/crates/wabidb/src/subscription/live_fanout.rs`
- **Acceptance:** 3 subscribers receive event, 1 on different channel does not.
- **Verify:** `cargo test -p wabidb --lib subscription::live_fanout`

### wabidb-49: Topic indexes (fast matching)
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-48
- **Scope:** `HashMap<TopicKey, HashSet<SubscriberId>>` for exact and wildcard matches.
- **Files:** `core/crates/wabidb/src/subscription/topic_index.rs`
- **Acceptance:** 1,000 subscribers, 10,000 events, O(1) lookup.
- **Verify:** `cargo bench -p wabidb subscription::topic_index`

### wabidb-50: Snapshot barrier
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-48
- **Scope:** Capture `commit_seq` on subscribe. Deliver only `seq > barrier`.
- **Files:** `core/crates/wabidb/src/subscription/barrier.rs`
- **Acceptance:** Subscribe at 100, receive 101-103. Subscribe at 200, receive 0.
- **Verify:** `cargo test -p wabidb --lib subscription::barrier`

### wabidb-51: Resume cursor
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-50, wabidb-19
- **Scope:** Reconnect with `resume_after`. Replay or `SnapshotRequired`.
- **Files:** `core/crates/wabidb/src/subscription/resume.rs`
- **Acceptance:** Disconnect, 50 events, reconnect, receive 50.
- **Verify:** `cargo test -p wabidb --lib subscription::resume`

### wabidb-52: EventEnvelope with versioning
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-48
- **Scope:** Define `EventEnvelope`. BSATN/bincode serialization.
- **Files:** `core/crates/wabidb/src/subscription/envelope.rs`
- **Acceptance:** Round-trip serialize. Old clients reject high versions.
- **Verify:** `cargo test -p wabidb --lib subscription::envelope`

### wabidb-53: Backpressure with priority lanes
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-48
- **Scope:** Per-subscriber control_tx (small) and data_tx (bounded). Drop after 5s.
- **Files:** `core/crates/wabidb/src/subscription/backpressure.rs`
- **Acceptance:** Full data_tx triggers control_tx. 5s timeout drops connection.
- **Verify:** `cargo test -p wabidb --lib subscription::backpressure`

### wabidb-54: WebSocket adapter
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** L
- **Depends on:** wabidb-48, wabidb-52
- **Scope:** Raw WebSocket. Auth, Subscribe, stream events, reconnect.
- **Files:** `core/crates/wabidb/src/subscription/websocket.rs`
- **Acceptance:** Connect, auth, subscribe, receive snapshot and live events.
- **Verify:** `cargo test -p wabidb --lib subscription::websocket`

### wabidb-55: WebSocket ticket auth (no JWT in URL)
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-54
- **Scope:** `POST /v1/ws-ticket` endpoint. 15s TTL, one-time use.
- **Files:** `core/crates/wabidb/src/subscription/ticket_auth.rs`
- **Acceptance:** Valid ticket -> AuthOk. Expired/used -> AuthErr.
- **Verify:** `cargo test -p wabidb --lib subscription::ticket_auth`

### wabidb-56: ws_tickets table + atomic redemption
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-55
- **Scope:** Projection table. Schema: ticket_hash, caller_user_id, expires_at, used.
- **Files:** `core/crates/wabidb/src/projections/ws_tickets.rs`
- **Acceptance:** Insert, lookup, mark used. Reaper deletes expired.
- **Verify:** `cargo test -p wabidb --lib projections::ws_tickets`

### wabidb-57: Membership Change Revalidation (NEW)
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-47, wabidb-48
- **Scope:** When a user is removed from a channel, banned, or loses a role, the subscription engine must actively revoke their existing live subscriptions. They should not continue receiving events for topics they no longer have access to.
- **Files:** `core/crates/wabidb/src/subscription/revalidation.rs`
- **Acceptance:** User A subscribes to channel X. Admin removes A from X. Next event in X is not delivered to A.
- **Verify:** `cargo test -p wabidb --lib subscription::revalidation`

## Phase 9: Blob Store

### wabidb-58: BLAKE3 content addressing
- **Component:** Blob
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-03
- **Scope:** Helper functions: `compute_hash`, `path_for_hash`.
- **Files:** `core/crates/wabidb/src/blobs/addressing.rs`
- **Acceptance:** Deterministic hash, correct path.
- **Verify:** `cargo test -p wabidb --lib blobs::addressing`

### wabidb-59: Blob write ordering
- **Component:** Blob
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-58, wabidb-12
- **Scope:** Write to temp, fsync, rename, fsync dir, update projection.
- **Files:** `core/crates/wabidb/src/blobs/write.rs`
- **Acceptance:** Crash between steps leaves blob fully present or absent.
- **Verify:** `cargo test -p wabidb --lib blobs::write`

### wabidb-60: Range read protocol
- **Component:** Blob
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-59
- **Scope:** Read bytes at offset N for length L. Stream with 256 KB BufReader.
- **Files:** `core/crates/wabidb/src/blobs/range_read.rs`
- **Acceptance:** Memory bounded to 256 KB regardless of blob size.
- **Verify:** `cargo test -p wabidb --lib blobs::range_read`

### wabidb-61: Blob metadata table
- **Component:** Blob
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-58
- **Scope:** `blob_metadata` projection table: hash, size, mime, ref_count.
- **Files:** `core/crates/wabidb/src/projections/blob_metadata.rs`
- **Acceptance:** Insert, increment/decrement ref_count, delete.
- **Verify:** `cargo test -p wabidb --lib projections::blob_metadata`

### wabidb-62: Blob GC (orphaned reference cleanup)
- **Component:** Blob
- **Tag:** OVERNIGHT
- **Size:** S
- **Depends on:** wabidb-61
- **Scope:** Background task every 6 hours. Scan for `ref_count = 0`, delete file.
- **Files:** `core/crates/wabidb/src/blobs/gc.rs`
- **Acceptance:** Orphaned file deleted. Second run is no-op.
- **Verify:** `cargo test -p wabidb --lib blobs::gc`

## Phase 10: Storage CLI

### wabidb-63: `wabidb check` command
- **Component:** CLI
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-15
- **Scope:** Binary subcommand. Open data dir, scan index/segments, verify CRCs. Don't modify.
- **Files:** `core/crates/wabidb/src/bin/wabidb.rs`, `core/crates/wabidb/src/cli/check.rs`
- **Acceptance:** "OK" on healthy, "ERROR" on corrupt, exit non-zero.
- **Verify:** `cargo run -p wabidb --bin wabidb -- check`

### wabidb-64: `wabidb dump-stream` command
- **Component:** CLI
- **Tag:** OVERNIGHT
- **Size:** S
- **Depends on:** wabidb-07
- **Scope:** Print all events in a stream, newest first, BSATN or JSON.
- **Files:** `core/crates/wabidb/src/cli/dump_stream.rs`
- **Acceptance:** Prints events.
- **Verify:** Manual.

### wabidb-65: `wabidb inspect-commit` command
- **Component:** CLI
- **Tag:** OVERNIGHT
- **Size:** S
- **Depends on:** wabidb-13
- **Scope:** Show commit index entry, event refs, payload hashes.
- **Files:** `core/crates/wabidb/src/cli/inspect_commit.rs`
- **Acceptance:** Shows commit details.
- **Verify:** Manual.

### wabidb-66: `wabidb rebuild-indexes` command
- **Component:** CLI
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-31
- **Scope:** Drop projection state, rebuild from snapshots + commit index.
- **Files:** `core/crates/wabidb/src/cli/rebuild_indexes.rs`
- **Acceptance:** Projection state matches pre-drop state.
- **Verify:** `cargo run -p wabidb --bin wabidb -- rebuild-indexes`

### wabidb-67: `wabidb list-streams` command
- **Component:** CLI
- **Tag:** OVERNIGHT
- **Size:** S
- **Depends on:** wabidb-21
- **Scope:** List all streams with kind, key id, retention, size.
- **Files:** `core/crates/wabidb/src/cli/list_streams.rs`
- **Acceptance:** Shows table of streams.
- **Verify:** Manual.

### wabidb-68: Manifest-based backup
- **Component:** CLI
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** wabidb-10
- **Scope:** Acquire read lock, capture `highest_commit_seq`, walk dir, hash files, write manifest.
- **Files:** `core/crates/wabidb/src/cli/backup.rs`
- **Acceptance:** Manifest consistent with data dir.
- **Verify:** Manual.

### wabidb-69: `wabidb verify-backup` command
- **Component:** CLI
- **Tag:** OVERNIGHT
- **Size:** S
- **Depends on:** wabidb-68
- **Scope:** Verify manifest against backup directory.
- **Files:** `core/crates/wabidb/src/cli/verify_backup.rs`
- **Acceptance:** "OK" on match, "ERROR" on mismatch.
- **Verify:** Manual.

## Phase 11: First Vertical Slice (end-to-end)

### wabidb-70: send_message command
- **Component:** Command
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-17, wabidb-24, wabidb-29
- **Scope:** First command. Auth, validation, emit `message_created`, return ULID.
- **Files:** `core/crates/wabidb/src/commands/messages/send_message.rs`
- **Acceptance:** Member sends message, projection has it. Non-member gets Forbidden.
- **Verify:** `cargo test -p wabidb --lib commands::messages::send_message`

### wabidb-71: Channel messages subscription
- **Component:** Command
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-54, wabidb-70
- **Scope:** First end-to-end flow. WebSocket subscribe, send message, receive event.
- **Files:** `core/crates/wabidb/tests/integration/send_message_flow.rs`
- **Acceptance:** Connect, auth, subscribe, send, receive.
- **Verify:** `cargo test -p wabidb --test integration -- send_message_flow`

### wabidb-72: 10 crash/resume tests
- **Component:** First vertical slice
- **Tag:** MIXED
- **Size:** L
- **Depends on:** wabidb-71
- **Scope:** 10 deterministic crash/resume tests in `core/crates/wabidb/tests/crash_resume.rs`. Test spec designed in Council Review #2 (`docs/architecture/wabidb-council-reviews.md`): (1) `atomic_commit_happy_path`, (2) `failure_rollback_option_b`, (3) `idempotency_replay`, (4) `snapshot_barrier`, (5) `resume_after_disconnect`, (6) `acl_denial_at_subscribe`, (7) `membership_change_revalidation`, (8) `commit_index_fsync_crash`, (9) `backup_and_restore`, (10) `snapshot_required`. **Crash injection: debug hook in the sequencer, `#[cfg(feature = "test-harness")]`, calls `std::process::exit(1)` at a configured boundary.** The "outbox crash" name on the original card is a leftover term; the equivalent in the log-structured design is "commit_index_fsync_crash" (test 8). Build in two waves: Wave A (Phase 11) = tests 1-9; Wave B (Phase 13) = test 10, after the helper-node protocol lands.
- **Files:** `core/crates/wabidb/tests/crash_resume.rs`, plus the `#[cfg(feature = "test-harness")]` debug hook in the sequencer.
- **Acceptance:** All 10 tests pass deterministically. Total runtime < 60s. Each test runs against a fresh `/tmp/wabidb-test-{uuid}/` data dir (UUID v4 to avoid collision under parallel runs). Test 7 requires `wabidb-57` to be implemented; test 10 requires a minimal in-process helper stub or the full `wabidb-79+` helper protocol.
- **Verify:** `cargo test -p wabidb --test crash_resume`
- **Notes:** This is the architecture validation gate. Each test targets a specific invariant from `docs/proposals/wabidb-endstate.md` §15.4 plus the 3 Council Review #1 invariants (Option B orphan skip, burned-seq never reused, durability-await correctness). Test 8 is the highest-value test for the Option B decision — it directly exercises the "burned seq + orphan skip" path. The debug hook is `#[cfg(feature = "test-harness")]` so it is compiled out of release builds. The harness uses `uuid::Uuid::new_v4()` for fresh data dirs to avoid collision under parallel runs. See Council Review #2 in `docs/architecture/wabidb-council-reviews.md` for the full test spec, crash-injection mechanism, anti-patterns, and dependency notes.

### wabidb-73: First-vertical-slice integration test
- **Component:** First vertical slice
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-72
- **Scope:** Real wabi-server binary using the engine. WebSocket, ticket auth, send_message.
- **Files:** `core/crates/wabi-server/src/main.rs`
- **Acceptance:** Start binary, connect client, send message, receive it.
- **Verify:** Manual.

### wabidb-74: Local dev deployment
- **Component:** First vertical slice
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-73
- **Scope:** Shell script to start engine + wabi-server on 127.0.0.1.
- **Files:** `scripts/dev-engine.sh`, `docs/LOCAL_DEV.md`
- **Acceptance:** Script works, system accessible.
- **Verify:** Manual.

## Phase 12: Encryption (X3DH + Double Ratchet)

### wabidb-75: Identity key + signed prekey + prekey pool
- **Component:** Crypto
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** wabidb-05
- **Scope:** Device-level key material. X25519 identity, signed prekey, 100 one-time prekeys. Tables: `devices`, `device_pinned_keys`, `device_key_backup`. **Prekey pool top-up notification:** the server tracks the count of remaining prekeys. When the count drops below 20, the server emits a notification on the device's `user:{id}:device:{device_id}:prekey_pool` topic. The client receives the notification, generates new keypairs, and uploads via `upload_one_time_prekeys`. The server cannot generate new private keys — only the client can. **Device revocation cleanup:** when a device is revoked, the server MUST delete all of its unused one-time prekeys from the `devices` table. The `consume_one_time_prekey` command must check that the device is still active before returning the key.
- **Files:** `core/crates/wabidb/src/crypto/identity.rs`
- **Acceptance:** Register device, rotate prekey, upload/consume prekeys. Top-up notification fires when count < 20. Revoked device's prekeys are deleted and `consume_one_time_prekey` returns `DeviceRevoked` for them. Concurrent consumption of the same prekey by two peers: one wins, the other gets `PrekeyAlreadyConsumed`.
- **Verify:** `cargo test -p wabidb --lib crypto::identity`
- **Notes:** See `docs/architecture/wabidb-council-reviews.md` Council Review #4 §3. The atomic UPDATE pattern from `wabidb-84` (Section 9.4 of the endstate doc) is what makes concurrent prekey consumption safe. Top-up at <20 is the same threshold the endstate doc specifies; the card makes the trigger explicit (server-side topic notification, not server-side key generation).

### wabidb-76: device_pinned_keys (TOFU)
- **Component:** Crypto
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-75
- **Scope:** Trust-on-first-use key pinning.
- **Files:** `core/crates/wabidb/src/projections/device_pinned_keys.rs`
- **Acceptance:** Pin keys, read back, detect change.
- **Verify:** `cargo test -p wabidb --lib projections::device_pinned_keys`

### wabidb-77: Safety numbers
- **Component:** Crypto
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-76
- **Scope:** Compute 60-digit safety number from identity keys.
- **Files:** `core/crates/wabidb/src/crypto/safety_number.rs`
- **Acceptance:** Both sides compute same number. Test vector matches.
- **Verify:** `cargo test -p wabidb --lib crypto::safety_number`

### wabidb-78: X3DH initial handshake
- **Component:** Crypto
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** wabidb-77
- **Scope:** Implement X3DH. Both sides compute same shared secret. **Atomic consume-and-return for prekeys:** the `consume_one_time_prekey` command is a single server-side command that returns the prekey public bytes AND marks it consumed atomically. The client must not compute the X3DH handshake until the consumption succeeds; on failure (`PrekeyAlreadyConsumed`, `DeviceRevoked`), the client discards the prekey and fetches a new one. This avoids wasted CPU and lost-prekey race conditions. **Signed prekey signature verification:** the X3DH implementation MUST hard-fail if the signed prekey signature does not verify against the identity key. A test must verify that a handshake with an invalid signature is rejected before any shared secret is derived. Signature verification happens client-side but the wabidb-78 acceptance criteria enforce the test.
- **Files:** `core/crates/wabidb/src/crypto/x3dh.rs`
- **Acceptance:** Alice and Bob derive same root key. Wrong keys differ. Two peers consuming the same prekey: one succeeds, the other gets `PrekeyAlreadyConsumed` and must refetch. Handshake with invalid signed_prekey_signature is rejected with `SignatureVerificationFailed`; no shared secret is derived. Test vectors match RFC 9380.
- **Verify:** `cargo test -p wabidb --lib crypto::x3dh` (including the negative tests for `PrekeyAlreadyConsumed` and `SignatureVerificationFailed`)
- **Notes:** See `docs/architecture/wabidb-council-reviews.md` Council Review #4 §2. The `PrekeyAlreadyConsumed` race condition is closed by the atomic UPDATE pattern in `wabidb-84`; this card's responsibility is to wire the X3DH handshake so that the consumption failure path is clean. The `SignatureVerificationFailed` test is the gate against MITM via key swap.

### wabidb-79: Double Ratchet session
- **Component:** Crypto
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** wabidb-78
- **Scope:** Implement Double Ratchet. Unique message keys, DH ratchet turns. **Skipped key cache cap:** `MAX_SKIPPED_KEYS = 1000` per session (see endstate doc §6.3). When a message arrives and adding its key to the cache would exceed the cap, the message is rejected with `CommandError::Validation("skipped key cache full")` and the client must wait for the missing messages or open a fresh session. This caps the memory exposure to a malicious peer sending thousands of out-of-order messages.
- **Files:** `core/crates/wabidb/src/crypto/double_ratchet.rs`
- **Acceptance:** 10 messages decrypted. Compromise at 5 doesn't decrypt 1-4 (forward secrecy). **Skipped key cache test:** 1,001 out-of-order messages are sent; the 1,001st is rejected with the cache-full error. The 1,000 previously cached keys are still decryptable. Cache eviction policy: oldest-first when at cap.
- **Verify:** `cargo test -p wabidb --lib crypto::double_ratchet` (including the cache-cap test)
- **Notes:** See `docs/architecture/wabidb-council-reviews.md` Council Review #4 §1.1 (skipped key cap) and §1.2 (where the ratchet state lives). **§1.2 resolved (Option A):** Double Ratchet state lives in `core/crates/wabidb/src/crypto/double_ratchet.rs` as a `pub` shared module. The wabidb crate is used by both the wabi-server (for storage of wrapped keys) and the Tauri desktop client (for ratchet state). The Rust implementation can be compiled to WASM for the browser client. The skipped key cap is non-negotiable; without it, the engine has a memory-exhaustion DoS vector.

### wabidb-80: Per-device DM envelopes
- **Component:** Crypto
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-79, wabidb-26
- **Scope:** Body encrypted once with random key. Key wrapped per-recipient-device.
- **Files:** `core/crates/wabidb/src/commands/dm/send_dm_message.rs`
- **Acceptance:** 3 devices unwrap and decrypt same plaintext.
- **Verify:** `cargo test -p wabidb --lib commands::dm::send_dm_message`

### wabidb-81: send_dm_message command
- **Component:** Command
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-80
- **Scope:** Full command: auth, validation, idempotency, emit event.
- **Files:** `core/crates/wabidb/src/commands/dm/send_dm_message.rs`
- **Acceptance:** Goes through full command flow.
- **Verify:** `cargo test -p wabidb --lib commands::dm::send_dm_message`

## Phase 13: Helper Node Protocol

### wabidb-82: pair_tokens table (with token_hash)
- **Component:** Helper
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-21
- **Scope:** Projection table. token_hash (BLAKE3), node_kind, capabilities_json.
- **Files:** `core/crates/wabidb/src/projections/pair_tokens.rs`
- **Acceptance:** Insert, lookup, atomic redemption. Raw token never stored.
- **Verify:** `cargo test -p wabidb --lib projections::pair_tokens`

### wabidb-83: route_tokens table (with token_hash)
- **Component:** Helper
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-82
- **Scope:** Projection table for long-lived route tokens.
- **Files:** `core/crates/wabidb/src/projections/route_tokens.rs`
- **Acceptance:** Same as pair_tokens but long-lived.
- **Verify:** `cargo test -p wabidb --lib projections::route_tokens`

### wabidb-84: Atomic pair token redemption
- **Component:** Helper
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-82
- **Scope:** Redemption command. UPDATE must affect exactly one row.
- **Files:** `core/crates/wabidb/src/commands/helpers/redeem_pair_token.rs`
- **Acceptance:** Valid token works, expired/used fails. Concurrent: one wins.
- **Verify:** `cargo test -p wabidb --lib commands::helpers::redeem_pair_token`

### wabidb-85: Helper node heartbeat
- **Component:** Helper
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-83
- **Scope:** Heartbeat command. Update row, return revocation list.
- **Files:** `core/crates/wabidb/src/commands/helpers/heartbeat.rs`
- **Acceptance:** Row updated, list returned. 3 missed = offline.
- **Verify:** `cargo test -p wabidb --lib commands::helpers::heartbeat`

### wabidb-86: Helper token revocation
- **Component:** Helper
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-83
- **Scope:** Revoke command. Set revoked=1. Next heartbeat includes in list.
- **Files:** `core/crates/wabidb/src/commands/helpers/revoke_route_token.rs`
- **Acceptance:** Revoked token appears in list. Helper stops working.
- **Verify:** `cargo test -p wabidb --lib commands::helpers::revoke_route_token`

## Phase 14: WebSocket + Ticket Auth (operator surface)

### wabidb-87: WebSocket ticket endpoint
- **Component:** HTTP
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-56
- **Scope:** `POST /v1/ws-ticket` endpoint. Validate session, return one-time ticket.
- **Files:** `core/crates/wabidb/src/http/ws_ticket.rs`
- **Acceptance:** Login, get session, get ticket.
- **Verify:** Manual: `curl -X POST http://127.0.0.1:8080/v1/ws-ticket`

### wabidb-88: Ticket auth handler
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-87, wabidb-54
- **Scope:** On WebSocket open, validate ticket, mark used, return AuthOk.
- **Files:** `core/crates/wabidb/src/subscription/ticket_handler.rs`
- **Acceptance:** Valid -> AuthOk. Expired/used -> AuthErr, close 4401.
- **Verify:** `cargo test -p wabidb --lib subscription::ticket_handler`

### wabidb-89: WebSocket frame parser/serializer
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-52
- **Scope:** BSATN (or bincode) for binary, JSON for debug. Parse ClientMessage/ServerMessage.
- **Files:** `core/crates/wabidb/src/subscription/frame.rs`
- **Acceptance:** Round-trip all messages. Garbage bytes = clean close.
- **Verify:** `cargo test -p wabidb --lib subscription::frame`

### wabidb-90: ClientMessage / ServerMessage protocol
- **Component:** Subscription
- **Tag:** DAYTIME
- **Size:** S
- **Depends on:** wabidb-52, wabidb-89
- **Scope:** Define wire types per Section 5.8 of design doc.
- **Files:** `core/crates/wabidb/src/subscription/protocol.rs`
- **Acceptance:** Every variant defined. Round-trip serialize.
- **Verify:** `cargo test -p wabidb --lib subscription::protocol`

### wabidb-91: Backpressure protocol (control lane)
- **Component:** Subscription
- **Tag:** MIXED
- **Size:** S
- **Depends on:** wabidb-53, wabidb-54
- **Scope:** When data_tx full, send Backpressure on control_tx.
- **Files:** `core/crates/wabidb/src/subscription/control_lane.rs`
- **Acceptance:** Full data_tx -> control_tx gets Backpressure. 5s -> close.
- **Verify:** `cargo test -p wabidb --lib subscription::control_lane`

## Phase 15: Operations

### wabidb-92: Manifest backup format
- **Component:** Operations
- **Tag:** OVERNIGHT
- **Size:** M
- **Depends on:** wabidb-10
- **Scope:** The manifest is the canonical backup artifact. Must include all fields.
- **Files:** `core/crates/wabidb/docs/BACKUP_FORMAT.md`, `core/crates/wabidb/src/cli/backup.rs`
- **Acceptance:** Spec doc covers fields. Implementation produces valid manifest.
- **Verify:** Manual.

### wabidb-93: Restore from manifest
- **Component:** Operations
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-92
- **Scope:** Restore data directory from manifest. Validate hashes. Reject corrupt.
- **Files:** `core/crates/wabidb/src/cli/restore.rs`
- **Acceptance:** Valid restore: engine starts. Corrupt file: rejects.
- **Verify:** Manual.

### wabidb-94: Real-world test deployment
- **Component:** Operations
- **Tag:** MIXED
- **Size:** L
- **Depends on:** wabidb-74
- **Scope:** Deploy engine + wabi-server on real machine (Ronin). Run 1 week with friend group.
- **Files:** `docs/REAL_WORLD_TEST_REPORT.md`
- **Acceptance:** 1 week stable. Documented performance and failures.
- **Verify:** Manual.

### wabidb-95: Performance benchmark
- **Component:** Operations
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-94
- **Scope:** `cargo bench` suite for hot paths. Target: 5k-10k commits/sec, <50ms p95 commit.
- **Files:** `core/crates/wabidb/benches/`
- **Acceptance:** Benchmarks < 5 min. Stable results. Meets targets.
- **Verify:** `cargo bench -p wabidb`

### wabidb-96: Migration plan doc (separate)
- **Component:** Operations
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-93
- **Scope:** `docs/futuresight-wabidb-migration.md`. Three migration options. Row transformations. Rollback procedure.
- **Files:** `docs/futuresight-wabidb-migration.md`
- **Acceptance:** Covers all three options, transformations, validation, rollback.
- **Verify:** Manual.

## Phase 16: Operational Hardening (NEW)

### wabidb-97: Engine Configuration and Limits (NEW)
- **Component:** Operations
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** wabidb-15
- **Scope:** Implement a configuration struct (`WabiDbConfig`) loaded from a TOML/JSON file. Must include all configurable limits mentioned in the design doc: segment size (64 MiB), commit batch size (10) and age (50ms), backpressure timeout (5s), reaper interval (60s), snapshot policies, and load-shedding thresholds (50,000 backlog).
- **Files:** `core/crates/wabidb/src/engine/config.rs`
- **Acceptance:** Engine starts with custom config. Invalid values (e.g., 0 batch size) are rejected at startup.
- **Verify:** `cargo test -p wabidb --lib engine::config`

### wabidb-98: Metrics and Health Endpoint (NEW)
- **Component:** Operations
- **Tag:** MIXED
- **Size:** M
- **Depends on:** wabidb-15
- **Scope:** Expose Prometheus metrics via the admin HTTP API. Metrics must include: `wabidb_commit_seq`, `wabidb_commit_latency_seconds`, `wabidb_commit_backlog`, `wabidb_subscriber_count`, `wabidb_retention_reaped_total`, `wabidb_segment_count`. Add a `GET /v1/admin/health` endpoint returning 200 OK if the commit sequencer is making progress.
- **Files:** `core/crates/wabidb/src/engine/metrics.rs`, `core/crates/wabidb/src/http/admin.rs`
- **Acceptance:** Metrics endpoint returns Prometheus formatted text. Health endpoint returns 200. Backlog metric increases when artificial sleep is injected into sequencer.
- **Verify:** `curl http://127.0.0.1:9812/v1/admin/health` and `curl http://127.0.0.1:9812/metrics`

### wabidb-99: Power-Loss / Kernel Panic Simulation Test (COMPLETE)
- **Component:** Operations
- **Tag:** MIXED
- **Size:** L
- **Depends on:** wabidb-72
- **Scope:** 5 power-loss / kernel-panic tests in `core/crates/wabidb/src/tests/power_loss.rs`, one per boundary in the commit sequence. Test matrix designed in `docs/proposals/wabidb-power-loss-test-design.md`: (0) `crash_before_any_write`, (1) `crash_mid_stream_write`, (2) `crash_before_index_fsync`, (3) `crash_after_index_fsync`, (4) `crash_after_projection_update`. **Crash injection: a parent Rust process that forks a child via `std::process::Command`, sets the `WABIDB_CRASH_BOUNDARY` env var to the boundary name, the child calls `std::process::exit(1)` at the configured point via `crash_point()`, parent waits, parent reopens the engine and asserts recovery invariants.** Each test uses a fresh tempdir.
- **Files:** `core/crates/wabidb/src/tests/power_loss.rs` (physical tests), `core/crates/wabidb/src/sequencer/mod.rs` (crash_point wiring), `core/crates/wabidb/src/sequencer/util.rs` (crash_point definition).
- **Acceptance:** All 5 tests pass deterministically. Each test verifies the recovery invariants from `endstate` §15.4 plus the 3 Council Review #1 invariants: (1) burned `commit_seq` is never reused (test 0, 2); (2) Option B orphan records in stream segments are skipped, not truncated, on read (tests 1, 2); (3) durability-await is correct — the `Ok` was never sent, so the client's retry path is the correct one (tests 3, 4).
- **Verify:** `cargo test --features test-harness -p wabidb --lib tests::power_loss -- --ignored`
- **Notes:** Physical durability suite complementing `wabidb-72`'s logical crash tests. Child entry point is `run_crash_child` (same test binary, dispatched via `WABIDB_CRASH_BOUNDARY` + `WABIDB_DATA_DIR` env vars). Tests are `#[ignore]` due to subprocess overhead. Implemented in June 2026.

---

## Status Tracking

*Last updated: 2026-06-28 — power-loss tests (wabidb-99) complete; crash_point wired in sequencer.*

### Phase 1: Storage Foundation (12/12 complete)
- [x] wabidb-01 — Cargo project setup
- [x] wabidb-02 — Storage format spec doc
- [x] wabidb-03 — Error types
- [x] wabidb-04 — Custom byte primitives (`format/record.rs`)
- [x] wabidb-05 — Per-stream encryption primitive (`crypto/aes_gcm_record.rs`)
- [x] wabidb-06 — Stream segment writer
- [x] wabidb-07 — Stream segment reader
- [x] wabidb-08 — Segment recovery
- [x] wabidb-09 — StreamKeyRegistry
- [x] wabidb-10 — Storage manifest format
- [x] wabidb-11 — Engine init and bootstrap key loading
- [x] wabidb-12 — Directory fsync utility

### Phase 2: Commit Infrastructure (8/8 complete)
- [x] wabidb-13 — Global commit index record format
- [x] wabidb-14 — Commit index fsync batcher
- [x] wabidb-15 — Commit sequencer
- [x] wabidb-16 — DurableEvent + CommandOutcome types
- [x] wabidb-17 — run_command wrapper (`sequencer/run_command.rs`)
- [x] wabidb-18 — command_idempotency table
- [x] wabidb-19 — consumer_offsets table
- [x] wabidb-20 — Concurrency and Lock Manager

### Phase 3: WabiStore Trait (2/2 complete — relocated to `engine/wabi_store.rs`)
- [x] wabidb-21 — WabiStore trait definition (lives in `engine/wabi_store.rs`, 50+ methods)
- [x] wabidb-22 — WabiStore implementation skeleton (`LocalWabiStore` in `engine/wabi_store.rs` + `WdbAdapter` in `wabi-server/src/adapter/mod.rs`)

### Phase 4: Projection Engine (9/10 complete)
- [x] wabidb-23 — Projection handler trait
- [x] wabidb-24 — messages projection (message_created/edited/deleted)
- [x] wabidb-25 — reactions projection (reaction_added + reaction_removed noop stub)
- [x] wabidb-26 — dm_messages projection
- [x] wabidb-27 — dm_message_recipients projection
- [ ] wabidb-28 — whiteboard_patches projection (NOT STARTED)
- [x] wabidb-29 — channels + channel_members projections
- [x] wabidb-30 — Fixed skiplist/B-tree indexes (crossbeam-skiplist)
- [x] wabidb-31 — rebuild_indexes from snapshots + commit index (lives in `cli/rebuild_indexes.rs`, `cli/rebuild_indexes_cmd.rs`, `engine/replay.rs`)
- [x] wabidb-32 — Projection Write Barrier (`projections/barrier.rs` — LinearizabilityBarrier complete)

### Phase 5: Snapshot Manager (3/4 complete)
- [x] wabidb-33 — Snapshot writer (`snapshots/writer.rs` — WSNAP format, atomic writes)
- [x] wabidb-34 — Snapshot reloader (functionality in `engine/locks.rs` `ProjectionState::load_snapshot`; no dedicated `loader.rs`)
- [x] wabidb-35 — Per-stream snapshot policy (checkpoint interval in dispatcher; no dedicated `policy.rs`)
- [ ] wabidb-36 — whiteboard_snapshots + whiteboard_history tables (NOT STARTED)

### Phase 6: Retention Engine (7/9 — 3 core + 4 extra files)
- [ ] wabidb-37 — expires_at indexes (NOT STARTED)
- [x] wabidb-38 — Per-stream TTL reaper (`retention/reaper.rs` — `RetentionReaper` with run_once/run_forever)
- [x] wabidb-39 — Cryptographic deletion (`retention/key_destruction.rs` — `destroy_stream_keys` with tombstone creation)
- [ ] wabidb-40 — retention_policies table (NOT STARTED)
- [ ] wabidb-41 — Per-scope policy evaluation (NOT STARTED)
- [x] wabidb-42 — Segment Compaction and GC (`retention/compaction.rs` — single-segment compaction, zero-and-remove, dir fsync)
- *(Extra)* `retention/tombstone.rs` — Tombstone and TombstoneTable (HashMap-based, 7 tests)
- *(Extra)* `retention/data_backup.rs` — Full data directory backup with manifest
- *(Extra)* `retention/manifest_backup.rs` — storage-manifest.json backup
- *(Extra)* `retention/verify_backup.rs` — BLAKE3 hash verification against manifest

### Phase 7: Ephemeral Bus (4/6 — 1 core + 5 extra files)
- [ ] wabidb-43 — EmissionDurability enum (NOT STARTED)
- [x] wabidb-44 — EphemeralBus (`ephemeral/bus.rs` — tokio::sync::broadcast, 3 tests)
- [ ] wabidb-45 — Ephemeral event dispatch (NOT STARTED — routing logic is ad-hoc)
- *(Extra)* `ephemeral/auth.rs` — EphemeralAction auth (typing, join_call, move_cursor)
- *(Extra)* `ephemeral/ticket.rs` — One-time ticket create/validate/revoke
- *(Extra)* `ephemeral/rate_limit.rs` — Per-user sliding window rate limiter
- *(Extra)* `ephemeral/subscription.rs` — Topic subscription registry
- *(Extra)* `ephemeral/persistence.rs` — JSON save/load (save is a stub)

### Phase 8: Subscription Engine (9/12 — core engine + 8 supporting files)
- [ ] wabidb-46 — Topic enum + grammar (topic concept is embedded inline)
- [ ] wabidb-47 — TopicAcl trait (NOT STARTED)
- [ ] wabidb-48 — Live fanout (equivalent in `engine.rs` `deliver` method)
- [ ] wabidb-49 — Topic indexes (NOT STARTED — uses simple matching)
- [ ] wabidb-50 — Snapshot barrier (subscription-barrier, not projection-barrier)
- [x] wabidb-51 — Resume cursor (`ws_resume.rs` — `ws_resume` function, 4 tests)
- [x] wabidb-52 — EventEnvelope with versioning (lives in `sequencer/event_envelope.rs`, 6 tests)
- [ ] wabidb-53 — Backpressure with priority lanes (backpressure in `ws_send.rs` MessageQueue)
- [ ] wabidb-54 — WebSocket adapter (WebSocket split across 4 files: `ws_subscribe.rs`, `ws_send.rs`, `ws_unsubscribe.rs`, `ws_resume.rs`)
- [x] wabidb-55 — WebSocket ticket auth (`ticket_auth.rs` — TicketStore + handshake, 5 tests)
- [x] wabidb-56 — ws_tickets table + atomic redemption (`ws_tickets.rs` — WsTicketsTable, 8 tests)
- [x] wabidb-57 — Membership Change Revalidation (`membership_revalidation.rs` — MembershipStore, 4 tests)
- *(Extra)* `subscription/engine.rs` — SubscriptionEngine core (subscribe/deliver/ack, 6 tests)
- *(Extra)* `subscription/consumer_offsets.rs` — ConsumerOffsetsTable (upsert/lookup/checkpoint, 5 tests)
- *(Extra)* `subscription/presence.rs` — PresenceTracker (RwLock-backed, 5 tests)
- *(Extra)* `subscription/ws_ticket_endpoint.rs` — Issue WS auth tickets (4 tests)

### Phase 9: Blob Store (2/5 complete)
- [ ] wabidb-58 — BLAKE3 content addressing (addressing inline in write/read; no dedicated `addressing.rs`)
- [x] wabidb-59 — Blob write ordering (`blobs/write.rs` — atomic write, temp+fsync+rename)
- [x] wabidb-60 — Range read protocol (`blobs/range_read.rs` — streaming range read)
- [ ] wabidb-61 — Blob metadata table (`projections/blob_metadata.rs` — NOT STARTED)
- [ ] wabidb-62 — Blob GC (`blobs/gc.rs` — NOT STARTED)

### Phase 10: Storage CLI (10/12 commands exist)
- [x] wabidb-63 — `wabidb check` (`cli/check.rs` + `cli/verify.rs`)
- [x] wabidb-64 — `wabidb dump-stream` (`cli/dump_stream.rs`)
- [ ] wabidb-65 — `wabidb inspect-commit` (NOT STARTED)
- [x] wabidb-66 — `wabidb rebuild-indexes` (`cli/rebuild_indexes.rs` + `cli/rebuild_indexes_cmd.rs`)
- [x] wabidb-67 — `wabidb list-streams` (`cli/list_streams.rs`)
- [x] wabidb-68 — Manifest-based backup (`cli/backup.rs`)
- [x] wabidb-69 — `wabidb verify-backup` (`cli/verify.rs`)
- *(Extra)* `cli/decrypt.rs` — Offline record decryption with key derivation
- *(Extra)* `cli/restore.rs` — Restore from backup directory
- *(Extra)* `cli/status.rs` — Data dir health summary
- *(Extra)* `cli/tail.rs` — Last N events from a stream
- *(Omitted)* `src/bin/wabidb.rs` — CLI binary entry point is elsewhere (Cargo.toml [[bin]])

### Phase 11: First Vertical Slice (2/5 checkable source files exist)
- [ ] wabidb-70 — send_message command (NOT STARTED — no `commands/messages/send_message.rs`)
- [x] wabidb-71 — Channel messages subscription (`tests/send_message_flow.rs` — integration flow test)
- [x] wabidb-72 — 10 crash/resume tests (`tests/crash_tests.rs` — logical crash tests)
- [ ] wabidb-73 — First-vertical-slice integration test (wabi-server level)
- [ ] wabidb-74 — Local dev deployment (`scripts/dev-engine.sh` missing; `docs/local-dev.md` exists lowercase)

### Phase 12: Encryption (6/7 source files exist)
- [x] wabidb-75 — Identity key + signed prekey + prekey pool (`crypto/identity.rs` + `crypto/x3dh_identity.rs`)
- [x] wabidb-76 — device_pinned_keys TOFU (`crypto/device_pinning.rs` — projection `device_pinned_keys.rs` missing)
- [x] wabidb-77 — Safety numbers (`crypto/safety_number.rs`)
- [x] wabidb-78 — X3DH initial handshake (`crypto/x3dh_handshake.rs`)
- [x] wabidb-79 — Double Ratchet session (`crypto/double_ratchet.rs`)
- [x] wabidb-80 — Per-device DM envelopes (`crypto/dm_envelope.rs`)
- [x] wabidb-81 — send_dm_message command (`commands/send_dm_message.rs`)
- *(17 total files in `crypto/` — fully stocked module including rekey, re-encrypt, version_skew, helper_revocation, etc.)*

### Phase 13: Helper Node Protocol (2/5 source files exist)
- [x] wabidb-82 — pair_tokens table (`auth/pair_tokens.rs`)
- [x] wabidb-83 — route_tokens table (`auth/route_tokens.rs`)
- [ ] wabidb-84 — Atomic pair token redemption (NOT STARTED — `commands/helpers/` dir absent)
- [ ] wabidb-85 — Helper node heartbeat (NOT STARTED)
- [ ] wabidb-86 — Helper token revocation (NOT STARTED)

### Phase 14: WebSocket + Ticket Auth (3/5 core files exist under different names)
- [x] wabidb-87 — WebSocket ticket endpoint (`subscription/ws_ticket_endpoint.rs` — request handler, 4 tests)
- [x] wabidb-88 — Ticket auth handler (`subscription/ticket_auth.rs` — TicketStore + handshake, 5 tests)
- [ ] wabidb-89 — WebSocket frame parser/serializer (NOT STARTED — no `subscription/frame.rs`)
- [x] wabidb-90 — ClientMessage / ServerMessage protocol (`protocol/mod.rs` — top-level protocol module, 14 tests)
- [ ] wabidb-91 — Backpressure protocol control lane (NOT STARTED)

### Phase 15: Operations (2/5 checkable items exist)
- [x] wabidb-92 — Manifest backup format (`cli/backup.rs` — backup produces manifest; `docs/BACKUP_FORMAT.md` missing)
- [x] wabidb-93 — Restore from manifest (`cli/restore.rs` — restore from backup)
- [ ] wabidb-94 — Real-world test deployment (`docs/REAL_WORLD_TEST_REPORT.md` missing)
- [x] wabidb-95 — Performance benchmark (`benches/commit_throughput.rs` — criterion bench)
- [ ] wabidb-96 — Migration plan doc (`docs/futuresight-wabidb-migration.md` missing; `futuresight-wabidb-proposal.md` exists)

### Phase 16: Operational Hardening (1/3 source files exist)
- [ ] wabidb-97 — Engine Configuration and Limits (`engine/config.rs` — NOT STARTED)
- [ ] wabidb-98 — Metrics and Health Endpoint (`engine/metrics.rs` + `http/admin.rs` — NOT STARTED)
- [x] wabidb-99 — Power-Loss / Kernel Panic Simulation Test (`src/tests/power_loss.rs` — 3 logical + 5 physical subprocess isolation tests, COMPLETE)

---

## Total: 61/99 cards complete (61.6%)

**Completed by phase:**
- Phase 1: 12/12 ✅
- Phase 2: 8/8 ✅
- Phase 3: 2/2 ✅
- Phase 4: 9/10
- Phase 5: 3/4
- Phase 6: 3/6 (plus 4 extra retention files)
- Phase 7: 1/3 (plus 5 extra ephemeral files)
- Phase 8: 5/12 (plus 4 extra subscription files)
- Phase 9: 2/5
- Phase 10: 6/7 (plus 5 extra CLI files)
- Phase 11: 2/5
- Phase 12: 6/7 (plus 10 extra crypto files)
- Phase 13: 2/5
- Phase 14: 3/5
- Phase 15: 2/5
- Phase 16: 1/3

**Latest session (2026-06-28):** Wired `crash_point()` into sequencer (5 boundaries). 5 physical power-loss tests implemented. Fuzz module expanded to 4 targets. Wired replication config into engine (config, transport trait, background worker). Added `/api/sync/pull`, `/api/sync/push`, `/api/sync/status` HTTP endpoints in wabi-server (POST/GET handlers). Dead code cleanup: removed 8 dead fields from `LocalWabiStore`, removed dead `make_cmd` from integration tests, removed unused `DoubleRatchetSession.role` field, removed dead `signed_prekey_signature` from X3DHResponder, removed secret fields from InternalPreKey/InternalSignedPreKey (secrets were stored but never consumed). Fixed `new_for_tests()` to use `env::temp_dir()` instead of hardcoded `/tmp`. Replaced hardcoded `"01H"` key_id with `generate_key_id()`. Reduced `#[allow(dead_code)]` from 35→17 (remaining stubs are intentional: `_category()` patterns, test-only fields, ProjectionDispatcher placeholder struct).

**Plan for remaining work (next sessions):**
1. ~~Wire `crash_point()` into sequencer commit path (for wabidb-99)~~ DONE
2. ~~Implement physical subprocess-isolation power-loss tests (wabidb-99)~~ DONE
3. ~~Expand fuzz testing~~ DONE
4. ~~Replication: wire into engine, add HTTP sync endpoints~~ DONE
5. ~~Clean up `#[allow(dead_code)]` annotations~~ DONE (35→17, all 18 removed were genuine dead code)
6. ~~Fix `new_for_tests()` hardcoded path~~ DONE (now uses `env::temp_dir()`)
7. ~~Replace hardcoded key_id `"01H"` with real ULIDs~~ DONE (uses `generate_key_id()` with `rand::Rng` + `hex::encode`)

✅ **All 7 items complete.** Wabidb 666 lib tests + 1 doc-test passing. Fuzz targets: 4. Power-loss tests: 5 physical + 3 logical.

**Summary of Additions:**
- **wabidb-11**: Engine initialization and bootstrap key loading. Critical for starting the engine.
- **wabidb-12**: Directory fsync utility. Prevents silent data corruption on power loss.
- **wabidb-20**: Concurrency and Lock Manager. Required to prevent write starvation.
- **wabidb-32**: Projection Write Barrier. Ensures linearizability (reads see writes).
- **wabidb-42**: Segment Compaction and GC. Prevents unbounded disk growth.
- **wabidb-57**: Membership Change Revalidation. Prevents security leaks when users are banned/removed.
- **wabidb-97**: Engine Configuration and Limits. Required for tuning.
- **wabidb-98**: Metrics and Health Endpoint. Required for production observability.
- **wabidb-99**: Power-Loss Simulation Test. Validates the custom storage engine's crash safety.
- **Replication wiring**: Engine config + `SyncTransport` trait + background sync worker + HTTP sync endpoints (`POST /api/sync/pull`, `POST /api/sync/push`, `GET /api/sync/status`). Worker uses `NoopTransport` by default; prod deployments provide a `reqwest`-based transport via `WabiDbConfig::sync_transport`.