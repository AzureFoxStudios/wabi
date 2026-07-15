# WabiDB DeepSeek Audit

**Auditor:** DeepSeek-V4-Flash (assisting Hermes)
**Date:** 2026-06-20
**Status:** PRE-FIRE AUDIT COMPLETE

## Methodology

1. Read the existing audit doc (`wabidb-prefire-audit.md`), all design docs, kanban, and council reviews
2. Read every source file in `core/crates/wabidb/src/` (all 90+ `.rs` files, ~20,652 lines)
3. Ran `cargo build` (compiles, 554 warnings) and `cargo test --lib` (517/517 pass, 0 fail)
4. Cross-referenced each kanban card claim against actual source implementation
5. Analyzed for correctness, completeness, and crash safety

## Overall Verdict

**The engine is substantially built but ~5-7 cards remain incompletely implemented.** The 99/99 kanban completion claim and "pre-fire COMPLETE" status in the audit doc overstate readiness. Several cards have TODO comments, stubs, or unimplemented features that an external reviewer would flag. Fixing these before external review would avoid credibility loss.

## Critical Issues (Must Fix Before External Review)

### C1. `StreamKeyRegistry::rotate_key` produces unusable keys (HIGH)

**File:** `src/crypto/stream_key_registry.rs:111-125`
**Kanban card:** wabidb-22

When `create_stream` creates a key, `max_commit_seq = u64::MAX`. When `rotate_key` is called:

```rust
let current_max = stream_keys.iter().map(|k| k.max_commit_seq).max().unwrap_or(0);
// current_max = u64::MAX for any active stream
let new_min = current_max.saturating_add(1);  // = u64::MAX
```

The new key gets `min_commit_seq = u64::MAX, max_commit_seq = u64::MAX`. Since `get_active_key` checks `commit_seq >= key.min_commit_seq`, and real commit_seqs are never `u64::MAX`, **the rotated key can never match**. The old key continues to be returned. Key rotation is a no-op.

**Impact:** Any rotation attempt silently creates a useless key. The stream continues writing under the old key. If key destruction (wabidb-39) later destroys the old key range, the data is lost even though a "new" key exists. The test `rotate_spans_both_ranges` only checks that both keys are *present*, not that the second key is ever returned.

**Suggested fix:** Pass the rotation `commit_seq` as a parameter, or track the actual highest used commit_seq separately from the sentinel `u64::MAX`.

### C2. `WabiDbEngine` is explicitly a stub (HIGH)

**File:** `src/engine/mod.rs:3-22` (module doc), `:96-139` (open impl)
**Kanban card:** wabidb-11

The module itself says:

> *"This card (wabidb-11) implements the bootstrap key loading portion. The `WabiDbEngine` struct is a stub; full engine initialization is implemented in later cards."*

TODOs in the `open()` method:
- Lock file check: `// TODO(wabidb-engine-init): add lock file check` (line 117)
- Storage manifest: `// TODO(wabidb-engine-init): read existing manifest or write new one` (line 125)
- Sequencer/projections/dispatcher wiring: `// (deferred to wabidb-15, wabidb-20, wabidb-32)` (line 128)

Additionally, `new_for_tests()` uses a hardcoded path `/tmp/wabidb-test` with a zeroed bootstrap key — the kanban card body specifies `uuid::Uuid::new_v4()`.

**Impact:** The engine cannot actually start and serve reads/writes. The sequencer, dispatcher, and projections exist independently but are never wired together. An external reviewer will notice this immediately.

### C3. No lock file / storage manifest (MEDIUM)

**File:** `src/engine/mod.rs:115-117` (TODO)
**Kanban card:** wabidb-11

No lock file check means multiple engine instances on the same data directory would silently corrupt data. No manifest means the engine cannot determine its own state at startup.

### C4. Projection dispatcher doesn't route to real handlers (HIGH)

**File:** `src/engine/locks.rs:250-264` (`run_dispatcher`)
**Kanban cards:** wabidb-23 (dispatcher), wabidb-24 through wabidb-29 (handlers)

