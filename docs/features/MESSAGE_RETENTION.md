# Message retention and deletion

## What a policy controls

The Authority applies Live, timed, or Forever policies per channel. Changing the default for new channels does not rewrite existing channels' choices.

| Policy | Current behavior |
|---|---|
| Live | New message bodies use the session path rather than the durable message write path. Changing a channel to Live does not purge its previous durable history. |
| Timed | Messages are durably written, then logically deleted after becoming eligible for the periodic sweep. |
| Forever | No timed expiry; members' permitted manual deletion still applies. |

Timed expiry is not an exact delivery-time deadline. The sweep runs once per minute and processes at most 1,000 eligible messages per channel per pass. A backlog can take additional passes. The candidate fixes the millisecond-to-microsecond conversion and selects expired records before limiting the batch, so recent traffic cannot hide older eligible messages.

**Upgrade effect:** corrected short-duration policies take effect much sooner than the previous faulty conversion. Preserve a stopped backup before upgrading an instance that uses short retention. The fix restores the configured duration; it does not introduce secure erasure.

## Deletion is not secure erasure

Normal history omits deleted messages. The database can still retain their body and attachment metadata in deleted records and event history. Diagnostic-log rotation is a different operation and does not erase database events.

Attachment files, explicitly saved report evidence, client caches, exports and backups have independent lifecycles. Do not promise that deleting a message deletes every copy. An older backup can restore a message that was deleted after that backup.

## Reproduce the current boundary safely

Run only against a candidate binary and disposable state:

```bash
cargo test --locked -p wabidb --lib projections::messages
cargo test --locked -p wabi-server --test message_retention_contract
cargo build --locked -p wabi-server --bin wabi-server
node scripts/authority-retention-smoke.mjs --binary target/debug/wabi-server
```

The runtime script creates its own temporary data directory, account, channel and upload. It verifies exact five-second policy restoration, the real periodic expiry, absence from normal history after restart, retention of a separately uploaded file, and absence of its canary bodies from default logs. It can take over a minute. It never opens an operator's data directory.

The database contract separately verifies that logical deletion survives reopening, the deleted body remains readable through the internal deleted-record lookup, an attachment fixture remains on disk, and a stopped pre-deletion backup restores the old visible message.

These are bounded checks. They do not certify report-evidence expiry, every client cache, external backups, debug logging, malicious plugins, secure erasure, or recovery from a damaged retention-policy sidecar. See [backup and recovery](../deployment/BACKUP_AND_RECOVERY.md) and the [privacy stance](../PRIVACY_STANCE.md).
