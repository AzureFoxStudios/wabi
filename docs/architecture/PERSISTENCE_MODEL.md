# Wabi Persistence Model

> **Status:** Canonical reference for how state is stored in Wabi.
> **Last major revision:** 2026-06-22 (Wabidb replaces SpacetimeDB).
> **Audience:** Operators configuring retention, contributors adding storage features, and integrators building on the Wabi API.

---

## 1. Philosophy

**"Signal + Self-Host Flexibility"**

Wabi defaults to client-side storage (like Signal), but server operators can opt into varying levels of persistence per channel. Self-host means **their data, their rules, their risk**.

Every byte of server-side state lives inside the operator's `./data/wabi-server/` directory. The Wabidb engine is the only writer; the only readers are `wabi-server` itself (for query responses) and the Wabidb CLI tools (for backup/verify/migration).

---

## 2. Storage Tiers

| Tier | Default | Who Controls | Purpose |
|------|---------|--------------|---------|
| **Client (IndexedDB)** | Always | User | Personal history, offline access, draft state |
| **Server (Wabidb streams)** | Always | Server admin | Real-time sync, active sessions, shared state |
| **Server (BLAKE3 blobs)** | Opt-in | Server admin | File uploads, attachments, large media |
| **Wabidb snapshots** | Automatic | Engine | Fast recovery from crash without replaying full commit log |
| **Operator archives** | Manual | Server admin | Offsite backup, disaster recovery |

All tiers run on the same filesystem. There is no separate database server to provision.

---

## 3. Persistence Modes (Per Channel / Stream)

Wabidb supports three modes, configured per-stream via the stream key metadata:

### 3.1 Ephemeral
Streams are deleted after a TTL. Used for high-churn channels (e.g. temporary coordination chats).

**Use cases:**
- Temporary coordination channels
- Privacy-focused conversations
- High-churn chat rooms

**Implementation:**
- The Wabidb retention engine (`wabidb::retention::reaper`) scans for streams past their TTL
- On expiry, the stream's encryption key is destroyed (cryptographic deletion)
- The segments become unreadable garbage
- The commit index entry remains (audit trail) but the data is unrecoverable

**Configuration (TOML, per stream):**
```toml
[streams."ch_01H...#temp"]
persistence = "ephemeral"
ttl_minutes = 5
```

### 3.2 Session-Only
Streams persist until server restart. No disk writes beyond the operating system's page cache flushes.

**Use cases:**
- Daily standup channels
- Event coordination
- Testing / development

**Implementation:**
- The stream is held in memory only; not flushed to disk
- On restart, all session-only streams are gone
- (This mode is partially implemented; currently most streams are durable-by-default. Future work.)

### 3.3 Persistent (Default)
Streams are durable across server restarts. This is the default for all streams that don't explicitly request ephemeral.

**Use cases:**
- Community servers with compliance needs
- Project coordination (audit trail)
- Servers wanting backup capability

**Implementation:**
- Writes are append-only to per-stream segments
- Segments are AES-256-GCM encrypted with the stream's key
- Segments are fsync'd to disk before the commit index is updated
- The commit index is the canonical ordering of all writes
- Snapshots are taken periodically (configurable threshold) to bound recovery time

**Configuration (TOML):**
```toml
[streams."ch_01H...#general"]
persistence = "persistent"
retention_days = 365
```

---

## 4. File Format

All on-disk formats are specified in `core/crates/wabidb/docs/STORAGE_FORMAT.md`. Summary:

| File | Format | Purpose |
|------|--------|---------|
| `*.wseg` | 48-byte header + payload + 4-byte CRC32C + padding | Encrypted stream segment |
| `*.widx` | 16-byte header + entries + 32-byte trailer | Commit index file |
| `*.wsnap` | 40-byte header + BLAKE3-keyed state + 4-byte CRC32C | Projection snapshot |
| `*.bin` | raw bytes | BLAKE3 content-addressed blob |
| `*.meta` | `BMTA` magic + content hash + size + CRC32C | Blob metadata sidecar |
| `storage-manifest.json` | JSON | Operator-readable manifest of all streams, segments, sizes |

All CRCs are CRC32C (Castagnoli polynomial `0x1EDC6F41`). All multi-byte integers are little-endian.

---

## 5. Storage Manifest

