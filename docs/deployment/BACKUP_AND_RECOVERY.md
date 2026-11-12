# Backup and Recovery

**Status:** canonical conservative runbook for the current single-Authority deployment.  
**Updated:** 2026-09-27

This document intentionally describes the boring recovery path that can be reasoned about today. It does **not** treat experimental WabiDB replication or warm-standby endpoints as backups.

The [instance recovery inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md) maps known Authority state, external paths, and the consistency work required before a live standby exporter can be trusted.

## What must be preserved

For a normal Docker/Podman deployment, the important host paths are:

| Path / value | Why it matters |
|---|---|
| `data/wabi-server/` | WabiDB streams/indexes/checkpoints plus persisted server secrets such as the generated root key/JWT secret when env overrides are not used |
| `data/wabi-server/uploads/` or explicitly configured `uploads/` | Default uploads are inside the data directory. Preserve the external path too when `WABI_UPLOADS_DIR=/app/uploads` is configured; bytes are not reconstructed from events |
| `.env` | Only if you use externally managed secrets/configuration; treat it as sensitive |
| `wabi.config` | Operator-friendly launch configuration when you use `scripts/launch.sh` |
| `plugins/` | Installed runtime plugin packages/configuration if plugin mode is used |
| optional helper config/certs | TURN, reverse-proxy, tunnel, or other operator-managed files needed by your deployment |

The **WabiDB root key is critical**. A backup of encrypted data without the key used to encrypt it may be unrecoverable. If `WABIDB_ROOT_KEY` is supplied externally rather than persisted under the data directory, back that secret up separately in a secure secret store.

JWT material is also sensitive. Losing/rotating it is primarily a session/login problem; losing the WabiDB root key is a data-recovery problem. Release builds refuse the known development JWT default and signing keys shorter than 32 bytes, including persisted files and legacy `JWT_SECRET` overrides. Configure a strong random `WABI_JWT_KEY` explicitly when upgrading such an installation; keys are never silently replaced. A signing-key change invalidates existing sessions. First-boot secret publication uses a permanent advisory publication lock and atomically publishes complete synced bytes, including on filesystems without hard-link support.

## Exact retention policy

Include `channel_retention.json` in the stopped data-directory backup. It distinguishes Live mode and sub-day durations from WabiDB's whole-day compatibility policy, and records when each policy began so older messages keep their original lifetime. Startup validates and loads it before serving requests; damaged or unreadable state stops startup while preserving the file. Restore a matching backup rather than deleting the file or replacing it with an empty object. Removing it can change the storage mode or expiry of existing messages after restart. An older server binary does not understand the policy timeline: it can apply the latest setting to older messages and expire them early. Roll back the binary only with a matching stopped backup of both WabiDB and this sidecar, or migrate the timeline explicitly. See [message retention](../features/MESSAGE_RETENTION.md).

## Server Center arrival and moderation state

Include `server_center.json` in the stopped Authority data-directory backup. It stores community rules and acknowledgments, community role choices, moderation reports and actions, raid posture, and the minimal per-member pending-welcome marker. Restoring a stale copy can roll back rules acknowledgments, role access, moderation state, or first-visit progress. Restore it with the matching WabiDB and policy files; do not delete a damaged copy to make the server start.

## Voice moderation upgrade recovery

Older server builds committed mute/deafen events without projecting them into
enforced restrictions. The corrected engine detects those ignored-event
markers in an older snapshot and rebuilds restrictions from committed history
before serving requests. It preserves legacy JSON payloads and does not alter
postcard record schemas. Mutes honor their expiry; `i64::MAX` is indefinite,
and deafen persists until an undeafen event.

Keep the full matching WabiDB data tree, including streams, commit index,
snapshot, and root key, when upgrading. This one-time repair validates all
indexed pre-checkpoint kind-1 history because the old snapshot markers do not
identify every affected pair. Missing or corrupt required history blocks
startup instead of treating affected users as unrestricted. Preserve the
failed tree and restore a matching stopped backup; do not delete the markers
or create empty restriction indexes to bypass recovery.

## Experimental encryption registry

Include `e2ee_state.json`, when present, in the full stopped data-directory backup. It stores device public keys and wrapped room-key metadata; it is separate from WabiDB's at-rest root key. Keep client-owned private keys and local browser data under their own recovery procedures—an Authority backup does not recreate them.

If Wabi reports that encryption state cannot be read, preserve the damaged file and restore the registry from the matching backup. Do not remove it or replace it with `{}` to make sending resume. Malformed or unreadable state pauses sends and registry updates; a missing file is still treated as an unused registry. Restoring an older valid registry can roll back device revocations and room epochs, so this is not a standalone safe rollback procedure. Coordinate recovery of the complete instance and affected devices.

## Shared conversation notes

The follow-up Shared notes feature writes `conversation_notes.json` beside the WabiDB data, outside WabiDB's event log. Preserve it with the **stopped** Authority data-directory backup, including when restoring to another machine. A WabiDB-only export cannot recover these notes. Personal browser Notes are separate and require their own client-side backup.

