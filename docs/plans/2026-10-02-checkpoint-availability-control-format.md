# Durable checkpoint observation: implementation slice

**Status:** development candidate integrated into `/home/ironin/wabi` at
`0b82cec796061d274b22655d16f24ca29720c7c3`; current-root consensus, preserved-reader
and genuine-producer acceptance pass; affected enabled-state acceptance and
production recovery wiring remain pending.
The accepted isolated source remains preserved in
`/home/ironin/.codex/worktrees/geographic-checkpoint-control/wabi`, based on
`361437d4778b4f4a863fa37c00b40f0449d0eace`. New V2 command, storage, snapshot and collector
submission code passed its focused consensus package on October 2: **95 passed,
zero failed, nine ignored** across six result groups. The separate preserved
V1-reader check now passes actual old-binary positive startup and V2 rollback
refusal. The [guarded 19-file adoption](../testing/geographic-2026-10-02/availability-control-root-adoption-1.json)
passed exact original/candidate hash checks and preserved the current nonowned
source, 645-package dependency graph and root revision. Original owned source is
archived with that receipt. No commit, push, deployment or activation is claimed.
Office's disconnected execution host could not start its reserved build, so the
coordinator temporarily assigned the idle slot to current-root consensus. Its
[actual compile/direct test receipt](../testing/geographic-2026-10-02/availability-control-root-consensus1.json)
passes 95 checks with zero failures and nine ignored across five direct groups;
doctests were excluded. A separate
[actual old-reader check](../testing/geographic-2026-10-02/availability-control-root-v1-reader1.json)
passes the legacy flat command/result positive and V2 refusal on the same 539
unchanged hashes. The fresh temperatures were 45.5°C and 43°C. Timed tests ran
directly without compiler throttling. Both scopes are terminal, and the slot
has returned to Office. A later separately assigned single server build passed
[current-root genuine producer acceptance](../testing/geographic-2026-10-02/availability-control-root-producer1.json):
seven passed, zero failed and one ignored physical-export entry on 5,187 unchanged
source/graph/static inputs. Compilation and direct unthrottled execution both
exited zero; the precheck measured 38.75°C. Its exact source/artifact/log receipts
are preserved. This slot has also returned to Office; no further geographic
compilation has started.

The [package receipt](../testing/geographic-2026-10-02/availability-control-consensus5.json)
records 61 unchanged source/graph inputs and exact executable hashes. The real
three-Raft opaque-payload test passed with the third endpoint and actor stopped;
six SIGKILL transaction boundaries and snapshot mutation checks also passed.
Earlier failed runs remain recorded. The [old-reader receipt](../testing/geographic-2026-10-02/availability-control-v1-reader2.json)
passes the separately executed ignored gate: the exact preserved V1 program
opens the matching V1 membership/snapshot, reports its actual durable position,
and stops successfully. After the atomic V2 upgrade, that same program exits
with its actual format refusal before creating an endpoint; canonical state
and the lock inode remain unchanged. The complete index-zero log prefix fixed
the earlier failed positive fixture; pinned OpenRaft startup requires that prefix.
A further positive-case extension now includes a flat legacy command and its
stored result. The [library-only regression](../testing/geographic-2026-10-02/availability-control-lib6.json)
passed 69 checks with zero failures and four ignored; the separately executed
[actual old-reader extension](../testing/geographic-2026-10-02/availability-control-v1-reader3.json)
passed the legacy log/result positive, then V2 refusal, on the same unchanged
61 source hashes. Counts overlap the earlier package and are not additive.
Fresh post-compilation and reader temperature checks were 46.5°C and 47.375°C;
the timed tests ran separately without throttling. The later source adoption
does not extend these isolated results to the current root. UI packaging released the
slot after actual successful completion and verified artifact copy. The genuine
encrypted Authority producer compiled successfully; its first run failed before
the initial Raft submission. The repaired fixture subsequently passed in the
isolated checkout using its existing target and a link to the accepted root
static assets, avoiding a duplicate frontend build. No new target directory
was created.

The actual Raft regression passed its extension to wait for a
purged V2 log prefix, restart the returning voter from its reopened redb store,
require snapshot-based convergence of both exact checkpoint records, and
repeat its store/actor restart while preserving the advisory lock inode.
That extension is included in the second 95-pass receipt above; the counts are
not additive. It tests metadata recovery, not full Wabi recovery or byte reseed.

