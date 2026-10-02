# Peer checkpoint candidates

**October 3, 2026: locally accepted development candidate; not deployed.**
Linux only, default off, main Wabi before ERP. The operator job retrieves an
already published peer copy of an existing local Ready Authority capture,
checks its exact signed source and ciphertext, and retains an independently
inspected inactive core candidate. It does not publish captures automatically,
start a production Raft cluster, activate a writer or recover after losing the
current Authority.

## Startup

Enable the existing checkpoint exporter and signed-source option first; see
[checkpoint boundary](CHECKPOINT_BOUNDARY.md). Set
`WABI_CHECKPOINT_PEER_VERIFY_CONFIG` to an absolute private JSON file. Missing
configuration disables these jobs; invalid explicit configuration refuses
startup. Scratch must be empty: unresolved entries from a prior owner require
explicit operator inspection/retirement, never automatic deletion. The strict
camelCase policy uses:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `binding` | Existing control community ID, partition ID, local numeric node ID |
| `peers` | Exactly three canonical numeric-string IDs with existing `RecoveryPeer` fields; distinct enrolled keys/sites/endpoints |
| `identityDirectory` | Preexisting local Noise identity; no implicit generation |
| `recipientIdentityFile` | Private local age X25519 identity for the capture |
| `scratchDirectory`, `candidateDirectory` | Separate existing private roots on the same filesystem, outside live data/uploads |
| `maxCandidates` | 1–128 retained/staging directories |
| `maxCandidateBytes` | Total retained file bytes, at most 1 GiB |
| `maxCiphertextBytes`, `maxPlaintextBytes` | Positive, each at most 64 MiB |
| `maxEntries` | 4–10,000 per restored inventory |
| `minFreeBytes` | Positive free-space reserve |
| `timeoutSeconds` | 1–300 aggregate job deadline |

Use existing operator provisioning for identities/enrollment; arbitrary JSON
entries are not a membership change. The numeric control node and string
Authority node ID have different roles. The signed capture must match the
actual Authority/community identity. Input files must be owned, private,
regular, single-linked and bounded; directories must be owned/private without
symlink ancestry. Candidate storage takes an exclusive advisory lock on its
persistent `.lock`: never unlink it. Startup reserves space for a worst-case
ciphertext/plaintext pair, metadata and free-space floor. This job does not
implement large-instance segmentation.

## Requests and ownership

`GET /api/operator/checkpoints/peer-verifications` reports enabled/admission
state and the latest 16 jobs. `POST` accepts exactly `captureJobId`,
`peerNodeId` and `manifestSha256` (64 lowercase hexadecimal characters).
Both require existing loopback/operator-secret checks and return
`Cache-Control: no-store, private`. Requests cannot select keys, paths, peer
addresses, receipts or writer permissions. Persisted Ready job, source,
archive and receipt are rechecked. The enrolled peer must already contain the
exact manifest/ciphertext; a fresh authenticated byte check precedes download.
Whole ciphertext hash and independent inactive verification must also match.

Only one job owns network/filesystem work: concurrent POST returns 409,
disabled/stopping admission 503, invalid binding 400 and unavailable Ready
source 404. Extra fields are rejected by the JSON decoder. Caller completion
does not cancel the worker. Shutdown closes admission and drains actual work.
Started blocking IO is not preemptible: deadline failure is reported after it
drains, so this is not a hard teardown-time guarantee.
Construction/cleanup failures, interrupted workers and uncertain scratch
ownership close admission. A late successful scratch allocation is explicitly
closed and checked before returning deadline failure; it is not discarded
through unchecked temporary-directory cleanup. A normal refused peer result
with successful cleanup can still permit a healthy retry.

## Retained candidates

Runtime status lasts for the `current_process`, not durable recovery
coordination. Successful `core_verified` jobs name a candidate containing
`candidate.json`, encrypted `capture.age` and private `inactive/`. The temporary
recipient identity is removed before publication and is never sent to peers.
Both inactive guard markers remain. The retained tree includes plaintext;
protect it like a backup. Every job/record keeps `fullInstanceReady` and
`canonicalWriterPermitted` false.
The job creates only an absent, newly restored inactive engine `.lock` with
private permissions before verification. Existing locks are refused and that
new inode is preserved through inspection, retention and repeat inspection.

The first frozen run compiled successfully; existing checkpoint checks passed
7/0/1, while the new job target passed two and failed publication. Its verifier
had created the excluded process lock with default permissions, and candidate
privacy checks correctly refused it. The repaired [frozen two-target run](../testing/geographic-2026-10-02/availability-control-root-peer2.json)
compiled and passed 11 checks with zero failures and one ignored physical-export
entry. All 5,189 source/graph/static inputs stayed unchanged. Four new checks
cover authentication/default-off behavior, genuine capture retrieval with
busy/refusal/healthy retry and shutdown drain, private policy/quotas/ownership,
and an allocated scratch cleanup failure that closes admission before shutdown.
That failure also leaves an inspectable fenced candidate and refuses restart
until its owned scratch remnant is explicitly retired. The lock inode survives
repeat inactive inspection. The permission fault ran as an unprivileged Linux
user. Constructor deadline, worker panic and mid-publication process crashes
have not each received a dedicated fault run in this target. The failed first
run and both exact source snapshots remain preserved separately.

Publication syncs files/directories before same-filesystem atomic rename. A
failed or late result may leave `.staging-<job-id>` or a final `<job-id>` even
when status reports failure. `candidate_publication_indeterminate` requires
inspection of the original job ID/record and preservation of its fenced tree;
it grants no activation permission. Both staging/completed trees consume quota.
Foreign entries/changed shapes refuse further admission. There is no automatic
GC or durable restart reconciliation. With the owner fully stopped, inventory
and explicitly retire only owned candidates, preserving needed backups and
the persistent `.lock`. Scratch cleanup precedes admission release.

These are historical proofs for one core capture, not a live byte majority,
nonce-allocation proof, current permission state or writer lease. Enabled
Office/external inventory, retention/deletion and full recovery remain open.
The later [saved Office state gate](../testing/OFFICE_SAVED_STATE_RECOVERY_2026-10-03.md)
does compare genuine enabled source documents/sheets/native deck records and
decoded edits after peer retrieval, preserving all inactive guards. It does not
certify restored API permissions or external Office service recovery.
See [writer boundary](../architecture/GEOGRAPHIC_WRITER_AUTHORITY.md) and
[full recovery plan](../plans/2026-10-01-recovery-material-integration.md).
