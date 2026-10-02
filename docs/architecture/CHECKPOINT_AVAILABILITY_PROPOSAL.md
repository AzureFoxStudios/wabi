# Checkpoint availability proposal

**Status:** experimental collection and opt-in durable historical observation;
current-root local acceptance passes, production recovery wiring remains open.
October 2, 2026.

This is a prerequisite for step 5 of the
[recovery material integration plan](../plans/2026-10-01-recovery-material-integration.md).
The collector can finish with an uncommitted proposal or submit a separate V2
historical observation through real Raft. V1 decoding is retained; writing V2
upgrades the control store and requires matching readers afterward. Neither path
activates Wabi or certifies current byte availability. See the
[control-format contract](../plans/2026-10-02-checkpoint-availability-control-format.md).

## Actual collection boundary

`CheckpointAvailabilityRound` takes the opened control Store, the opened
MaterialService, an immutable signed checkpoint manifest and the fixed
authenticated Config. Their actual community, partition and node bindings
must agree. Applied membership must contain exactly the configured three
voters and peer records, with one stable voter set and a covered membership
log position. Joint membership, learners, uninitialized membership and a
different applied membership position refuse collection.

Every public refresh performs its own read. A local refresh uses the existing
MaterialService's owned IO admission and hashes the complete required local
bytes. A remote refresh invokes `CheckpointClient::fresh_receipt` over the
configured peer's authenticated Noise connection and validates the exact
manifest and source context. The public collector cannot deserialize an ACK
or accept an arbitrary caller-supplied voter list. Unit tests have a separate
test-only synthetic ACK constructor; it is not network acceptance.

The operation ID is canonical lowercase hexadecimal and cannot already be
present in either the applied legacy-operation or checkpoint-observation table.
Collection has one aggregate
deadline of at most 30 seconds, including control reads. Membership and
operation identity are checked before and after refresh and at finish. A
refresh removes that node's earlier success before attempting a new check;
failure cannot leave a previously successful observation counted as fresh.
Duplicate observations never count as additional voters.

Finish requires at least two distinct current voters. The immutable,
Serialize-only proposal binds the operation, community/partition, membership
log position and roster digest, exact manifest/source/archive/inventory hashes,
applied source position, required byte/object counts and observed receipt hashes.
It has a separate proposal hash domain. Allocation knowledge remains unknown.

## What the result means

These are bounded historical observations of durable byte copies. They are
not an atomic assertion that all copies still exist at finish. A computer can
fail immediately after its receipt, and a proposal can be retained in memory
after its collection deadline. The result itself is not a submission permit.

For a finished proposal, `committed`, `sourceRoleVerified`, `payloadEncryptionVerified`,
`inactiveReplayVerified`, `quorumAvailable`, `fullInstanceReady` and
`canonicalWriterPermitted` are all false. Proposal collection leaves durable
control state unchanged. Normal Authority startup does not enable this service
automatically.

`commit_observation` instead consumes the live round, rechecks its applied
membership and original operation identity, refreshes its selected byte copies,
and submits a strict versioned command through the actual local Raft. The initial
V2 transition probes all three enrolled control formats; after an accepted V2
observation under that membership, a healthy majority can proceed without the
third endpoint. Durable application checks the exact roster, membership position,
command fingerprint and shared operation-ID namespace. Changed-content retries
and legacy/checkpoint collisions refuse. V2 is sticky across reopen and snapshot
installation, and older readers refuse the upgraded store before serving.

The resulting receipt reports `metadataCommitted: true` and the actual committed
log position. `quorumAvailable`, `fullInstanceReady` and
`canonicalWriterPermitted` remain false. This records a historical observation;
it supplies no byte-retention lease or current serving permission. A submission
timeout is indeterminate until the original operation ID is inspected; creating
a new operation ID is not a safe retry.

The current trust model is explicitly enrolled fail-stop recovery operators.
Transport authentication establishes which peer answered; it is not independent
signed byte attestation or Byzantine fault tolerance. Bandwidth volunteers and
media helpers cannot become voters through collection.

## Implemented format and remaining integration

The [control-format slice](../plans/2026-10-02-checkpoint-availability-control-format.md)
maps the existing command/store/snapshot/transport changes and their compatibility
and fault acceptance. Its isolated V2 consensus package passed 95 checks with
zero failures, including actual three-node commit with a stopped third endpoint,
purged V2 snapshot catch-up and two reopened-store/actor restarts, and six SIGKILL
transaction boundaries. The separate preserved old-reader gate now passes V1
membership/snapshot startup and actual V2 rollback refusal. After guarded source
adoption, current-root consensus passes 95 checks on 539 unchanged inputs, and
the actual preserved old program separately passes a flat legacy command/result
positive followed by V2 refusal on that same freeze. Current-root genuine
encrypted Authority producer acceptance also passes seven checks on 5,187
unchanged source/graph/static inputs. Its copied-peer inactive core bridge remains
a test fixture, not a production recovery API. No V2 deployment, complete Office
recovery, automatic failover or activation is claimed.

