# Runtime operation pause

**Date:** 2026-10-02

**Status:** Experimental local boundary used by the opt-in core live-checkpoint
exporter. Complete-instance recovery and promotion remain unproven.

## Purpose

`AppState::instance_operations` coordinates participating work in one process.
A pause drains work that has entered, then holds new participating work until
the pause guard is dropped. It helps establish a future shared ordering boundary
between database changes, file-backed policy and uploads.

This is an in-process scheduling gate. It is not a durable writer fence,
distributed lease, recovery-ready verdict or permission to start another writer.
The standby exporter/importer/promotion endpoints remain unavailable, and a
development receiver must still report `fullInstanceReady: false`.

## Participants

| Path | Admission behavior |
|---|---|
| API router and full application router | Middleware owns handler execution until a response is created. A caller disconnect or an outer timeout does not detach a continuing handler from admission. Nested router middleware shares the same lease. |
| Socket.IO | 89 asynchronous callbacks, including disconnect handling, own their admitted execution. The transport's acceptance of a packet is separate from the application callback entering. Stateless synchronous output and the rejected-rejoin output do not mutate recovery state. |
| Account publication | Ownership, revocations, code issuance/consumption and code-based recovery use owned workers. Workers inherit an existing lease before spawning and retain it after caller cancellation. |
| Background passes | Helper heartbeat expiry, stale job requeueing, durable retention, Live buffer eviction, guest cleanup, report-evidence expiry, field-pilot expiry and blacklist expiry enter for each pass. Interval waits remain outside admission. |
| Startup tasks | Hermes registration and legacy payment-intent migration use owned admitted tasks. |

The middleware stops covering a response when its headers/body object are
returned. It does not hold admission for the lifetime of streamed downloads,
an upgraded WebSocket or a service tunnel. The actual Socket.IO handlers have
their own admission. The separate call-state WebSocket is a read/subscription
surface. Any future streaming or upgraded writer needs explicit participation.

Outbound webhooks currently read WabiDB and perform external HTTP delivery;
they do not persist local delivery state. Detached Socket.IO emissions are
output-only. Neither external webhook delivery nor active media sessions are
made recoverable by this gate.

## Implementation contract

- `run(future)` admits borrowed work. Nested work on the same instance reuses
  its current lease. Different instances do not inherit each other's lease.
- `spawn(future)` captures a current lease synchronously, then owns the future
  in a task. Without an inherited lease it waits for admission itself.
- The HTTP middleware and `scoped` Socket.IO wrapper use owned tasks. This
  avoids dropping admission while a cancelled handler's sequencer command or
  other accepted work continues.
- `quiesce()` must be called outside an admitted operation. Calling it from
  inside that instance's operation returns an error instead of waiting for its
  own lease. The opt-in privileged checkpoint controller uses a separate control
  path; an ordinary admitted API handler cannot pause itself.
- Cancelling a queued pause removes its wait. Dropping an acquired guard resumes
  work. The local `waiting_operations()` count is an entry backlog, not proof
  that every writer participates.
- An admitted task that panics or is cancelled sets a checkpoint veto before
  releasing its final lease. A queued task cancelled before entry does not.
  The running gate has no reset for this veto; reload and validate state after
  restart. A normal error return is a completed operation, not an interruption.
- A future timeout/cancel path must retain the pause guard until any blocking
  copy actually stops. Dropping a caller while its blocking copy continues must
  never resume writers against the files being copied.

Owned work can outlive a client request. A client timeout still means an unknown
application outcome; it is not evidence that an accepted write was cancelled.
A stalled handler can delay a pause. The candidate checkpoint controller's
`prepare_with_timeout` refuses after its asynchronous drain deadline, without
interrupting admitted work. Synchronous validation cannot be preempted, and a
late result is also refused. A started blocking copy needs its own cooperative
deadline while retaining its guards until it actually stops.

## Work still required for complete recovery

The gate does not cover arbitrary direct adapter/engine calls, plugin workers,
external processes or writes by an operator. A separate
[coordinated engine/copy boundary](CHECKPOINT_BOUNDARY.md) now holds local commit
windows, inbound ingestion and the projection snapshot writer after application
drain, and owns those guards during blocking I/O. Helper subprocess runtime
files, logs/cache/temp paths, external stores and the complete inventory still
require coordination. The local interruption veto does not make unregistered
blocking I/O or an error-returning partial workflow recoverable.

The current [core live-checkpoint exporter](LIVE_CHECKPOINT_ARCHIVE.md) uses this
pause through the coordinated boundary. Its [operator control](OPERATOR_CHECKPOINT_CONTROL.md)
owns bounded export jobs; neither path reports complete-instance readiness.
Before treating an enabled deployment as recoverable, complete the
[instance inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md):
freeze/drain all relevant database and file writers, record an applied database
position, preserve unknown required files and key/config continuity, encrypt
the full bundle, verify hashes, restore and exercise a matching Authority.
Then prove safe promotion while the source is unavailable, distributed old-node
fencing and reseeding. The current planned stopped-move workflow and local core
restore checks do not establish that unavailable-source protocol. None of
those guarantees follows from acquiring this pause guard alone.

Focused disposable evidence is recorded in
[the dated pause checks](../testing/RUNTIME_OPERATION_PAUSE_2026-09-28.md).
