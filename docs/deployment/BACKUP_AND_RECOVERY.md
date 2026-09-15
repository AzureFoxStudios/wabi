# Backup and Recovery

**Status:** canonical conservative runbook for the current single-Authority deployment.  
**Updated:** 2026-09-15

This document intentionally describes the boring recovery path that can be reasoned about today. It does **not** treat experimental WabiDB replication or warm-standby endpoints as backups.

## What must be preserved

For a normal Docker/Podman deployment, the important host paths are:

| Path / value | Why it matters |
|---|---|
| `data/wabi-server/` | WabiDB streams/indexes/checkpoints plus persisted server secrets such as the generated root key/JWT secret when env overrides are not used |
| `uploads/` | User-uploaded files that are not reconstructed from the event log |
| `.env` | Only if you use externally managed secrets/configuration; treat it as sensitive |
| `wabi.config` | Operator-friendly launch configuration when you use `scripts/launch.sh` |
| `plugins/` | Installed runtime plugin packages/configuration if plugin mode is used |
| optional helper config/certs | TURN, reverse-proxy, tunnel, or other operator-managed files needed by your deployment |

The **WabiDB root key is critical**. A backup of encrypted data without the key used to encrypt it may be unrecoverable. If `WABIDB_ROOT_KEY` is supplied externally rather than persisted under the data directory, back that secret up separately in a secure secret store.

JWT material is also sensitive. Losing/rotating it is primarily a session/login problem; losing the WabiDB root key is a data-recovery problem.

## Safest supported backup: stop, copy, start

Until a live/hot-backup protocol has a documented consistency guarantee, take file backups while the Authority is stopped.

### Docker / Podman example

From the Wabi repository/deployment directory:

```bash
docker compose stop wabi-server

# Choose a secure destination outside the live Wabi tree.
mkdir -p ../wabi-backups/2026-09-14
cp -a data/wabi-server ../wabi-backups/2026-09-14/
cp -a uploads ../wabi-backups/2026-09-14/

# If present and used by this deployment:
cp -a .env wabi.config plugins ../wabi-backups/2026-09-14/ 2>/dev/null || true

docker compose start wabi-server
```

Then verify:

```bash
curl -f http://localhost:3001/livez
curl -f http://localhost:3001/readyz
```

A backup is not proven merely because files were copied. Periodically restore one to a separate machine or isolated directory and prove the application reaches readiness and the expected accounts/content can be read.

### Archive example

After stopping the server, you may archive the copied backup directory:

```bash
tar -C ../wabi-backups -czf ../wabi-backups/wabi-2026-09-14.tar.gz 2026-09-14
```

If the archive contains `.env`, persisted secrets, private uploads, or WabiDB data, treat the archive as sensitive community data. Encrypt it at rest and restrict access.

## Restore onto a clean Authority

1. Install/check out the Wabi version you intend to restore with.
2. Keep the new Authority stopped.
3. Move any newly generated empty `data/wabi-server` aside rather than merging it into the backup.
4. Restore the backed-up `data/wabi-server/`, `uploads/`, and required configuration/secrets as complete units.
5. Restore appropriate file ownership/permissions for the service account/container.
6. If a copied backup contains stale process lock files, and you have confirmed **no Wabi process is running against that data**, remove:
   - `data/wabi-server/.lock`
   - `data/wabi-server/wabidb/.lock`
7. Start only the Authority first.
8. Verify `/livez` and `/readyz`.
9. Log in and verify representative data: owner account, channels, messages/content, uploads, and any critical workspace state.
10. Only then re-enable optional ingress, TURN/SFU, tunnels, plugins, or other helpers.

Do not restore by copying selected `.wseg`/`.widx` files into an unrelated live data directory. WabiDB state has ordering, encryption, projection, and checkpoint relationships that should be recovered as one data set.

## Version compatibility

Do not assume arbitrary forward/backward restore compatibility between distant Wabi versions.

Before upgrading a server that matters:

1. take a stopped-server backup;
2. record the Wabi commit/release used to create it;
3. perform the upgrade;
4. prove readiness and representative reads/writes before deleting the pre-upgrade backup.

If a release changes persistent record formats or WabiDB recovery semantics, its release notes/migration plan must override this generic runbook.

## What is **not** a backup today

### WabiDB peer replication

Network replication code exists behind an explicit experimental gate. It does not yet prove complete live projection convergence, deletion semantics, safe passive-writer behavior, or production failover. A peer is therefore **not** a substitute for a tested backup.

### Warm standby endpoints

The old standby export path could present an encrypted envelope without a valid live-state backup payload. That behavior has been removed/fails closed in the current multi-node consolidation work.

Until a deletion-safe exporter, importer, and manual promotion runbook are implemented and tested end to end, standby endpoints are **not** a supported disaster-recovery mechanism.

### Filesystem copy of a running Authority

A convenient live copy is not automatically crash-consistent across every file WabiDB and Wabi manage. Use the stopped-server procedure unless/until a documented hot snapshot path explicitly guarantees otherwise.

## Recovery priorities

When a host fails, preserve evidence before experimenting:

- keep the original data directory read-only if possible;
- copy it before attempting repair or format conversion;
- preserve the exact root key/configuration that belonged to that data;
- avoid repeatedly starting different Wabi versions against the only copy;
- prefer restoring a known-good backup to a clean host over hand-editing encrypted engine files.

For engine-level corruption or replay failures, use the WabiDB storage/recovery tooling and architecture docs rather than deleting indexes or segments by guesswork.

## Future HA acceptance gate

Wabi should not call a multi-node arrangement “HA” until all of the following are demonstrated in repeatable tests:

- live two-node convergence;
- restart catch-up;
- deletion/tombstone semantics;
- passive writer/no-split-brain rules;
- real standby export and import of current state;
- tested manual promotion with explicit operator action;
- recovery of uploads/blobs, not only event metadata;
- documented key handling;
- failure injection showing the surviving node does not silently diverge.

Automatic election/failover comes **after** a safe manual recovery path, not before it.


## Candidate first-boot and disposable restore gate

The production-finish candidate persists a generated JWT secret even when the data directory does not yet exist. Generated JWT and WabiDB root keys are written with restricted permissions, flushed, and published without replacing an existing key. A failed write, unreadable file or invalid persisted key stops startup; it does not silently choose a different key. Explicit environment overrides retain precedence. Recover original key material or repair storage access before restarting a failed instance.

For an embedded Authority built from the candidate, run:

```bash
node scripts/authority-backup-restore-smoke.mjs --binary /absolute/path/to/wabi-server
```

The script creates private disposable directories and loopback-only processes. It registers an owner, retains a message forever, completes an upload, stops the writer, copies the full data/uploads trees, restarts the original, restores the snapshot into another directory, and verifies both old and newly written messages/uploads through a second restart. Original session identity and key-file hashes must remain stable; post-snapshot messages must not appear in the restored snapshot. No operator secrets or live data directories are read. A report records the tested binary hash and limits.

This is a same-binary disposable-state gate. It does not certify upgrade from a previous release, a hosted-data backup, external key recovery, unfinished uploads, proxies, helpers, or an independent clean host. Those rehearsals remain separate. `scripts/state-plane-backup.mjs` and `state-plane-restore.mjs` are legacy STDB tooling; do not use them as embedded WabiDB backup instructions.
