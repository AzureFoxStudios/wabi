# Recovery material integration: next source slot

**Status:** partially implemented; main Wabi before ERP.
This refines steps 3–5 of the
[geographic master plan](2026-09-26-geographic-community-nodes.md), without
changing its whole-instance, locality, failover or capacity acceptance gates.

The [accepted local byte store](../testing/RECOVERY_MATERIAL_2026-10-01.md)
is the starting point. Keep every writer/readiness verdict false while adding
transport and supported source verification. File/build reservations must be
coordinated with the other chats sharing this checkout.

## October 2 implementation boundary

The signed source-context consumer and separate schema-2 checkpoint byte
store/chunker are implemented. A final local consensus-package run passes
64 checks with no failures; five ignored subprocess entry points are invoked
by their parent checks. See [the exact source and result receipt](../testing/geographic-2026-10-02/source-context-consensus-acceptance.json).
Claims use the actual community P256 identity and a separate signature domain;
allocation knowledge is explicitly unknown. Legacy material manifests remain
separate. Chunk order, whole ciphertext hash, private file identity, quotas,
publication/crash cases and real deadline expiry are checked. Started blocking
publication cannot be preempted: a late result reports failure, retains complete
immutable bytes and needs a fresh durability check. Failed ingestion leaves
valid quota-charged chunks; automatic garbage collection is not implemented.

The separately approved server signer, frozen-source accessor, private sidecar
and operator-only retrieval route now pass focused default server acceptance:
three producer unit checks and sixteen real checkpoint/archive/boundary
integration checks. The actual Authority is reconstructed against the same
community and lock inode before retrieving the original context. See
[the exact focused receipt](../testing/geographic-2026-10-02/producer-focused-acceptance.json).
Existing V2 metadata/export receipts/job schemas are preserved.
The first server compile stopped before tests because subsequent shared
notification hooks referenced an unregistered push module. Their owner has
removed those incomplete hooks, restoring the accepted message source without
adding dependencies. The UI owner released a frozen static frontend. A
test-only HMAC constructor typo stopped the first integration compile before
tests; its log is retained and the corrected same-scope rerun passed. The
first full workspace compile exposed missing test-only snapshot wrapper
imports. Those aliases and the crash-child module root were repaired; all
39 CLI checks passed. Final workspace session 84268 passes 2,663 checks with
no failures and 15 ignored entries; every frozen source/build hash remains
unchanged. The previous security acceptance covers its historical source
snapshot only. See [current workspace receipt](../testing/geographic-2026-10-02/producer-workspace-acceptance.json).

Authenticated checkpoint byte RPC subsequently passed a frozen workspace run
with 2,673 checks and no failures. Its real producer fixture transfers multiple
ordered encrypted chunks, removes one copy and reseeds it over authenticated
loopback sockets. The [physical trial](../testing/PHYSICAL_CHECKPOINT_BYTES_2026-10-02.md)
also transferred the genuine archive to Ronin and Iyoku and reseeded Ronin from
Iyoku, but failed its final restarted-listener request. It is not complete
physical acceptance. See the [byte-RPC contract](2026-10-02-checkpoint-byte-rpc-contract.md)
for the implemented opt-in service and limits.

The next collector now builds an **uncommitted availability proposal** from
actual applied control membership and fresh local/Noise byte receipts. The
full consensus package passes 84 checks with zero failures, including nine
proposal checks; their peer acknowledgments are deliberately synthetic model
fixtures. The separate genuine-producer socket fixture subsequently passed
seven checks with zero failures and all 5,198 source/static hashes unchanged;
see [its focused receipt](../testing/geographic-2026-10-02/availability-producer2.json).
Its control membership is installed through the actual Store application API
as a fixture; it does not commit an availability command through a running
Raft cluster. See the [proposal contract](../architecture/CHECKPOINT_AVAILABILITY_PROPOSAL.md).
Committed byte-majority availability and the supported independent inactive
verification bridge remain subsequent work. Every full-instance, quorum,
source-role and writer verdict remains false. These checks do not activate an
Authority or establish HA.

