# Recovery control runtime

**October 3, 2026 — locally accepted library candidate; not deployed.**
Linux only. Main Wabi before ERP. This is a library lifecycle used by an
explicitly configured caller; the normal Authority does not start it, and
there is no new server environment setting, operator HTTP route or deployment.

The runtime owns the actual fixed-roster control store, ciphertext material
store, Raft actor and authenticated listener. It supplies a place to attach the
remaining capture publication and durable job reconciliation work. It does not
open WabiDB, restore a community, clear inactive guards or activate a writer.
All full-instance and writer permission fields remain false.

## Provisioning and enrollment

`RuntimePolicy` is trusted local programmatic input. It names the existing
community/partition/local numeric node binding, exactly three enrolled
`RecoveryPeer` records, the expected string Authority source node, separate
existing private control/material/identity roots, optional explicit local
bind address, existing storage/transport limits and a work deadline up to
30 seconds. Helper tokens and discovered addresses are not enrollment inputs.
Every member here is a trusted control voter; a storage-only helper must use
the separate ciphertext service, not join this roster through the runtime.

The identity must already exist. Paths must be absolute, without symbolic-link
ancestry, private, owned and disjoint. Aliased root inodes are refused. The
runtime takes an exclusive persistent `.runtime.lock` in the control root
and preserves its inode along with the control/material `.lock` files.
Never unlink or chmod an existing lock to admit another owner.

First startup writes `runtime.enrollment.json` durably before opening stores.
It binds the exact roster, local binding, expected source, material/identity
paths and local listen address. First enrollment requires otherwise empty
control/material roots. Existing unmarked stores are refused rather than
implicitly adopted. Subsequent startup requires the exact same record.
Changing JSON does not perform a supported membership change or migration.
A failed or interrupted first record write can leave a partial record;
startup refuses it and leaves it for operator inspection, rather than
regenerating or resetting state.

Set `initialize` only for the first bootstrap on the lowest roster ID.
Followers start with it false. Restart uses it false on every node; a node
with applied state refuses a fresh initialization request. A bound listener
does not mean the applied fixed-roster membership or leader is ready.
Joint/different applied membership refuses startup, and incompatible runtime
membership or a fatal actor/listener closes local admission and drains.

## Owned jobs and shutdown

`ingest_capture` verifies the provisioned community/source signature and uses
the existing exact-hash chunker in an owned blocking job. It receives no
recipient key and performs no decryption. Source role, nonce allocation,
payload encryption and complete-instance coverage are not certified by the
signature. Partial ingestion can leave valid immutable quota-charged objects;
there is no new garbage collection or retention policy here.

`observe_checkpoint` takes an original operation ID and exact manifest. It
uses the existing collector's actual applied membership, fresh local and
authenticated peer checks, V2 capability transition, real Raft commit and
exact control-store readback. Serialized ACKs are not an input. The collector
requires a healthy majority; initial V2 transition additionally requires the
enrolled format checks. A successful observation records historical metadata,
not a lease on current bytes or permission to run Wabi.

Only one local job is admitted. Caller cancellation does not cancel that
owned worker. Panics or critical ownership/worker failures close admission.
Timeout during consensus submission is indeterminate: inspect the original
ID in `control_state`; do not create a different ID to turn a retry green.
The runtime exposes durable records, but the server's pre-publication journal
and automatic restart reconciliation have not been implemented by this module.

Dropping the owner requests supervisor shutdown. Explicit `shutdown` waits
for the listener's admitted work, the local worker and Raft to finish, keeping
stores and locks owned until then. Started filesystem IO is not forcibly
preemptible; the deadline is not a hard process teardown guarantee.

## Acceptance and remaining work

Independent source review found that the initial candidate waited for Raft
Core/ticker shutdown but not every spawned state-machine/snapshot store owner.
The underlying store lock remains safe, but shutdown could return before
immediate restart is possible. The second source candidate attaches a
cycle-free process-local owner lease to the fresh store's internal owner.
Every existing store clone and blocking owner retains that lease. After
closing runtime admission and draining listener/local jobs/Core, the supervisor
waits until only its original store owner remains, including on fatal exits.
The lease is destroyed after the database and original store lock.
Both independent source reviews passed before the accepted run. The first
source snapshot was never compiled or run; it remains preserved separately.

Source includes six runtime unit checks, one store lifetime unit check and one
managed three-node integration check
for refusal/admission/cancellation/shutdown, durable observation, full runtime
reopen, fresh material reads, original lock/key inodes, a two-voter commit and
returning follower catch-up. The [frozen current-root run](../testing/geographic-2026-10-02/availability-control-root-runtime1.json)
compiled successfully and passed **103 checks, zero failures and nine ignored
entries across six serial groups**. Counts include the existing package
regressions and overlap earlier runs; they are not 103 additional runtime tests.
All 5,193 Rust/graph/static inputs stayed unchanged. Compilation used the shared
pinned toolchain/target with half-duty heat control; direct timed tests ran
serially without compiler throttling after artifact/source/cool/disk checks.
The added lifetime checks hold a real snapshot builder across Core
shutdown and cancel a caller during actual blocked transactional IO; they also
check immediate reopen and lease release after the original database lock.
The integration payload is synthetic signed opaque bytes, not a genuine
Wabi export or a physical three-site result.

Required next work remains server capture publication, a persisted original
job identity before publication, partial-publication and restart reconciliation,
retention/reseed policy, genuine enabled-instance acceptance, all writer and
encryption fences, safe activation and the full geographic fault/capacity gates.
See [recovery material integration](../plans/2026-10-01-recovery-material-integration.md)
and [writer authority](../architecture/GEOGRAPHIC_WRITER_AUTHORITY.md).
