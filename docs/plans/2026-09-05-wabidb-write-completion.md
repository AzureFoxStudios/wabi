# WabiDB write completion and projection integrity

Status: complete and locally verified. Changes are uncommitted; not pushed or deployed.

## Objective

A successful command must be durable and fully visible in projections before
the server reads back state or publishes a live update. A projection failure
must not masquerade as success or allow checkpoints to skip unapplied events.

## Evidence at fb28bebd

- `sequencer::finalize_command` advances the applied barrier before dispatch,
  sends events individually, and responds without waiting for application.
- The dispatcher logs handler errors and still advances the watermark; it can
  checkpoint between events belonging to the same commit.
- Non-essential dispatch can return `EngineBusy` after the commit-index fsync,
  leaving a durable command unapplied until restart and inviting duplicate retries.
- Call session HTTP handlers read projections immediately to build WebSocket
  pushes; the albums create handler polls for up to 500 ms after command success.
- The baseline database library suite passes: 886 tests. Its barrier smoke test
  advances the barrier manually, and several sequencer tests never run a dispatcher.

## Design and verification

Dispatch whole commits with an explicit application acknowledgment. Only complete,
successful application advances the applied watermark and permits a checkpoint.
Durable work waits for dispatch capacity; reject optional work at admission,
before writing. Surface post-commit projection failure as a storage invariant
failure and stop advancing across the failed commit. Preserve group fsync ordering,
event encodings, stable message IDs, and the external Lore boundary.

Regression coverage will exercise delayed dispatch, multiple events per commit,
handler failure, canceled callers, saturation, immediate server reads/pushes,
and restart/crash recovery. Update engine documentation and WabiDB skills with
the proven guarantees and their limits; do not claim snapshot isolation or
arbitrary read-modify-write transaction isolation.

No postcard records, event names, domain fields, or ChannelKind values are changed.
No push or deployment is authorized.

## Implemented behavior

- `DispatchCommit` is an in-memory protocol containing an ordered event batch
  and an application acknowledgment. The sequencer retains group-index fsync
  and finalizes commands in sequence, awaiting application before success.
- ProjectionState owns a single watch-backed applied watermark. Dispatcher
  progress wakes existing barrier waiters without a second manual advance.
- Application errors halt the dispatcher and sequencer. Later commands in the
  same fsynced group receive an explicit durable-but-unapplied error. A lost
  response is reported as potentially durable, not a safe retry or rollback.
- Optional work is rejected at command admission; durable work always waits
  for dispatcher capacity. Losing a caller does not cancel application.
- Whole-command application and snapshot writers share a lock. Failed/poisoned
  application cannot be checkpointed. Snapshot writes fsync a temporary file,
  rename over the old checkpoint, and fsync the directory on Unix.
- Replay validates all indexed post-snapshot event references and preserves
  event-ref order within multi-stream commands. Missing events/handler errors
  refuse startup; failed open releases the engine lock it acquired.
  Compatibility review found that chat/workspace operations can share a stream
  ID with different kinds while the historical writer cache keys only by ID.
  Replay therefore matches record hash/segment/offset/length, not directory kind;
  a regression proves these existing records still reopen correctly.
- Empty-index replay no longer resurrects uncommitted segment records. A test
  reproduced a real failed first command (second stream missing its key), then
  reopened the engine: before the fix its first event appeared as committed.
  Orphans now remain absent while their sequences still prevent nonce reuse.
- Duplicate stream IDs in one command are rejected before any encryption/write.
  The current stream-key/commit-sequence nonce cannot safely encrypt two events
  in the same stream. Supporting this needs a versioned format, not a new field
  casually appended to a postcard record.
- Valid call teardown of an absent session/participant is an explicit no-op;
  malformed events still fail and no phantom roster entries are created.
- `/health` and `/readyz` check writer/application health, not merely whether
  an in-memory read succeeds. `/livez` is unchanged. Album creation reads back
  directly after success; its 20 × 25 ms projection polling workaround is gone.
- Removed unused `commands/send_dm_message.rs`, an experimental path with
  hardcoded all-zero handshake inputs and JSON incompatible with the registered
  postcard DM projection. Its five tests relied on ignored application errors;
  there were no production callers. The real WdbAdapter DM path is untouched.
  The removed file remains recoverable from Git history.

## Verification evidence