The isolated October 2 durable-observation package subsequently passed 95
checks, including a real three-node commit with a stopped third endpoint,
purged V2 snapshot catch-up, two reopened-store/actor restarts and six SIGKILL
transaction boundaries. Its separately executed preserved old-reader check
passes V1 membership/snapshot startup and actual V2 format refusal. The later
library-only regression passed 69 checks; its separately executed preserved
reader case also passed a flat legacy command/stored-result positive followed
by V2 refusal. Counts overlap and are not additive. The genuine
encrypted producer fixture now also has source for actual Raft commit/faults
and copied-peer ciphertext reconstruction through the existing inactive-core
verifier. Its first run failed a fresh peer receipt before initial Raft submission;
the fixture-only fresh-service-generation repair subsequently passed
[seven local producer checks](../testing/geographic-2026-10-02/availability-control-producer2.json)
on unchanged inputs. Actual observation/fault behavior and the peer-to-inactive
core bridge are now covered for this one genuine capture. This test bridge does
not complete production wiring for steps 5–7, enabled/external inventory,
canonical writer permission or automatic recovery. See the
[durable-format plan](2026-10-02-checkpoint-availability-control-format.md).

## Ordered work and ownership

### October 3: locally accepted configured control runtime

The narrowly released six-file consensus source now adds a
[configured runtime owner](../deployment/RECOVERY_CONTROL_RUNTIME.md) for
actual Raft/control/material/listener lifecycles, immutable private enrollment,
explicit fixed-roster bootstrap and owned ingest/observation/shutdown jobs.
Its [frozen local run](../testing/geographic-2026-10-02/availability-control-root-runtime1.json)
compiled and passed **103 checks, zero failures and nine ignored entries**
across six serial groups, on 5,193 unchanged Rust/graph/static inputs. Existing
package counts overlap earlier acceptance. Review caught the first source's
Core-versus-background-store shutdown gap before any compilation; the repaired
source retains runtime ownership through every store/IO/snapshot owner and
awaits actual drain on successful and fatal shutdown. Actual blocked IO,
cancelled caller, snapshot lifetime, immediate reopen and original lock/key
inodes are checked. The normal Authority does not start it. Its new checks
use synthetic signed bytes; server capture
publication, the original-operation journal, automatic restart reconciliation
and genuine enabled-instance recovery remain open. This prerequisite leaves
all writer/full-instance permission fields false and changes no WabiDB schema.

### October 3: standalone recovery-node entry point

The narrowly owned five-file server slice adds explicit
`--recovery-node-config` before Authority initialization. It loads a strict,
private bounded operator file, requires preexisting identities and exactly three
trusted voters, preserves enrollment and original lock inodes, and supervises
status output, signal/stdin shutdown and fatal admission. It opens no community
WabiDB and supplies no publisher, restore API or writer activation.
See the [operator contract](../deployment/RECOVERY_CONTROL_RUNTIME.md).

The [frozen local retry](../testing/geographic-2026-10-02/recovery-node-root-standalone2.json)
compiled and passed **six checks, zero failures and zero ignored entries** on
5,196 unchanged inputs: four configuration/lifecycle units and two real-binary
contracts, including three loopback processes draining and reopening the same
keys/locks/enrollment. The other library suites and doctests were excluded.
The preserved first run compiled but failed two private-parent fixtures before
the contract ran. Only those test fixtures changed for the accepted retry;
permission guards remain unchanged. Its existing compiled contract/server were
reused after exact input and artifact verification. This acceptance supplies
an explicit process lifecycle, not complete-instance or geographic recovery.

