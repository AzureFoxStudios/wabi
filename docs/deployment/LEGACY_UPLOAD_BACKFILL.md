# Legacy upload publication backfill

**Status:** Explicit offline migration for upload files already registered before `upload_published_v1` existed. It does not complete whole-instance replication or authorize standby promotion.

Older `upload_registry.json` entries have ownership metadata but no canonical size/hash event for the fenced receiver to request. `wabi-upload-backfill` reads that registry and the matching upload tree, verifies each eligible regular file against its recorded size, hashes it, and can append the same `upload_published_v1` event used by new uploads. It skips revoked names using both the sidecar and canonical WabiDB denials. Missing files remain uncommitted. Files absent from the registry are never inferred or published.

## Before running

1. Stop the Authority and any other process using its WabiDB and uploads trees. Make a complete, encrypted stopped-instance backup of the data and uploads directories with the matching root key and operator configuration. This command needs exclusive WabiDB access and refuses a fenced or activation-pending tree in apply mode.
   The offline migration bypasses live per-room owner admission. Complete it before any room ownership handoff; do not run it against a retired node or treat its output as proof that this node still owns a room.
2. Review the upload retention/privacy policy. A publication event persists original filenames, channel/uploader associations, size, and digest in WabiDB history. Later revocation denies delivery and removes current-tree bytes in the configured paths; it does not erase historical event records, caches, or backups. Do not backfill content whose metadata must not become retained history.
3. Build this checkout's tool with `cargo build --locked -p wabi-server --bin wabi-upload-backfill`. Use the same binary and root key as the Authority. If the Authority uses `WABIDB_ROOT_KEY`, supply the matching value through its normal private secret mechanism.

Preview a bounded batch:

```bash
wabi-upload-backfill \
  --data-dir /srv/wabi/data \
  --uploads-dir /srv/wabi/uploads \
  --limit 100
```

Apply only after reviewing that preview and the stopped backup:

```bash
wabi-upload-backfill \
  --data-dir /srv/wabi/data \
  --uploads-dir /srv/wabi/uploads \
  --limit 100 \
  --apply
```

Repeat while `report.deferred` is nonzero. The command is resumable: already canonical entries are counted and not appended again. `complete: true` means no *registered legacy* entry was missing or deferred in that run; it does not inventory unregistered files or prove the second machine has complete state. `report.missing` includes unfinished or lost files. Resolve those through the normal upload/recovery procedure; do not invent an event for absent bytes. A mismatched size, symlink, malformed registry entry, or conflicting canonical record stops the batch. Preview does not append publication events, although opening WabiDB can perform its normal engine recovery.

After applying, restart the Authority and verify its upload reads. With experimental replication explicitly configured, check that the fenced receiver catches the publication events and hash-verified bytes. It still lacks other sidecars, external stores, a complete consistency checkpoint, and safe promotion. Follow [Experimental DB Replica](EXPERIMENTAL_DB_REPLICA.md) and the [instance inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md) for those boundaries.