The `run_dispatcher` function just inserts into a generic `"events"` index:

```rust
// Real projection handlers come in wabidb-23+.
state.insert("events", key, value, item.commit_seq);
```

The concrete projection handlers exist (`projections/messages.rs`, `reactions.rs`, `dm_messages.rs`, etc.) and implement the `Projection` trait correctly. But the dispatcher never creates a `DispatchTable`, never registers them, and never routes to them.

**Impact:** Projections (messages, reactions, channel members, etc.) are never computed. A fresh engine would lose all projection state. The handler infrastructure is complete but dead.

## Medium Issues

### M1. `recovery.rs` doesn't truncate corrupt records (MEDIUM)

**File:** `src/stream_log/recovery.rs:18-33` (`scan_segment_file`)
**Kanban card:** wabidb-08

The kanban card body explicitly says:

> *"Truncate at first invalid record. Update file size on disk."*

The implementation just calls `SegmentReader::read_records()` and returns whatever it finds. There is no truncation logic. If a segment has a corrupt record at offset 500, the file is not truncated to exclude it. On recovery, the corrupt record is silently dropped but the file retains the trailing data.

### M2. Missing directory fsync after tombstone-only deletion (MEDIUM)

**File:** `src/retention/compaction.rs:100-113`
**Kanban card:** wabidb-42, wabidb-12 (directory fsync warning)

When all records in a segment are tombstoned, the code calls `tokio::fs::remove_file(original_path)` but never calls `fsync_dir` on the parent directory. The `fsync.rs` module (whose docstring says *"Missing directory fsyncs is the #1 cause of custom database corruption on power loss"*) exists precisely for this purpose.

A crash after file deletion but before directory metadata sync could cause the deleted file to be referenced on recovery.

### M3. `make_burned_seq_tombstone` defined but never called (MEDIUM)

**File:** `src/retention/key_destruction.rs:153-174`
**Kanban card:** wabidb-39, wabidb-40