Next production work must connect the later accepted trusted archive-handle
adapters to a configured publisher retaining source admission and directory
ownership. It also needs a journal saving the original operation before any
publication and the exact prepared consensus command before submission. A timeout cannot justify
a new operation ID or a changed retry fingerprint. A control follower also
needs separately reviewed authenticated forwarding or explicit unavailability;
a remote acknowledgment is not a committed observation. Publication,
reconciliation, retention/reseed, full enabled recovery and every-path writer
and encryption fencing remain open.

### October 3: owned archive-file ingestion prerequisite

The narrowly owned material module/test pair now accepts a trusted caller's
owned `File`, rewinds it, validates private regular current-owner/single-link
metadata and exact signed length before reads, and rechecks original metadata,
digest and deadline before certification. The same bounded chunker serves the
path API, preserving its independent ancestor/name/no-follow/inode guards.
The handle receipt makes no path-name provenance claim. Failed partial chunks
remain quota charged. Schema, dependencies and writer/readiness permissions are
unchanged. See the [caller contract](../deployment/RECOVERY_CONTROL_RUNTIME.md#owned-archive-file-ingestion-prerequisite).

Two source reviews passed. The
[frozen library acceptance](../testing/geographic-2026-10-02/checkpoint-file-root-library1.json)
compiled and passed **82 checks, zero failures and four ignored entries** in
one serial unit group on 5,196 unchanged inputs. Counts overlap the prior
76-check baseline; six new units cover owned-file metadata/offset/hash/budget
and expiry alongside existing checkpoint/legacy/crash/runtime regressions.
Integration/server binaries, doctests, genuine exports and physical uplinks
were excluded. The [review scope](../testing/geographic-2026-10-02/checkpoint-file-source-review1.json)
keeps the timing limit explicit: expiry may precede arrival at the lane wait;
the check proves late-receipt refusal. Metadata changes after reads use a
deterministic cut point; concurrent races and FIFO substitution were inspected.

The later adapter slice below supplies the trusted runtime File entry point
and same-descriptor source accessor. The configured production job must retain
Ready/source admission and directory ownership through actual IO, persist the
original publication operation and exact prepared consensus command before
submission, and reconcile the same operation across restart. Retention/reseed,
full enabled recovery and every-path fencing remain open. This material
primitive supplies no production publisher or automatic recovery.

### October 3: runtime and pinned archive-handle adapters

The exact four-file runtime/source-directory adapter slice is locally accepted.
`ingest_capture_file` shares signed community/expected-source validation,
single-job admission and actual supervised blocking/store lifetime with the
path API, and both inputs recheck runtime roots after success or refusal.
The Linux source accessor returns the same verified held file at offset zero,
with exact bounded digest, original private metadata/name/directory and deadline
checks. Existing wrappers and unsupported-platform refusal remain. Caller
Ready/source admission and directory/name ownership remain obligations after
return; the normal Authority publisher is still unwired. See the
[caller contract](../deployment/RECOVERY_CONTROL_RUNTIME.md#runtime-and-pinned-archive-handle-adapters).

Two independent source reviews and the corrected bounded runner review passed.
The [frozen acceptance](../testing/geographic-2026-10-02/checkpoint-handle-root-libraries1.json)
compiled and passed **91/0/5 across two serial groups**: full consensus units
84/0/4 and filtered server source-directory units 7/0/1. All 5,196 frozen inputs
and both exact test programs stayed unchanged. Counts overlap earlier suites;
six new units are included. Other 478 server units, snapshot CLI, integration
binaries, doctests, genuine producer/publication and physical uplinks were
excluded. The synthetic-byte tests use deterministic post-read mutation/expiry
cut points; they do not add direct File cancellation/lost-root IO or concurrent
mutation/FIFO race acceptance. Owned compiler/runner/controller completion and
absence were independently verified before shared holds were released.

Next: persist original operation identity before publication and the exact
prepared consensus command before submission, with durable restart
reconciliation that never changes an indeterminate operation's fingerprint.
The configured job must retain source admission/directory ownership throughout
actual work. Follower behavior needs authenticated forwarding or explicit
unavailability; fresh ACKs still do not establish commitment. Publication,
retention/reseed, full enabled restore, writer/encryption fencing and automatic
geographic recovery remain open; writer/readiness permissions remain false.

### October 3: owned peer candidate job source

The [operator contract](../deployment/CHECKPOINT_PEER_CANDIDATES.md) describes
new default-off Linux runtime source: approved Noise retrieval of an exact
signed Ready capture, bounded download/inspection and retained private
ciphertext plus an inactive/fenced core tree. Single-job admission, shutdown
drain, pinned scratch cleanup and candidate quotas are wired without changing
existing archive/job/receipt schemas or granting a writer. The repaired
[frozen local run](../testing/geographic-2026-10-02/availability-control-root-peer2.json)
compiled and passed 11 checks with zero failures and one ignored physical-export
entry; all 5,189 inputs stayed unchanged. Automated capture
publication, production consensus ownership, restart reconciliation, enabled
Office/external inventory, nonce fences and full recovery remain open.

Next focused gates for this source slice:

The later two-file Office fixture now has [local saved-state acceptance](../testing/OFFICE_SAVED_STATE_RECOVERY_2026-10-03.md):
the frozen rerun compiled and passed 11 checks with zero failures and one ignored
entry on 5,190 unchanged inputs. Its first schema-refusal failure is preserved.
It seeds genuine HTTP document/sheet/native deck records, appended CRDT deltas,
reviews, grants/revocation, protected cells, capability switches and presentation
audience/questions. The capture keeps both sheets and presentations enabled
after checking intermediate disable/refusal behavior. It also replaces the source router to exercise lost
controller state; that is not a whole-process recovered API test. The retained
candidate is inspected through the existing read-only view, comparing all five
workspace records and decoded content while preserving both guards and the
lock inode. Full recovered API and external-instance acceptance remain open.

1. Frozen two-target compile/direct checks are complete; actual terminal codes,
   artifact/source identities, failed first run and repaired source are retained.
2. Allocated scratch cleanup failure now proves admission closure and restart
   remnant refusal before explicit retirement; ordinary refused peer data permits
   a healthy retry. Dedicated constructor-deadline, worker-interruption and
   mid-publication crash fault runs remain required.
3. Genuine Office source HTTP records and guarded inactive comparison now pass
   for settings, documents/sheets/native slides, deltas, grants/revocation,
   review/protection and a paused presentation with a question. All five saved
   rows and three decoded artifact contents match. Permission-checked restored
   API, a captured active controller in a new process, external conversion and
   asset/configuration recovery still need separate safe checks. Equal stored
   ACL fields do not prove those behaviors; preserve both guards and lock inode.
4. Coordinate and accept production publication/consensus ownership and
   durable restart reconciliation before using these candidates for automatic
   recovery. Retention/deletion and partial-publication retirement require an
   explicit operator policy. Never clear guards merely to make an API fixture
   run against the candidate.

The accepted isolated V2 source has now passed
[guarded adoption into the current root](../testing/geographic-2026-10-02/availability-control-root-adoption-1.json):
all nineteen original/candidate hashes matched, and nonowned source, the current
dependency graph and root revision were preserved. After a temporary idle-slot
handoff during Office's host outage, current-root consensus passed 95 checks
and the actual preserved-reader gate passed separately on the same 539 unchanged
inputs. A subsequent temporary single-build handoff passed
[current-root genuine-producer acceptance](../testing/geographic-2026-10-02/availability-control-root-producer1.json):
seven checks with zero failures and one ignored physical-export entry, on 5,187
unchanged source/graph/static inputs. Compilation and direct timed execution both
exited zero; tests ran without compiler throttling. The slot is released back to
Office. Enabled-state server acceptance and production recovery wiring remain
pending. This adoption adds no recovery job or writer permission.

### Current shared graph: Office recovery coverage

The October 2 [current-source audit](../testing/geographic-2026-10-02/availability-control-office-recovery-audit1.json)
records thirteen unchanged source hashes at root `0b82cec7`. This is an inventory
audit, not restored Office acceptance. The isolated seven-pass producer predates
the merged Office implementation and does not cover its enabled state.

Documents, Sheets and Present persist versioned workspace records through
`workspace_record_replaced_v1` and `workspace_update_appended_v1`. The current
engine registry includes both handlers, and inactive inspection uses that
registry. Recovery acceptance must exercise actual documents, sheet protection,
native slides, reviews, ownership/grants, access revisions, capability switches,
audience editions and presentation questions through a genuine capture, inactive
replay and the restored permission-checked API. Matching raw projection bytes
alone does not prove those API semantics.

Presentation leases and pointers live in memory. Current source pauses an active
session, marks its controller lost and advances its generation after an instance
change. Test that behavior during recovery before enabling clients; do not revive
an old controller lease. Local originals, pending edits, drafts and private
speaker notes remain client-owned and require their separate continuity contract.
The optional converter's environment, credentials and external lifecycle need an
explicit inventory participant; the Authority archive cannot certify them.

Office artifact streams use `workspace:<key>` with no room-owner precondition;
channel association supplies access policy. Future regional ownership must
classify and fence these private objects explicitly. A channel's geographic home
does not automatically make an associated artifact locally owned.

| Step | Required source scope | Acceptance before proceeding |
|---|---|---|
| 1. Supported real source | New bridge module plus narrowly released archive/verifier interfaces | Produce a real V2 encrypted core export through the running operator route; derive its exact ciphertext/inventory/key-context/sequence binding from the supported source receipt, never from client-supplied assertions. Refuse unsupported enabled stores/plugins and inconsistent sequence semantics |
| 2. Chunk the ciphertext | New bridge/chunker and local material tests | Read the pinned export with byte/time/object budgets; 64 KiB transport objects retain their exact order and concatenate to the authenticated source ciphertext SHA. No plaintext extraction or key transmission to storage-only peers. Interrupted work removes only owned scratch; no writer opens |
| 3. Authenticated material RPC | Released existing Noise RPC/server/client files and new material codec/handler tests | Reuse immutable peer/community/partition/roster bindings and existing inbound/outbound limits. Reject helpers, wrong keys, spoofed receipt node IDs, discovered redirects, malformed encodings, oversized manifest/objects and stalled peers before storage mutation |
| 4. Owned storage work | New owned blocking dispatcher plus server integration | Admission, memory/disk permits and store ownership stay held until filesystem work actually completes, even if the client times out or disconnects. Shutdown drains known work. A timeout returns indeterminate, never an invented durability verdict or a duplicate mutation with a new identity |
| 5. Durable byte majority | New availability model and narrowly released consensus command/application | Distinct current fixed-roster voters certify the same exact manifest only after required bytes and manifest are durable. Bind the committed availability operation to manifest, roster/membership, partition, position and exact operation identity. Missing bytes, duplicate voters, wrong contexts and changed-content retries refuse atomically |
| 6. Real inactive verification | New bridge plus narrowly released existing inactive verifier interface | Reassemble selected exact ciphertext, restore only to a private inactive/fenced tree and independently compare supported source history/projections/permissions/denials/uploads/key continuity. No ordinary engine writer open. Missing/corrupt/changed source and unsupported enabled state refuse |
| 7. Failure rehearsal | Existing owned-process harness only after release | Kill before/after each byte and availability publication; cut minority paths; restart stores; remove required bytes; restore from a surviving voter. Recheck current byte availability after loss, not merely old receipt metadata. Record every actual outcome and exact source/artifact receipt |

The next slot must name existing transport/consensus/verifier files explicitly.
A new module, card claim or test-only change does not authorize editing held
files. Root manifest/dependency/lock changes are separate work. Preserve the
existing transport and consensus tests and the historical physical receipts.

## Wire and semantic boundaries

The current transport permits one RPC per authenticated connection and bounds
the complete encoded request. The local store accepts objects up to 1 MiB,
but the first proposed transport uses **one complete 64 KiB object per RPC**.
A bounded canonical hex encoding can use the existing dependency; charge both
decoded and encoded sizes before allocation and keep the total under the
existing RPC cap. This avoids inventing a partially committed object protocol
in the first slice. The final codec choice still needs implementation review
and actual parser/allocation tests; no wire schema is shipped by this document.

Manifest validation currently checks shapes, hashes and ordered checkpoint
bytes. It does not prove that a committed tail contains every required event,
that an inventory describes a complete enabled instance, or that a claimed key
context matches live source keys. Step 1 must supply those supported meanings;
step 6 must independently verify them. Do not fill sequence/key fields with
placeholder hashes or conclude correctness from a successful local receipt.

### Verified source gap before the real bridge

The [read-only boundary audit](../testing/geographic-2026-10-01/material-source-boundary-audit.json)
finds that `LiveArchiveReceipt` and `PausedEngine` expose the applied committed
position, not the highest sequence ever allocated for encryption. The inactive
inspector's `observedHighSequence` is the highest observed on-disk record,
including orphan/skipped records; it is not the highest ever assigned, and it
cannot establish what an unreachable old writer may encrypt after capture.

The current unwired material manifest requires `assignedSequenceHighWater`;
its accepted fixtures use synthetic values. Before a real-source bridge is
implemented, either represent allocation knowledge explicitly as unknown in a
versioned storage-only schema, or coordinate separately reviewed capture of
the exact intended allocation fact. Do not substitute the applied watermark
or the observed-record watermark for that field. Distinguish a supported
inactive replay result from writer/nonce permission regardless of the schema
choice. Existing root key, signing key and protected metadata context must
also have a reviewed canonical binding, rather than an invented digest.

The source's canonical community ID also needs actual verification. Today it
is the SHA-256 of the uncompressed P256 public key derived from the database
root key in `CommunityRosterStore`; it is distinct from node ID and replica
fingerprint. The public archive receipt and protected metadata have no typed
community-ID field. Derive or verify that identity through a narrowly reviewed
read-only supported source interface and compare it to the approved recovery
roster. A real foreign-community archive must fail this check. Do not open a
mutating roster store against an inactive tree merely to obtain the identity.

The Noise session authenticates a peer. A serialized local receipt is not an
independently signed attestation. The first fixed-roster design assumes trusted
fail-stop recovery operators, and must validate receipt provenance inside that
authenticated exchange. Do not silently add a Byzantine-tolerance claim or
allow untrusted bandwidth helpers to enter the voting roster.

A prior two-of-three durability outcome is historical proof for that exact
membership. After a voter loss, at least one surviving original byte copy must
be retrieved and verified; reseed the required surviving majority before any
future serving permit depends on renewed availability. Old metadata alone
cannot prove a returning or rebuilt machine still has the bytes. Membership
change/revocation and retention/garbage collection remain explicit subsequent
contracts; do not use fixed two-of-three arithmetic for an unimplemented
dynamic membership scheme.

## Writer activation remains separate

Even all seven steps passing will not activate Wabi. Whole enabled-instance
support, durable command ordering, every mutation/publication path, encryption
allocation and rollback protection, surviving client discovery and actual
full-server recovery remain necessary. Preserve the
[writer and nonce contract](../architecture/GEOGRAPHIC_WRITER_AUTHORITY.md).
Real regional room owners/selective fanout and capacity/privacy acceptance
follow the master plan. Storage, media or bandwidth volunteering does not
become canonical state ownership by receiving an opaque material object.