The sidecar holds readable note text for server-readable rooms and signed ciphertext envelopes for experimental encrypted rooms. Treat it and its backups as sensitive. A missing sidecar means no saved shared notes; an unreadable or damaged sidecar is preserved and note operations fail closed rather than silently replacing it. If recovery is needed, keep the damaged file for diagnosis and restore `conversation_notes.json` from a matching stopped backup with the corresponding WabiDB and `e2ee_state.json` state. Recipients still need their client-owned keys to decrypt encrypted notes. Removing a note or room from the live server does not erase earlier backups.

## Field pilot sessions

The optional local field pilot is disabled by default. Set `WABI_FIELD_PILOT=1` when starting the Authority for a supervised adult/test-account trial; `GET /api/field/capability` then returns `{"enabled":true}`. Only a server owner/admin can create a session. Invited registered participants must explicitly consent before seeing the shared session or reporting. No field session routes are exposed when the flag is absent. The pilot writes `field_sessions_v1.json` in the Authority data directory. It contains the active session roster, consent state, and each participant's latest manual check-in and map position in **server-readable plaintext**. The Authority operator and anyone with the data directory or a stopped backup can read the file. The optional map image path points to a public `/uploads/` asset; use only a generic, non-sensitive background image.

Include this sidecar in the **stopped** full data-directory backup. A WabiDB-only export cannot recover it. A missing file means no saved field sessions; a damaged or unreadable file makes field operations fail closed. Restore a matching backup after preserving the damaged file for diagnosis. Ending or leaving a session removes its live records; expiry removes them on the next field API request or the Authority's 30-second sweep while the pilot is enabled. The first sweep also runs at startup. Neither action erases earlier backups or proves erasure of old filesystem blocks. Keep and destroy backup copies according to the outing's agreed retention policy. A restored older backup can reintroduce a location report or prior consent state, so review restored field sessions before allowing members onto the restored Authority.

## Upload registry and revocations

Include `upload_registry.json` in the stopped data-directory backup with the matching configured uploads directory. It contains upload ownership and revoked filenames. New revocation decisions also enter WabiDB events and are merged into the registry at Authority startup; upload metadata and bytes still need their matching stopped copy. A malformed registry blocks Authority startup. A missing registry also blocks startup when the uploads directory is nonempty, because the server cannot tell whether old upload URLs were revoked. An absent or empty uploads directory can start without a registry on a fresh installation.

If startup reports a missing or damaged registry, keep the Authority stopped. Preserve the current data and uploads trees for diagnosis, then restore the **matching stopped** data and uploads trees, including `upload_registry.json`, from a trusted backup. Do not create an empty registry or copy one from a different point in time to clear the error. If this is a legacy installation that never had a registry, keep its existing uploads out of the served directory while you inventory their ownership and past access policy; do not publish the old URLs as if they were fresh uploads. A valid but stale registry is repaired only for revocations already represented in the matching WabiDB history; older unimported decisions and upload ownership cannot be reconstructed from those events. See the [local persistence check](../testing/UPLOAD_REVOCATION_RECOVERY_2026-09-27.md).

## Community entry-point roster

The Authority imports an existing `community_roster.json` once into the WabiDB event store. Subsequent owner changes are canonical WabiDB events; the legacy file remains as it was and can be stale. Preserve the whole stopped data tree, including both WabiDB and any legacy file. A restored Authority with the same root key re-signs the database roster under the same community identity. Database catch-up can carry this roster event, and an optional narrow sidecar lane can copy selected files, but neither creates a consistent whole-instance recovery point. An older binary may use the stale file or fail to replay the new event; roll back only with a matching stopped backup or a deliberate migration.

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

### Candidate encrypted stopped-instance tool

The working tree also contains `wabi-instance-snapshot`, a separate binary built from the `wabi-server` package. It streams a stopped Authority's complete data and uploads trees into an age-encrypted archive without writing a plaintext archive to disk. It holds the WabiDB advisory writer lock throughout stopped operations and refuses a live owner or an unresolved legacy root `.lock`, symlink/special-file inputs, an output inside the source tree, and missing persisted JWT or WabiDB root-key files. Persistent lock inodes and secret-publication lock files are runtime coordination metadata, excluded from archive content and passive-state hashes. Restore decrypts into a new, private directory and checks each file's hash before publishing that directory. It never merges into an existing Authority directory.

Generate the private key on the recovery machine and keep it there:

```bash
wabi-instance-snapshot keygen --identity-file /secure/wabi-recovery.agekey
```

After stopping the Authority and confirming its data is idle, copy the printed recipient to the source machine and export using the **actual** configured data and uploads paths:

```bash
wabi-instance-snapshot export \
  --data-dir /srv/wabi/data \
  --uploads-dir /srv/wabi/uploads \
  --recipient "age1REPLACE_WITH_PRINTED_RECIPIENT" \
  --output /secure/wabi-stopped.age
```

Move the encrypted archive to the recovery machine and restore it into a path that does not exist yet:

```bash
wabi-instance-snapshot restore \
  --input /secure/wabi-stopped.age \
  --identity-file /secure/wabi-recovery.agekey \
  --target-root /srv/wabi-recovered
```

For a trusted remote site, the separate [encrypted instance inbox](ENCRYPTED_INSTANCE_INBOX.md) can stream and store this ciphertext under an immutable ID, then provide a hash-checked download. It was exercised with a disposable loopback export/send/fetch/restore fixture. It does not make the backup live or ready for automatic promotion.

