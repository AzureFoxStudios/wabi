# Encrypted instance inbox disposable check

**Date:** 2026-09-27  
**Scope:** Current working tree; disposable local files and loopback receiver only.

Commands run:

```bash
cargo test --locked -p wabi-server --bin wabi-instance-inbox
cargo test --locked -p wabi-server --test instance_inbox_contract
```

The binary suite passed four focused cases: public HTTP endpoint refusal; token authorization, immutable archive IDs and authenticated fetch; corrupt/oversize upload rejection without publication; and loopback send/fetch. The contract test passed one end-to-end case: a stopped fixture with WabiDB key files, a sidecar, and a 256 KiB upload was exported by `wabi-instance-snapshot`, sent to the separate inbox process, fetched, and restored. The encrypted stored and fetched bytes matched the source archive; the restored sidecar and upload matched the fixture. The CLI reports transferred bytes and elapsed time for operator runs.

The loopback tests needed local socket permission beyond the default sandbox and passed with that permission. No external host or operator data was used.

This does not prove a running-server checkpoint, a complete hosted installation with external secrets/plugins, restore on a second physical machine, a three-site path, incremental catch-up, deletion-safe replication, live projection convergence, or safe promotion after a node fails. An inbox item is a stopped backup, not an eligible live standby.
