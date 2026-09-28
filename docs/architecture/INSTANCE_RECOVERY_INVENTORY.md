# Instance recovery inventory

**Date:** 2026-09-26  
**Status:** Source-backed inventory for a stopped single Authority. It is not a live snapshot, standby importer, or failover procedure.

## Recovery unit

The safe recovery unit today is the **entire stopped Authority data directory**, the **entire configured uploads directory**, and the external secrets/configuration needed to interpret them. Do not build a backup from a table allowlist or selected WabiDB segments. New sidecars can appear as features are enabled, and the event store, projections, keys, uploads, and file-backed policy must agree at one stopped point in time.

The disposable [backup/restore rehearsal](../../scripts/authority-backup-restore-smoke.mjs) hashes every file in its stopped `data/` and `uploads/` trees and compares the copied snapshot and clean restore by path, size, and SHA-256. Its optional encrypted-tool path also exports and restores an age archive, compares all restored files, and reads the account, message, and upload through the restored Authority. The plain copy path additionally proves key continuity and post-restore writes. This [recorded check](../testing/INSTANCE_RECOVERY_2026-09-26.md) covers the disposable fixture and same binary only; it does not certify an operator's installation or a running-server copy.

The candidate `wabi-instance-snapshot` binary packages those whole trees as a streaming age-encrypted stopped backup and restores into a new directory. It is documented in [Backup and Recovery](../deployment/BACKUP_AND_RECOVERY.md#candidate-encrypted-stopped-instance-tool). It cannot establish a live cross-file ordering boundary. A separate [controlled passive move](../testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) can activate a matching stopped copy only after the old Authority is stopped and fenced under operator control; it is not unreachable-host recovery.

A [disposable two-network controlled-move check](../testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md) used this whole stopped archive to move an Authority from Iyoku to Ronin, then restored Ronin's later stopped state as a fenced passive copy on Iyoku. The data-tree file hashes matched after the reseed. This does not change the recovery-unit rule or prove live standby promotion.

A separate [two-network live receiver check](../testing/REMOTE_FENCED_REPLICA_2026-09-27.md) applied post-baseline WabiDB commits and copied one verified published upload while the source Authority ran. The receiver still reported `fullInstanceReady: false`; no cross-file checkpoint or promotion was established.

The separate [encrypted instance inbox](../deployment/ENCRYPTED_INSTANCE_INBOX.md) can stream that stopped archive to another site, store immutable ciphertext, and return a hash-checked copy for isolated restore. The [disposable loopback check](../testing/ENCRYPTED_INSTANCE_INBOX_2026-09-27.md) covers this transport and restore path. It does not add a live checkpoint, incremental catch-up, or promotion authority.

## Authority-owned paths

| State | Where source puts it | Recovery rule |
|---|---|---|
| WabiDB engine, manifest, streams, indexes, projections, and root key | `<data_dir>/wabidb/` via `AppState::new`; the key is normally `wabidb/root_key` | Copy the whole tree from a stopped process. An externally supplied `WABIDB_ROOT_KEY` must be preserved separately. |
| Local WabiDB writer fence | `<data_dir>/wabidb/writer-fenced-v1`, when present | Copy it with the database. Presence makes local canonical commits fail closed and now prevents the full Authority from starting, including sidecar routes. Removing it is not a promotion protocol and is unsafe without proof the former writer is fenced and the state is complete. |
| Controlled-move activation guard | `<data_dir>/wabidb/activation-pending-v1`, when `restore --controlled-move` created the tree | Keep it until `activate-restored` verifies a matching receipt from the fenced old tree. Presence refuses WabiDB writes and full Authority startup; this is a planned move guard, not quorum failover. |
| Inactive live checkpoint guard | `<data_dir>/wabidb/live-checkpoint-v1`, created with `writer-fenced-v1` on every V2 live archive restore | Preserve both markers. Either marker prevents Authority startup; the live marker alone also prevents local engine commands. Stopped-move activation refuses these copies. No unavailable-source promotion protocol is enabled. |
| JWT signing secret | `<data_dir>/jwt_secret` unless `WABI_JWT_KEY` or legacy `JWT_SECRET` overrides it | Preserve the matching secret so sessions and identity continuity are predictable. |
| Uploaded bytes | `WABI_UPLOADS_DIR`, legacy `UPLOADS_DIR`, or the configured default | Copy the whole tree, including content outside `<data_dir>`. A database event cannot reconstruct a missing uploaded file. |
| Retention and encryption policy | `channel_retention.json`, `e2ee_state.json`, `conversation_notes.json` | Preserve with the matching database. An older copy can undo a revocation or resurrect content/policy that was later removed. |
| Account and administration sidecars | `admin_policies.json`, legacy `revocations.json`, legacy `recovery_codes.json`, `server_center.json`, `join-invites-v1.json` | Preserve with account state; permissions and recovery controls must not silently reset. Session revocations now import once into ordered `auth_revocations_updated_v1` WabiDB events; the old file becomes a stale compatibility source after the final component initialization marker. Recovery-code hashes and consumed-code records now import once into ordered `recovery_codes_updated_v1` events; code-based owner recovery spends the code, restores ownership and advances global session revocation in one event. Matching receivers apply these canonical account components, while other account sidecars and remaining compound workflows still need a shared recovery boundary. See [session revocation recovery](../deployment/SESSION_REVOCATION_RECOVERY.md) and [account recovery state](../deployment/ACCOUNT_RECOVERY_STATE.md), including mixed-version rollback limits. |
| Blacklist | `<data_dir>/blacklist.txt` by default, or `WABI_BLACKLIST_FILE` | Preserve the configured file and its location; an external path is outside the normal data copy. |
| File, media, and service metadata | `upload_registry.json`, `blob_registry.json`, `media_rooms.json`, `media_nodes.json`, `voice_policies.json`, `service_endpoints.json`, `volunteer_boosters.json`, `web_push.json` | Preserve with matching uploads and reconcile external references. `upload_registry.json` contains upload metadata and revocations; malformed state, or a missing file alongside a nonempty uploads directory, blocks Authority startup. Monotonic revocation decisions enter WabiDB as `upload_revoked_v1` events and are merged into the registry at Authority startup. A configured fenced receiver also removes current-tree files and staged chunks named by applied revocations, with a separately reported cleanup position; caches and backups are unaffected. Newly published files record filename, ownership metadata, size and SHA-256 in WabiDB as `upload_published_v1` before public rename. The receiver can copy and verify those bytes. On Authority startup, a recognized private staging file can finish publication only when its size and digest match the committed record; missing or changed nonrevoked bytes refuse startup. Startup hashes every canonical published file, which can take time on a large upload tree. A stale registry can recover missing entries for these events only when the matching bytes are present. An opt-in experimental sidecar lane can copy the registry file, but it has no shared checkpoint with WabiDB or the upload tree. Older registered uploads need the explicit [stopped-Authority backfill](../deployment/LEGACY_UPLOAD_BACKFILL.md) before their metadata can be derived from WabiDB; unregistered files cannot be inferred. Do not delete the sidecar to recover. |
| Node and optional feature state | Legacy `community_roster.json`, plus `node_registry.json`, `job_queue.json`, `addons.json`, `bots.json`, `lore_roles.json` | Preserve if present. An existing roster sidecar is imported once into a WabiDB event; later roster changes are canonical in WabiDB and leave the old file stale. The signed roster is tied to the WabiDB root key and may advertise stale entry points after restore. Reassess helper/job leases before re-enabling helpers. |

The experimental [sidecar copy lane](../deployment/EXPERIMENTAL_DB_REPLICA.md) uses a fixed, 64 MiB-per-file allowlist for incremental copies of several top-level files in this table. It can copy updates and remove a source-deleted file except `jwt_secret`. It excludes external paths, unknown files, nested trees and plugins. Its individual hashes do not create a cross-file recovery point; a copied policy can disagree with the database or another file. It must never be used as the only recovery inventory.

These names are an audit aid, **not** an exhaustive copy filter. A stopped snapshot includes unknown files under the data and uploads roots. The Authority also has process lock files. A restored lock may be removed only after confirming no process uses that copied data, as described in [Backup and Recovery](../deployment/BACKUP_AND_RECOVERY.md).

## State outside those roots

- Operator-managed `.env`, `wabi.config`, TLS/TURN/tunnel configuration, and secrets supplied through the environment or a secret store need a separate protected copy. Never put plaintext secrets into a diagnostic report.
- `plugins/` and plugin-owned storage need an explicit per-plugin inventory. A plugin may persist outside Wabi's data directory.
- Lore may use `WABI_LORE_DATA_DIR` or an external service. That store is not included merely because the Authority data directory is copied.
- Helper machines can hold their own `helper_identity.json` and service credentials. Re-pairing may be needed if those are not preserved; they are not substitutes for Authority state.
- Browser/Tauri local drafts, queued actions, and client-owned encryption private keys are not present in an Authority backup. Their recovery needs a separate client contract.
- Logs, caches, and temporary media may help diagnosis but do not establish canonical state. Incomplete uploads and active calls need explicit behavior; a stopped copy alone does not promise that an interrupted operation resumes.

## Gate before a live standby exporter

A working-tree [runtime operation pause](../deployment/RUNTIME_OPERATION_PAUSE.md)
now drains participating HTTP/Socket.IO work, account publication workers and
several background mutation passes. Owned handlers retain admission after
client cancellation. This is local scheduling groundwork; unregistered writers,
external/plugin state and complete file-inventory coordination are still required.
It does not establish a live recoverable copy or permit promotion.

The [coordinated checkpoint boundary](../deployment/CHECKPOINT_BOUNDARY.md)
now pairs that drain with engine commit/ingest guards and holds the projection
snapshot writer through a synchronous copy. Interrupted admitted tasks veto
checkpoint preparation. A matching local fixture copy is a component check;
operator inventory, complete encrypted live export and unavailable-source
promotion still require their own acceptance.

The internal [encrypted live core archive](../deployment/LIVE_CHECKPOINT_ARCHIVE.md)
now consumes that boundary and captures whole data/uploads roots, including
unknown regular files and empty directories. It substitutes the actual running
JWT and bootstrap keys, rather than trusting stale persisted key files, and
records resolved `ServerConfig` inside the protected header. Its V2 restorer
checks file/inventory digests and key/prefix continuity and always installs an
inactive writer fence. This does not replace the whole-instance inventory:
external blacklist and enabled Lore are refused; operator environment,
deployment, plugins and other external stores remain unverified. No live
operator trigger or promotion is enabled, and `fullInstanceReady` stays false.

A future exporter must define one ordering boundary across WabiDB and required sidecars/uploads, prove a clean restore with hashes and representative reads/writes, and protect the full bundle in transit and at rest. Incremental catch-up must preserve deletion, expiry, key continuity, and an observable recovery point. Promotion needs a durable writer fence and a tested old-node rejoin path. The current `standby` API intentionally returns not implemented for export, import, and promotion; its encrypted envelope receiver does not prove a recoverable community.