The command prints the restored data and uploads paths. Keep the original Authority fenced/stopped, supply any external config or services from the [instance recovery inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md), and verify the restored server before changing traffic. Losing the age private key makes the archive unreadable. An interrupted restore can leave a private `.wabi-restore-*` staging directory; inspect and remove it only after confirming no restore is running. For a planned move between two hosts, use `restore --controlled-move` and the fence receipt below; a plain restore is for isolated backup inspection or a separately controlled disaster recovery decision and does not prevent a second writer from starting.

The export/restore path is a **stopped backup and isolated restore**, not a hot snapshot or automatically promoted standby. The separate guarded move commands below require operator control of the old writer. The snapshot tool holds the local advisory lock during export, fencing participating current binaries. It cannot fence older binaries that ignore that lock, another filesystem copy, or an independently writable host; keep all old writers stopped. Historical backups may contain content later deleted or expired, so restoring an older archive requires the normal retention/privacy review. External plugin/Lore stores and environment-managed secrets remain separate. The tool refuses missing persisted core-key files, but cannot prove that a running deployment actually used those files when environment overrides were set; preserve and restore matching overrides separately.

If `data/wabidb/writer-fenced-v1` exists in an archive, the restored WabiDB engine rejects new local canonical commits and the full Wabi Authority refuses to boot from that tree. Keep that marker with the data. Deleting it does not establish a safe promotion: the previous Authority may still be writable, and no distributed lease exists yet.

### Candidate controlled move of a stopped Authority

For an operator who controls both machines, the snapshot tool can retire the **old stopped data tree** before creating its replacement. This is a planned move, not failover of an unreachable Authority. Fence the old tree before export so the archive itself proves it was made from a fenced source; no later canonical WabiDB write should be acknowledged by that tree. Keep the old process stopped throughout.

1. While the old Authority is healthy, publish the intended new HTTPS URL as an approved Anchor entry point and verify it reaches the old Authority. Let clients fetch the signed roster before the move; otherwise a dead original address cannot tell them where to connect. A plain HTTP private URL still requires manual sign-in under the current client rules.
2. Stop the old Authority and verify its process exited. Leave the persistent `wabidb/.lock` in place; the snapshot tool must acquire its OS lock. If a legacy root `.lock` exists, confirm every old Wabi process is stopped before removing only that legacy file. Never remove the engine lock to force the snapshot tool past a live writer. Run `wabi-instance-snapshot fence-stopped --data-dir /srv/wabi/data` on the old machine. It durably writes `wabidb/writer-fenced-v1` and checks the locks again. Keep the marker in place. Then export the encrypted whole-instance archive as above. An archive made before the fence is refused by `restore --controlled-move`.
3. Move the encrypted archive to the new, isolated machine. Restore it with `wabi-instance-snapshot restore --input /secure/handoff.age --identity-file /secure/wabi-recovery.agekey --target-root /srv/wabi-recovered --controlled-move`. The restore verifies that the archive contained the old writer fence, removes that fence only from the inactive replacement copy, and writes a private `data/wabidb/activation-pending-v1` marker. Both WabiDB writes and the full Authority startup refuse the replacement while it is pending. Keep it stopped.
4. On the **old** machine, run `wabi-instance-snapshot fence-stopped --data-dir /srv/wabi/data --archive /secure/handoff.age --receipt /secure/fence-receipt.json`. This form now requires the old writer fence to exist already; it checks the locks and writes a private proof bound to the exact encrypted archive. If it reports an error, treat the move as unsafe until the old process and both data trees have been inspected. Copy the receipt to the new machine over the protected operator channel.
5. On the **new** machine, run `wabi-instance-snapshot activate-restored --target-root /srv/wabi-recovered --receipt /secure/fence-receipt.json`. This checks the restored root key, encrypted archive hash and old-host proof before durably removing the pending marker. A missing, altered or different-archive receipt leaves the copy inactive. Start the restored Authority with matching external secrets/configuration. Verify readiness, login, representative messages, uploads and deletion/retention state. Publish a new signed roster version that labels the new URL as Authority and removes or retires the old entry, then shift traffic. Keep the old tree fenced.

The receipt is a workflow guard bound to the encrypted archive and its persisted root key. It records the old tree's fence at receipt time; the archive's embedded fence establishes that it was exported after the fence was present. It cannot independently attest the state of a remote machine or detect an operator removing the fence and restarting the old Authority between steps. Because the restored archive contains the same root key, a person with the decrypted restore could fabricate an equivalent receipt. Keep control of both hosts and activate only one replacement copy. This is not a distributed lease and cannot prevent another unfenced copy from starting. The procedure cannot safely promote a standby while the former Authority is unreachable or merely partitioned: it cannot place a fence on a machine the operator cannot control. It does not create a live checkpoint or choose a writer by quorum. Do not remove the marker from the old data tree to rejoin it; reconcile or reseed from the current Authority instead.

### Rejoin the retired machine as a passive copy

After a controlled move, the old machine must receive the **new Authority's** state, including writes made after the move. Keep its original data tree and `writer-fenced-v1` marker untouched. Stop the new Authority for a complete encrypted export of its current data and uploads trees. Use the recipient printed by `keygen` for the operator-held recovery identity:

