> ⚠️ **STALE (2026-09-02): this documents the REMOVED SpacetimeDB stack.**
> The current deployment flow is `FRESH_INSTALL.md` in this directory, the
> `wabi-deploy` agent skill, and `docs/NETWORKING.md`. Kept for historical
> reference on the `docs-history` branch.

# Backup And Restore

Last updated: 2026-05-10

This runbook defines Wabi backup profiles and the privacy posture behind them.

Wabi backups are intentionally not one giant archive by default. A normal admin backup should restore the community shell without creating a secret message archive.

## Privacy Posture

Default admin backups are continuity backups. They restore accounts, roles, channels, memberships, moderation state, server settings, plugin trust state, selected server assets, and STDB bootstrap material.

They do not preserve private message history. That is intentional.

Until the user-owned server-side data export feature ships, a disaster recovery via the continuity profile restores the community shell: accounts, roles, channels, encrypted key registry, plugin trust, and selected non-content uploads. Private message history is not preserved by admin backups. Users who had DMs cached locally on a Tauri client may have access to that local cache, but current Tauri export is local-sidecar only and `export_data_as_zip` is still a stub. Web users do not currently have a server-side export path.

The full-emergency profile preserves message/content data for break-glass recovery, but it is not the normal backup path. It requires explicit operator confirmation and short retention.

Phase 2 must add a real user-owned server-side export/import feature. That feature should authenticate the user, query STDB rows belonging to that user, encrypt the archive for the user, and work for web and Tauri clients.

## Profiles

### `continuity`

Default profile.

Included logical STDB tables:

- `state_user`
- `state_user_meta`
- `state_user_username`
- `state_user_handle`
- `state_user_encryption_key`
- `state_channel`
- `state_channel_member`
- `state_role_definition`
- `state_rbac_assignment`
- `state_ban`
- `state_mute`
- `state_deafen`
- `state_relay`
- `state_dictionary_entry`
- `state_app_setting`
- `state_emoji_role_rule`
- `state_emote`
- `state_album`
- `state_webhook`
- `state_user_settings`
- `state_theme_preferences`
- `state_layout_preferences`
- `state_guest_code`

`state_user_meta`, `state_user_username`, and `state_user_handle` are dumped for inspection, but restore treats them as derived state rebuilt from `state_user`.

Included filesystem state:

- `.env`
- `data/.wabi-auto-secrets`
- `data/spacetimedb-config/`
- `data/stdb-publisher-config/`
- `data/.plugin-storage/`
- `plugins/`
- Only `uploads/` files referenced by continuity rows

Excluded from continuity:

- `state_message`
- `state_offline_message`
- `state_reaction`
- `state_whiteboard`
- `state_album_item`
- `state_session`
- `state_backend_instance_lease`
- `state_socket_lease`
- `state_presence_lease`
- `state_webhook_delivery`
- `ingested_event`
- `data/state-plane-outbox.ndjson`
- `data/state-plane-reducer-ingest.ndjson`
- Full `uploads/`

`state_album_item` is excluded from continuity because it contains attachment URLs, attachment names, captions, and optional message links. Those are user content or content-adjacent metadata, not admin continuity state.

The restore script enforces the same boundary. A continuity-labeled manifest that contains content tables is rejected instead of silently restoring message or album-item data.

Operator-decision payment/legal tables are excluded by default:

- `state_payment_intent`
- `state_payment_event`
- `state_payment_account_link`
- `state_payment_user_block`
- `state_payment_policy`
- `state_manual_settlement`

Use `--include-payments` only if the server operator has a retention obligation and an access policy for payment records.

### `full-emergency`

Break-glass profile.

Includes continuity plus content tables, ephemeral tables, forensic tables, and full filesystem state. It also snapshots `data/`, `uploads/`, `plugins/`, and `.env`.

This profile requires:

- `--i-understand-this-includes-content`
- encrypted storage
- access restricted to break-glass operators
- short retention, default target: 7 days
- deletion after the incident is resolved

Do not automate long-lived full-emergency retention.

## Sensitive Fields

Continuity backups contain secret material. These files must be encrypted at rest before leaving the host.

Sensitive examples:

- `state_user.row_json.password_hash`
- `state_user_encryption_key.private_key_encrypted`
- `state_webhook.secret`
- `.env`
- `data/.wabi-auto-secrets`
- STDB publisher/client tokens in config directories

Use `restic`, `borg`, `age`, or equivalent encryption. Do not upload raw backup directories to object storage.

## Local Disposable Drill

Run this before any production restore drill:

```bash
scripts/state-plane-local-drill.sh
```

This starts a temporary STDB container, copies the Wabi state bridge module into `/tmp`, publishes it to throwaway databases named `wabi-restore-drill-*`, seeds synthetic rows, creates a continuity backup with `--skip-filesystem`, restores it into a clean throwaway database, and verifies that continuity state comes back while message content does not.

The local drill intentionally skips filesystem sidecars so it does not copy the repo's real `.env` into `/tmp`. It requires Docker Compose or Podman Compose access from the current user. If host `node` is missing, it runs the Node scripts through `docker.io/library/node:22-alpine` using the same container runtime.

If you choose custom database names, the script refuses to run unless they are still obviously non-production or you pass:

