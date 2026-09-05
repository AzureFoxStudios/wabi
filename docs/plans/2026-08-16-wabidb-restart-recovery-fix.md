# WabiDB restart-recovery fix (audit remediation)

**Date:** 2026-08-16
**Status:** Implemented and verified
**Scope:** `core/crates/wabidb` — sequencer, replay, barrier, engine open, power-loss tests, bench, CLI bin

## Background: the audit findings

A full engine audit (2026-08-16) found that WabiDB's *recovery* path was
never finished, while the design docs (council reviews, STORAGE_FORMAT.md)
correctly specified the invariants. Three findings were production-critical:

1. **`commit_seq` reset to 1 on every restart.** `sequencer::run`
   initialized `next_commit_seq = 1` and nothing seeded it from disk.
   Because stream keys are deterministically re-derived from the bootstrap
   key and the AES-GCM nonce IS the `commit_seq`, any stream written across
   a restart at overlapping seqs got the same (key, nonce) pair — a
   two-time-pad break of at-rest encryption (the exact invariant Council
   Review #1 §1.1 warned about: "safe as long as the global sequencer never
   resets"). Duplicate seqs also replayed two generations of events into
   projections (duplicate messages) and made the commit index non-monotonic
   across files. The old `power_loss.rs` test suite knew: its
   `verify_recovery` deleted the commit-index directory before reopening
   and refused to assert seqs ("The sequencer always starts at seq 1 after
   restart").
2. **Durability ordering violation.** The sequencer appended `.wseg`
   records without fsync, then fsynced the commit index and returned `Ok`.
   The index is the durability point but references page-cache-only
   segment bytes — a power loss after ack could lose acknowledged data.
   The crash tests couldn't catch this (`process::exit` preserves the page
   cache; the "after_commit_index_fsync" test manually fsynced the segment
   first, simulating rather than testing the correct order).
3. **Replay ignored the commit index.** `replay_projections` called
   `read_records()` unfiltered, so orphans of partially-committed commands
   were applied to projections on recovery — violating the Option B
   decision (Council Review #1 §2.2: "Recovery MUST skip them") that the
   commit index exists to enforce.

Additional (non-critical) findings fixed in the same pass: watermark could
regress (`set_applied_commit_seq` was a plain store); the throughput bench
measured commands that failed with `UnknownStreamKey` before any durable
work; the operator CLI had no binary; lock acquisition wasn't atomic (race
between exists-check and write) and stale locks from dead processes blocked
boot (manual `rm` deploy step); the manifest's `highest_commit_seq` was
written once as 0 and never updated; `SequencerPermit::into_static` was a
documented no-op that dropped the permit it claimed to leak.

## Changes

### `src/sequencer/mod.rs`
- `run()` takes `initial_commit_seq: u64` (the recovered high-water mark);
  the first commit gets `initial + 1`.
- `process_command` step 1.5: every `SegmentWriter` touched by the command
  is flushed (fsync) BEFORE the commit-index entry is submitted — WAL
  ordering: the bytes the index references are durable before the index
  fsync that acknowledges them.
- New test `initial_commit_seq_seeds_counter` (restart at 100 → first
  write gets 101).

### `src/engine/mod.rs` (open)
- Step 8.1: recovers `recovered_high_seq = max(replay scan, commit index
  max, snapshot watermark)` and passes it to the sequencer. The replay scan
  max INCLUDES orphaned records — an orphan consumed its nonce, so its seq
  must never be reused either.
- Lock acquisition is now atomic (`create_new` / O_EXCL) with stale-lock
  stealing: if the holder PID is dead (probed via `/proc`), the lock is
  removed and re-acquired; a live holder still refuses with
  `AlreadyRunning`. Unparseable lock files are treated as stale.
- `update_manifest_high_seq`: keeps the manifest's `highest_commit_seq`
  current at open (best-effort).

### `src/engine/replay.rs`
- `replay_projections` now returns `u64` (highest seq observed on disk,
  tracked BEFORE any filtering so orphans count) and honors the commit
  index: records whose seq has no index entry are skipped as orphans
  (counted + logged). Decrypt failures are counted and summarized in a
  warn line instead of being purely silent. If the index is missing/empty
  while segments exist, replay falls back to applying everything (least
  data loss) and warns.

### `src/engine/locks.rs`
- `advance_watermark` / `set_applied_commit_seq` are monotonic
  (`fetch_max`) — the linearizability barrier can no longer regress.
- `SequencerPermit::into_static` actually leaks the permit
  (`std::mem::forget`).

### `src/tests/power_loss.rs`
- `verify_recovery` no longer deletes the commit index. It now asserts:
  watermark >= prior commits, commit index strictly increasing with no
  duplicate seqs, and a post-restart write lands ABOVE the prior
  high-water mark.
- `populate_engine` / crash child use `get_or_create_stream_key`
  (deterministic bootstrap-derived key) instead of registering a fixed
  `[0xAB;32]` key — prior records now stay decryptable across
  generations (the old setup made cross-generation replay silently
  undecryptable).
- New always-on regression test `restart_never_reuses_commit_seq`:
  three generations of writes → one strictly-increasing commit history,
  no duplicate seqs in the index, watermark covers all commits.

### `benches/commit_throughput.rs`
- Registers the stream key and reuses one engine across iterations, so
  the bench measures the full durable path (encrypt → segment fsync →
  index fsync). Panics if a bench command fails, so the bench can never
  silently go back to measuring failures.

### `src/bin/wabidb-cli.rs` (new)
- Operator binary: `wabidb-cli <check|verify|status> <DATA_DIR>`.
  Auto-discovered by cargo (no Cargo.toml change).

## Verification

- `cargo test -p wabidb` — 849 passed; 2 failures are pre-existing on
  pristine HEAD (`projections::messages::tests::insert_and_lookup`,
  `engine::locks::tests::projection_messages_routes_to_handler` — in-flight
  MessageRecord WIP, verified identical on a clean HEAD worktree).
- `cargo test --workspace --no-fail-fast` — all 20 suites; same 2
  pre-existing failures only. (Required a placeholder
  `frontend/build/index.html` for the rust_embed compile; real builds
  overwrite it.)
- `cargo test --features test-harness -p wabidb --lib -- tests::power_loss -- --ignored`
  — all 5 physical crash boundaries pass with the strict recovery
  assertions.
- New tests: `restart_never_reuses_commit_seq` (fails on the pre-fix
  engine by construction), `initial_commit_seq_seeds_counter`.

## Known follow-ups (not in this pass)

**2026-09-05 follow-up:** [write completion and projection integrity](2026-09-05-wabidb-write-completion.md)
resolves barrier-ahead-of-apply with whole-command acknowledgments and shares one
watch-backed applied watermark. It also makes checkpoints whole-commit/atomic,
rejects partial indexed replay, and fixes empty-index orphan resurrection.
Checkpoints remain synchronous JSON; the binary-format/off-thread work below
is still open. Group-window fsync has already landed in the sequencer; the
per-command batching note below records the state at this August audit.

- **Compaction scheduling**: `compact_segment` still has no production
  caller; server retention is logical deletes only, so `.wseg` bytes grow
  monotonically. Needs a scheduler in the engine (avoided touching
  `wabi-server/main.rs`, which carries unrelated uncommitted WIP).
- **Group commit**: the sequencer still fsyncs once per command (batch
  size/age knobs never engage on the write path). Pipelining commits
  through the sequencer would restore batching.
- **Snapshot format**: engine checkpoints remain full JSON+hex dumps of
  all projections every 1000 dispatches (blocking, in the dispatcher
  loop). The spec'd binary `.wsnap` format exists unused
  (`snapshots/writer.rs`). Replace JSON checkpoint with `.wsnap`, and
  move the write off the dispatcher's hot path.
- **Barrier-ahead-of-apply**: the sequencer advances the barrier BEFORE
  the dispatcher applies (read-after-write can race a slow dispatcher).
  Fixing needs dispatcher acknowledgments; noted, not changed.
- **Idempotency table** is in-memory only (replay detection resets on
  restart).
- **Replay envelope is JSON** — postcard would shrink records and speed
  replay (must dual-decode, per golden rule 5).
- Orphan recovery semantics: an orphan's seq is now correctly never
  reused; physical orphan bytes remain until compaction exists.