```bash
wabi-instance-snapshot export \
  --data-dir /srv/wabi-new/data \
  --uploads-dir /srv/wabi-new/uploads \
  --recipient age1YOUR_RECIPIENT \
  --output /secure/reseed.age
```

Transfer that archive over the protected operator channel, then restore it into a **new empty directory** on the returned machine with `--passive-replica`:

```bash
wabi-instance-snapshot restore \
  --input /secure/reseed.age \
  --identity-file /secure/wabi-recovery.agekey \
  --target-root /srv/wabi-reseeded \
  --passive-replica
```

Resume the new Authority after its stopped export is durably published and its original data tree is intact. Check the restored community root key, representative users/permissions/content and upload hashes against that export. The restored `data/wabidb/writer-fenced-v1` must remain present; the full Authority must refuse to boot from this tree. The [experimental receiver](EXPERIMENTAL_DB_REPLICA.md) can then use that passive tree for further catch-up under its stated limits. It cannot serve clients while fenced. A disposable [controlled-move process check](../testing/CONTROLLED_MOVE_RECEIPT_2026-09-27.md) covers the reseed sequence on one machine. A [two-network field run](../testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md) moved the stopped Authority from Iyoku to Ronin and reseeded Iyoku as a fenced passive copy. Recovery from an unreachable old Authority and automatic failover remain unproven.

### Candidate controlled move from a caught-up passive copy

`seal-passive-move` and `activate-passive` provide a guarded **planned move** when an operator can stop and fence the old Authority and the passive copy has already caught up. They compare the entire configured data and uploads trees, including sidecars and keys. The generated projection snapshot is compared by decoded, order-normalized content and watermark because its byte ordering can differ after replay. The SQLite read model (`wabidb/projections/read-model.sqlite3`, messages) is compared the same way, by its rows and not its bytes, because a file rebuilt from the log holds the same rows in a different layout; its `-wal` and `-shm` side files are not compared. A read model whose write-ahead log still holds frames, or that fails SQLite's integrity check, makes the comparison fail (test: `core/crates/wabi-server/src/instance_archive/mod.rs::tests::passive_move_claims_compare_the_read_model_by_content_not_bytes`). This is a check at a stopped boundary; the live receiver still reports `fullInstanceReady: false` and does not declare its own promotion readiness.

1. While the old Authority is healthy, confirm the candidate is on a trusted host with matching external secrets, plugin data and services, and arrange an approved client entry point as in the stopped move above. Wait for WabiDB, upload and sidecar copying to settle; this status alone does not prove completeness.
2. Stop the old Authority and passive receiver. Verify both process exits on each host. Keep each `wabidb/.lock` inode; the stopped tool checks and holds actual OS ownership. Resolve a legacy root `.lock` only after every old process is stopped. If the receiver left an **empty** `uploads/.replica` staging directory, remove it with `rmdir`; if it is nonempty, leave the copy fenced and resolve the unfinished transfer. Keep the old Authority stopped and run `wabi-instance-snapshot fence-stopped --data-dir /srv/wabi-old/data` there. Verify that this old tree refuses Authority startup.
3. On the old host, run `wabi-instance-snapshot seal-passive-move --data-dir /srv/wabi-old/data --uploads-dir /srv/wabi-old/data/uploads --receipt /secure/passive-move-receipt.json`. Use the actual configured uploads directory. This command requires the old writer fence, hashes every file and directory in both roots, and writes a private receipt outside those roots. Transfer the receipt to the candidate host over the protected operator channel.
4. On the candidate host, run `wabi-instance-snapshot activate-passive --target-root /srv/wabi-passive --receipt /secure/passive-move-receipt.json --external-state-reviewed`. The final flag is an explicit operator assertion that separately managed secrets, plugins and services were reviewed. A missing, changed or extra file, unequal projection state, invalid receipt, absent passive fence or active lock leaves the candidate fenced. The tool removes the candidate's writer fence only after the comparison passes.
5. Start only the candidate Authority with its matching external configuration. Verify readiness, the same community identity and existing sessions, permissions, history, uploads, deletions and a new write through the intended client entry point. Keep the retired source fenced. Reseed it from the new Authority before using it as a passive receiver again.

The receipt is a workflow guard, not remote attestation: both trees hold the root key used to authenticate it. The tool cannot detect an operator restarting the old host outside this procedure, and it cannot fence an unreachable host. File equality at one stopped point does not establish a durable live cross-file checkpoint, deletion-safe retention, or complete external service state. An unmatched candidate must stay fenced; use the complete stopped export/restore path or repair its state before trying again. Do not use this procedure for a partitioned or unreachable old Authority.

A [disposable real-process loopback check](../testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) passed the guarded move, same community/session/history/upload reads and a post-move write. A remote passive activation and physical three-site move have not been run.

## Restore onto a clean Authority

