---
name: wabidb-transaction-system
description: "Learn WabiDB transaction system and ACID guarantees."
version: 0.1.0
author: Hermes
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Transaction, ACID, Isolation, WabiDB, Consensus]
---

# WabiDB Transaction System Learning Guide

This skill provides a structured approach to learning the WabiDB transaction system, including its ACID properties, isolation levels, and consensus mechanisms.

## When to Use

- Need to understand WabiDB's transaction guarantees
- Building applications that rely on WabiDB's consistency properties
- Debugging transaction-related issues or performance problems
- Learning how WabiDB implements atomic commits and durability
- Comparing WabiDB's transaction model to other storage systems

## Prerequisites

- Access to WabiDB source code (specifically sequencer module)
- Understanding of ACID properties and transaction concepts
- Familiarity with consensus algorithms and distributed systems basics
- Rust programming knowledge (for implementation references)
- Basic knowledge of asynchronous programming patterns

## How to Learn

Follow this structured approach to learn the WabiDB transaction system:

## Procedure

### 1. Review Transaction System Architecture

Read through the key files to understand the overall structure:
- `src/sequencer/mod.rs`: Main sequencer logic and commit process
- `src/engine/mod.rs`: Engine initialization and component wiring
- `src/engine/locks.rs`: Locking and synchronization mechanisms
- `src/engine/replay.rs`: Recovery and replay mechanisms
- `src/projections/barrier.rs`: Linearizability barrier for read-after-write consistency

### 2. Understand the Commit Sequencer (Core Transaction Mechanism)

**Key Components to Study:**

**Sequencer Role:**
- Single global ordering point for all writes (serializes all transactions)
- Holds a Semaphore(1) permit to ensure exclusive access
- Assigns monotonic commit sequences (never reused, even on failure)
- Ensures durability before returning success (fsync wait)

**Transaction Processing Flow:**
1. **Assign commit sequence**: Get next monotonic `commit_seq` (burned on failure)
2. **Write events to streams**: Encrypt and append to per-stream segment files
3. **Build commit index entry**: Create entry with all event references
4. **Submit to batcher**: Add to commit index batch for fsync
5. **Wait for durability**: Block until batch is flushed to disk (fsync)
6. **Advance linearizability barrier**: Make changes visible to readers
7. **Notify projection dispatcher**: Send events to update materialized views
8. **Return result**: Send commit success/failure back to caller

### 3. Study ACID Properties Implementation

**Atomicity:**
- All events in a transaction are written together or none at all
- If any step fails, the entire transaction is aborted
- Burned sequence numbers ensure partial transactions don't consume IDs
- Recovery process ignores incomplete transactions (orphan handling)

**Consistency:**
- Schema validation at write time (through projection handlers)
- Invariant checking during commit process
- Referential integrity maintained through stream references
- Cryptographic validation (hashes, signatures) on all data

**Isolation:**
- **Serialization**: Single sequencer ensures serializable isolation
- **Lock-free reads**: Projections use lock-free skiplists for concurrent reads
- **Write serialization**: Semaphore(1) ensures only one transaction commits at a time
- **Read-after-write consistency**: Linearizability barrier ensures immediate visibility
- **Snapshot isolation**: Readers see consistent snapshots via projection versions

**Durability:**
- **WAL-like behavior**: Each transaction fsyncs before returning success
- **Batcher optimization**: Groups commits for efficient fsync while maintaining durability
- **Crash recovery**: Replay from commit index to restore state
- **Power-loss testing**: Artificial crash points validate recovery at key boundaries

### 4. Examine Isolation Levels and Guarantees

**Strong Guarantees Provided:**
- **Strict Serializability**: Equivalent to executing transactions one-at-a-time in some order
- **Linearizable Reads**: Read-after-write consistency via barrier
- **Monotonic Reads**: No going back in time for individual readers
- **Consistent Prefix**: Readers see transactions in commit order
- **Write Serialization**: No concurrent writes to same data

