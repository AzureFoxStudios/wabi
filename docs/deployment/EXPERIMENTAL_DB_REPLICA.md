# Experimental fenced WabiDB receiver

**Status:** Development-only WabiDB catch-up with optional verified upload copying. This is not a Wabi standby, automatic recovery, or a production high-availability setup. The [two-process loopback checks](../testing/DB_REPLICA_PROCESS_2026-09-27.md) include a fenced restore from an encrypted stopped baseline. A [two-network field check](../testing/REMOTE_FENCED_REPLICA_2026-09-27.md) then observed a running Authority send later commits and verified upload bytes to a fenced remote receiver. A complete recoverable instance and physical three-site trial remain unproven.

## What this copies

An Authority can send ordered WabiDB commits and encrypted segment bytes to a separate `wabi-db-replica-dev` process. The receiver must already have the same WabiDB root key and a durable `writer-fenced-v1` marker. It validates incoming records, appends them, and applies them to its live WabiDB projections. The sender reads the receiver's **applied** sequence and compares a fingerprint of its earlier commit-index entries before sending missing commits. Each push also carries the sender's commit-index fingerprint through the batch's final entry; the receiver preflights the merged index and refuses a batch that omits an earlier committed entry or diverges. Sequence numbers can have legitimate gaps after failed commands, so numeric adjacency alone is not the rule. A peer with the same root key but divergent commit history fails these checks. The receiver reports `fullInstanceReady: false` even when the database commit positions match.

This process does not serve Wabi clients or replicate a complete Authority instance. A restored baseline includes uploads and sidecars as of the stopped export. New `upload_published_v1` records carry filename, ownership metadata, byte count and SHA-256 through WabiDB; `upload_revoked_v1` carries denial decisions. With upload trees configured on both sides, the sender can copy a published file in bounded chunks after the receiver has applied the matching database prefix. The sender checks the local publication record and SHA-256 before sending; the receiver resumes a staged file by exact offset and checks the final SHA-256 before publication. Revoked names are excluded and matching files already in the passive uploads tree are removed after the denial is applied. Cleanup is retried and its position is reported separately from the WabiDB applied position. An Authority startup can reconstruct missing upload-registry entries only after verifying canonical file bytes. Older registered files need the [offline legacy upload backfill](LEGACY_UPLOAD_BACKFILL.md); unregistered files are not inferred.