```bash
scripts/state-plane-local-drill.sh \
  --database wabi-restore-drill-my-test \
  --restore-database wabi-restore-drill-my-test-restore \
  --i-know-this-is-not-production
```

Do not use production database names for this script.

## Create Backups

Continuity backup:

```bash
node scripts/state-plane-backup.mjs \
  --profile continuity \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN"
```

Continuity backup including payment/legal tables:

```bash
node scripts/state-plane-backup.mjs \
  --profile continuity \
  --include-payments \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN"
```

Logical-only drill backup without filesystem sidecars:

```bash
node scripts/state-plane-backup.mjs \
  --profile continuity \
  --skip-filesystem \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN"
```

Use `--skip-filesystem` for test drills only. It is not a complete disaster-recovery backup because it omits `.env`, STDB publisher config, plugin trust state, and referenced uploads.

Full emergency logical/filesystem backup:

```bash
node scripts/state-plane-backup.mjs \
  --profile full-emergency \
  --i-understand-this-includes-content \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN"
```

Break-glass filesystem snapshot:

```bash
scripts/state-plane-emergency-snapshot.sh \
  --i-understand-this-includes-content \
  --retention-days 7
```

Immediately push backup output into encrypted storage. Example with restic:

```bash
restic backup backups/state-plane-continuity-YYYYMMDD-HHMMSS
```

## Restore Continuity

Use a non-production drill host first.

1. Stop services that write to STDB.

```bash
docker compose stop backend stdb-publisher
```

2. Start or prepare a clean STDB module/database.

```bash
docker compose up -d spacetimedb stdb-publisher
```

3. Restore logical continuity rows.

```bash
node scripts/state-plane-restore.mjs \
  --backup-dir backups/state-plane-continuity-YYYYMMDD-HHMMSS \
  --profile continuity \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN"
```

4. Restore filesystem sidecars when replacing a host.

```bash
node scripts/state-plane-restore.mjs \
  --backup-dir backups/state-plane-continuity-YYYYMMDD-HHMMSS \
  --profile continuity \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN" \
  --restore-files \
  --overwrite-files
```

5. Restart backend.

```bash
docker compose up -d backend
```

6. Verify.

```bash
curl -fsS http://127.0.0.1:8080/state-plane/healthz
```

Manual verification checklist:

- Existing registered user can log in.
- Owner/admin roles are present.
- Channels and memberships are present.
- Moderation state is present.
- Plugin trust/signers are present if plugins are enabled.
- Message history is absent under continuity unless restored by user-owned export or emergency path.

## Restore Full Emergency

Prefer a filesystem-level restore for full emergency recovery. Use this only after deciding that content restore is appropriate for the incident.

```bash
node scripts/state-plane-restore.mjs \
  --backup-dir backups/state-plane-full-emergency-YYYYMMDD-HHMMSS \
  --profile full-emergency \
  --i-understand-this-restores-content \
  --database "$WABI_STDB_BRIDGE_DATABASE" \
  --token "$WABI_STDB_AUTH_TOKEN" \
  --restore-files \
  --overwrite-files
```

If restoring the tarball from `state-plane-emergency-snapshot.sh`, stop the stack, extract the archive into the repo root, verify checksums from `manifest.txt`, then start STDB and backend.

## Ingest Auth Bootstrap

`ingest_auth_config` is not dumped as a normal table. Restore uses `WABI_STDB_INGEST_SECRET` from `.env`.

The restore script includes the SHA-256 digest of `WABI_STDB_INGEST_SECRET` in replayed events when the environment variable is set, then attempts to call `set_ingest_key`.

For key rotation on an existing module, provide:

```bash
node scripts/state-plane-restore.mjs \
  --backup-dir backups/state-plane-continuity-YYYYMMDD-HHMMSS \
  --previous-ingest-secret "$OLD_WABI_STDB_INGEST_SECRET"
```

## Restore Drill

Run a quarterly restore drill on a non-production host.

Drill standard:

- Start from a clean STDB data directory.
- Restore the latest continuity backup.
- Log in as a pre-existing user.
- Confirm owner/admin role assignment.
- Confirm channels and channel memberships.
- Confirm selected continuity upload assets, such as avatars or emotes.
- Confirm excluded content is not restored by continuity.
- Record the date, backup id, operator, and issues found.

If this drill has not succeeded, Wabi does not have a proven backup. It has untested backup files.

## Warm Standby

For Tim/Iyoku-style standby:

1. Run continuity backups on the primary.
2. Push encrypted backups off-host after each run.
3. Keep the standby stack installed but stopped.
4. Periodically perform a dry-run restore on standby.
5. During incident failover, restore the latest continuity backup, start STDB/backend, then switch routing.

Expected target for this stage is warm standby with minutes of downtime, not active-active no downtime.

## Known Gap

User-owned server-side export is not complete.

Current Tauri storage exports local cache and settings only, and the ZIP export command is currently a stub. Web users have no equivalent server-side export. Until Phase 2 ships, continuity backup protects community structure, not private/user content history.

Phase 2 requirements:

- Authenticated user export endpoint.
- Password or fresh-session re-prompt before export.
- Rate limit exports.
- Query only rows the user owns or participates in.
- Include messages, received DMs, sent DMs, private channel membership, settings, and user-owned files.
- Encrypt the archive for the user before writing it to disk.
- Provide import/restore path owned by the user.
