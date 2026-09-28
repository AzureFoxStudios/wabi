# Coordinated checkpoint boundary checks — 2026-09-28

**Scope:** Disposable local main Wabi; working-tree candidate, not deployed.

## Change under check

The internal Authority checkpoint boundary drains registered application work,
then holds local database commit windows and inbound ingestion. Its blocking
file operation saves a projection snapshot and holds that snapshot writer
through the copy. All guards remain owned by the blocking task after its caller
disconnects. See [the implementation contract](../deployment/CHECKPOINT_BOUNDARY.md).

An admitted task that panics or is cancelled after entry sets an in-process
checkpoint veto before releasing its admission. Later checkpoint preparation
refuses. Cancelling queued work or completing with an ordinary error does not
set that flag. A copy panic instead poisons the projection application lock and
prevents another database boundary.

## Direct acceptance cases

### Database and projection tests

- A pause waits for a commit window already preparing, captures its fully
  applied and indexed prefix, and holds a following command unacknowledged.
- Cancelling a queued pause releases its waiting locks; a later write and pause
  can finish.
- The guard retains the engine and its process lock even after the caller drops
  its engine handle. The data can reopen after the guard is released.
- A durable event that fails projection application refuses checkpoint
  preparation and leaves the earlier good snapshot intact.
- An inconsistent applied/indexed position refuses checkpoint preparation.
- A durably fenced receiver pauses inbound ingestion without removing its
  fence, then applies the pending segment after release.
- The snapshot-copy callback holds the projection writer throughout its work.
  Ordinary errors release it; panic poisons it and preserves the last snapshot.

The sequencing fixtures use synthetic unknown events where domain behavior is
not needed. They exercise the real commit/index/dispatch machinery. The
separate failed-application fixture uses a registered event with invalid
payload.

### Main Wabi fixture

The AppState fixture creates real accounts, ownership, recovery codes, session
denials, a retained message, a deleted message and published/revoked files. It
copies its entire data and separately configured uploads roots during the
boundary, including unknown files and empty directories. The known engine
process lock is omitted from the new isolated copy. File paths, sizes and
SHA-256 values are compared before and after copying.

Reopening the copy checks the applied position, account security state, retained
history, deletion and upload denial, readable kept bytes and unknown files.
Both instances remain isolated fixtures with no listening user endpoint.
Resuming a source write checks that the copied history stays independent.

Other fixture cases check a disconnected copy caller, queued database/sidecar
work held until blocking I/O finishes, admitted-worker interruption, refusal to
prepare from inside an admitted operation, ordinary copy failure and copy panic.
A preparation deadline refuses a zero timeout, expires behind held work without
interrupting it, removes its waiting writer so normal admission can proceed,
and allows a later checkpoint after that work completes.

## Results and provenance

The final database run passed **49** checks, including snapshot/dispatcher,
sequencer and write-completion regressions. The final server unit run passed
**43** checks: eleven operation-gate cases and 32 existing state/authentication/
socket checks. The final integration run passed **61** checks across six
targets, including six coordinated-checkpoint fixtures. That is **153 passing
test executions**, with no final failures or ignored cases. Eighteen socket
executions cover nine existing cases through two module paths.

Commands, target counts and source/log hashes are recorded in the
[machine-readable receipt](checkpoint-boundary-2026-09-28/receipt.json).
Builds use repository toolchain 1.93, locked dependencies and disabled
incremental output. Existing compiler warnings remain. The integration runs
used local listener access for the existing loopback webhook fixture; no
production service, firewall or live data was changed.

The new fixture's initial compilation used the wrong integer type for a token
expiry. It was corrected before the first successful integration run. A source
review also corrected the fixture's projection snapshot lookup to the WabiDB
subdirectory. Earlier passing runs are recorded separately; the final totals
count only the final three runs after the implementation was stable.

## Limits

- The fixture copies are plaintext local test artifacts. They are not an
  encrypted live exporter or an operator backup recipe.
- Matching fixture configuration and signing keys are supplied explicitly.
  External secrets, plugin stores, helper processes, logs, caches, temporary
  work and arbitrary unregistered writers still need the complete inventory
  and participant contract.
- These checks do not test unavailable-host promotion, distributed writer
  fencing, automatic failover, independent regional writers or selective
  delivery. The development receiver remains `fullInstanceReady: false`.
- This is local recovery-ordering evidence, not fresh physical-network, native
  desktop, call/media, sustained bandwidth, capacity or privacy acceptance.
- Gate B, C and D and the capacity/privacy gates remain open.

Owned temporary logs and three contract-test executables are removed after
receipt capture under an exclusive Cargo artifact lock. Shared build
dependencies and other tasks' previews are retained; exact cleanup quantities
are in the receipt.
