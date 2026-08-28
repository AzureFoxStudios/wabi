---
name: wabidb-crash-recovery-patterns
description: "Learn WabiDB crash recovery patterns from the 5 implemented crash points."
version: 0.1.0
author: Hermes
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Crash, Recovery, Testing, WabiDB]
---

# WabiDB Crash Recovery Patterns Learning Guide

This skill provides a structured approach to learning WabiDB's crash recovery mechanisms through its 5 implemented crash injection points.

## When to Use

- Need to understand WabiDB's crash recovery guarantees
- Implementing or testing distributed systems with power-loss scenarios
- Learning about WAL-like durability and replay mechanisms
- Debugging recovery-related issues in WabiDB deployments
- Studying crash consistency patterns in storage systems

## Prerequisites

- Access to WabiDB source code (specifically power_loss.rs and sequencer modules)
- Understanding of ACID transactions and crash recovery concepts
- Familiarity with WAL (Write-Ahead Logging) principles
- Rust programming knowledge (for test examination)
- Basic knowledge of asynchronous testing patterns

## How to Learn

Follow this structured approach to learn the crash recovery patterns:

## Procedure

### 1. Review Crash Injection Implementation

Examine the `crash_point()` function in `src/sequencer/mod.rs`:
- Located at lines 419-432
- Only active when `test-harness` feature is enabled and `WABIDB_CRASH_AT` env var matches
- Calls `std::process::exit(1)` to simulate hard power loss
- Does not run destructors (intentional for realistic crash simulation)

### 2. Study the 5 Crash Injection Points

**Point 1: crash_before_any_write** (sequencer.rs line 223)
- Called: After `commit_seq` assignment, before any stream writes
- Tests: Burned-sequence invariant (never reuse failed transaction's seq)
- Recovery expectation: Transaction should appear as if never started
- Verify: Next transaction gets same commit_seq or next available

**Point 2: crash_mid_stream_write** (sequencer.rs line 286)
- Called: After writing one stream's segment, before next stream's segment
- Tests: Orphan handling in multi-stream transactions (Option B rollback)
- Recovery expectation: Written segments exist as orphans (skipped on replay)
- Verify: Orphan segments present but ignored during recovery

**Point 3: crash_before_index_fsync** (sequencer.rs line 300)
- Called: After all stream writes, before commit index fsync
- Tests: Option B orphan tolerance (writes durable but not indexed)
- Recovery expectation: Writes appear as orphans, safely ignored
- Verify: Segment data intact but no commit index references

**Point 4: crash_after_index_fsync** (sequencer.rs line 327)
- Called: After commit index fsync, before projection update
- Tests: Durability-await correctness (index is durable)
- Recovery expectation: Transaction fully recoverable from index
- Verify: All writes replayed correctly despite projection lag

**Point 5: crash_after_projection_update** (sequencer.rs line 367)
- Called: After projection update, before returning Ok to caller
- Tests: Idempotency and replay safety
- Recovery expectation: Safe to retry with same idempotency key
- Verify: Retry produces same result without duplication

### 3. Examine Test Infrastructure

Review `power_loss.rs` to understand:
- **Logical tests** (lines 32-159): Simulated crashes via early returns
- **Physical tests** (lines 172-403): Actual subprocess isolation with `WABIDB_CRASH_AT`
- **Test structure**: 
  - `populate_engine()`: Sets up initial state with known transactions
  - `spawn_crash_child()`: Launches test binary with crash boundary env var
  - `verify_recovery()`: Checks engine state after restart
- **Key helper functions**: `make_crash_cmd()`, `verify_recovery()`

### 4. Understand Recovery Process

From `engine/mod.rs` and `replay.rs`, study how WabiDB recovers:
1. **Startup sequence**: Lock file → manifest → bootstrap key → projections
2. ** 登場人物 replay**: Replay transactions from commit index to rebuild state
3. **Orphan handling**: Skip writes not referenced in commit index (Option B)
4. **Snapshot utilization**: Start from latest snapshot + journal entries
5. **Subscription recovery**: Re-establish streams and resume positions

### 5. Analyze Specific Recovery Behaviors

**For each crash point, verify:**
- What gets persisted to disk before crash
- What recovery process sees on restart
- How invariants are maintained (no duplicates, no lost committed data)
- Idempotency safety for retry scenarios

**Key concepts to master:**
- Burned-sequence never reused (critical for correctness)
- Orphan tolerance (Option B) allows unsafe writes to be safely ignored
- Durability-await ensures commit index is fsck'd before success
- Projection updates are idempotent-safe for retries
- Recovery always produces deterministic final state

## Verification

Confirm your understanding by being able to:

1. **Identify each crash point** in the sequencer code and explain its purpose
2. **Describe the exact state** on disk at each crash point (what's flushed, what's not)
3. **Explain the recovery outcome** for each scenario (what gets replayed, what's ignored)
4. **Articulate why burned sequences matter** and how they prevent replay attacks
5. **Detail the orphan handling mechanism** and why Option B semantics are safe
6. **Explain how idempotency is maintained** across retries after partial commits
7. **Describe the verification process** used in the power loss tests
8. **Connect crash recovery** to broader ACID guarantees (especially atomicity and durability)

## Practice Exercises

To solidify your learning:

1. **Trace each crash point**: For each of the 5 locations, list exactly what persistent state exists on disk
2. **Simulate recovery**: Given a crash at point N, manually walk through what the recovery process would do
3. **Analyze test cases**: Study how `power_loss.rs` validates each scenario's expected outcome
4. **Compare with ARIES**: Contrast WabiDB's approach with the ARIES recovery algorithm
5. **Design additional tests**: What other crash points might be valuable to test?
6. **Explain trade-offs**: Why did WabiDB choose these specific 5 points over others?

## Reference Implementation

Focus on these key files for implementation details:
- `src/sequencer/mod.rs`: Contains the 5 `crash_point()` calls at strategic locations
- `src/sequencer/types.rs`: Defines CommandCommit and related transaction structures
- `src/tests/power_loss.rs`: Implements the physical power-loss test framework
- `src/engine/mod.rs`: Shows engine startup and recovery process
- `src/engine/replay.rs`: Implements transaction replay from commit index
- `src/projections/barrier.rs`: Demonstrates linearizability for read-after-write
- `src/commit_index/batcher.py`: Shows commit batching for durable writes

## Summary

By following this learning guide, you will understand how WabiDB implements:

- **Five strategic crash injection points** covering all critical sections of the commit path
- **Burned-sequence invariant** to prevent ID reuse and enable correct recovery
- **Orphan tolerance (Option B)** allowing safe handling of partially committed writes
- **Durability-await mechanism** ensuring commit index is fsck'd before success acknowledgment
- **Idempotency guarantees** making retries safe after partial commits
- **Deterministic recovery process** that rebuilds consistent state from disk artifacts
- **Physical subprocess testing** framework that validates real power-loss scenarios

This knowledge enables you to reason about WabiDB's behavior under failure conditions, build correct applications that handle transient failures, and contribute effectively to its reliability engineering efforts.