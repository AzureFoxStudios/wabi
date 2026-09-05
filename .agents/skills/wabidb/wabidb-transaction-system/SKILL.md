---
name: wabidb-transaction-system
description: "Trace and change WabiDB command completion, durability, projection barriers, and crash recovery."
metadata:
  hermes:
    tags: [Transaction, WabiDB, Durability, Recovery]
---

# WabiDB command completion

Use this skill when changing command sequencing, write acknowledgments, replay,
or projection visibility. Paths below are relative to `core/crates/wabidb`.
The implementation contract was corrected on 2026-09-05; older plans describe
barrier-before-apply and must not be copied.

## Trace the actual write path

Read `src/sequencer/run_command.rs`, `src/sequencer/mod.rs`,
`src/engine/locks.rs`, `src/projections/barrier.rs`, and
`src/engine/replay.rs` for the layer being changed.

1. Admission: essential commands wait for command-queue capacity; optional
   commands may get `EngineBusy` here, before writing.
2. The single sequencer assigns a sequence. At most one event per stream per
   command is allowed: encryption uses the stream key and commit sequence as
   its nonce. Supporting more requires a versioned encryption-format design.
3. Encrypt/append events and fsync every touched segment before the commit index.
   Failed preparation can leave orphan records; it is not physical rollback.
4. Submit index entries, then await the group-window fsync (up to 32 commands).
5. Dispatch each whole command as `DispatchCommit`, preserving event order.
   Await its application acknowledgment before finalizing the next command.
6. The dispatcher applies all handlers synchronously, advances the shared
   watch-backed watermark once, and acknowledges. Only then return success.

Do not advance the barrier from the sequencer or reply when a batch is merely
queued. Once durable, optional work must wait too; a post-fsync busy response
would invite retries of an already committed command.

## Guarantees and limits

- Success means segment/index durability plus complete projection application.
  Immediate adapter reads and live payload construction need no catch-up sleeps.
- This is ordered writes and read-after-write visibility, NOT MVCC, snapshot
  isolation, or serializable application read-modify-write transactions.
  Ordinary reads can see a later command while its handlers are applying.
- A handler error after durability cannot roll back the log. Halt the applied
  prefix and writer, keep the last good checkpoint, and return an invariant
  failure. Remaining commands in the same flushed window may also be durable.
  Lost acknowledgment is an uncertain outcome, not proof of non-commit.
- Validate ordinary user errors before committing. Handlers must replay valid
  events deterministically. Explicitly idempotent absent teardown is a no-op;
  malformed durable payloads must not be swallowed as successful application.
- Dropping the caller does not cancel admitted durable work.
- The idempotency table is in-memory and has a check/insert concurrency gap.
  Do not promise restart-safe exactly-once retries. Replication ingestion is a
  separate path; local command completion does not prove replica application
  or distributed consensus.

## Checkpoint and replay invariants

Application and snapshot writers share the application lock. Take that lock
before index locks; never snapshot inside a projection handler and never hold
these synchronous locks across an await. Save only complete healthy commits,
writing/fsyncing a temporary JSON snapshot and renaming it over the old file
(parent-directory fsync on Unix). Engine checkpoints still use
`projections/snapshot.json`, not the separate binary snapshot implementation.

Replay uses the commit index as authority even when empty. Skip unindexed
orphans, but count their sequences for nonce allocation. Recover every indexed
post-snapshot event or fail startup; apply in `(commit_seq, event_ref ordinal)`
order. A registered handler failure is a startup error. The applied watermark
tracks committed work, not the larger orphan-inclusive sequence high-water.
Failed open must release only the lock it acquired.

Legacy writer caching uses stream ID, not (kind, ID); chat/workspace operations
can therefore record different kinds in one physical stream directory. Replay
matches stream hash/segment/offset/length to event references, not directory kind.
Keep the shared-stream restart regression when tightening reference validation.

Do not casually alter postcard records, event envelopes, stream references, or
nonce construction. Consult existing compatibility decoders and document any
migration. This completion change required no encoded-record changes.

## Verification

- `cargo test -p wabidb --lib`
- `cargo test -p wabidb --features test-harness --lib tests::write_completion`
- `cargo test -p wabi-server --test write_visibility_contract`

Use gates/acknowledgments to prove pending state rather than sleeps that make a
race disappear. Cover multi-event application, concurrent snapshotting, failure
after partial apply, canceled callers, admission/backpressure, and durable
group-window failure. The subprocess regression exits at all five sequencer
crash points and reopens actual segments/indexes; it is process-crash coverage,
not a hardware power-cut test.

Update the active plan and relevant docs/skills for projection/domain changes
per AGENTS.md. This does not authorize pushing or deployment. Detailed evidence:
`docs/plans/2026-09-05-wabidb-write-completion.md` at repository root.
