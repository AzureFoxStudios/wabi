# Local operator checkpoint control

**Updated:** 2026-10-02
**Status:** Main Wabi candidate; acceptance results are recorded separately.
A successful job is an encrypted core archive. `fullInstanceReady` remains
false; these controls do not activate a restored copy.

## Setup

Generate an age identity with `wabi-instance-snapshot keygen --identity-file
/path/to/private-identity.txt`. Keep that private identity on the recovery
computer; only its printed public recipient belongs on the Authority.

The configured data and uploads roots must already exist, including an empty
uploads directory for an Authority with no attachments. Create a dedicated
private checkpoint directory outside both roots:

```sh
mkdir -m 700 /path/to/checkpoints
```

Configure the running Authority:

```sh
WABI_OPERATOR_SECRET=<your-local-operator-secret>
WABI_CHECKPOINT_DIR=/path/to/checkpoints
WABI_CHECKPOINT_RECIPIENT=age1...
```

Both checkpoint settings are required together. With neither set, ordinary
Wabi remains usable and checkpoint creation reports that it is disabled.
Invalid recipient, nonprivate directory, symlink root, or overlap with source
state refuses configuration. Requests cannot select output paths, recipients,
limits or decryption keys.

| Setting | Default | Meaning |
|---|---|---|
| `WABI_CHECKPOINT_DRAIN_SECONDS` | 15 | Deadline to drain admitted work and prepare the database boundary |
| `WABI_CHECKPOINT_COPY_SECONDS` | 30 | Cooperative deadline for encryption, source verification and publication |
| `WABI_CHECKPOINT_MAX_ENTRIES` | 100000 | Archived directory/file count ceiling |
| `WABI_CHECKPOINT_MAX_BYTES` | 1073741824 | Cumulative plaintext file byte ceiling |
| `WABI_CHECKPOINT_MAX_PATH_BYTES` | 16777216 | Cumulative inventory path byte ceiling |
| `WABI_CHECKPOINT_STORAGE_BYTES` | 4294967296 | Stored directory budget including a conservative next-export reserve |
| `WABI_CHECKPOINT_MIN_FREE_BYTES` | 1073741824 | Additional filesystem headroom after reserving the export |
| `WABI_CHECKPOINT_SOURCE_CONTEXT` | 0 | Separate experimental signed-source sidecar; set exactly 1 to enable on Linux |

The checkpoint directory accepts at most 512 regular files. The current
status retains sixteen recent job records in memory. Older artifacts are
retained on disk. Storage-budget refusals remain only in memory so repeated
refusals cannot consume more disk with failure records. Explicitly move or remove archives and their matching job
records according to the operator's retention policy. No automatic deletion
of recovery material occurs. Other processes can consume disk after the
headroom check, and synchronous filesystem calls cannot be preempted.

## Create and inspect

`POST /api/operator/checkpoints/` starts a job and returns HTTP 202 with its ID.
`GET /api/operator/checkpoints/` returns enabled state, the active ID and recent
job records. Both require the **actual socket peer** to be loopback and the
`x-operator-secret` header to match `WABI_OPERATOR_SECRET`. A member token or a
forwarded loopback header is insufficient. Use the local console or SSH to run
the request on the Authority computer. Protect the secret from shell history
and command arguments by supplying it through a private client configuration.

A second creation request while a job runs returns HTTP 409. These routes are
outside the application admission gate so status remains reachable while the
checkpoint owns that gate. Authentication still applies. Responses have
`Cache-Control: no-store, private`.

Phases are `queued`, `draining`, `copying`, `ready`, and `failed`. The server
owns the task after returning 202; disconnecting the requester does not cancel
it or release its guards. A copy keeps all boundary guards until its blocking
work actually finishes. Failure codes contain no source configuration, keys or
exception text. A failed drain/copy releases this job; an interrupted admitted
application operation still vetoes further checkpoints until restart/recovery.

A completed job produces `<id>.age` and a private `<id>.json` record. Receipts
contain commit position, byte/count values and SHA-256 digests, with
`fullInstanceReady: false`. The decrypted archive contains secret configuration;
status does not. Job records are atomically replaced and synced. On restart,
persisted unfinished jobs become `failed` with `process_interrupted`; restart
never resumes a copy or promotes its output. Completed records are checked
against their ciphertext size and digest; unavailable or damaged archives become
failed with `recorded_archive_unavailable`. A crash can leave private temporary
files or an archive whose final receipt was not published. Inspect those before
retention cleanup; never treat them as recovery-ready merely because they exist.

## Transfer and inactive restore

### Experimental signed source context — acceptance pending

