# Encrypted live checkpoint archive candidate

**Date:** 2026-09-28  
**Status:** Main Wabi working-tree component. The opt-in [local operator control](OPERATOR_CHECKPOINT_CONTROL.md) starts bounded core exports. No full-instance readiness certificate or promotion protocol is enabled.

[Forty-five selected local checks](../testing/LIVE_CHECKPOINT_ARCHIVE_2026-09-28.md)
cover the core archive, authenticated inbox round-trip, inactive CLI restore,
corruption/refusal cases and existing stopped-backup/boundary regressions.

## Capture contract

An Authority control task first obtains the
[coordinated boundary](CHECKPOINT_BOUNDARY.md) outside ordinary request
admission. `InstanceCheckpointBoundary::export_encrypted` consumes that boundary
and owns application, engine and projection-snapshot guards throughout blocking
I/O. It streams an age-encrypted **V2** archive directly to a private temporary
ciphertext file, then publishes a complete file without replacing an existing
output. There is no plaintext staging tree.

The archive includes the entire configured data and uploads roots, including
unknown regular files and empty directories. Uploads may be a separate root or
a child of data; overlapping/reversed roots are refused. Unknown symlinks,
special files, unsafe paths and non-UTF-8 names are refused.

The explicit differences from source files are:

| Source path | Archive treatment |
|---|---|
| `data/.lock`, `data/wabidb/.lock`, `data/.wabi-secret-publication.lock`, `data/wabidb/.wabi-secret-publication.lock` | Omit process-local coordination files. The new restore directory has no process. |
| `data/tailcat/addr.txt` | Omit the listener's mutable runtime address; a future activated process must produce its own address. |
| `data/jwt_secret` | Write the actual running signing secret into the encrypted archive, rather than copying an absent or stale persisted file. |
| `data/wabidb/root_key` | Write the actual running engine bootstrap key into the encrypted archive, rather than copying an absent or stale persisted file. |

Tailcat settings, member keys and audit state are included with the other files.
Export does not change source key files or transport settings. Keys whose
configuration cannot round-trip through the persisted signing-key resolver are
refused. The substitutions and runtime omissions are declared in the protected
header; they are not an allowlist for the rest of the tree.

Older V2 headers with the original three runtime exclusions remain readable.
Current exports declare and omit the two additional secret-publication lock
files. Unknown exclusion lists are refused; persistent record layouts are
unchanged.

## Inventory and limits

Every archived entry has a path and type; files additionally carry their size
and SHA-256. A final ordered inventory digest binds entries, file/directory
counts and total file bytes. Age authenticates the encrypted header and stream.
That integrity check does not authenticate the archive's producer: anyone with
the public recipient can encrypt an archive. Offsite recovery must bind the
ciphertext digest to an authenticated receipt from the trusted source. The
protected header's identity/fingerprints alone are not an enrollment proof.
The header captures the applied commit position, commit-prefix fingerprint,
bootstrap fingerprint, local node identity and resolved `ServerConfig`.
That configuration contains secrets and must never be exposed through status
endpoints or ordinary logs.

Before publication, the exporter enumerates the source again and hashes every
copied file again. A changed inventory, file size, modification time or content
refuses publication. This detects changes outside registered participation; it
does not create a transaction with an arbitrary external writer.

The caller supplies positive entry, plaintext-file-byte and inventory-path-byte
budgets and a copy deadline. Enumeration bounds its pending queue before growth.
Copy and revalidation check the deadline between chunks and entries and before
and after publication. An expired deadline discards the attempt. Synchronous
filesystem calls cannot be preempted; the blocking task retains all guards
until it actually stops. Partial ciphertext is removed on ordinary failure or
panic; a process crash can leave an unreported private temporary file.

The returned receipt contains positions, counts and ciphertext/inventory
digests, with `fullInstanceReady: false`. It contains no secret configuration.

## Inactive restore

The shared snapshot CLI continues to export/read **V1 stopped archives**. Older
restorers reject V2 rather than treating a live archive as an ordinary stopped
copy. The current restorer accepts V2, verifies entry hashes and the inventory
footer, then requires commit-index prefix, projection watermark and active-key
continuity to match the protected header.

It publishes a new private restore directory containing data/uploads and a
private `live-checkpoint.json` with the captured configuration. Paths and
listeners in that configuration describe the source; they are not automatically
applied to the destination.

