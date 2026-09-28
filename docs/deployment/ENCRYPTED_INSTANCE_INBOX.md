# Encrypted stopped-instance inbox

**Status:** Candidate offsite transport for a stopped Authority backup. It is not live replication, a ready standby, or automatic failover.

`wabi-instance-inbox` is a separate process that receives the complete age-encrypted archive made by `wabi-instance-snapshot`. The receiving site stores ciphertext under an immutable archive ID. An operator can fetch it, verify the transfer hash, and restore it into a clean directory using the recovery identity. The inbox never receives that private age identity and cannot serve the community.

## Prepare the receiving site

Build the two separate binaries from the same Wabi checkout:

```bash
cargo build --locked -p wabi-server --bin wabi-instance-snapshot --bin wabi-instance-inbox
```

Create an inbox bearer token on a trusted operator machine and place the same private file on the sending and receiving machines over a protected channel:

```bash
umask 077
openssl rand -hex 32 > /secure/wabi-inbox.token
chmod 600 /secure/wabi-inbox.token
```

The inbox requires at least 32 ASCII token characters and a private regular token file. Keep the age recovery identity separately on the recovery machine. Anyone with the inbox token can upload and download encrypted archives, but needs the age identity to decrypt them. Restrict both credentials and rotate the inbox token if it is exposed.

The default listener is loopback only. Put it behind a reverse proxy with valid HTTPS, or bind it to an operator-protected private transport. For example, on the receiving host:

```bash
wabi-instance-inbox serve \
  --storage-dir /srv/wabi-inbox \
  --token-file /secure/wabi-inbox.token
```

To bind directly to a protected Tailcat address, pass `--listen 100.64.x.y:47073 --allow-remote-listen`. That flag permits a non-loopback listener; it does **not** configure a firewall or verify the private transport's peer. A public listener requires a properly configured TLS reverse proxy and access controls. The CLI requires HTTPS for public IP endpoints. A domain is optional when the public IP has a certificate the client can validate. Plain HTTP to a private IP requires the client flag `--allow-private-http` and an operator-protected link.

`/healthz` is unauthenticated and shows only that the inbox process is answering. Archive upload and download require the token. Keep the storage filesystem private; the process uses a private directory and private archive files on Unix.

## Send a stopped backup

Generate the recovery identity and recipient as described in [Backup and Recovery](BACKUP_AND_RECOVERY.md#candidate-encrypted-stopped-instance-tool). Stop the Authority, confirm it is idle, and export its **entire configured data and uploads trees**. Preserve any environment-managed keys, plugin/Lore state, and other external state separately according to the [instance inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md).

```bash
wabi-instance-snapshot export \
  --data-dir /srv/wabi/data \
  --uploads-dir /srv/wabi/uploads \
  --recipient "age1REPLACE_WITH_PRINTED_RECIPIENT" \
  --output /secure/wabi-stopped.age

wabi-instance-inbox send \
  --input /secure/wabi-stopped.age \
  --endpoint https://RECEIVING_SITE_IP_OR_HOST \
  --token-file /secure/wabi-inbox.token \
  --id planned-move-2026-09-27
```

For a private Tailcat URL such as `http://100.64.x.y:47073`, add `--allow-private-http` to `send` and `fetch`. Keep the Authority stopped during export. The inbox ID may be omitted to generate one; record the ID and SHA-256 printed by `send`. A second upload to the same ID is rejected. The receiver streams the ciphertext into a temporary file, checks its age header, byte limit and SHA-256, syncs it, then publishes the immutable ID. The default per-archive limit is 100 GiB; `serve --max-bytes` changes it.

`send` prints the archive ID, SHA-256, byte count, and elapsed transfer time. This is a transfer measurement, not a replication lag or recovery-point measurement. The archive remains a backup of the instant when the Authority was stopped; later writes do not reach the inbox.

## Fetch and restore on an isolated machine

```bash
wabi-instance-inbox fetch \
  --id planned-move-2026-09-27 \
  --endpoint https://RECEIVING_SITE_IP_OR_HOST \
  --token-file /secure/wabi-inbox.token \
  --output /secure/fetched.age

wabi-instance-snapshot restore \
  --input /secure/fetched.age \
  --identity-file /secure/wabi-recovery.agekey \
  --target-root /srv/wabi-recovered
```

`fetch` checks the returned SHA-256 and age header before publishing a new private output file. The restore tool decrypts and verifies the archive contents; only a successful restore and representative application checks establish that the backup is usable. The inbox itself checks only ciphertext transport integrity and an age header, not whether the encrypted payload decrypts or contains a complete Wabi instance.

Keep the restored Authority isolated while checking accounts, retained and deleted content, permissions, uploads, policy sidecars, and matching external secrets. For a **planned move** between controlled hosts, use the guarded `restore --controlled-move`, old-tree `fence-stopped`, and `activate-restored` sequence in [Backup and Recovery](BACKUP_AND_RECOVERY.md#candidate-controlled-move-of-a-stopped-authority). A plain restore provides no cross-host writer fence. An unreachable old Authority cannot be safely promoted through this procedure.

## Storage and privacy operations

- The inbox stores ciphertext only, but old backups can contain messages or files later deleted or expired. Set a retention schedule and remove expired archive files under operator control. No automatic retention or aggregate storage quota is implemented.
- Keep a separate, tested copy of the age identity. Losing it makes the stored archive unreadable. Losing the inbox token prevents transfer until the receiver is restarted with a new shared token.
- Monitor free space and restrict access to the inbox process and storage directory. The per-archive byte limit does not limit cumulative archive storage or upload rate.
- If an upload is interrupted, the receiver removes its temporary file when the handler exits. Review stale private `.tmp` files after a process crash, and remove them only when no upload is active.
- A second physical host and the actual three-site network path still require a field rehearsal. The disposable loopback [inbox check](../testing/ENCRYPTED_INSTANCE_INBOX_2026-09-27.md) proves the commands work together, not cross-site availability.
