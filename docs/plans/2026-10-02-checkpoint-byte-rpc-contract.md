# Checkpoint byte RPC: next compiled slice

**Status:** compiled local candidate after the explicit UI build-slot release.
Transport-focused session 65781 passed 20 tests; whole-consensus session 99493
passed 73 tests with zero failures and five ignored fixtures. These are distinct
source receipts, not additive counts. Six real Authority producer/operator checks passed after correcting only an
unregistered test-upload fixture. The fresh frozen workspace session 47619
passed **2,673 checks, zero failures, 15 ignored entries across 88 groups**.
All 5,165 workspace source/embedded inputs and 17 explicitly labeled unrelated
preexisting generated snippets matched their before-launch hashes. Physical
three-site transfer, byte-quorum commitment and activation remain open.
This continues the [recovery material integration plan](2026-10-01-recovery-material-integration.md).
It does not enable another Authority, automatic promotion or regional writes.

## Source slot

After the current producer/workspace acceptance receipt and build handoff,
reserve `wabi-consensus/src/transport/{mod,rpc,server,material}.rs`, their tests,
and narrow read-only accessors in `material.rs` and `material/checkpoint.rs`.
Preserve the fixed-roster Noise handshake, existing Raft requests, limits,
writer command model and durable control store. No dependency additions are
needed for this slice. Do not modify these sources during the current freeze.

The original two-file draft was unreferenced during the earlier producer
workspace acceptance. This new slice wires it into the transport, adds a strict
remote client and read-only store accessors, and retains an explicit Linux-only
opt-in. `serve` remains Raft-only; `serve_with_material` opts in alongside Raft;
`serve_checkpoint` serves only recovery copies and refuses Raft calls. None is
automatically enabled by normal Authority startup. The new sources require their
own acceptance; the earlier 2,663-test source3 result does not cover them.

## Configuration admission

- A material-enabled listener must compare the **actual immutable disk-store
  binding** with its transport configuration: community, partition and local
  voter ID. A separately supplied duplicate binding is insufficient.
- The expected source node and community are operator-approved configuration,
  not request-selected identity. Source signatures prove historical capture;
  they do not prove present source role or ownership of a writer lease.
- Reuse the exact three-voter public-key roster. Account/JWT/operator HTTP
  credentials, a helper role and an advertised reachable IP cannot enter it.
- The old Raft-only `serve` API remains compatible and refuses material
  requests. Add an explicit material-enabled entry point, default off, whose
  shutdown drains its owned storage worker.

## One bounded request per authenticated connection

| Request | Server action | Required reply validation |
|---|---|---|
| Put checkpoint object | Verify complete canonical hex, kind, exact length and SHA; durably store at most 64 KiB | Exact requested object reference, authenticated target voter |
| Certify checkpoint | Verify source signature, partition, ordered required bytes and whole ciphertext; durably publish separate schema-2 manifest | Exact manifest/context/archive/inventory/position/count/bytes and target voter |
| Fresh checkpoint receipt | Recheck persisted manifest and every required byte now | Same exact bindings; an earlier receipt alone cannot substitute |
| Read checkpoint manifest | Bounded canonical read, exact content ID and supported source binding | Recompute manifest SHA, validate signature and configured source identity |
| Read checkpoint object | Pinned private-file identity and exact digest/size | Exact requested reference and decoded bytes before storing locally |

The read operations are required for recovery/reseeding; upload-only delivery
is not sufficient. Charge complete encoded request/response and decoded object
budgets. Keep the existing total RPC cap and fixed one-request protocol. Reject
duplicate/unknown fields, invalid encodings, oversized arrays and noncanonical
hashes. Filesystem paths and raw internal errors never appear on the wire.

## Receipt provenance and truth

`LocalCheckpointReceipt` remains locally constructed and Serialize-only.
Decode remote replies into a separate strict wire representation. Construct an
immutable authenticated-peer acknowledgment only after matching the live Noise
connection's target ID and every requested manifest field. Do not deserialize
remote JSON directly into a trusted local receipt or permit structure.

Require schema 2, `local_signed_checkpoint_bytes_only`, exact configured
community/partition, exact manifest and signed context SHA, ciphertext and
inventory SHA, applied position, required object count and byte count,
allocation `unknown`, and verified community signature. Source-role, payload
encryption, inactive replay, quorum, full-instance and writer flags must remain
false in this slice. A dishonest approved voter remains outside the fail-stop
trust model; this is not Byzantine quorum proof.

## Ownership, deadlines and shutdown

The admitted blocking closure owns its store clone, memory/disk admission and
completion guard until actual synchronous work returns. Caller cancellation,
RPC timeout and connection abort cannot release these early or detach a
descendant writer. Closing refuses new work and drains already admitted work
before reporting completion. A started filesystem syscall cannot be promised
to stop at a wall-clock deadline; report timeout/indeterminate and retain its
ownership until completion.

A retry uses the same object or manifest content identity. A timeout never
invents a success acknowledgment, a new mutation identity or an availability
vote. Immutable completed bytes may remain after caller cancellation; a fresh
readback is necessary before relying on them.

## Acceptance

1. Strict codec/remote-reply tests reject extra fields, wrong voter, changed
   content/context/position/count/bytes and fabricated readiness flags.
2. Configuration refuses actual disk-store/community/partition/voter mismatch
   before listening or mutating storage.
3. Real authenticated sockets transfer an actual encrypted producer archive,
   certify it and retrieve/reseed it with independently verified byte hashes.
4. Wrong keys/roster/helpers/redirects, missing or corrupt bytes, budgets,
   stalled peers and post-success corruption refuse without invented proof.
5. Aborted request, timed-out connection, shutdown and blocking-worker panic
   retain permits/store ownership and drain; exact lock inode remains intact.
6. Repeat existing Raft/loss/snapshot tests and frozen workspace acceptance.
   Then run disposable physical three-site transfer/loss/reseed with exact
   source and executable hashes and complete owned-process/scratch cleanup.

## Subsequent gates

This first store supports at most 1024 ordered 64 KiB objects, so a checkpoint
is limited to 64 MiB logical ciphertext even with a larger disk quota.
Hierarchical/segmented manifests, incremental committed tail and blob delivery,
permission-aware retention/expiry/GC and bounded reseeding are required before
large-community capacity acceptance. Complete snapshots per chat message would
not satisfy the intended bandwidth design.

Distinct current voters must subsequently certify and commit availability for
the exact same operation/material under reviewed consensus application rules.
That change is a separate source slot and format contract; this RPC adds no
control-store commands. Supported independent inactive verification, complete
enabled-instance inventory and safe encryption allocation/writer fencing remain
necessary before activation. Automatic client recovery and regional room
ownership/selective fanout remain in the master plan.
