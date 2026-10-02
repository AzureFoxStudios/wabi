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

Authenticated checkpoint byte RPC, committed byte-majority availability and
the supported independent inactive-verification bridge remain subsequent
work. Every full-instance, quorum, source-role and writer verdict remains
false; these local checks do not activate an Authority or establish HA.
The [next byte-RPC contract](2026-10-02-checkpoint-byte-rpc-contract.md)
specifies the separate source slot and transport acceptance.

## Ordered work and ownership

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