An additional **opt-in experimental sidecar lane** copies only the top-level names in `instance_sidecars.rs`, including `upload_registry.json`, notes, policy files and `jwt_secret`. Each file is limited to 64 MiB, and the sender sends at most 64 MiB of sidecar bodies per sync interval. The sender compares receiver size and SHA-256, sends changed whole-file bytes, and removes a receiver file when its source disappears, except `jwt_secret` is never deleted. The receiver rejects unlisted names, symlinks, oversized files and a mismatched request hash, then writes through a private temporary file and syncs the directory. These files can contain keys, recovery data and private community records: use only a trusted receiver and protected transport. Plugin-owned files, nested trees, external services, live sessions and unregistered uploads remain outside this lane. Sidecar copies have no database-linked checkpoint, generation number or atomic cross-file ordering; a file can reflect a different moment than the applied WabiDB position or another sidecar. Deletion from the current tree does not securely erase caches or backups. The receiver reports `fullInstanceReady: false` even after all known copies finish. It has no automatic promotion or unfence command. A separate [candidate controlled move](BACKUP_AND_RECOVERY.md#candidate-controlled-move-from-a-caught-up-passive-copy) requires the operator to stop and fence the old Authority, compare whole stopped trees and review external state before activating the passive copy. Do not point users or Anchors at the fenced receiver.

Channel-wide history clear is an ordered `channel_messages_cleared` event. Both source and receiver must run builds that register it; a receiver that ignores the event can report a matching commit position while showing old messages. A [controlled loopback move](../testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) checked a cleared channel after activation, but this does not erase older raw event bodies or backups. Do not use an older binary to read or recover state after this event without a compatible migration.

The source Authority also recovers a local crash between its publication event and final upload rename: it recognizes only the two staging names used by direct and resumable uploads, checks the canonical size and SHA-256, and syncs the final directory before startup continues. Existing canonical files are hash-checked at startup. A missing or changed nonrevoked file still blocks startup, and this local repair does not make the fenced receiver promotable.

## Prepare a disposable second host

Build the binaries from the same Wabi checkout:

```bash
cargo build --locked -p wabi-server --bin wabi-server --bin wabi-instance-snapshot --bin wabi-db-replica-dev
```

Prepare a complete encrypted baseline using the [stopped-instance export](BACKUP_AND_RECOVERY.md#candidate-encrypted-stopped-instance-tool). Stop the Authority while exporting the configured data and uploads trees. Transfer the ciphertext over an operator-protected channel or the [encrypted instance inbox](ENCRYPTED_INSTANCE_INBOX.md). On the second host, restore with a passive WabiDB fence **before publication**:

```bash
wabi-instance-snapshot restore \
  --input /secure/wabi-stopped.age \
  --identity-file /secure/wabi-recovery.agekey \
  --target-root /srv/wabi-passive \
  --passive-replica
```

The restore publishes `/srv/wabi-passive/data/wabidb/writer-fenced-v1`. WabiDB rejects local canonical commits and the full Authority refuses to start from this tree. Do not remove the fence. The encrypted archive still contains private community data and may contain records later deleted on the Authority. If the original Authority uses an environment-managed WabiDB root key, place the *matching* key in a private `--root-key-file` on the second host; preserving a persisted key file alone does not prove the live key matched it. Review the [complete instance inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md).

Create a different, random sync token on a trusted machine and copy it privately to both hosts. The receiver requires at least 32 non-whitespace ASCII characters in a regular private file (mode 0600 on Unix):

```bash
umask 077
openssl rand -hex 32 > /secure/wabi-sync.token
chmod 600 /secure/wabi-sync.token
```

Start the receiver on the second host. The default listener is loopback only:

```bash
wabi-db-replica-dev \
  --data-dir /srv/wabi-passive/data/wabidb \
  --uploads-dir /srv/wabi-passive/uploads \
  --instance-dir /srv/wabi-passive/data \
  --token-file /secure/wabi-sync.token \
  --experimental-replication
```

Put a loopback receiver behind an HTTPS reverse proxy with a valid certificate, or bind directly to an operator-protected private address using `--listen 100.64.x.y:47074 --allow-remote-listen`. The latter flag only permits binding; configure the private transport and firewall separately. Anyone with the sync token and network reachability can submit candidate database data, so keep both tightly scoped. A public IP works without a domain if its HTTPS certificate validates for that IP. Do not send the token over public plain HTTP.

On the Authority, supply the *same token value* as `WABI_SYNC_TOKEN` through its secret management and set:

```text
WABIDB_EXPERIMENTAL_REPLICATION=true
WABIDB_PEER_ENDPOINT=https://RECEIVER_IP_OR_HOST
WABIDB_SYNC_INTERVAL_MS=30000
WABIDB_REPLICATE_SIDECARS=true
```

For a protected private IP URL such as `http://100.64.x.y:47074`, set `WABIDB_ALLOW_PRIVATE_HTTP=true` as well. Loopback HTTP is permitted for local experiments. The sender rejects public HTTP, URL credentials, paths/query strings, redirects, a writable Authority peer, and a receiver whose root-key fingerprint differs. The fingerprint checks key consistency; the token provides request authentication. The sender and receiver must run matching builds for the current push format, including `targetPrefixFingerprint`. The transport has bounded request timeouts. The sender refuses missing, symlinked, oversized or short source segments before push and reads each unique segment once per batch; see the [integrity check](../testing/REPLICATION_TRANSPORT_INTEGRITY_2026-09-27.md). Database segments still travel in buffered JSON; upload chunks are raw requests of at most 1 MiB, with an 8 MiB sender budget per sync interval. `--uploads-dir` must point to the uploads tree restored alongside this receiver's fenced database. Omitting it disables upload copying; a configured Authority sender then receives an error from the receiver's upload inventory endpoint. `--instance-dir` must contain that fenced WabiDB tree and is required only when `WABIDB_REPLICATE_SIDECARS=true` is set on the Authority. Omit both to leave sidecar copying off. The sidecar lane sends whole files and should not be enabled across an untrusted network.

## Observe and stop

`GET /livez` only checks that the receiver process answers. The receiver's `GET /api/v1/sync/status` requires the `x-wabi-sync-token` header and reports `appliedCommitSeq`, `indexedCommitSeq`, `writerFenced`, `replicaFingerprint`, `commitPrefixFingerprint`, `uploadCopyEnabled`, `uploadPrunedThroughCommitSeq`, `sidecarCopyEnabled`, and `fullInstanceReady`. If upload copying is enabled, first read the Authority's post-write `GET /api/sync/status` with the same token and require the receiver to apply and index through its `latestCommitSeq`; then require the receiver's prune position to catch up with that applied position before treating cleanup as current. A receiver can report pruning through its own position while a later source revocation is still in transit. The watermark does not detect files placed back in the tree by an external process after the pass. `sidecarCopyEnabled` means the receiver has an instance directory configured; it does not prove that the Authority enabled the lane or that its latest files arrived. There is no sidecar checkpoint or catch-up watermark. Check representative database reads and file hashes on an isolated copy. The prefix fingerprint covers commit-index entries, not historical segment bytes or the rest of the instance. Equal sequence numbers and copied files are **not** proof of a complete or usable Wabi instance. Stop the Authority's experimental sender before retiring or replacing the receiver. SIGTERM or Ctrl-C now asks the development receiver to drain and exit so WabiDB can write its projection snapshot and release the process lock; a [focused process check](../testing/REPLICA_STATE_COMPARISON_2026-09-27.md) covers that path. A forced kill may leave a stale lock and requires the usual process verification before removal.

No deletion-safe retention, full-instance incremental state path, sustained capacity result, remote partition behavior, safe writer election, or unavailable-host promotion runbook exists yet. A [controlled passive move](../testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) passed with both processes stopped, the old writer fenced and complete fixture trees compared; that is narrower than declaring this receiver a recovery target. Raw replicated segments can preserve material removed from current views. Keep ordinary encrypted backups and their restore rehearsals. This receiver remains an implementation probe for the [geographic community plan](../plans/2026-09-26-geographic-community-nodes.md).
