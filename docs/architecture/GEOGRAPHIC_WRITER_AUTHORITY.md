# Geographic writer authority: implementation contract

**Recorded:** 2026-09-30
**Status:** Implementation contract for the remaining geographic plan. The
October 1 isolated durable control foundation has local acceptance; canonical
Wabi writer authority and automatic instance recovery remain unimplemented.

## Durable control foundation — October 1

`core/crates/wabi-consensus` pins OpenRaft 0.9.25 and redb 2.6.3. Its actual
transactional store passes the upstream 35-contract storage suite, restart,
snapshot consistency, cancellation and process-kill checks. Three real Raft
nodes with an in-process controlled network pass each-node loss/return, full
restart, majority partition and snapshot catch-up after purge. Exact counts,
provenance and limitations are in the
[acceptance record](../testing/DURABLE_CONSENSUS_2026-10-01.md).

The expanded local run passes 39 checks, adding actual fixed-roster encrypted
TCP and separate-process loss/return, minority refusal/heal, snapshot catch-up,
private bootstrap and configuration/timing checks. A separate real Rust/Python
control-interface run passes exact receipt convergence and supervised follower
SIGKILL/restart with complete owned cleanup. See
[expanded acceptance](../testing/ENCRYPTED_RECOVERY_RPC_2026-10-01.md).

A subsequent [three-computer encrypted coordination trial](../testing/PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md)
passes four durable operations and each owned worker's kill/restart/majority
write/catch-up on dotRonin, Ronin and Iyoku. Exact original receipts, complete
operation-state hashes and original key/store-lock inodes match; all fixtures
were disposed. An actual application-port check found and avoided Iyoku's
rejected random port by using its existing allowed unused private port 3000,
without firewall changes. This is private-overlay metadata coordination and
worker loss, not whole-host loss or Wabi state recovery. A further owned-proxy
physical trial passes minority refusal/heal and metadata snapshot installation
after an actually purged prefix: 32 exact accepted operations, second restart
and complete disposal. Every outcome still refuses Wabi writer permission.

The state machine records bounded, idempotent ownership intents. Its replies
always refuse canonical writer permission. The crate has no WabiDB writer activation
path. A separately approved, default-off server source-metadata producer is
local implementation with focused default server acceptance; combined frozen
workspace acceptance passed 2,663 checks with no failures and unchanged
source/build hashes. It grants no writer permit; 15 ignored entries include
external fixtures that are not claimed accepted.
Fixed-roster authenticated RPC has local and scoped
three-computer acceptance; dynamic enrolled/revoked membership, whole-host and
actual Wabi recovery acceptance remain required before it can serve a
real recovery cluster. Follow the commit/publication and encryption contract
below before adding any engine writer permit.

## Control and data are separate

### Next implementation boundary after physical coordination

The physical trials establish transport and durable **control metadata**. Their
checkpoint fingerprint is a disposable fixture value; no Wabi checkpoint,
committed tail or upload is covered by that acknowledgment. The next source
slice must establish actual recovery-material availability before any activation
work. Keep `canonicalWriterPermitted: false` throughout this slice.

The [local material-store step](../testing/RECOVERY_MATERIAL_2026-10-01.md)
now provides a separately versioned opaque-object manifest and exact durable
byte receipts on one Linux node. Eleven new parent checks, including eight
actual process-kill publication boundaries, pass; the whole isolated package
passes 50 checks on a same-source rerun after one preserved leader-fixture
failure. This does not establish authenticated source semantics, encryption,
required-tail completeness, majority availability or inactive Wabi verification.
All readiness and writer fields remain false. The table below still describes
the complete required integration, rather than completed activation support.

The October 2 [signed checkpoint consumer/storage acceptance](../testing/SIGNED_CHECKPOINT_SOURCE_2026-10-02.md) passes 64 local package checks. Its schema-2 allocation field remains explicitly unknown; only community-signature and exact local byte checks are proven. The real producer/operator route and later authenticated byte RPC passed separate frozen workspace runs with 2,663 and 2,673 checks. The physical ciphertext trial transferred and reseeded genuine bytes but failed its final restarted-listener check. A later [availability proposal collector](CHECKPOINT_AVAILABILITY_PROPOSAL.md) checks actual applied membership and fresh byte receipts, with 84 passing consensus-package checks. It does not log an availability command. Committed byte majority and independent inactive recovery remain open; these counts refer to distinct frozen scopes.