The genuine producer fixture has a further **accepted local test** bridge: fetch
the committed capture's manifest and every ordered object from a Noise peer
at node 2 or 3 (which received its bytes from the producer), verify the exact
signed ciphertext digest, and use the existing bounded restore and independent
inactive-core verifier. The private recipient key stays on the verifier. An
owned blocking worker holds its private scratch through restore and all replay
checks, then explicitly removes it. Wrong source digest and changed upload
bytes must refuse; a second valid pass must preserve both inactive guards and
the lock inode. This adds no production job API, enabled/external-state support,
writer activation or physical-site acceptance. The exact 19-source candidate
and unchanged original baselines are recorded in
[progress6](../testing/geographic-2026-10-02/availability-control-progress6.json).

The [first producer receipt](../testing/geographic-2026-10-02/availability-control-producer1.json)
records actual compile exit 0, then test exit 101: six passed, one failed and
one ignored, with all 5,173 inputs unchanged. The failure was node 2's fresh byte
receipt at `checkpoint_rpc.rs:501`, **before** the initial Raft submission; the
first status report incorrectly placed it in the later healthy-majority stage.
The fixture had reused a service clone after listener shutdown permanently
closed that shared generation. The [fixture-only repair](../testing/geographic-2026-10-02/availability-control-progress7.json)
asserts that the old generation still refuses work and creates a fresh service
over the same bound store. It preserves runtime admission, authentication and
quorum checks. The inactive peer verifier was not reached by the failed run.
The [repaired producer receipt](../testing/geographic-2026-10-02/availability-control-producer2.json)
records actual compile and direct-test exit 0: seven passed, zero failed and
one ignored, with 5,173 unchanged inputs. Its executable SHA-256 is
`c259f39c97ee786b07d09fa563a69aaf81a594473d9a641aa8c9e0410001d73c`;
the fresh pre-test temperature was 41.375°C. The closed-generation refusal,
initial exact observation on all three stores, retry identity, inactive copied-peer
verification, altered-source/upload refusals, valid retry, fresh loss/reseed,
healthy-majority commit and minority refusal all ran successfully.

These are overlapping integration checks, not an added package total or a
physical/capacity result. The peer verifier remains a test bridge, and every
canonical-writer/full-instance permission stays false. Complete enabled-state
inventory, incremental tails/blobs, production recovery wiring, distributed
fencing and automatic activation remain required. The same accepted source is
now adopted in the shared checkout after fresh baseline checks; the subsequent
Office graph now has current-root consensus/format and genuine-producer core
acceptance. Its enabled state still requires actual recovery acceptance.

This completes the next implementation specification for step 5 of the
[material integration plan](2026-10-01-recovery-material-integration.md).
It records byte observations through real consensus while continuing to
refuse Wabi activation. It is not the complete failover design.

## Source and compatibility boundary

The existing application data is the flat `model::ControlCommand`; its
operation fingerprints, log JSON, stored outcomes and Python physical workers
already have accepted fixtures. Preserve their serialization exactly. Do not
reuse `checkpoint_inventory_sha256` to hide a different command kind.

| Surface | Required change | Compatibility requirement |
|---|---|---|
| `src/model.rs` and `src/lib.rs` | A typed application-data wrapper for the unchanged legacy command and a separately tagged/versioned checkpoint-observation command | Old flat commands decode and serialize to their original bytes; unknown tags, mixed shapes and duplicate fields refuse |
| New `src/availability_control.rs` | Bounded typed observation command, deterministic application and stored receipt | No plaintext content, decryption keys, nonce allocation or writer capability |
| `src/store.rs` | Version-aware identity, log envelope and applied-state validation; atomic format upgrade | Accept validated V1 stores; old readers must refuse a store after its first V2 record; do not overwrite/unlink advisory locks |
| State/snapshot envelopes | Separate V2 encoding for observation records; explicit V1 decode | Legacy state fields and receipt relationships retain their meaning. Installing/purging snapshots cannot remove the format requirement or operation history |
| `src/transport` and worker tests | Explicit capability/format support for the enrolled peers before V2 submission | Do not assume an old protocol-1 byte responder can replay V2 control commands. Unsupported peers refuse before successful submission |
| `transport/material/availability.rs` | Consume a fresh owned round into the submission path | A saved serialized proposal is not a fresh submission permit |

