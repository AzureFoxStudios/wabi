# WabiDB Power-Loss / Kernel Panic Simulation Test — Design

> **Card:** wabidb-99 (Phase 16, Operational Hardening)
> **Status:** Design proposal, prerequisite for "firing the gun" on the WabiDB build
> **Author:** Hermes, derived from `docs/proposals/wabidb-endstate.md` §15.4 and Council Review #1
> **Date:** 2026-06-20

## 1. Purpose

`wabidb-72` (10 crash/resume tests) simulates crashes at logical boundaries. This card (`wabidb-99`) simulates **physical** failures: the process is killed via `SIGKILL` (no destructors, no graceful shutdown) at specific points in the commit sequence, and the engine is reopened to verify recovery invariants hold.

These two test suites are complementary:
- `wabidb-72` validates the **logical** correctness of the commit path
- `wabidb-99` validates the **physical** durability of the on-disk format

If `wabidb-99` passes, the engine is safe against real power loss and kernel panics, not just well-behaved test failures.

## 2. The crash-point matrix

The commit sequence has 5 boundary points where the process can be killed. Each boundary gets one test. The test forges a real subprocess, runs the commit, kills the child at the configured boundary, then the parent reopens the engine.

| # | Boundary | What has happened at this point | What has NOT happened |
|---|---|---|---|
| 0 | Before any write | Sequencer assigned `commit_seq`; nothing on disk | No stream segment write; no commit-index append; no projection update |
| 1 | Mid-stream-segment write (between two stream segments) | Stream A segment fsync'd with the new event | Stream B segment write; commit-index append; projection update |
| 2 | After all stream segments fsync, before commit-index fsync | All stream segments fsync'd for the commit | Commit-index entry; projection update; `run_command` return |
| 3 | After commit-index fsync, before projection update | All stream segments + commit-index fsync'd | Projection handler ran; `run_command` returned |
| 4 | After projection update, before `run_command` return | Everything done, command not yet acknowledged to caller | Caller has not received the `Ok` response |

These are the 5 load-bearing boundaries. The card's body lists 3 of them (1, 2, 3); the test matrix expands to 5 for completeness. Adding tests 0 and 4 is cheap (same harness, different boundary).

## 3. Test harness

Required harness: a parent Rust process that:

1. Forks a child via `std::process::Command` (or uses the engine as a library with a debug hook).
2. Configures the child to crash at a specific boundary via an env var (e.g., `WABIDB_CRASH_AT=2`).
3. The child runs the engine, attempts a commit, hits the boundary, calls `std::process::exit(1)`.
4. The parent waits for the child to die (no SIGKILL needed; the child exits).
5. The parent reopens the engine from the same data directory.
6. The parent asserts the recovery invariants.

The debug hook in the engine is `#[cfg(feature = "test-harness")]`, so it's compiled out of release builds.

### Why `std::process::exit(1)`, not SIGKILL