1. Install/check out the Wabi version you intend to restore with.
2. Keep the new Authority stopped.
3. Move any newly generated empty `data/wabi-server` aside rather than merging it into the backup.
4. Restore the backed-up `data/wabi-server/`, `uploads/`, and required configuration/secrets as complete units.
5. Restore appropriate file ownership/permissions for the service account/container.
6. Leave a copied `data/wabi-server/wabidb/.lock` in place. The current engine reacquires its OS advisory lock; stale PID text is not ownership. If a legacy `data/wabi-server/.lock` exists, remove only that legacy file after confirming **every old Wabi process is stopped**. Never unlink the engine lock to bypass a live writer.
7. Start only the Authority first.
8. Verify `/livez` and `/readyz`.
9. Log in and verify representative data: owner account, channels, messages/content, uploads, and any critical workspace state.
10. Only then re-enable optional ingress, TURN/SFU, tunnels, plugins, or other helpers.

Do not restore by copying selected `.wseg`/`.widx` files into an unrelated live data directory. WabiDB state has ordering, encryption, projection, and checkpoint relationships that should be recovered as one data set.

## Version compatibility

Do not assume arbitrary forward/backward restore compatibility between distant Wabi versions.

The advisory-lock candidate requires a stopped upgrade from PID-based binaries: stop every old Authority/receiver process first and keep the engine lock inode in place. Old binaries do not participate in the new OS lock; mixed-version concurrent opens are unsafe. This is local filesystem exclusion, not distributed fencing or HA.

Stream directory names changed on 2026-11-10 (PR 293) and the change is forward-only. WabiDB stores each stream under `streams/<kind>/<name>/`. Older builds used the stream id as the name unchanged, including ids with a colon such as `community-roster:v1`. Current builds percent-encode any id outside `[A-Za-z0-9._-]` when they create a **new** stream directory (`community-roster%3Av1`), because Windows forbids `:` in file names. Existing directories are never renamed: a stream that already has a raw-named directory keeps using it, and replay reads both spellings. Consequences:

- **No rollback past this change once it has run.** A build from before PR 293 does not understand encoded directory names. If the newer build has created any new stream with such an id (for example a new user, channel membership or call session), the older build derives the wrong key for that directory and cannot decrypt its events. It then either refuses to start ("not all indexed events could be recovered", when those events are newer than the last projection snapshot) or starts from the snapshot and writes the same stream into a second, raw-named directory. Neither state is supported. Restore the pre-upgrade stopped backup instead of downgrading the binary.
- **A data tree that contains raw colon directories cannot be restored on Windows.** That is every tree first written by a pre-PR 293 build on Linux or macOS. Trees first created by a current build use only portable names. There is no conversion tool yet.

Messages moved to a SQLite read model (Task 3.5.1, PR 334), and this change is forward-only too. `wabidb/projections/read-model.sqlite3` holds the messages projection; `snapshot.json` keeps every other projection. The file is derived from the log, is not encrypted (it holds message bodies as `snapshot.json` did) and is created with mode 0600 (tests: `tests::read_model_messages::deleting_the_read_model_file_changes_no_read`, `tests::read_model_messages::the_read_model_file_is_owner_only_and_messages_leave_the_snapshot`).