`$DATA_DIR/manifests/storage-manifest.json` is the canonical operator-readable manifest. It's the primary artifact for backup verification (per `wabidb-62` and `wabidb-86`).

```json
{
  "schema_version": 1,
  "format_version": 1,
  "highest_commit_seq": 12345,
  "engine_version": "0.1.0",
  "created_at_micros": 1718901234567890,
  "config": {
    "segment_size_bytes": 67108864,
    "commit_batch_size": 10,
    "commit_batch_age_micros": 50000,
    "backpressure_timeout_micros": 5000000,
    "reaper_interval_micros": 60000000,
    "snapshot_threshold_events": 10000,
    "snapshot_threshold_age_micros": 86400000000,
    "load_shed_backlog_threshold": 50000
  },
  "streams": [
    {
      "stream_id": "ch_01H...",
      "stream_kind": 1,
      "stream_key_id": "01H...",
      "segment_count": 3,
      "total_record_count": 15234,
      "total_size_bytes": 8923456,
      "created_at_micros": 1718901234567890,
      "last_commit_seq": 12345
    }
  ]
}
```

The manifest is regenerated whenever the engine reopens the data directory. It is also the **primary backup verification artifact**: a backup is valid iff its manifest matches the live data directory's manifest after restore.

---

## 6. Cryptographic Deletion

Wabidb supports **cryptographic deletion** of streams: rather than overwriting data on disk (slow, fragile on SSDs), the engine destroys the stream's encryption key. The on-disk bytes become mathematically unrecoverable.

**Lifecycle:**
1. **Create:** A new stream is allocated with a fresh 256-bit key. The key is stored in the `StreamKeyRegistry` (in-memory + optional offline backup).
2. **Use:** Every segment is encrypted with the stream's current key. AES-256-GCM provides confidentiality + integrity.
3. **Rekey (optional):** For streams being migrated, the engine generates a new key, re-encrypts all segments, and discards the old key. See `wabidb::crypto::rekey`.
4. **Delete:** The key is removed from the registry. The segments are now unrecoverable garbage. The commit index retains a tombstone marking the stream as deleted (for audit).

This is the basis for the Ephemeral persistence mode (3.1): reaper deletes keys, segments are unreadable, no I/O amplification.

---

## 7. Backup and Recovery

### 7.1 What to Back Up

The full `data/wabi-server/` directory plus the `storage-manifest.json` are the backup unit. Specifically:

- `streams/` — all segments
- `global/commit-index/` — the index
- `manifests/storage-manifest.json` — the manifest
- `blobs/` — content-addressed uploads
- The Wabidb engine's bootstrap key material (stored separately; see `wabidb::crypto::bootstrap`)

### 7.2 Backup Workflow

The Wabidb CLI (`wabidb backup`) produces a manifest-frozen directory copy. Steps:

1. Engine quiesces (no new commits accepted for the duration)
2. Engine flushes pending writes
3. `storage-manifest.json` is regenerated with `highest_commit_seq` reflecting the quiesced state
4. The manifest is frozen (hash recorded)
5. Directory copy proceeds (rsync, cp, tar, etc.)
6. Manifest hash is verified against the post-copy directory

See `wabidb::retention::manifest_backup` for implementation.

### 7.3 Restore

Restore is the inverse: write the directory back, then run `wabidb check` to verify the manifest matches. If the manifest hash disagrees, the engine refuses to start (configurable; default = refuse).

---

## 8. What This Document Does Not Cover

- Wire protocol for client-server sync — see `docs/architecture/ARCHITECTURE.md` §5
- Internal Wabidb key derivation — see `wabidb::crypto::bootstrap`
- Operator runbook for backups — see `docs/deployment/BACKUP_AND_RESTORE.md`
- Disaster recovery procedures — see `docs/deployment/DEPLOYMENT.md`

---

## 9. Cross-References

- `core/crates/wabidb/docs/STORAGE_FORMAT.md` — full byte-level format spec
- `docs/proposals/wabidb-endstate.md` — Wabidb endstate design (the larger storage architecture)
- `docs/deployment/BACKUP_AND_RESTORE.md` — operator backup runbook
- `docs/architecture/ARCHITECTURE.md` §4 — Wabidb engine architecture
- `docs-history branch (archive/) 2026-04-stdb-migration/` — historical context for what this doc replaced