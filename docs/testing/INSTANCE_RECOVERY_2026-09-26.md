# Disposable instance recovery rehearsal — 2026-09-26

**Scope:** stopped, whole-instance copy and encrypted export/isolated restore of a disposable single Authority. This is a development check, not a three-site or production-data recovery certification.

## Run

```sh
cargo build --locked -p wabi-server --bin wabi-server
node scripts/authority-backup-restore-smoke.mjs --binary /home/ironin/wabi/target/debug/wabi-server

cargo build --locked -p wabi-server --bin wabi-instance-snapshot
node scripts/authority-backup-restore-smoke.mjs \
  --binary /home/ironin/wabi/target/debug/wabi-server \
  --snapshot-binary /home/ironin/wabi/target/debug/wabi-instance-snapshot
```

The run passed on 2026-09-26 at 15:19 UTC. The tested binary SHA-256 was `e45adc133000d5cfbae05c8233683bab4eef43faf074ca736e5277d0c0cbb2d4`. The fixture snapshot contained 19 files and 13,379 bytes across `data/` and `uploads/`. The script compared every file's relative path, size, and SHA-256 from stopped source to snapshot to clean restore. The canonicalized file-list hash was `f3e97f5e72923bedeac58782e70a6c92580ff97d0e60466aebdcca27a6cdcd74`.

The same run verified the owner account and original session, retained pre-snapshot message, completed upload, stable key files, absence of a later source-only message from the snapshot, and successful message/upload writes after restore and a second restart.

The second run passed at 15:33 UTC with the same Authority binary. The snapshot tool encrypted the stopped source into an age archive, decrypted into a new private directory, and compared all 19 restored files by relative path, size, and SHA-256. This run's fixture totaled 13,363 bytes and its file-list hash was `7d182ef606fd64a75e2c1a7d98e44828bf8046cc088b312e7d4cc1a150f4634e`. The restored Authority served the original account, retained message, and uploaded bytes through its API. The unencrypted stopped-copy and later-write checks still passed in the same run. The age identity and archive had mode `0600`; the restored root had mode `0700`, and the restored JWT secret had mode `0600` on this Linux host. The local evidence report is `/tmp/wabi-authority-restore-cxzjWc/report.json`.

The snapshot binary's eight focused unit checks passed. They cover an external uploads tree, uploads nested in the data tree, lock refusal, corrupt archives, unsafe archive paths, source symlinks, a wrong recovery identity, and a preexisting dangling symlink at the restore target. The archive format accepts colon-containing WabiDB stream names on Unix.

The focused encrypted standby-store checks also passed (4 tests). The receiver now writes a complete encrypted envelope before publishing its snapshot ID and refuses a replacement with the same ID. This checks storage behavior only; the envelope is not a complete WabiDB restore payload.

## Limits

The source and restore used the same local binary on loopback and disposable data. The run did not cover a physical second host, external secrets, plugins, Lore storage, ongoing uploads, real network ingress, or a live snapshot. It did not test a release upgrade, standby promotion, writer fencing, client redirect, regional room ownership, or automatic failover. A historical whole-instance archive can contain material later deleted or expired. The [instance recovery inventory](../architecture/INSTANCE_RECOVERY_INVENTORY.md) lists state that a future complete standby path must cover.