- **The first start replays the whole log.** An existing installation has no read model, so the engine does not use `snapshot.json` and rebuilds every projection from commit 1 (test: `tests::pre_versioning_fixture::opening_rebuilds_messages_from_the_log_not_the_snapshot`). It does not write `snapshot.json` before that replay has succeeded, so a failed first start leaves the directory as the previous build left it (same test; and `tests::read_model_messages::a_failed_startup_replay_leaves_none_of_its_messages_in_the_file` for the read model). This has not been run against a long-lived real data directory, and the time it takes on a large one is not established (one measurement is in PR 334).
- **Check a copy first.** A log that cannot replay from commit 1 (old records that no longer decrypt or decode, which the snapshot hides today) makes the first start refuse with "repair required". To find out beforehand: stop the server, copy the data directory, delete `wabidb/projections/snapshot.json` **in the copy**, and start the *current* release on the copy. If it starts, the new build's first start will replay too.
- **A log shorter than the checkpoint is refused.** If the commit index ends below the watermark of `snapshot.json`, and there is no usable read model at exactly that watermark, the engine refuses to start, because rebuilding would discard what only the checkpoint still holds. That is every first start after the upgrade on such a directory. Restore the missing `streams/` and `global/commit-index/` files, or keep running the previous build (test: `tests::read_model_messages::a_log_shorter_than_the_checkpoint_is_never_rebuilt_from`). `wabidb-cli check` reports the same refusal (test: `cli::check::tests::check_and_verify_agree_with_the_engine_about_a_missing_read_model`).
- **What a refusal may touch.** A refused start changes no saved projection. The probe opens the read model read-only, so it never folds SQLite's write-ahead log into the file or removes it, also after a crash that left frames in the log (test: `tests::read_model_messages::a_refusal_from_an_unclean_stop_leaves_the_database_and_its_log_as_they_were`). It may do two things, and the refusal text says both: raise `highest_commit_seq` in `storage-manifest.json` (atomically) to the highest commit any file names, and let SQLite recreate `projections/read-model.sqlite3-shm`, an index it rebuilds. The manifest raise is deliberate: if a file claimed commit 40 over a log that ends at 5, and you then delete that file, the next commit is 41, not 6 (test: `tests::read_model_messages::an_unusable_read_model_claiming_more_than_the_log_is_refused_and_its_claim_is_kept`).
- **A directory with an incomplete log.** When the first start keeps the saved projections over a log shorter than its checkpoint (both stores at the same commit N, the case that opened before this change), the engine records it in `global/incomplete-log.json` and copies the number into `storage-manifest.json` and the snapshot. From then on the engine **never rebuilds from the log**, even after new commits have made the log look healthy, because nothing in the commit index shows that commits below its first entry are missing (commit numbers are legitimately missing from an index: rejected commands burn theirs). It runs, logs a warning at every start, and `wabidb-cli check` and `verify` print the same warning. **Back up the whole data directory at once.** Anything that needs a rebuild now makes the start refuse with "the log of this directory is incomplete below commit N": losing or deleting the read model, a read-model generation change in a new release, a rebuild request left by run-time damage, a missing snapshot, `wabidb-cli quarantine` (which refuses up front and writes nothing). Removing the record file does not help, because the manifest and the snapshot carry the same number (test: `tests::read_model_messages::removing_the_record_alone_does_not_allow_a_rebuild`). The two ways out: **restore the whole data directory from a backup taken before the log lost its commits**, losing the commits written since; or **keep running on the read model you have** and take a fresh backup now. Do not copy the missing log files into the directory: once commits were written after the loss they share the new commits' file names, so copying without overwriting restores nothing and copying with overwriting destroys the newer log (same test). Tests: `tests::read_model_messages::a_directory_recorded_as_incomplete_never_rebuilds_from_its_log`, `tests::read_model_messages::quarantine_refuses_a_directory_recorded_as_incomplete`. A live checkpoint export carries the record but not the read model, so the restored copy refuses to start until it gets a read model from the source directory (tests: `tests::read_model_messages::a_copy_without_the_read_model_keeps_the_record_and_refuses`, `instance_archive::live::tests::the_incomplete_log_record_is_exported`).
- **An old hole this build cannot see.** A hole made before this build ever ran, by an older build that kept writing, leaves nothing in the commit index to show it. The first start of this build rebuilds the messages from the log and refuses if the old snapshot holds messages the log cannot give back; it does not check the snapshot's other projections, and `wabidb-cli check` can only warn that the snapshot holds messages in the old format (test: `tests::read_model_messages::a_hole_an_older_build_made_is_not_rebuilt_from`). If you know commits were lost, do not start this build on the directory without that old snapshot: start it on a copy first.
- **A rebuild request on an incomplete-log directory means restore from backup.** If `projections/read-model.rebuild` exists beside `global/incomplete-log.json`, the engine will not start. Do not delete either file to make it start: deleting the request starts the engine on a read model that SQLite reported as damaged.
- **Recovery rule for the read model: when deleting `projections/read-model.sqlite3*` by hand is safe, and when it is not.** With the server stopped, deleting `read-model.sqlite3`, `-wal`, `-shm` and `read-model.rebuild` and starting again rebuilds the read model from the log (test: `tests::read_model_messages::deleting_the_read_model_file_changes_no_read`). It is safe only if **the log is whole**, and the engine can only vouch for that much: `wabidb-cli check` on a copy reports no error and no incomplete-log warning, the record, the manifest and the snapshot carry no `incomplete_log_below`, the manifest's `log_head_commit` equals the lowest commit in the commit index, and the index reaches the snapshot's watermark. Commit numbers missing from the index are not a sign of a hole (see above), so the index being contiguous is not part of the rule and not something to check by hand. It is **not safe** when you know or suspect that log files were lost: the read model can then be the only copy of what the lost commits held, and after the deletion the engine refuses to start (tests: `tests::read_model_messages::a_log_shorter_than_the_checkpoint_is_never_rebuilt_from`, `tests::read_model_messages::a_directory_recorded_as_incomplete_never_rebuilds_from_its_log`). Copy the data directory first. Deleting only the `-wal` file of an unclean stop discards the commits in it, so it is never part of the rule. The engine replaces a read model by itself, under the same conditions, when the file is another build's or damaged (tests: `tests::read_model_messages::a_read_model_of_another_generation_is_rebuilt_from_the_log`, `tests::read_model_messages::a_damaged_read_model_is_rebuilt_from_a_whole_log_and_kept_when_the_log_is_short`).
- **Do not open the live read model with other tools, and copy it only with the engine stopped.** The engine keeps its write-ahead log small by holding back its own readers for at most 50 ms. It cannot hold back a reader in another process: an `sqlite3` shell, or a backup tool copying `read-model.sqlite3` while the engine runs, that keeps a read transaction open pins the log. Measured with such a reader: 344 MiB of log over 8,000 commits and a 118 ms commit every 16 commits. A file copied that way is also not a state the engine wrote (the live checkpoint export leaves the read model out for this reason).

Stored records carry a version header since 2026-11-11 (PR 320, and PR 325 for four event payloads), and this change is forward-only as well. A durable record of 30 types, and four event payloads, is now written as ten `0xFF` bytes, a four-letter type tag and a version byte, followed by the same bytes as before (`docs/architecture/STORAGE_FORMAT.md` §7.1). Records written by older builds have no header and still load, from the checkpoint and from the log (tests: `tests::pre_versioning_fixture::pre_versioning_snapshot_still_decodes`, `tests::pre_versioning_fixture::pre_versioning_log_replays_to_the_same_state`, `tests::pre_versioning_fixture::pre_versioning_log_with_new_writes_replays`).