The upgrade is restricted to explicitly enabled disposable/recovery control
stores. It does not migrate WabiDB or change persistent postcard records.
Keep dependency manifests, pins and lockfile unchanged.

## Command identity and validation

The command must include the immutable signed manifest, its exact canonical
digest, source-context digest and proposal fingerprint; current community and
partition; exact applied membership log position and roster digest; operation
ID; and a bounded, sorted list of distinct voter observations. Each observation
binds its node and exact receipt digest. The manifest supplies ordered object
sizes/hashes, total ciphertext hash, source archive/inventory and applied
position. Never replace these fields with caller-provided readiness booleans.

Submission uses only the existing authenticated receipt collector and opened
store identities. Require at least two of the exact three stable voters. Check
freshness, peer format support and durable byte retention before proposing.
The deterministic state machine checks the command against its **current**
applied membership and covered position, verifies the manifest/source bindings,
strict limits and canonical ordering, and refuses a changed membership or
manifest. It performs no network or filesystem wait inside application.

Noise receipts are authenticated exchanges within the trusted fail-stop peer
model. Receipt digests are not independently signed byte attestations. The
leader's collected evidence is not a Byzantine proof; do not claim one.

Use the existing global operation-ID namespace across both command kinds.
An exact duplicate returns its original committed outcome. Different contents
or a different command kind cannot reuse that ID, even after reopen or snapshot
catch-up. Legacy IDs keep their exact historical meaning and fingerprints;
new IDs are canonical lowercase. Charge the combined operation count and
serialized state bytes against the existing bounded store limits.

## Durable format transition

Keep V1 identity/log/state readers explicit rather than adding permissive
defaults to unknown schemas. The V2 transition must atomically publish its
format requirement with the first V2 log entry, using immediate redb
durability. A crash cannot leave an accepted V2 log behind a V1 identity.
Legacy logs may remain byte-identical in a V2 store. Preserve all votes,
commit positions, membership, old operation receipts and ownership intents.

Snapshot build and installation carry the minimum required control format.
Installing a V1 snapshot into a V2 store must not make that store readable by
an old binary. V2 snapshot import upgrades the identity in the same durable
transaction as its applied state. Unknown versions, inconsistent receipts,
uncovered membership/log positions and conflicting operation histories refuse
before publication. A rollback requires the matching stopped V1 backup; it
cannot discard V2 operations or reinterpret them as ownership intents.

## Byte retention and outcome semantics

Pin the exact manifest and required immutable bytes through submission and
resolution of an indeterminate outcome. Define durable retention before adding
garbage collection or replacement. Do not publish successful availability from
control metadata when required material has disappeared. Partial work remains
quota-charged and has an explicit owned cleanup path.

A successful consensus result certifies a **historical committed observation**
for that manifest, operation and membership. It does not prove all copies are
currently alive. After loss, fetch/hash a surviving original copy, reseed the
required surviving majority and obtain fresh receipts before any renewed
serving decision depends on it. Metadata snapshot catch-up is not byte reseed.

The receipt binds the exact command fingerprint and actual committed log
position. Source-role verification, independent decryption/replay, allocation
knowledge, full-instance readiness and canonical writer permission remain
unproven. No result may enable an Authority or report production HA. There is
no public mutation endpoint or default Authority wiring in this slice.

### Current implementation choices, awaiting acceptance

The candidate preserves flat legacy application data through a typed wrapper
and uses a separately tagged schema-2 observation command. Identity upgrades
and existing snapshot upgrades occur in the same immediate transaction as the
first V2 log publication. Truncating an uncommitted V2 entry cannot downgrade
that identity. Snapshot imports must preserve acknowledged operation records
from both command kinds, including refusals and original retry positions.

`commit_observation` consumes an owned round, probes schema support through
fresh authenticated channels to both other configured peers for the initial
transition, rechecks selected byte observations and membership, and submits
through the actual local Raft. After an accepted observation for that exact
membership is durable, a healthy majority can submit with fresh format checks
on its selected observers; it does not wait for the third node. A changed
roster/membership requires the initial format checks again.
It then compares the durable result against the collector's original opened
control store. A timeout is indeterminate; resolution must inspect the original
operation ID. Format support means code support, not active Raft participation.
The actual consensus result is still required.

MaterialStore retains certified immutable files without automatic garbage
collection or replacement. This is the current retention boundary; deliberate
file loss and offline faults remain possible. Before adding garbage collection,
durable pins and indeterminate-operation resolution must govern retention.
Historical metadata alone never permits serving or reconstructs lost bytes.