- `SIGKILL` requires IPC (parent must know child's PID and signal it at the right moment). More moving parts.
- `std::process::exit(1)` is a clean "process gone" with no destructors, which is what we want — destructors can mask bugs (e.g., a `Drop` that accidentally fsyncs).
- The parent's `wait()` call will see the child exit and proceed.

This matches what a kernel panic looks like to user-space: the process is gone, no cleanup ran, the disk has whatever bytes made it to the page cache + the filesystem's last fsync.

## 4. The 5 tests

### Test 0: `crash_before_any_write`

**Setup:** fresh data dir. Engine has committed 100 prior commands.

**Action:** child runs command 101. Crash boundary 0 = before the sequencer writes to the segment file.

**Assertions (after parent reopens):**
- Engine starts cleanly.
- `commit_seq` for command 101 is NOT in the commit index.
- The 100 prior commits are intact (count, ordering, content).
- The engine assigns a new `commit_seq` to the next command (proves the burned-seq invariant: 101 was burned, 102 is fresh).

**Invariants verified:** 1, 5, Council Review #1 §2.2 (burned-seq).

### Test 1: `crash_mid_stream_write`

**Setup:** fresh data dir. 100 prior commits. The next command writes events to two streams (e.g., a DM that posts a message and a presence update).

**Action:** child runs command 101, which writes to stream A's segment, fsyncs, then is killed before writing to stream B's segment.

**Assertions:**
- Engine starts cleanly.
- No commit-index entry for command 101.
- Stream A's segment has a valid record with `commit_seq=101` (orphan; allowed by Option B).
- Stream B's segment does not have a record for `commit_seq=101`.
- Reading stream A's events skips the orphan (Council Review #1 §2.2: wabidb-07 reader behavior).
- The 100 prior commits are intact.

**Invariants verified:** 1, 5, 6, Council Review #1 §2.2 (Option B orphan skip).

### Test 2: `crash_before_index_fsync`

**Setup:** 100 prior commits. Next command writes to 3 stream segments, fsyncs all 3.

**Action:** child writes to all 3 streams + fsyncs, then is killed before writing to the commit index.

**Assertions:**
- Engine starts cleanly.
- No commit-index entry for command 101.
- All 3 stream segments have valid records with `commit_seq=101` (orphans; allowed).
- Reading any of the 3 streams skips the orphan.
- The 100 prior commits are intact.
- The next `commit_seq` assigned is 102 (burned-seq invariant).

**Invariants verified:** 1, 5, 6, Council Review #1 §2.2, §2.4.

### Test 3: `crash_after_index_fsync`

**Setup:** 100 prior commits.

**Action:** child writes 3 stream segments (fsync), appends to commit index (fsync), then is killed before the projection handler runs.

**Assertions:**
- Engine starts cleanly.
- Commit-index has entry for `commit_seq=101` (durable).
- Stream segments have records for `commit_seq=101` (reachable from index).
- Projection does NOT have the events from command 101 yet (the handler never ran).
- On engine restart, the projection rebuilds (wabidb-28) and now includes the events from command 101.
- The 100 prior commits are intact, and their projections are correct.

**Invariants verified:** 1, 5, 6, 8, Council Review #1 §2.3 (durability-await correctness — the `Ok` was never sent, so the client doesn't think command 101 succeeded; the projection rebuild on restart is the correct recovery).

### Test 4: `crash_after_projection_update`

**Setup:** 100 prior commits.

**Action:** child runs the full commit (stream fsync, index fsync, projection update), then is killed before `run_command` returns `Ok` to the caller.

**Assertions:**
- Engine starts cleanly.
- Commit-index has entry for `commit_seq=101`.
- Projection has the events from command 101.
- The `idempotency` table has an entry for `(caller, client_request_id)` for command 101 (so a client retry returns the cached result).
- The 100 prior commits are intact.

**Invariants verified:** 1, 5, 8, Council Review #1 §2.3 (the client didn't receive `Ok`, so the retry is the correct path; idempotency table makes the retry safe).

## 5. What the parent must verify

The recovery invariants (mapped to endstate doc §15.4):

1. **Every committed mutation has exactly one entry in the global commit index.** All 5 tests verify this.
2. **Every durable event is replayable until retention removes it.** All 5 tests verify this via the projection-rebuild path.
3. **Ephemeral events are never written to disk.** Out of scope for these tests; covered by wabidb-44, wabidb-45.
4. **Clients deduplicate by event ID and recover by snapshot/resume.** Test 4 covers idempotency.
5. **Every external command is idempotent by `(caller, client_request_id)`.** Test 4 covers this.
6. **Every topic has an explicit ACL and snapshot contract.** Out of scope here; covered by wabidb-47, wabidb-50, wabidb-51.
7. **Every table has canonical ID types and foreign keys.** Out of scope for crash tests.
8. **Every blob referenced by DB has been fsync'd before DB commit.** Out of scope here; covered by wabidb-59.
9. **Migration rollback is only safe before WabiDB accepts exclusive writes.** Out of scope; covered by wabidb-90, wabidb-96.

Plus the 3 Council Review #1 invariants: Option B orphan skip, burned-seq never reused, durability-await correctness.

## 6. Performance budget

The card says "marked ignored so it doesn't run on every CI commit due to disk I/O heaviness." The 5 tests, sequential, with fork overhead (~5-10ms per test), commit overhead (100ms for 100 prior commits), recovery overhead (50-200ms depending on state size), should total **< 5 seconds**. If they exceed 10s, the harness needs optimization (likely the recovery path; rebuild from snapshot should be fast).

## 7. Anti-patterns to reject

- **Drop impls that fsync.** A `Drop` on a stream segment writer that calls `fsync` would mask bugs by completing writes that the test thought were unfinished. Use `ManuallyDrop` or `mem::forget` in the test path, and audit all `Drop` impls in the engine.
- **Hooks in release builds.** The debug crash hook must be `#[cfg(feature = "test-harness")]` so it cannot fire in production.
- **Recovery paths that read the whole commit index on startup.** This would make tests slow. Recovery should be incremental (load latest snapshot + post-snapshot commit index entries).

## 8. Open questions

1. **The "burned seq" log.** When a `commit_seq` is burned, should the engine append a tombstone to a "burned_seqs" log for postmortem analysis? This is not required for correctness, but it would help diagnose flaky tests. Defer to a follow-up card; current tests can detect the invariant via the next-`commit_seq` assertion.
2. **The wabidb-72 vs wabidb-99 boundary.** Test 2 (crash_before_index_fsync) in this matrix overlaps with test 8 (commit_index_fsync_crash) in the wabidb-72 review. They test the same invariant via different mechanisms (logical failure vs physical SIGKILL). Keep both — they catch different bug classes.
3. **Test determinism under parallel runs.** All 5 tests use a fresh data dir in `/tmp/wabidb-test-{uuid}/`. If two test processes run in parallel and pick the same UUID, they collide. The harness must use `uuid::Uuid::new_v4()` (not a counter) to avoid this.

## 9. Cross-references

- `wabidb-07` (segment reader): must skip orphan records (Council Review #1)
- `wabidb-15` (sequencer): Option B rollback, burned-seq invariant, durability-await
- `wabidb-28` (rebuild): the recovery path that test 3 exercises
- `wabidb-72` (10 crash/resume tests): the complementary logical-failure test suite
- `docs/architecture/wabidb-council-reviews.md`: Council Review #1 (wabidb-05/15) and #2 (wabidb-72)
- Endstate doc: §15.4 (testing strategy), §4 (commit infrastructure), §11 (recovery rules)

## 10. What this design does NOT do

- It does not test hardware-level failures (disk failure, bit rot). Those are covered by `wabidb check` (the storage CLI) and the manifest-based backup's hash verification.
- It does not test the network layer. Network failures between the client and the engine are covered by `wabidb-72` test 5 (resume_after_disconnect) and the helper-node protocol tests.
- It does not test the encryption layer's key destruction. That is `wabidb-39` (cryptographic deletion) and `wabidb-69` (key rotation).
- It does not test retention-driven deletion. That is `wabidb-34` (TTL reaper) and `wabidb-37` (per-scope policy evaluation).