The subsequent **isolated V2 control candidate** does log historical byte
observations through actual Raft. Its [95-check package receipt](../testing/geographic-2026-10-02/availability-control-consensus5.json)
covers opaque test bytes, a healthy two-voter commit after the third actor
stops, purged-log snapshot catch-up and repeated store/actor restart. The
separate [preserved V1-program gate](../testing/geographic-2026-10-02/availability-control-v1-reader3.json)
passes matching V1 startup with a flat legacy command and stored result, then
actual V2 format refusal; its preceding library-only regression passed 69
checks. These overlapping scopes are not additive. The later
[genuine encrypted producer contract](../testing/geographic-2026-10-02/availability-control-producer2.json)
passes seven local checks: actual observation commits, authenticated copied-peer
ciphertext reconstruction, bounded inactive core replay, changed-source/upload
refusals, valid retry, majority/minority behavior and owned scratch cleanup.
The first failed run and fixture-only fresh-service-generation repair are
recorded separately. This proves one local core recovery fixture, not complete
enabled-instance recovery, automatic activation or physical-site failover. See the
[format implementation plan](../plans/2026-10-02-checkpoint-availability-control-format.md)
for the exact source and acceptance boundary. The
[guarded 19-file adoption](../testing/geographic-2026-10-02/availability-control-root-adoption-1.json)
now places that source in the shared checkout while preserving its current
graph and nonowned source. The
[current-root consensus](../testing/geographic-2026-10-02/availability-control-root-consensus1.json)
and [preserved-reader](../testing/geographic-2026-10-02/availability-control-root-v1-reader1.json)
gates now pass on 539 unchanged inputs. The subsequent
[current-root genuine producer](../testing/geographic-2026-10-02/availability-control-root-producer1.json)
passes seven checks with zero failures and one ignored physical-export entry on
5,187 unchanged source/graph/static inputs. Enabled-state acceptance, production
recovery wiring, deployment and writer-admission integration remain unimplemented.
Successful genuine core verification leaves allocation knowledge
unknown and every writer/full-instance permission false until the remaining
contracts below are implemented and accepted.

| Current source boundary | Next concrete work | Required acceptance |
|---|---|---|
| `wabi-consensus/src/model.rs`: `ControlCommand` records an inventory fingerprint; `ControlReply` never grants a writer permit | Add a separately versioned material manifest/receipt binding community, partition, format, applied/committed positions, encryption/key context and every required byte digest. Do not interpret an arbitrary hash as readiness | Missing/corrupt/stale/wrong-community/wrong-key material cannot be certified; a metadata-only intent cannot pass the availability condition |
| `wabi-server/src/instance_archive/verify.rs` and `wabidb/src/engine/offline_inspect.rs`: independent inactive core replay | Connect the actual supported export/restore proof to that manifest. Preserve the core-only support profile; unknown enabled integration state refuses complete-instance readiness | Exact source comparison, complete-history replay, permissions/denials/retention/uploads/key continuity, no ordinary writer opened, source mismatch refused |
| Authenticated bounded archive inbox plus consensus transactional store | Obtain durable required-byte receipts from the selected majority before recording an available material set. Define atomic staged publication, crash cleanup, retention and reseed behavior | Kill before/after file fsync, rename and receipt commit; retry returns the original bound outcome; unavailable majority never reports durable material availability |
| `wabidb/src/sequencer/types.rs`: `CommandCommit` has optional room conditions and only a local `CommandOutcome` | Define an opt-in canonical distributed operation identity and committed position, with deterministic validation/application and explicit global versus room partitions | Every accepted distributed command survives a voter loss; changed-content retries cannot reuse a receipt; absent/unrelated owner conditions cannot bypass admission |
| `wabidb/src/sequencer/mod.rs`: local sequence allocation precedes encryption, segment flush, index flush and projection completion | Establish the distributed ordering/encryption boundary before permitting a second copy to allocate records. Preserve local single-Authority behavior and the one-event-per-stream guard | A paused/unreachable old writer cannot encrypt different bytes under a reused key/nonce, complete stale queued writes, acknowledge or publish after supersession |
| `wabi-server/src/instance_operations.rs` and `instance_checkpoint.rs`: cancellation-safe local pause/copy guards | Add actual distributed commit/publication authority across durable, session-only, upload/sidecar and asynchronous paths. A local pause remains a separate mechanism | Faults after request admission, during blocking work and before response/live push/sidecar publication leave exactly one permitted outcome; caller cancellation does not release ownership early |

