# Coordinated checkpoint boundary

**Date:** 2026-09-28  
**Status:** Main Wabi working-tree local ordering component. No operator-facing live exporter or promotion is enabled.

## Ordering

`InstanceCheckpointBoundary::prepare` is an internal Authority control path,
called outside ordinary HTTP/Socket.IO admission. It first drains registered
application operations, then pauses both engine mutation paths. This order
allows a database commit's following sidecar/upload publication to finish before
the copy boundary is chosen.

The database pause takes the inbound-ingestion lock before the local writer
lock, matching ingestion's order. The sequencer holds its reader through
segment/index fsync, complete projection application and acknowledgment.
An ongoing commit window finishes before the pause is returned; another window
waits until release. Unacknowledged commands still outside a commit window are
pending work, not part of the captured applied prefix.

`prepare_with_timeout` sets an asynchronous admission/engine drain deadline.
An expired deadline drops the waiting preparation and any acquired guards
before file I/O starts; it does not abort already admitted work or veto later checkpoints. Its timeout
must be positive and representable. Synchronous index validation cannot be
preempted by the timer; preparation also refuses a result that completes after
the deadline. This is not a hard wall-clock bound for blocking work and does
not bound a started copy, whose guards remain held until it actually finishes.

The engine checks known application/replication health, flushes the commit-index
batcher and requires the indexed position to equal the applied position. The
guard records that position and its commit-prefix fingerprint and retains the
engine so shutdown cannot release its process lock during a copy. The existing
durable writer fence is preserved; a temporary pause creates no fence marker
and cannot elect or activate a replacement.

## Projection snapshot and cancellation

The dispatcher can start a periodic projection snapshot **after** acknowledging
application. Pausing the sequencer does not by itself freeze that file.
`PausedEngine::with_projection_checkpoint` saves the ordinary healthy snapshot
while holding its application/snapshot lock and keeps that lock through the
synchronous file-copy closure. This drains an earlier periodic snapshot and
holds a later one until the copy returns.

`InstanceCheckpointBoundary::with_files` moves the application and engine
guards into the blocking task before copying. A disconnected caller cannot
release those guards while started blocking I/O continues. An error result
releases the guards; a panicking closure poisons the shared projection lock and
prevents later checkpoint certification until restart/recovery. The closure
must not await, invoke another snapshot, call admitted handlers or write through
WabiDB while it holds these locks.

## Interruption veto

Admitted operations track normal completion. Panic or cancellation **after
entry** sets an in-process checkpoint veto before the last lease can release
admission. A waiting pause then refuses instead of certifying an unknown
partial operation. Cancelling a queued operation, or returning an ordinary
validation/error result, does not set this flag. Owned handlers continuing
after an HTTP caller disconnects are still admitted and can complete normally.

The veto has no running-process reset. Reconstruct and validate the instance
after restart before attempting a checkpoint. Ordinary operation admission is
not globally disabled by this flag; it is a checkpoint safety decision.
Successful completion of an error-returning handler also does not prove that
all canonical files are restorable: the future exporter must validate them.

## Remaining exporter and recovery gates

This component freezes participating application work, canonical engine commit
windows, inbound engine ingestion and the projection snapshot writer. It does
not certify an operator's whole instance. Direct sidecar/file mutation, plugin
workers, helper subprocess files, logs/temp/cache paths, external secrets and
optional external stores still need the [complete inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md).
The prefix check is not an archive manifest or proof that every archived byte
is intact and readable.

The internal [encrypted live archive candidate](LIVE_CHECKPOINT_ARCHIVE.md)
now consumes this boundary, supplies bounded copying, streams both core roots
to age ciphertext, records the active keys and resolved server configuration,
and restores V2 archives inactive. Its inventory and key/prefix checks are
component checks. The opt-in [local operator control](OPERATOR_CHECKPOINT_CONTROL.md)
starts owned, bounded core exports; no complete-instance readiness verdict is enabled. Explicit participant/path classification, external/operator/plugin
inventory and comprehensive clean restore acceptance remain required. A private staging
copy must not be labeled recovery-ready until those checks pass. Manual
unavailable-host promotion, durable distributed fencing and old-node reseeding
come afterward. The current standby endpoints remain unavailable and the
development receiver remains `fullInstanceReady: false`.

Local evidence and fixture-specific limits are recorded in
[the dated checks](../testing/CHECKPOINT_BOUNDARY_2026-09-28.md).