1. **Implemented and locally accepted:** a versioned command/state/snapshot
   envelope, legacy decoding, sticky upgrade and actual old-reader refusal;
   existing metadata fingerprints and the global operation-ID namespace are
   preserved. Ownership-intent inventory hashes are not byte certificates.
2. **Implemented and locally accepted:** fresh owned-round submission and
   membership/context/identity/deadline checks, with exact durable fingerprints
   and changed-content retry refusal. Production job wiring remains required.
3. **Remaining:** define required-byte retention and pinning through submission and
   application. A historical receipt must not override missing bytes, replacement
   of a material store or a revoked/moved voter. No metadata snapshot may silently
   create a byte-availability verdict.
4. **Local acceptance passes:** actual consensus commit, reopen, snapshot installation after purge,
   operation collisions, quotas and kills around each transaction/publication
   boundary, minority refusal and timed-out operation handling. These scoped
   metadata/core fixtures do not prove full Wabi recovery under host failure.
5. **Local genuine-core fixture passes; production/physical gates remain:**
   after loss, retrieve and hash at least one surviving original copy, reseed
   the required surviving majority and obtain fresh receipts before renewed
   serving permission can depend on the data. Physical copy/restart acceptance
   remains incomplete. The accepted independent inactive-core verification is
   narrower than enabled-instance recovery and restored permission-checked APIs.

Even that integration will not grant canonical writer permission. Complete
enabled-instance inventories, distributed publication fencing, safe encryption
allocation and old-writer retirement still follow the
[writer authority contract](GEOGRAPHIC_WRITER_AUTHORITY.md).

## Current-root evidence

The [current-root consensus receipt](../testing/geographic-2026-10-02/availability-control-root-consensus1.json)
records actual compilation and direct execution exits zero, 95 passed, zero
failed and nine ignored across five direct result groups; doctests were excluded.
All 539 Rust/graph hashes stayed unchanged. The separate
[actual old-reader receipt](../testing/geographic-2026-10-02/availability-control-root-v1-reader1.json)
passes the flat legacy command/result positive and V2 refusal on the same inputs.

The [current-root genuine producer receipt](../testing/geographic-2026-10-02/availability-control-root-producer1.json)
records actual compilation and direct execution exits zero, seven passed, zero
failed and one ignored physical-export entry. All 5,187 source/graph/static hashes
stayed unchanged. It exercises real encrypted capture, three-node Raft/Noise,
byte loss/refusal/reseed, healthy-majority/minority behavior and copied-peer
inactive core verification with source/upload negative cases. Timed tests ran
directly without compiler throttling. Enabled Office state, production recovery
jobs, physical-site acceptance, full recovery and writer activation remain open.
These scopes overlap; their counts are not additive.

## Earlier collection evidence

The [full consensus receipt](../testing/geographic-2026-10-02/availability-proposal-consensus2.json)
records actual exit 0, 84 passing checks, zero failures, seven ignored fixture
entry points and all 33 before-run input hashes unchanged at readback. Nine
new proposal checks cover distinct voters, local corruption, expiry, current
membership, invalid contexts, operation reuse and foreign ACK bindings.
They use synthetic peer ACKs and do not establish genuine peer bytes.

The [readiness guard receipt](../testing/geographic-2026-10-02/checkpoint-readiness1.json)
records 13 Python checks. Complete-line parsing refuses duplicate fields,
duplicate readiness markers, changed identities and partial records. It
prepares a physical retry; it is not proof that the retry ran.

The later [15-check guard receipt](../testing/geographic-2026-10-02/checkpoint-readiness2.json)
also covers explicit local-only routing and distinct-node/tool cleanup. The
[local three-process rehearsal](../testing/geographic-2026-10-02/checkpoint-local1-readback.json)
passed all 15 transfer/loss/reseed/restart steps with genuine encrypted bytes
and removed all six directories. It used no SSH and is not physical acceptance.

The [focused genuine-producer receipt](../testing/geographic-2026-10-02/availability-producer2.json)
records session 84321, actual exit 0, seven passing checks, zero failures and
one ignored explicit exporter entry point. All 5,198 before-run Rust/Cargo/
toolchain/static hashes remained unchanged. Its three authenticated loopback
endpoints hold real encrypted capture bytes. A local plus node-2 proposal
succeeds; stopping node 2 makes its fresh recheck fail and removes its old
observation; a fresh node-3 receipt supplies a new proposal. Control operation
and intent tables are not changed by collection. The fixture directly applies
membership through the actual durable Store API; no availability command is
committed through a running Raft cluster. Default-off route/authentication,
operator capture and Authority reconstruction checks remain included.

The earlier producer run also passed seven checks but its shared embedded
frontend changed during compilation. Its preserved receipt explicitly refuses
coherent frozen-build acceptance. The later exclusive rerun above supplies
that focused acceptance; neither run is a fresh full-workspace or UI rendering
result.
