# Encrypted live checkpoint archive candidate

**Date:** 2026-09-28  
**Status:** Internal main Wabi working-tree component. No operator-facing live export trigger, full-instance readiness certificate or promotion protocol is enabled.

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
| `data/.lock`, `data/wabidb/.lock` | Omit process-local lock identities. The new restore directory has no process. |
| `data/tailcat/addr.txt` | Omit the listener's mutable runtime address; a future activated process must produce its own address. |
| `data/jwt_secret` | Write the actual running signing secret into the encrypted archive, rather than copying an absent or stale persisted file. |
| `data/wabidb/root_key` | Write the actual running engine bootstrap key into the encrypted archive, rather than copying an absent or stale persisted file. |

Tailcat settings, member keys and audit state are included with the other files.
Export does not change source key files or transport settings. Keys whose
configuration cannot round-trip through the persisted signing-key resolver are
refused. The substitutions and runtime omissions are declared in the protected
header; they are not an allowlist for the rest of the tree.

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
operator trigger, authenticated transfer and receipt tracking, comprehensive
restore validation, unavailable-source promotion/fencing/reseed and measured
recovery objectives remain required. Gate C and D and capacity/privacy gates
remain open.