The accepted consensus package covers strict parsing, global ID collision and
quota, reopen/snapshot retry identity, sticky format upgrades and transaction
rollback, including the six subprocess kill cases and returning-voter snapshot
checks recorded above.
The genuine encrypted producer fixture adds three actual Raft nodes, original
result retries, unsupported capability-service refusal, loss of a previously
observed copy, majority success with one stopped Raft voter, and minority
refusal with working byte endpoints but stopped peer Raft actors. Six owned
subprocess kill cases cover before/after log/identity, state and snapshot
publication. The repaired genuine producer extension and preserved old-reader
rollback/flat-legacy positive passed within their recorded local scopes.
Production integration and physical acceptance remain required separately.

## Shared Git cleanup and integration handoff

The cleanup chat owns repository consolidation. This geographic chat owns the
candidate paths listed in [progress6](../testing/geographic-2026-10-02/availability-control-progress6.json)
and the geographic documentation, workload scripts and acceptance receipts.
A Project card is bookkeeping; file ownership and build slots require explicit
coordination between the chats.

| Location | Preserve during cleanup | Integration rule |
|---|---|---|
| Root checkout | The two accepted baseline test patches in `transport/material/availability/tests.rs` and `tests/fixtures/checkpoint_rpc.rs`, geographic docs/scripts, and tracked or untracked compressed evidence | Keep other chats' changes; do not replace these files with the isolated V2 versions before acceptance |
| Isolated geographic checkout | All 19 candidate paths and their dirty/untracked contents | Retain this checkout until the candidate is accepted and its changes are integrated; a detached base does not mean it is disposable |
| Shared build inputs | The active owner's Rust/graph sources and accepted static frontend | Wait for actual compiler termination and explicit artifact-copy release before reconciliation or the next compile |
| Temporary test inputs | The preserved V1 reader and encrypted field export still needed by pending gates | Keep out of Git; remove only after the corresponding gate and exact ownership/hash checks |
| Build outputs | One shared target directory | Coordinate deletion with artifact owners; an old filename alone does not establish that an executable is unused |

The October 2 readback found root `636f133b971288577cd402a8c71bfeb31772790a`,
`origin/main` `f9e19e160048e418daafabc5f606144a502f417d`, and isolated base
`361437d4778b4f4a863fa37c00b40f0449d0eace`. All 19 candidate hashes and their
original baseline hashes still matched progress6. These are a dated handoff,
not permission to assume that a later checkout has the same inputs.

After build release, run the strengthened consensus library and actual
preserved-reader checks, then the genuine encrypted producer/peer verifier.
Before copyback, compare current root/main changes against the baseline for
every owned file and compare nonowned Rust/graph inputs. Resolve overlaps with
their owners, preserve both edits, and rerun affected acceptance on the final
integrated source. Record its exact revision and receipt hashes. Integration,
push, deployment and runtime acceptance are distinct results.

## Required acceptance

1. Golden V1 command/log/state fixtures keep the original JSON and Python
   fingerprint. Reopen existing V1 stores; preserve acknowledged old outcomes.
   Old readers refuse V2 identities/logs/snapshots. Unsupported capabilities
   prevent submission.
2. Actual three-voter Raft commits one genuine producer checkpoint observation.
   Verify the exact operation/manifest/roster/position on every applied store;
   metadata-only ownership commands never satisfy it.
3. Duplicate retry returns the original result. Changed contents, cross-kind ID
   collision, foreign source/partition, changed membership, duplicate/nonvoter
   observations, malformed signatures and limit exhaustion refuse atomically.
4. Kill before/after V2 identity/log/state/snapshot publication. Resolve the
   original operation after restart; do not infer success from a client timeout.
   Purge logs, install a snapshot on a lost follower and recheck original outcomes.
5. Partition one versus two voters: the minority cannot commit. Lose actual
   required bytes after an earlier observation; fresh checks refuse, and a new
   surviving-majority observation needs real reseed and fresh authenticated reads.
6. Run the pinned offline package and actual producer contracts under one
   exclusive Cargo slot, unchanged source/static hashes and exact executable
   readback. Repeat physical transfer/restart with complete owned cleanup.

Independent inactive Wabi verification and every-path publication/encryption
fencing follow this slice. Automatic Wabi recovery and geographic room owners
remain the separate gates in the master plan.