The existing AES-GCM record nonce is derived from `commit_seq` under each
stream key (`wabidb/src/crypto/aes_gcm_record.rs`). The sequencer also burns
failed sequences and can leave unindexed encrypted orphan records. Therefore,
the **acknowledged** checkpoint watermark is not sufficient to choose a safe
new encryption sequence on another copy. Nor may a potentially overwritten
uncommitted Raft index simply become the encryption nonce.

Before implementing the writer permit, choose and review either
consensus-committed record allocation/encryption or a versioned
writer/partition key-and-nonce migration. Include transition from an earlier
single-Authority tree, orphan/burned sequence continuity, historical decoding,
rollback refusal and an unreachable earlier writer. Do not hand-edit existing
postcard layouts or silently repurpose the current header's reserved bytes.
Replicated recovery data must retain the intended at-rest protection; placing
ordinary plaintext events in the current unencrypted metadata store would
require a separately reviewed storage design.

The historical security source freeze has been released. Current compiled
source/Cargo reservations are coordinated on the geographic Project card.
This mapping is a
source/design handoff, not implemented writer behavior. It creates no production migration and grants
no activation permission. Source ownership and a serialized acceptance slot
must be explicitly released before the above changes begin.

The initial recovery topology has one community writer and three explicitly
trusted recovery voters. A later regional topology adds independent room
partitions. Helper/volunteer pairing cannot enroll a voter, admit a canonical
writer or disclose recovery keys. Enrollment binds community identity, node
identity, key, role, protocol version and approved endpoints. Revocation and
membership changes themselves require the existing majority.

