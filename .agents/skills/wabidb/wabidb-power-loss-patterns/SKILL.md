---
name: wabidb-power-loss-patterns
description: "Learn WabiDB subprocess power-loss testing with 5 crash boundaries."
version: 0.1.0
author: Hermes
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Testing, PowerLoss, WabiDB, Subprocess]
---

# WabiDB Power Loss Testing Patterns Learning Guide

This skill provides a structured approach to learning WabiDB's power loss testing implementation using subprocess isolation to validate crash recovery guarantees.

## When to Use

- Need to implement or understand power-loss testing for storage systems
- Learning about WAL-like durability validation through crash injection
- Studying subprocess isolation techniques for reliable testing
- Validating recovery mechanisms in distributed systems
- Building test harnesses for fault-tolerant systems

## Prerequisites

- Access to WabiDB source code (specifically `src/tests/power_loss.rs`)
- Understanding of crash consistency and recovery concepts
- Familiarity with Rust testing framework and asynchronous testing
- Knowledge of subprocess execution and inter-process communication
- Basic knowledge of filesystem durability guarantees

## How to Learn

Follow this structured approach to learn the power loss testing patterns:

## Procedure

### 1. Review Test Harness Setup

Examine the test configuration in `power_loss.rs`:
- **Feature gate**: `#[cfg(feature = "test-harness")]` enables heavy tests
- **Environment variables**:
  - `WABIDB_CRASH_BOUNDARY`: Set by `spawn_crash_child()`, read by `run_crash_child()` to dispatch the correct boundary command
  - `WABIDB_CRASH_AT`: Set by `spawn_crash_child()` alongside `WABIDB_CRASH_BOUNDARY`, checked by `crash_point()` to trigger the actual crash. Both env vars get the same boundary value.
  - `WABIDB_DATA_DIR`: Passes data directory to child process
  - **Known lifecycle issue**: After a crash (`exit(1)`), the lock file and .widx files remain on disk. Tests clean these up in `verify_recovery()` and `run_crash_child()` before re-opening the engine.
- **Test annotation**: `#[ignore]` due to subprocess overhead (manual execution required)

### 2. Understand the Subprocess Isolation Model

**Parent Process Responsibilities:**
- Set up initial state with `populate_engine()`
- Launch child process with specific crash boundary via `spawn_crash_child()`
- Verify child crashed successfully (`assert!(!status.success())`)
- Reopen engine and validate recovery with `verify_recovery()`

**Child Process Responsibilities:**
- Check for `WABIDB_CRASH_BOUNDARY` environment variable
- Initialize engine with 100 prior transactions
- Execute the boundary-specific command
- Crash intentionally at exactly exit via `crash_point()` hook when boundary matches
- Parent detects crash and validates recovery state

### 3. Study the 5 Boundary Points and Their Purposes

**Boundary 0: crash_before_any_write**
- **Location**: After `commit_seq` assignment, before any stream writes
- **Tests**: Burned-sequence invariant (seq never reused on failure)
- **Expected**: Recovery shows transaction never started (next seq = same or skipped)
- **Validation**: `verify_recovery` confirms next expected seq is correct

**Boundary 1: crash_mid_stream_write**
- **Location**: After writing one stream's segment, before next stream's segment
- **Tests**: Orphan handling in multi-stream transactions (Option B rollback)
- **Expected**: Partial writes appear as orphans, safely ignored on replay
- **Validation**: Orphan segments present but skipped during recovery

**Boundary 2: crash_before_index_fsync**
- **Location**: After all stream writes/fsyncs, before commit index fsync
- **Tests**: Option B orphan tolerance (writes durable but not indexed)
- **Expected**: Writes exist on disk but not in commit index → ignored
- **Validation**: Recovery ignores uncommitted writes despite data presence

**Boundary 3: crash_after_index_fsync**
- **Location**: After commit index fsync, before projection update
- **Tests**: Durability-await correctness (index is durably stored)
- **Expected**: Transaction fully recoverable from commit index
- **Validation**: All writes replayed correctly despite projection lag

**Boundary 4: crash_after_projection_update**
- **Location**: After projection update, before returning `Ok` to caller
- **Tests**: Idempotency and replay safety
- **Expected**: Safe to retry with same idempotency key
- **Validation**: Retry produces identical result without duplication

**Boundary 5: crash_during_snapshot**
- **Location**: During snapshot creation, after writing snapshot header but before finalizing
- **Tests**: Snapshot consistency and recovery
- **Expected**: Snapshot is either fully present or fully absent
- **Validation**: Recovery either uses complete snapshot or ignores it entirely