The October 2 local candidate optionally writes a separate private
`<id>.source-context.json`. Existing V2 archives, export receipts and job
records keep their existing schema. This file binds the actual paused
community/node/bootstrap identity and applied prefix to the completed
ciphertext/inventory digest and size, using the community P256 key and a
separate signature domain. It contains no private key, server configuration
or operator path. Allocation knowledge remains `unknown`.

`GET /api/operator/checkpoints/<id>/source-context` uses the same actual
loopback socket peer plus operator secret as checkpoint creation; account
JWTs, step-up tokens and forwarded loopback headers do not admit it. Retrieval
requires a Ready job whose bounded private persisted record still matches,
valid signed context, and unchanged archive bytes. Missing, corrupted,
interrupted or mismatched material is unavailable. Responses remain private
and uncached. One owned source read is admitted at a time; disconnecting a
caller does not release its filesystem permit early.

The optional sidecar and its temporary publication count toward entry/byte
reserves. A failed enabled signing/publication marks the job failed. A crash
can retain a private temporary file or complete sidecar without a Ready job;
neither is a recovery permission. Retained stages stay quota charged and
need explicit inspection/retention cleanup. Preserve matching archive, job
record and sidecar together. No automatic cleanup or writer activation occurs.

This producer/route passes [focused default server acceptance](../testing/geographic-2026-10-02/producer-focused-acceptance.json):
three unit checks and sixteen real checkpoint/archive/boundary integration
checks, including actual Authority reconstruction with the same community and
lock inode. The [combined frozen workspace check](../testing/geographic-2026-10-02/producer-workspace-acceptance.json)
passed 2,663 checks with no failures and 15 ignored entries. All source/build
hashes remained unchanged; no UI rendering or physical byte-transfer acceptance
is inferred.
Incomplete notification hooks have been removed without adding dependencies.
Local consumer/storage checks are recorded
in [the consensus receipt](../testing/geographic-2026-10-02/source-context-consensus-acceptance.json).
A signature proves historical community-key claims, not current source role,
payload encryption, inactive replay, durable majority or complete recovery.

### Existing protected inbox transfer

Obtain `encryptedArchiveSha256` from the trusted source's job receipt. Bind both
the fetched ciphertext and extraction to that digest:

```sh
wabi-instance-inbox fetch --id <inbox-id> --endpoint <protected-inbox-url> \
  --token-file /path/to/private-inbox-token --output /path/to/fetched.age \
  --max-bytes 4294967296 --expected-sha256 <trusted-source-digest>

wabi-instance-snapshot restore --input /path/to/fetched.age \
  --identity-file /path/to/private-identity.txt --target-root /path/to/new-restore \
  --max-bytes 4294967296 --max-entries 100000 \
  --max-path-bytes 16777216 --timeout-seconds 300 \
  --expected-sha256 <trusted-source-digest>
```

Private nonloopback HTTP requires the inbox's explicit private-transport flag.
Public endpoints require HTTPS. A digest supplied by the inbox itself detects
transfer corruption but authenticates the producer only if it matches the
separately trusted source receipt. Anyone with the public recipient can encrypt
another archive.

Restore budgets apply to both old stopped V1 archives and live V2 archives.
Sizes and cumulative path lengths are checked before writing the corresponding
file/entry; ciphertext size is bounded before extraction; deadline checks occur
between reads and before publication. Failure/unwind cleans the owned private
staging directory. Raising limits is an explicit operator decision. Every live
V2 restore remains inactive and fenced, even without `--passive-replica`.

The inbox defaults to a 4 GiB per-archive limit, an 8 GiB stored-directory
budget, and 1 GiB of free headroom after reserving the next archive. It accepts
one upload at a time, refuses a second with 429, and refuses insufficient
storage with 507 before allocating a partial file. The receive deadline is
300 seconds; configure `--max-bytes`, `--max-stored-bytes` and
`--min-free-bytes` deliberately for larger instances. These are admission
checks, not an exclusive reservation against unrelated filesystem writers.

The inbox receive path cleans an interrupted owned partial file. Publication
owns its temporary file through hard-link and directory sync even if its caller
disappears. A completed publication followed by a lost response is an uncertain
acknowledgment; verify the immutable stored ID/digest instead of assuming it was
not stored. Network requests have bounded connection/transfer deadlines.

## Remaining recovery requirements

See [the core archive contract](LIVE_CHECKPOINT_ARCHIVE.md) and
[whole-instance inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md).
External stores/plugins and deployment settings need verified participants;
complete clean-machine state validation, catch-up, durable distributed fencing,
promotion, old-node reseed and client discovery remain prerequisites to Gate B.