Every V2 restore receives both `writer-fenced-v1` and `live-checkpoint-v1` before
publication, even when the CLI's passive flag is omitted. Main Wabi refuses
Authority startup with either marker. The engine also refuses local commands
with the live marker alone. The existing stopped-move activation commands
refuse live checkpoint trees. Removing markers manually is not a promotion
protocol. A passive engine can be inspected while keeping its write fence.

## Inactive core verification candidate

The current worktree adds `verify-inactive` to the snapshot CLI. It requires
the original encrypted V2 archive, its private age identity and the receipt
obtained through the trusted source's authenticated channel:

```sh
wabi-instance-snapshot verify-inactive \
  --target-root /private/new-restore \
  --input /private/checkpoint.age \
  --identity-file /private/recovery-identity.txt \
  --source-receipt /private/authenticated-source-receipt.json
```

This command keeps the stopped tree's persistent advisory lock and both live
guards. It does not start an Authority or call the ordinary engine open/drop
path, which can update persisted state even on a fenced engine. It independently
replays the complete indexed history into a new in-memory projection view and
compares every nonempty index, key, value and applied watermark with the saved
projection. Missing/pruned history, mismatched prefix, malformed snapshots,
duplicate decoded keys and unsupported filesystem entries refuse this profile.

The verifier hashes the source ciphertext and checks its private header against
the restored metadata. It also recomputes the source's exact ordered whole-root
inventory, including unknown files and empty directories and the substituted
active keys. This catches changed header/configuration, omitted components and
changed bytes. The separately authenticated receipt establishes which source
archive to check; knowledge of the public age recipient alone does not do so.

Every canonical nonrevoked published upload must match its recorded metadata,
size and SHA-256. Canonical upload denials must match the registry. An older
nonrevoked registered upload without a canonical publication record refuses
verification until the stopped source has a documented canonical backfill.
Revoked historical bytes are not certified as physically erased. The whole
restore tree is hashed before and after inspection, and inspection does not
repair a registry, rewrite a snapshot or remove an inactive marker. Creating a
missing persistent engine lock is the only intended filesystem mutation.

The support profile is `inactive-live-core-complete-history-v1`. Enabled Lore
(including a persisted addon switch), legacy mesh, runtime plugin directories
and an external blacklist are refused. This checks the bounded captured core;
it does not inspect operator environment files, deployment configuration,
external stores or helper/client private state. Unknown bundled files are
preserved and compared; that does not validate their application semantics.

Default limits are 10,000 inventory/projection entries, 64 MiB whole-tree file
bytes, 4 MiB projection JSON and 60 seconds. Hard ceilings are 100,000 entries,
256 MiB files, 16 MiB projection JSON and 300 seconds. Ciphertext is limited to
the file-byte budget plus 2 MiB for archive/encryption framing; depth is 64 and
inventory path bytes are bounded at 4 MiB. The deadline is cooperative between
filesystem operations. Individual synchronous I/O calls cannot be preempted.
Large or pruned installations need a separately validated support profile.

PASS reports aggregate positions/counts/digests and matching active-key/guard
checks, with `externalStateVerified: false` and `fullInstanceReady: false`.
REFUSED emits a fixed public reason and no private filenames, configuration,
keys or parser errors. Neither outcome authorizes promotion. Existing V1/V2
restore formats and stopped-move behavior are unchanged.

## Outstanding whole-instance work

An external blacklist path is refused, even when currently empty. Enabled or
active Lore needs an external-store participant and is refused. A configured
log directory inside a captured root is refused because the logging writer is
not admitted canonical work. External diagnostic logs are not community state.

Operator configuration beyond `ServerConfig`, runtime plugins and their stores,
other external services/secrets, deployment/TLS/TURN configuration and helper
re-pairing still require the
[complete inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md).
Active calls, Live messages and incomplete transfers do not acquire restart
guarantees. Historical encrypted segments/backups are not proof of physical
erasure merely because current history or upload access denies an item.

The header explicitly keeps `externalStateVerified: false` and
`fullInstanceReady: false`. This component does not complete Gate B. A durable
complete-inventory validation, comprehensive clean
restore validation, unavailable-source promotion/fencing/reseed and measured
recovery objectives remain required. Gate C and D and capacity/privacy gates
remain open.
