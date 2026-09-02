# WabiDB Validation & Integration Test Plan

> **Date:** 2026-06-21
> **Status:** Engine complete with all deepseek audit fixes. Integration layer not yet built.
> **Goal:** Before "putting it into wabi", validate the engine is production-ready. Plan 5 validation tracks, then 1 integration track.

## Current state (verified)

```
99 of 99 kanban cards complete (initial pass)
534 unit tests + 1 doc test = 535 total, 0 failing
Build clean (cargo check + cargo test + cargo test --features test-harness)
All 4 critical + 6 medium findings from the deepseek audit resolved
```

**What this does NOT cover:**
- Memory leaks (no leak detector run)
- Performance under load (no benchmarks)
- Scale (tests use 3-5 records; we don't know behavior at 1M+ records)
- Failure modes under load (disk full, ENOSPC mid-fsync, process kill mid-transaction)
- Real-workload replay (tests use synthetic data; no STDB → wabidb replay tool)
- UB / MIRI (not run)

## Phase 1: Validation (no integration yet)

### Track 1.1: MIRI pass

**Tool:** `cargo +nightly miri test -p wabidb --lib`

**What it catches:** undefined behavior (use-after-free, data races, invalid casts, alignment violations) that the borrow checker doesn't catch. Particularly important for the unsafe code in `crypto/aes_gcm_record.rs`, `stream_log/recovery.rs::actual_truncate`, `storage/fsync.rs`.

**Setup:**
```bash
rustup install nightly
rustup component add miri --toolchain nightly
```

**Expected outcome:** zero UB reports. If MIRI flags anything, fix and re-run.

**Time estimate:** 1-2 hours (mostly MIRI setup, plus fix any UB).

**Pass criteria:** clean MIRI run on the entire lib test suite.

### Track 1.2: Memory leak detection

**Tool:** valgrind (or heaptrack) on the integration test binary.

**What it catches:** memory leaks in long-running code paths. The engine uses tokio + crossbeam-skiplist + parking_lot — all leak-free in normal use, but mistakes (e.g., forgetting to drop a Mutex guard, leaked channels) could leak.

**Setup:**
```bash
sudo dnf install valgrind  # Fedora/Bazzite
cargo test -p wabidb --lib --no-run
valgrind --leak-check=full --show-leak-kinds=all \
  ./target/debug/deps/wabidb-<hash> engine::tests::engine_starts_and_serves_a_command
```

**Expected outcome:** zero definitely-lost, zero indirectly-lost. Some "still reachable" is OK (global state).

**Time estimate:** 1 hour.

**Pass criteria:** valgrind reports no lost blocks.

### Track 1.3: Load test

**Goal:** measure commit throughput, p99 latency, memory growth under realistic load.

**Test scenarios:**
- 100 concurrent readers + 10 concurrent writers, 10 minutes
- 1000 concurrent readers + 100 concurrent writers, 5 minutes
- Burst: 10,000 writes in 1 second, then 1 reader per write

**New module:** `core/crates/wabidb/src/tests/load_test.rs`

**Skeleton:**
```rust
#[tokio::test(flavor = "multi_thread")]
async fn load_test_100r_10w_10min() {
    let engine = WabiDbEngine::open(...).await.unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    
    // 100 readers
    let mut reader_handles = vec![];
    for _ in 0..100 {
        reader_handles.push(tokio::spawn(read_loop(engine.clone(), stop.clone())));
    }
    
    // 10 writers
    let mut writer_handles = vec![];
    for _ in 0..10 {
        writer_handles.push(tokio::spawn(write_loop(engine.clone(), stop.clone())));
    }
    
    tokio::time::sleep(Duration::from_secs(600)).await;
    stop.store(true, Ordering::Relaxed);
    
    for h in reader_handles { h.await.unwrap(); }
    for h in writer_handles { h.await.unwrap(); }
    
    // Report metrics
}
```

**Metrics to capture:**
- Commits/sec (target: 1000+ commits/sec sustained)
- p50/p99 read latency (target: p99 < 10ms)
- p50/p99 commit latency (target: p99 < 100ms; fsync-bound)
- Memory growth over 10 minutes (target: < 50MB growth)
- Final disk size

**Time estimate:** 1 day (build the test, run it, analyze, iterate).

**Pass criteria:** all metrics within targets.

### Track 1.4: Failure injection

**Goal:** verify the engine handles crashes, disk full, network errors gracefully.

**Test scenarios:**
- **kill -9 mid-fsync:** spawn a worker that's writing 1000 records; SIGKILL at random times. Restart. Verify recovery via `scan_segment_file` recovers everything that was successfully fsync'd. The existing `tests::crash_tests` cover the simulated version; this is the real version.
- **ENOSPC simulation:** use `LD_PRELOAD` with a fault-injection shim, or a custom filesystem (fuse), or just `setrlimit`. Verify the engine returns a clean error rather than panicking.
- **Disk full mid-write:** truncate a file mid-write and verify the engine rejects the corrupted file.

**Setup:** new module `core/crates/wabidb/src/tests/failure_test.rs`. Use `nix` crate for signal handling, `fault_injection` shim or a `setrlimit` approach for ENOSPC.

**Time estimate:** 1-2 days.

**Pass criteria:** engine never panics; always returns a structured `WabiError`; recovery restores the last fsync'd state.

### Track 1.5: Real-workload replay

**Goal:** prove the engine handles real Wabi-shaped data, not just synthetic.

**Test scenario:**
1. Take a snapshot of a STDB instance (or a synthetic generation script).
2. Generate 1M messages across 1000 channels, 100 DMs, with realistic distribution (some channels hot, most cold).
3. Replay through wabidb. Time it.
4. Read back the projections. Compare to expected.

**Setup:** new crate `core/crates/wabidb-loadgen` (or a script) that generates realistic Wabi data. New test `core/crates/wabidb/src/tests/replay_test.rs`.

**Time estimate:** 2 days (build the gen, run the replay, debug).

**Pass criteria:** replay completes; all reads return expected values.

## Phase 2: Integration

### Track 2.1: `wabi-server` minimal scaffold

**Goal:** a binary that embeds wabidb and exposes a tiny HTTP API. The first version is read-only: `GET /messages?channel=ch_X&since_seq=N` → returns projections. No writes yet.

**Why read-only first:** reads are easier to test against STDB (same data, both engines). Writes are where the migration risk is. Get reads right first.

**Files to create:**
- `core/crates/wabi-server/Cargo.toml`
- `core/crates/wabi-server/src/main.rs` (axum or hyper)
- `core/crates/wabi-server/src/state.rs` (wraps WabiDbEngine)
- `core/crates/wabi-server/src/api.rs` (the HTTP handlers)

**Endpoints (v1):**
- `GET /health` → 200 OK
- `GET /channels/{id}/messages?since=N` → returns projection state
- `GET /users/{id}/dm_channels` → returns projection state

**Time estimate:** 3-4 days.

### Track 2.2: STDB → wabidb migration tool

**Goal:** a one-time tool that copies all messages, DMs, reactions, channel memberships from STDB into wabidb.

**Approach:**
1. Read from STDB via its existing client API.
2. Translate each STDB event to a wabidb `CommandCommit`.
3. Submit via the wabidb sequencer.
4. Wait for projection dispatch.
5. Verify reads match.

**Files to create:**
- `core/crates/wabidb-migrate/Cargo.toml`
- `core/crates/wabidb-migrate/src/main.rs`

**Time estimate:** 1-2 weeks (depends on STDB schema and edge cases).

### Track 2.3: Side-by-side

**Goal:** run wabidb alongside STDB on a real wabi instance. Compare reads.

**Approach:**
1. wabi-server reads from BOTH STDB and wabidb for the same query.
2. Returns the STDB response (source of truth).
3. Logs the wabidb response.
4. Diff in tests; alert on mismatch.

**Time estimate:** 1 week to build the side-by-side.

### Track 2.4: Switch over

Only after Tracks 1.1-1.5 + 2.1-2.3 all pass.

1. Switch wabidb to source of truth (STDB becomes read-only mirror).
2. Run for 1 week. If no mismatches, remove STDB.
3. Decommission STDB.

**Time estimate:** 1 week of production testing + decommissioning.

## Phase 3: Operational

### Track 3.1: Backup / restore verified end-to-end

We have the code (`retention/data_backup.rs`, `retention/verify_backup.rs`) but no end-to-end test.

**Goal:** run `wabidb backup` on a real data dir, run `wabidb verify-backup`, restore to a fresh dir, verify reads match.

**Time estimate:** 2 days.

### Track 3.2: Migration plan doc updated

The `docs/plans/wabidb-rollout.md` (or similar) should reflect:
- Phase 1 validation results
- Phase 2 integration steps with actual timestamps
- Rollback procedure if wabidb fails in production

**Time estimate:** 1 day.

## Total estimate (no firm dates per Ronin's preferences)

- Phase 1 (validation): 4-5 working days
- Phase 2 (integration): 3-4 weeks
- Phase 3 (operational): 3-4 days

**Critical-path dependencies:**
- Phase 1 must complete before Phase 2.3 (side-by-side needs a known-good engine).
- Phase 2.1 (wabi-server scaffold) is the first integration work; can start in parallel with Phase 1's later tracks.

## Open questions for Ronin

1. Where does wabidb sit in the wabi monorepo? New crate in `core/crates/`? Separate repo? (Currently the source is in `core/crates/wabidb/`, suggesting the former.)
2. Where does the new `wabi-server` crate go? Same monorepo? (Likely yes.)
3. For Track 1.3 (load test), do we have a target workload spec? "1000 users, 100 channels each, ~10 msg/sec/channel" is a reasonable default but I'd want to confirm against Wabi's actual scale target.
4. For Phase 2.4 (switch over), what's the rollback time budget? "If wabidb breaks in production, how fast can we switch back to STDB?" That determines the failover design.
5. For Track 2.2 (migration tool), do we have access to a real STDB schema and instance? Or do we need to mock?

## First concrete step

**Start Phase 1.1 (MIRI pass) in-session.** This is the highest-value lowest-effort validation:
- Catches real UB before we integrate
- Takes 1-2 hours
- No integration dependency

Then queue 1.3 (load test) as the next major work item.
