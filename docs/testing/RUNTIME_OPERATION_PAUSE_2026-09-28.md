# Runtime operation pause checks — 2026-09-28

**Scope:** Disposable local main Wabi; working-tree candidate, not deployed.

## Change under check

Participating handlers and background mutation passes now share one local
operation-admission gate. Nested work reuses its lease; owned HTTP/Socket.IO
execution and account workers retain admission after caller cancellation.
A pause drains these participants and holds new work until its guard drops.
See [the implementation contract](../deployment/RUNTIME_OPERATION_PAUSE.md).

## Direct acceptance cases

- Real `/auth/logout` remains pending during a held pause, without advancing the
  database commit position or publishing a token denial. After release it
  succeeds, makes one canonical commit and remains revoked after restart.
- A real `/auth/recover` worker held at the code-map boundary prevents a queued
  pause from completing after the HTTP caller is aborted. Releasing that worker
  produces one commit with consumed code, restored owner and global session
  cutoff; the memory view agrees before the pause completes and after replay.
- A separate actual HTTP handler with no account subworker remains admitted
  after its caller is aborted. It creates a WabiDB user only after its controlled
  boundary is released; the pause drains that write and the record replays.
- A real Socket.IO message reaches its callback through Engine.IO while the API
  middleware is bypassed in the fixture. The callback waits during the pause
  without a durable row or session-cache entry. On release, the sender receives
  acceptance, the recipient receives the same ID and exactly one row is saved.

Unit cases separately cover drain/resume, nested work with a waiting pause,
owned workers and callbacks surviving cancellation, cancellation of a queued
pause, cancellation bookkeeping for queued work, refusal to pause from inside
an admitted operation, and isolation between two instance gates.

The broader contracts exercise setup, roles, authentication/revocations,
ownership/code recovery, payments and committed/failed/Live chat delivery.
They preserve existing auth and permission assertions.

## Result and provenance

The final integration run passed **78** checks across seven contract targets.
The final combined unit regression run passed **40** checks: eight admission
cases and 32 existing state/authentication/socket checks. That is **118 passing
test executions**, with no final failures. Eighteen socket executions cover
nine existing cases through two module paths. Commands, counts and source/log
hashes are recorded in the
[machine-readable receipt](runtime-operation-pause-2026-09-28/receipt.json).
All builds use the repository toolchain, locked dependencies and disabled
incremental output. Existing compiler warnings remain.

An initial sandboxed integration run passed 68 checks and failed one existing
webhook fixture because binding its loopback listener returned permission
denied. The full integration suite was rerun successfully with local listener
access; this changed no production service, firewall or data. One existing
ignored subprocess fixture remains ignored in the integration target.

## Limits

- This is local handler/gate evidence, not a fresh physical network, native
  desktop, media, bandwidth, load or privacy acceptance run.
- Background-loop registration was audited in source; their every timed pass
  and cancellation/failure mode was not individually exercised here.
- Arbitrary direct database calls, plugin/external writers, engine-internal
  coordination, blocking-I/O failure health and the complete file inventory
  still need a checkpoint contract.
- No encrypted live bundle, unavailable-source restore/promotion, majority
  fencing, automatic failover or independent regional writer was enabled.
- Gate B, C and D and the capacity/privacy gates remain open. The development
  receiver still cannot report full-instance recovery readiness.

Temporary logs and owned account test executables are removed after receipt
capture under an exclusive Cargo artifact lock. Shared dependencies, binaries
and other tasks' live previews are retained; cleanup details are in the receipt.