### 4. Analyze Helper Functions

**`make_crash_cmd(seq_prefix, stream_id, stream_kind, plaintext)`**
- Creates a CommandCommit with one event
- Uses sequential caller IDs for test isolation
- Includes idempotency key for replay safety testing
- Marks command as essential (blocks on dispatcher)

**`populate_engine(data_dir, n)`**
- Sets up engine with `n` prior transactions
- Uses fixed bootstrap key for determinism
- Registers test stream before populating
- Waits for engine drain before returning

**`spawn_crash_child(data_dir, boundary)`**
- Locates current executable via `std::env::current_exe()`
- Launches child with test entry point and environment variables
- Returns child's exit status for failure verification

**`verify_recovery(data_dir, expected_prior_count, expected_next_seq)`**
- Reopens engine after crash
- Submits verification command with expected next sequence
- Confirms engine is functional and sequence correctness

**`run_crash_child()`**
- Child entry point when `WABIDB_CRASH_BOUNDARY` is set
- Initializes engine with 100 prior transactions
- Executes boundary command (should crash via `crash_point()`)
- Panics if child doesn't crash (indicates misconfiguration)

### 5. Examine Test Implementation Patterns

Each of the 5 test functions follows this pattern:
1. Create temporary directory with `tempfile::tempdir()`
2. Populate with 100 prior transactions via parent process
3. Spawn child to crash at specific boundary
4. Verify child crashed successfully
5. Validate recovery state via `verify_recovery()`
6. Expect next commit sequence to be 102 (101 was burned)

### 6. Understand Execution Requirements

**Running the Tests:**
- Requires `test-harness` feature: `cargo test --features test-harness`
- Tests are `#[ignore]` - must run explicitly: `-- --ignored`
- Full command: `cargo test --features test-harness -p wabidb --lib tests::power_loss -- --ignored`
- Output shows which boundary is being tested and verification results

**Why Subprocess Isolation?**
- Avoids interference with parent process state
- Simulates real power loss (no cleanup, no signal handling)
- Tests actual file system persistence guarantees
- Prevents test harness from affecting crash behavior

## Verification

Confirm your understanding by being able to:

1. **Explain the two-phase test design** (parent setup/verification + child execution/crash)
2. **Describe each of the 5 boundary points** and what specific invariant they validate
3. **Detail the helper functions'** roles in the test ecosystem
4. **Articulate why subprocess isolation** is necessary for valid power-loss testing
5. **Explain the burned-sequence validation** across all test scenarios
6. **Describe how orphan handling** (Option B) is verified in boundary 1 and 2 tests
7. **Detail the idempotency validation** in the boundary 4 test
8. **Explain how test determinism** is achieved despite asynchronous components

## Practice Exercises

To solidify your learning:

1. **Modify a boundary**: Change one test to verify a different recovery invariant
2. **Add logging**: Insert trace statements to observe exact crash points
3. **Vary prior count**: Test with different numbers of prior transactions (1, 10, 1000)
4. **Test non-essential commands**: Modify to test EngineBackoff handling
5. **Create boundary 6**: Imagine what a sixth boundary might test (e.g., during snapshot)
6. **Explain trade-offs**: Why these 5 points were chosen over other possible locations

## Reference Implementation

Focus on these key sections in `src/tests/power_loss.rs`:
- Lines 10-23: Helper functions (`write_record`)
- Lines 24-59: Logical test `simulate_power_loss_before_fsync`
- Lines 61-115: Logical test `simulate_crash_between_segment_write_and_commit_index`
- Lines 117-159: Logical test `simulate_power_loss_after_commit_index_fsync`
- Lines 162-210: Physical test setup (helpers and child entry point)
- Lines 212-234: `populate_engine()` function
- Lines 235-258: `verify_recovery()` function
- Lines 261-305: `run_crash_child()` child entry point
- Lines 307-403: The 5 actual power-loss test functions

## Summary

By following this learning guide, you will understand how WabiDB implements:

- A **robust subprocess isolation framework** for power-loss validation
- **Five strategic crash injection points** covering critical commit path sections
- **Deterministic test setup** with known prior state and verification procedures
- **Burned-sequence validation** ensuring failed transactions don't consume IDs
- **Orphan handling verification** confirming Option B rollback semantics work
- **Durability-await testing** proving commit index fsync before success
- **Idempotency safety validation** ensuring safe retries after partial commits
- **Clear validation procedures** that confirm recovery correctness

This knowledge enables you to implement similar power-loss testing in your own systems, understand WabiDB's reliability guarantees, and contribute effectively to its testing and quality assurance efforts.