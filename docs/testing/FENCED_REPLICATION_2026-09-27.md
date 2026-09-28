# Fenced WabiDB replication ingestion check

**Date:** 2026-09-27  
**Scope:** Disposable same-machine WabiDB engines and sync token guard. This is a development check, not a full Wabi standby or field test.

Focused commands:

```bash
cargo check --locked -p wabidb -p wabi-server
cargo test --locked -p wabidb fenced_replica_validates_and_applies_ordered_segment_extensions -- --nocapture
cargo test --locked -p wabi-server --lib sync_api_requires_experimental_mode_and_exact_token
```

The WabiDB test created two commits in one source stream segment and opened a second engine with the durable local writer fence. The receiver accepted the first segment, rejected a corrupted extension without changing its stored bytes, then accepted the correct extension without truncating the earlier record. The receiver's live projection and applied barrier advanced to the second commit. A duplicate commit was idempotent, a writable source engine and an engine with only an in-memory fence refused peer ingestion, and the durably fenced receiver reopened with the second event still present. The sync API guard test proved that the endpoint requires the explicit experimental switch and exact token.

The receive method validates stream identity and path safety, record offsets, headers, encrypted payload hashes, decryption with the local root key, and replay envelope stream names before it writes. It refuses a conflicting or out-of-order commit. Segment bytes are durable before the index entry is submitted. If projection application fails after indexing, the in-process receiver stops accepting more commits and skips saving a possibly partial projection snapshot; restart must replay the durable log.

This check covers two small WabiDB commits, not the complete Authority recovery unit. Since this check, the sender worker has gained applied-position-based push and a separate [WabiDB-only receiver passed a two-process catch-up check](DB_REPLICA_PROCESS_2026-09-27.md). The push protocol still carries whole segment files in buffered JSON and rescans the commit index per accepted commit; throughput and bounded memory have not been established. Uploads, policy sidecars, identity/configuration, retention/deletion behavior, interrupted transfers, field networks and safe promotion are unproven. No production HA or automatic recovery claim follows from this test.