- **No rollback past this change once the newer build has written anything.** A build from before PR 320 cannot decode a record that has the header. No test runs an older build against newer data, so do not rely on how it fails. The way back is the stopped backup from before the upgrade: take one first.
- **A tree that spans the upgrade still passes offline inspection** (tests: `tests::pre_versioning_fixture::pre_versioning_directory_passes_offline_inspection`, `tests::pre_versioning_fixture::upgraded_directory_passes_offline_inspection`). Inspection compares content, so a row saved before the upgrade and the same row rebuilt after it count as equal.

Startup replay is stricter since 2026-11-10 (PR 299). It merges the stream directories in commit order instead of loading every event and sorting. If any one stream directory holds its indexed records out of commit order, the Authority now refuses to start with a `Corrupt` error that names the directory ("indexed records out of commit order") or the commit ("not all indexed events could be recovered"). Earlier builds started on such a tree. No normal write path produces one, so treat the error as real damage: keep the data tree as it is and restore the last good stopped backup. For the first upgrade across this change, start the new build against a **stopped copy** of the data directory before touching the live one.

Before upgrading a server that matters:

1. take a stopped-server backup;
2. record the Wabi commit/release used to create it;
3. perform the upgrade;
4. prove readiness and representative reads/writes before deleting the pre-upgrade backup.

If a release changes persistent record formats or WabiDB recovery semantics, its release notes/migration plan must override this generic runbook.

## What is **not** a backup today

### WabiDB peer replication

Network replication code exists behind an explicit experimental gate. A [separate fenced WabiDB-only receiver](EXPERIMENTAL_DB_REPLICA.md) has passed disposable two-process restart/catch-up checks using the sender's applied-position-based push worker. With both upload trees explicitly configured, it can also copy newly published nonrevoked uploads in verified chunks; older registered files require [offline backfill](LEGACY_UPLOAD_BACKFILL.md). An optional fixed allowlist lane can copy selected top-level sidecars, including the upload registry and notes, but has no checkpoint shared with the database or uploads. Unregistered files, other sidecars and external stores remain outside this path. Complete live-state convergence, promotion after an unreachable host loss and production failover remain unproven. The controlled stopped-tree move above passed only for its disposable fixture. A peer is therefore **not** a substitute for a tested backup.

### Warm standby endpoints

The old standby export path could present an encrypted envelope without a valid live-state backup payload. That behavior has been removed/fails closed in the current multi-node consolidation work.

Until a deletion-safe exporter, importer, and manual promotion runbook are implemented and tested end to end, standby endpoints are **not** a supported disaster-recovery mechanism.

### Filesystem copy of a running Authority

A convenient live copy is not automatically crash-consistent across every file WabiDB and Wabi manage. Use the stopped-server procedure unless/until a documented hot snapshot path explicitly guarantees otherwise.

The SQLite read model makes this more likely to go wrong: `read-model.sqlite3` and its `-wal` file are only consistent together, and a copy of a running engine can catch them at different moments. The live checkpoint export therefore leaves all three read-model files out; the restored copy has no read model and the engine builds one from the checkpoint's log at its first start (test: `core/crates/wabi-server/src/instance_archive/live/tests.rs::the_derived_read_model_is_not_exported`). Verification of a restored checkpoint does not pass when a read model is present and was not compared with the log (test: `core/crates/wabi-server/tests/checkpoint_operator_contract.rs`, through `tests/fixtures/checkpoint_peer_verify.rs`).

## Recovery priorities

When a host fails, preserve evidence before experimenting:

- keep the original data directory read-only if possible;
- copy it before attempting repair or format conversion;
- preserve the exact root key/configuration that belonged to that data;
- avoid repeatedly starting different Wabi versions against the only copy;
- prefer restoring a known-good backup to a clean host over hand-editing encrypted engine files.

For engine-level corruption or replay failures, use the WabiDB storage/recovery tooling and architecture docs rather than deleting indexes or segments by guesswork.

## Startup refuses one commit: quarantine it

Since 2026-11-10 an operator can get past a single durable commit that stops startup, instead of restoring a backup. This is a last-resort repair. Restoring a known-good backup is still the safer choice when you have one.

**When it applies.** The Authority refuses to start and its log names one commit, for example:

```text
corrupt projection message_created at commit 1234: replay failed: ...; repair required before startup (copy the data directory, then `wabidb-cli quarantine --seq 1234` skips this commit)
corrupt projection message_created at commit 1234: handler panicked: ...; repair required before startup (...)
```

The first means the projection code rejected that event. The second means it panicked; startup now reports the panic as this error instead of crashing (tests: `core/crates/wabidb/src/engine/quarantine_tests.rs` `failing_handler_is_named_at_startup_and_quarantine_skips_it`, `panicking_handler_is_named_at_startup_and_quarantine_skips_it`). Both usually point at a server bug rather than disk damage. While the server was running, the same event halted the engine (the log said "engine halted, repair required before retry").