Use a maintained consensus implementation rather than the legacy heartbeat
coordinator. OpenRaft is the first Rust integration candidate. Its maintained
[storage interfaces](https://docs.rs/openraft/0.9.25/openraft/storage/index.html)
separate log storage and state-machine application. The
[getting-started storage contract](https://docs.rs/openraft/0.9.25/openraft/docs/getting_started/index.html)
requires durability and supplies a storage test suite. Pin an exact compatible
version only after checking repository toolchain/dependencies and exercising
that suite against the actual durable store. An in-memory example is not an
acceptable production store.

Consensus covers writer decisions and committed operations, not just health.
A majority selecting a replacement is insufficient if an isolated former
writer can still finish local commands and acknowledge them. Integrate the
commit path with consensus, or establish a fully specified expiring-authority
mechanism checked at publication with its clock/process-pause assumptions
proven. A pre-request lease check followed by unrestricted local persistence is
insufficient. Default single-node operation stays outside this opt-in mode.

## Durable acknowledgment and recovery

Every distributed write acknowledgment identifies its partition, authority
term/epoch and committed position. A client retry must be bound to its durable
operation identity, not only the current engine's in-memory idempotency table.
A restarted worker replays a committed operation exactly into its existing
application record or returns its previously recorded outcome. A local fsync
without the selected durability policy is not a successful distributed write.

The state machine needs deterministic application, durable applied position,
crash-safe snapshot installation and membership restoration. WabiDB's current
single sequencer and completed-projection acknowledgment are useful components,
but importing an event and advancing a snapshot do not establish consensus.
Sidecar/upload publication must share the distributed outcome. Active calls
and ephemeral messages need explicit behavior when authority changes.

Recovery material includes a verified complete checkpoint plus every required
committed tail and content blob. Reject promotion if any required component is
missing, older, unverified or incompatible. Preserve denials/deletions and
expired content in the canonical current view. Reseed a former writer under a
fence rather than merging its divergent local tail into accepted history.
Manual recovery also needs unreachable-writer safety; merely stopping the
reachable old process cannot satisfy that failure case.

## Encryption and duplicate writers

Current WabiDB record encryption uses a stream key and commit sequence. Copies
with the same keys must never independently encrypt different plaintext at the
same stream/sequence. An unacknowledged stale-writer record can still create
nonce reuse even if clients discard it afterward. This must be resolved before
any distributed promotion, not after detecting two client-visible writers.

The integration must either make record allocation/encryption follow the
consensus-committed ordering, or use a versioned writer/partition key and nonce
scheme with explicit historical decoding and migration. Separate regional
writers cannot share a global stream and allocate unrelated local sequences
under the same key. Account/control streams belong to their defined control
partition; room streams belong to the room partition. Existing postcard and
encryption layouts remain compatible until a reviewed versioned change exists.

## Room locality and permissions

A room partition owns its sequence, retained history, subscriptions and
recovery replicas. A region with two local users delivers locally; a remote
subscriber receives one authorized event copy per destination region, followed
by local fanout. Regional helpers hold only explicitly subscribed/recovery
content. Global member/role changes use a defined permission epoch.

For strict revocation, an owner that cannot confirm its permission authority
stops authorizing affected operations. An optional bounded offline policy would
need a visible maximum revocation delay and cannot claim immediate global
revocation. Likewise, remote synchronous durability adds a WAN round trip;
local acknowledgment with asynchronous disaster recovery exposes a measured
unreplicated loss window. The operator's chosen policy must be enforced and
reported, not inferred from physical proximity.

### Delivery locality and recovery traffic are separate measurements

The three-business-site topology initially has one trusted machine per site.
A two-of-three durable write necessarily waits for at least one other site's
storage acknowledgment. Local subscribers can still receive through their own
room owner, and one regional event copy can replace thousands of WAN client
deliveries. That reduces origin traffic; it does not eliminate recovery traffic
or the WAN round trip of synchronous durability.

| Intended guarantee | Required acknowledgment boundary | WAN-isolated room behavior |
|---|---|---|
| Zero acknowledged tail loss after one voter loss in the three-site topology | Complete operation and required bytes durably accepted by the room's majority, then applied/publication-complete on its serving owner | An isolated single voter cannot acknowledge canonical writes; local reads/drafts follow the explicit permission policy |
| Local acknowledgment with asynchronous offsite recovery | Local durable state; remote recovery watermark and unreplicated bytes/operations shown explicitly | Requires a separately proven authority mechanism and bounded authorization policy; cannot silently continue under the strict-majority policy or promise zero tail loss |
| Local machine-loss protection with distant disaster recovery | A separately configured local durable quorum, with asynchronous offsite replication | Needs additional local machines and its own quorum/authority proof; a single spare laptop at each distant site does not supply this topology |

These are design/acceptance policies, not currently selectable runtime features.
Implement the strict three-voter policy first. Do not add an automatic fallback
from quorum acknowledgment to local acknowledgment when the WAN fails. A UI
message such as "saved locally" must never stand in for a canonical quorum
acknowledgment. Any later asynchronous option must publish its measured RPO,
prove stale-owner exclusion and account for delayed permission revocation.

Record client delivery, authorization/control traffic and recovery replication
separately in the locality tests. A room with no remote subscribers may still
send recovery copies. The "no unrelated region" assertion applies to client
delivery fanout; a claim of completely WAN-independent acknowledged writes
requires the selected local authority/durability topology to actually prove it.

A move captures a verified room prefix, establishes the successor's authority,
redirects subscribers and permanently rejects the predecessor's later epoch.
Catch-up includes membership, retention, edits, deletion and attachment denials.
Per-room failover uses the proven partition authority mechanism; the original
community leader's recovery alone does not protect every regional room owner.

## Required executable scenarios

- Three-node startup and complete restart retain membership, term and applied state.
- Each node loss leaves the required quorum and exactly one accepted writer.
- A one-versus-two partition, delayed/reordered RPCs and a paused old process
  never produce competing acknowledged writes or key/nonce collisions.
- Power/process interruption at log flush, application and snapshot installation
  preserves every previously acknowledged operation under the published policy.
- Returning stale nodes reject writes until verified reseed/catch-up completes.
- Concurrent room owners write distinct partitions; each room's owner failure,
  move, permission change, retention and reconnect are independently verified.
- Clients retain community/account identity and durable pending operation identity
  through entry-point rotation, repeated failure and explicit logout.

These scenarios run first on disposable local processes, then on three actual
uplinks with exact build/network provenance. Capacity testing reports registered
accounts, concurrent sessions, writes, fanout, files and media separately.