The original completion regression failed before implementation: finalization
returned `Ok(CommandOutcome)` while no dispatcher had applied the event. The
new suite checks pending acknowledgments/barriers with controlled handlers,
not a sleep inserted into application code to hide races.

- Database regressions cover multi-event application, concurrent snapshots,
  partial handler failure, last-good checkpoint preservation, dropped callers,
  empty commits, admission/backpressure, failed durable groups, replay ordering,
  incomplete replay, failed-open lock cleanup, and nonce uniqueness.
- The `test-harness` subprocess regression exits without destructors at each
  of the five sequencer crash points. Parent recovery checks actual event state,
  indexed event counts, applied watermark, stale-lock reclamation, and the next
  allocated sequence. This is process-crash coverage, not hardware power loss.
- Three server tests use the real adapter and Axum router: call create/join/
  leave/end payloads and album readback; immediate Lore metadata/change-cursor
  visibility without the external CLI; health/readiness degradation even while
  the old list-users readiness read still succeeds.

Final results on 2026-09-05:

| Verification | Result |
|---|---|
| `cargo test -p wabidb --lib` | 895 passed, 0 failed (normal parallel runner) |
| `cargo test --workspace -- --test-threads=1` | 1,460 passed across 37 suite executions, 0 failed; 1 pre-existing mDNS doctest ignored |
| `cargo test -p wabidb --features test-harness --lib` | 898 passed, 0 failed; 5 opt-in crash tests ignored |
| `cargo test -p wabidb --features test-harness --lib tests::power_loss -- --ignored --test-threads=1` | All 5 opt-in crash tests passed |
| `cargo test -p wabidb --features test-harness --lib tests::write_completion` | 11 passed, including the new five-boundary subprocess regression |
| `cargo test -p wabi-server --features addons --test write_visibility_contract` | All 3 passed; also passed in the default-feature workspace run |
| Skill validation | All 3 edited skills passed the skill-creator validator |
| Diff review | Reviewed engine/sequencer/server/tests/docs changes; `git diff --check` clean |

The original 886-test library baseline predates 14 added regressions and removal
of the 5 obsolete experimental DM tests described above; counts are not a
substitute for the behavioral evidence. Workspace counts include the server's
library/binary test duplication. Logs are local `/tmp/wabi-*-20260905.log` files.

An early parallel server run hit the unchanged `call_security` header-cache
tests: the global-cap test can evict another concurrently running test's
entries. Both server suites passed serially. This work does not claim that
whole-workspace parallel-test isolation is fixed. Sandbox DNS/loopback-bind
failures were rerun with approved access; the successful full run includes
the loopback HTTP/editor-port tests. Existing compiler warnings remain.

Workspace code generation stripped `ChannelView`'s `position`/`parentId` fields;
they were restored exactly to HEAD per AGENTS.md. No generated protocol diff
remains, and there are no frontend changes requiring browser rendering checks.

## Limits and remaining work

This establishes local command completion, not full database ACID or distributed
consensus. Ordinary concurrent reads can observe a later in-flight command;
there is no MVCC or isolated application read-modify-write transaction. In-memory
idempotency still has a concurrent check/insert gap and is not restored on
restart. Replica ingestion is a separate segment/index path, not covered by the
new local-command completion guarantee. Graceful task/lock ownership on engine
shutdown also warrants a separate audit.

Startup now fails honestly on indexed corruption or incompatible post-snapshot
records instead of silently omitting them. No automatic destructive repair or
legacy unindexed salvage is attempted. Preserve backups and diagnose the
reported commit/projection; deleting an index or checkpoint is not a repair.
Already-created inconsistent legacy snapshots are not retrospectively validated.

Live browser rendering, WebRTC/relay audio and video, external Lore binary
operations, deployment behavior, and physical power-cut durability have not
been verified in this objective. No UI or call transport implementation changed.

## Recommended next objective

End-to-end offline command acknowledgment and retry safety. The current
`frontend/src/lib/wabidb/drain.ts` calls `sock.emit(...)` and immediately
`markSynced(...)` without server acknowledgment. Connection loss or rejection
can therefore discard pending intent. Trace admission, stable optimistic IDs,
server acceptance, deduplication, and reconnect replay together before changing
it; the local database completion guarantee now provides a sound server-side
boundary for that work. No offline-queue changes were made in this objective.