Quarantine also skips a commit whose stored records are damaged ("commit N: not all indexed events could be recovered") (test: `cli::check::tests::quarantined_corrupt_commit_is_reported_as_quarantined`). That is real data damage, so restore a backup if you can.

**What it costs.** A quarantined commit stays in the log, but no part of the server's state ever applies it again. Whatever that command did (a message, an edit, a membership or settings change) is gone from what users see, and later commands that depended on it may behave differently. Keep `quarantine.json`. Deleting it does not bring the commit back, and it can make a later startup refuse the same commit again (test: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it` refuses before the file exists and starts after).

**Procedure.**

1. Stop the Authority: `docker compose stop wabi-server`.
2. Copy the whole data directory first, exactly as in [the stopped backup above](#safest-supported-backup-stop-copy-start). Do not skip this step.
3. Read the commit number N from the startup error: `docker compose logs wabi-server`.
4. Build the tool from the same checkout and release as the server: `cargo build --release -p wabidb --bin wabidb-cli`. The server image does not contain it.
5. Run it against the engine directory, as the user that owns the data (UID 1000 for the Docker image):

   ```bash
   target/release/wabidb-cli quarantine --seq N data/wabi-server/wabidb
   ```

   It takes the engine's advisory lock while it runs, so it fails with `AlreadyRunning` if anything still holds the data directory open (test: `cli::quarantine::tests::quarantine_fails_while_the_lock_is_held`). It refuses a directory without `data/wabi-server/wabidb/.lock` (test: `cli::quarantine::tests::quarantine_refuses_a_directory_without_a_lock_file`), and refuses an N that is not in the commit index (test: `cli::quarantine::tests::quarantine_appends_once_and_refuses_unindexed_seqs`). It adds N to `data/wabi-server/wabidb/global/quarantine.json` atomically (same test). It never creates or deletes `.lock` (test: `cli::quarantine::tests::quarantine_fails_while_the_lock_is_held` checks the lock inode is unchanged); never delete it yourself (step 6 of [restore onto a clean Authority](#restore-onto-a-clean-authority)).
6. Optional: `target/release/wabidb-cli check data/wabi-server/wabidb` lists N under `quarantined_commits`. `check` and `verify` report a quarantined commit as quarantined, not as damage (tests: `cli::check::tests::quarantined_corrupt_commit_is_reported_as_quarantined`, `cli::check::tests::quarantine_entry_above_every_commit_is_not_ok`). Of the `wabidb-cli` commands, `check`, `verify`, `status` and `list-streams` only read, and `quarantine` is the one that writes (test: `cli::tests::commands_are_read_only_and_never_touch_the_lock`).
7. Start the Authority and verify `/livez` and `/readyz`. Its log shows a warning for every quarantined commit it skips: `replay: skipping quarantined commit N` (test: `engine::quarantine_tests::failing_handler_is_named_at_startup_and_quarantine_skips_it`).

The quarantine command also leaves `projections/read-model.rebuild`, so the next start rebuilds the SQLite read model without the quarantined commit, which it may already have applied (test: `tests::read_model_messages::quarantining_a_commit_the_read_model_holds_removes_it_from_the_read_model`). That start therefore replays the whole log, so the command refuses on a directory recorded as having an incomplete log (test: `tests::read_model_messages::quarantine_refuses_a_directory_recorded_as_incomplete`).

If startup then refuses a different commit, it is safe to repeat the procedure for that commit. If more than one or two commits fail, stop: a bad build or wider damage is more likely than a few bad events, so restore the backup instead.

The Authority refuses to start if `quarantine.json` cannot be parsed, or if it lists a commit above every commit on disk (the next write would receive that number and be skipped) (tests: `engine::quarantine_tests::unparseable_quarantine_file_refuses_startup`, `engine::quarantine_tests::quarantine_file_listing_a_future_seq_refuses_startup`). Restore the file from the copy taken in step 2.

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

# Also exercise the offline encrypted export and isolated restore:
node scripts/authority-backup-restore-smoke.mjs \
  --binary /absolute/path/to/wabi-server \
  --snapshot-binary /absolute/path/to/wabi-instance-snapshot
```

The script creates private disposable directories and loopback-only processes. It registers an owner, retains a message forever, completes an upload, stops the writer, copies the full data/uploads trees, and compares every file's size and SHA-256 between source, snapshot, and clean restore. With `--snapshot-binary`, it also creates an age identity, exports the stopped source into an encrypted archive, restores into a fresh private tree, compares all files, and reads the account/message/upload through the restored Authority API. It restarts the original, restores the plain copied snapshot into another directory, and verifies both old and newly written messages/uploads through a second restart. Original session identity and key-file hashes must remain stable; post-snapshot messages must not appear in the restored snapshot. No operator secrets or live data directories are read. A report records the tested binary hash, snapshot file count/size, manifest hash, and limits.

This is a same-binary disposable-state gate. It does not certify upgrade from a previous release, a hosted-data backup, external key recovery, unfinished uploads, proxies, helpers, or an independent clean host. Those rehearsals remain separate. `scripts/state-plane-backup.mjs` and `state-plane-restore.mjs` are legacy STDB tooling; do not use them as embedded WabiDB backup instructions.