The function creates a tombstone entry recording the destroyed seq range. It has full test coverage (5 tests). But it is never called from production code — only from tests. The `destroy_stream_keys` function destroys the keys but does not record a tombstone in the commit index. The burned-seq invariant (Council Review #1 §1.1) requires that the commit index record the destroyed range.

### M4. `highest_commit_seq_for_stream` always returns `u64::MAX` (MEDIUM)

**File:** `src/retention/key_destruction.rs:130-142`

The function has a comment: *"We return u64::MAX as the worst-case upper bound."* This means `KeyDestructionResult.highest_commit_seq_destroyed` is always `u64::MAX`, which is not useful for audit trails. The function body is:

```rust
let _ = registry;
let _ = stream_id;
u64::MAX
```

### M5. No `test-harness` feature or crash injection (MEDIUM)

**File:** `Cargo.toml`, all of `src/`
**Kanban card:** wabidb-72

The kanban card body specifies:
- A `#[cfg(feature = "test-harness")]` conditional compilation hook
- The hook calls `std::process::exit(1)` at specific points

Neither the feature nor any `process::exit` calls exist. The crash tests in `src/tests/crash_tests.rs` simulate crashes by dropping writers without proper fsync, but they don't test the actual crash-injection path. The crash tests pass but don't exercise the mechanism the card was supposed to build.

### M6. Audit doc module map inaccuracies (LOW)

**File:** `docs/wabidb-prefire-audit.md` §2 (`Module Map`)

| Claimed path | Actual path | Status |
|---|---|---|
| `commands/runner.rs` | `sequencer/run_command.rs` | Wrong path |
| `storage/wal.rs` | (does not exist) | Doesn't exist |
| `key_destruction.rs` | `retention/key_destruction.rs` | Different path |
| `18,000+ lines` | ~20,652 lines | Under-count |

The `storage/wal.rs` non-existence suggests kanban card wabidb-18 ("WAL storage / segment writer proxy") was never implemented. The WAL functionality appears to be integrated directly into the segment writer.

## Minor Issues

### m1. X3DH: no identity-key-to-verifying-key binding check (LOW)

**File:** `src/crypto/x3dh_handshake.rs`

The initiator's `verify_handshake` checks `self.recipient_verifying_key.verify(spk_bytes, &sig)` but does not verify that the identity key `IK_B` corresponds to the same entity as the verifying key. The test `wrong_identity_rejected` explicitly acknowledges: *"The initiator can't detect this at the crypto layer."*

This is a protocol-level concern, not a code bug, but should be documented for external review.

### m2. Duplicate `HandshakeResult` structs (LOW)

**Files:** `src/crypto/x3dh_handshake.rs`, `src/crypto/double_ratchet.rs`

Both modules define their own `HandshakeResult` struct with different fields. The X3DH version has `shared_secret`, `initiator_identity_key`, `initiator_ephemeral_key`, `recipient_identity_key`, `recipient_prekey`. The Double Ratchet version has `shared_secret`, `our_dh_private`, `their_dh_public`. The conversion between them is done externally (the kanban says the cards are separate), but a shared type would be cleaner.

### m3. `#[allow(unused_variables)]` on `decrypt_record` (LOW)

**File:** `src/crypto/aes_gcm_record.rs:133`

The attribute `#[allow(unused_variables)]` is present on `decrypt_record`. All parameters appear used. Likely leftover from development cleanup.

### m4. `new_for_tests()` hardcoded path (LOW)

**File:** `src/engine/mod.rs:156-161

`WabiDbEngine::new_for_tests()` creates an engine at `/tmp/wabidb-test` with `[0u8; 32]` bootstrap key. This is a shared path; parallel test runs would conflict. Should use `tempfile::tempdir()` or `uuid::Uuid::new_v4()` per the original card spec.

### m5. No Mutex poisoning handling in X3DH identity (LOW)

**File:** `src/crypto/x3dh_identity.rs`

Uses `std::sync::Mutex` with `.lock().unwrap()` throughout. A thread panic while holding the lock would poison the mutex and crash the next acquisition.

## Verified Correct

### Build & Tests
- `cargo build`: Compiles successfully (554 warnings, mostly missing docs)
- `cargo test --lib`: **517/517 pass, 0 fail** (includes 10 crash tests, 3 power-loss tests, property tests)

### Strong Points
- **Commit index batcher** (`src/commit_index/batcher.rs`): Well-designed with `flush_now()` for durability-await, extensive tests
- **Segment writer/reader** (`src/stream_log/`): Correct CRC handling, proper rotation logic
- **Crash tests** (`src/tests/crash_tests.rs`, `power_loss.rs`): 13 tests covering crash-after-fsync, crash-before-fsync, partial compaction, idempotency, etc.
- **Projection handlers** (`messages.rs`, `reactions.rs`, etc.): Individual handlers are fully implemented with encode/decode and tests
- **Stream key registry** (non-rotation parts): Correct key lookup, destruction semantics
- **Directory fsync utility** (`storage/fsync.rs`): Cross-platform, proper documentation
- **Bootstrap key loading** (`crypto/bootstrap.rs`): Argon2id parameterization (64 MiB, 3 iterations)
- **Double Ratchet** (`crypto/double_ratchet.rs`): Forward secrecy, skipped-key cache cap at 1000

## Summary

| Category | Count |
|---|---|
| **Critical issues** (must fix) | 4 (C1-C4) |
| **Medium issues** (should fix) | 6 (M1-M6) |
| **Minor issues** (note) | 5 (m1-m5) |
| **Total findings** | 15 |

The 99/99 kanban claim is technically correct in card count but misleading in readiness. The core infrastructure (commit index, segments, crypto, crash tests) is strong. The missing pieces are the glue that wires the components together, and one algorithmic bug in key rotation. External review should be deferred until:
1. The key rotation bug is fixed
2. The engine's `open()` is completed with lock file, manifest, and component wiring
3. The projection dispatcher is wired to real handlers
4. Directory fsync is added to compaction deletion path
5. `make_burned_seq_tombstone` is called from `destroy_stream_keys`
