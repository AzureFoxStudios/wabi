# Message retention and deletion

## What a policy controls

The Authority applies Live, timed, or Forever policies per channel. Changing the default for new channels does not rewrite existing channels' choices.

| Policy | Current behavior |
|---|---|
| Live | New member messages use the session path rather than the durable message write path. Changing a channel to Live does not purge its previous durable history, though that history may be hidden from chat until the room leaves Live mode. The durable bot-send endpoint and Lore promotion reject Live rooms. If a room changes to Live during a Lore promotion, the promotion succeeds without its optional durable chat announcement. |
| Timed | Messages are durably written, then logically deleted after becoming eligible for the periodic sweep. Each message keeps the lifetime selected when it was sent, even after later policy changes. |
| Forever | No timed expiry; members' permitted manual deletion still applies. |

Timed expiry is not an exact delivery-time deadline. Channels with a timer of one minute or less have a one-second sweep; every channel also receives a full sweep once per minute. Each pass processes at most 1,000 eligible messages per policy generation. A backlog can take additional passes. The Tim release fixes the millisecond-to-microsecond conversion and selects expired records within each generation before limiting the batch, so earlier Forever history cannot hide newer eligible messages.

Policy changes append an effective-at generation to `channel_retention.json`. Sends and policy updates share an ordering lock: a message that selected the old policy completes its durable or session write before the new generation begins. Existing sidecars with only a `channels` map are accepted; their one saved label is treated as having applied since the channel began because no older changes were recorded. The authenticated timeline endpoint gives the browser each message's original deadline. Empty old generations are compacted during changes, and the number of generations per channel is bounded.

The Appearance setting controls only the small per-message badge: Static (the default) shows the original fixed lifetime, such as “30s retention”; Live shows a changing “Leaves chat in …” countdown; Off hides the badge. All three modes remove a message from active chat at its deadline, even while the server's logical-deletion sweep is catching up.

**Upgrade effect:** corrected short-duration policies take effect much sooner than the previous faulty conversion. Preserve a stopped backup before upgrading an instance that already uses short retention. Future-only behavior starts with the first policy change on this version; an older sidecar cannot reconstruct policy changes that it never saved. The fix restores the configured duration; it does not introduce secure erasure. An older binary ignores policy generations and can apply the latest timer to older messages, so rolling back requires a matching stopped backup of WabiDB and the sidecar or an explicit migration.

## Deletion is not secure erasure

Normal history omits deleted messages. The database can still retain their body and attachment metadata in deleted records and event history. Diagnostic-log rotation is a different operation and does not erase database events.

Attachment files, explicitly saved report evidence, client caches, exports and backups have independent lifecycles. Do not promise that deleting a message deletes every copy. An older backup can restore a message that was deleted after that backup.

## Reproduce the current boundary safely

Run only against a test binary and disposable state:

```bash
cargo test --locked -p wabidb --lib projections::messages
cargo test --locked -p wabi-server --test message_retention_contract
cargo build --locked -p wabi-server --bin wabi-server --features addons
node scripts/authority-retention-smoke.mjs --binary target/debug/wabi-server
```

The runtime script creates its own temporary data directory, account, channel and upload. It verifies that earlier Forever messages survive a switch to five seconds, a later one-hour message keeps its original lifetime, five-second messages leave active history promptly before and after restart, the uploaded file remains independent, and a durable bot send is rejected in Live mode. It also checks that canary bodies do not appear in default logs. It never opens an operator's data directory.

The database contract separately verifies that logical deletion survives reopening, the deleted body remains readable through the internal deleted-record lookup, an attachment fixture remains on disk, and a stopped pre-deletion backup restores the old visible message.

These are bounded checks. They do not certify report-evidence expiry, every client cache, external backups, debug logging, malicious plugins, secure erasure, or every failure during a multi-store policy update. See [backup and recovery](../deployment/BACKUP_AND_RECOVERY.md) and the [privacy stance](../PRIVACY_STANCE.md).

## Damaged exact-policy file

The Authority loads `channel_retention.json` before opening WabiDB or serving requests. Invalid JSON, missing required fields, unsupported modes and unreadable files stop startup without replacing the file. This prevents Live storage behavior from briefly falling back to durable writes while a background task loads settings.

If the file becomes damaged while the server is running, existing in-memory policies remain in effect. Policy lookup reports an error and policy changes reject the damaged file before changing runtime policy. Preserve the bytes and restore a matching stopped-instance backup; do not delete the file to clear the error. A missing file is still accepted for a fresh installation and cannot distinguish accidental deletion from a never-configured instance. The exact file is authoritative: updates save it before changing runtime policy. The older database day count is only a compatibility fallback and cannot override an explicit Live, Forever or timed choice. Its adapter write has no registered projection handler. Active settings and first-owner setup no longer emit that ineffective write; both save the exact-policy file. Preserve that file with backups. Policy changes, member sends, bot/Lore durable sends and each deletion batch share a lock; a settings request can wait for an active write or batch to finish. This is not a cross-store transaction or a power-loss certificate.

REST and realtime `update-channel-settings` now use the same exact-policy validation and persistence function. Realtime Live/short-duration choices no longer depend solely on memory, and an unrelated channel rename does not emit a fabricated retention reset. Optional per-channel Live TTL/cap runtime controls retain their existing separate lifecycle; this change does not certify their persistence.

First-owner setup validates defaults before creating the account and applies the configured exact policy to its starter channels. If a starter-channel policy save fails, setup logs the failure and attempts to remove that channel; owner creation is not rolled back. Operators can create channels after correcting storage access.

New REST channel creation validates the saved server default and exact-policy file before creating state. If the initial exact-policy save fails, creation returns an error and attempts to remove the new channel. Cleanup failure is logged and requires operator inspection; creation is not an atomic transaction across the database and settings file. Damaged defaults must be restored, not silently replaced with a 24-hour policy.
