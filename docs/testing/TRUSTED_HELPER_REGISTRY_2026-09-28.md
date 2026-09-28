# Trusted helper registry check

**Date:** 2026-09-28 (Asia/Bangkok)  
**Scope:** Current working tree, focused local checks; no multi-host election or standby promotion.

The Authority's `node_registry.json` contains pairing tokens, node secrets, granted capabilities and revocations. Startup now rejects an existing unreadable, malformed or nonregular registry instead of loading an empty one. On Unix, an existing readable registry is narrowed to mode `0600` if needed, and new saves use a private temporary file, file sync, rename and parent-directory sync. A failed save does not publish the candidate mutation to the live registry. Helper heartbeats may report load and reachability but cannot add a capability that the operator did not grant at pairing.

Verification:

```text
CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --lib nodes::tests
10 passed; 0 failed

CARGO_INCREMENTAL=0 cargo check --locked -p wabi-server --bin wabi-server
passed (existing worktree warnings)
```

The focused cases include a damaged registry, narrowing an existing file's permissions, rejection of a symlinked registry, private credentials surviving restart, failed-write rollback, an attempted self-grant of `Standby`, valid heartbeats, single-use pairing and revoked-node rejection. They do not establish quorum membership, writer fencing, recoverable state or automatic failover. The experimental replication sidecar lane can copy this file, but it has no shared checkpoint with WabiDB; operators still need a verified complete-state recovery path.