**Implementation Mechanisms:**
- **Sequencer Permit**: `Semaphore(1)` ensures exclusive commit access
- **LinearizabilityBarrier**: Blocks reads until previous writes are visible
- **Projection Versioning**: Readers work on consistent snapshots
- **Commit Index Ordering**: Single source of truth for transaction order

### 5. Analyze Crash Recovery and Resilience

**Recovery Process:**
1. **Lock file validation**: Ensure only one instance runs
2. **Manifest loading**: Read storage configuration
3. **Replay from commit index**: Rebuild state from durable log
4. **Orphan handling**: Ignore writes not referenced in commit index (Option B)
5. **Projection rebuild**: Use snapshots + post-snapshot journal entries
6. **Subscription recovery**: Re-establish streams and resume from checkpoints

**Crash Injection Points (for testing):**
- `crash_before_any_write`: Test burned-seq invariant
- `crash_mid_stream_write`: Test orphan skip in multi-stream transactions
- `crash_before_index_fsync`: Test Option B recovery (ignore uncommitted writes)
- `crash_after_index_fsync`: Test durability-await correctness
- `crash_after_projection_update`: Test idempotency and replay safety

### 6. Review Configuration and Tuning

**Key Transaction-Related Settings:**
- **Batch size**: Number of commits per fsync operation (tradeoff: throughput vs latency)
- **Batch age**: Maximum time to wait for batch to fill
- **Sync timeout**: How long to wait for fsync completion
- **Sequencer channel size**: Buffer for incoming commands
- **Dispatcher channel size**: Buffer for projection updates

### 7. Study Related Components

**Commit Index Batcher:**
- Groups multiple commits for efficient fsync
- Maintains durability guarantees while improving throughput
- Handles partial batch failures gracefully

**Projection System:**
- Materialized views updated asynchronously
- Lock-free reads for high concurrency
- Snapshot-based recovery for fast startup
- Incremental updates from commit journal

**Subscription Engine:**
- Real-time event delivery to clients
- Snapshot + resume mechanism for reconnections
- Message ordering guarantees matching transaction order

## Verification

Confirm your understanding by being able to:

1. **Explain the commit sequence** step-by-step from command submission to result return
2. **Describe how each ACID property** is implemented in the system
3. **Detail the isolation guarantees** and how they're achieved
4. **Walk through the recovery process** after a crash at each injection point
5. **Explain the role of each component** (sequencer, batcher, barrier, dispatcher)
6. **Describe how durability is ensured** despite batching optimizations
7. **Explain why burned sequence numbers** are critical for correctness
8. **Detail how read-after-write consistency** is achieved without blocking reads

## Practice Exercises

To solidify your learning:

1. **Trace a transaction**: Follow a single command through the entire sequencer process
2. **Analyze failure scenarios**: What happens if the process crashes at each step?
3. **Compare isolation levels**: How would you implement weaker isolation if needed?
4. **Optimize batching**: What trade-offs exist in batch size and timing choices?
5. **Design a monitoring system**: What metrics would indicate transaction system health?
6. **Implement a simple test**: Create a test that verifies atomicity under failure conditions

## Reference Implementation

Focus on these key files for implementation details:
- `src/sequencer/mod.rs`: Core transaction processing logic
- `src/sequencer/types.rs`: Transaction data structures
- `src/sequencer/run_command.rs`: Individual command processing
- `src/engine/locks.rs`: Synchronization and locking mechanisms
- `src/engine/replay.rs`: Recovery and replay procedures
- `src/projections/barrier.rs`: Linearizability and read-after-write consistency
- `src/commit_index/batcher.py`: Commit batching for efficient fsync

## Summary

By following this learning guide, you will understand how WabiDB implements:
- A single-threaded commit sequencer for transaction ordering
- ACID guarantees through careful durability and consistency mechanisms
- Strong isolation levels using locking barriers and versioning
- Crash recovery with orphan handling and replay semantics
- Performance optimizations like batching while maintaining correctness
- The relationship between transactions, projections, and subscriptions

This knowledge enables you to reason about WabiDB's behavior, build correct applications on top of it, and contribute effectively to its development.