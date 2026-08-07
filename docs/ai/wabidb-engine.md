# WabiDB Engine — Core Architecture

WabiDB is an encrypted, event-sourced database embedded in `wabi-server`. It is NOT a key-value store, SQL database, or generic KV engine. Clients submit structured `CommandCommit` messages containing typed events.

## Commit flow

All writes flow through one sequencer:

```
CommandCommit
  → 1. Sequencer (Semaphore(1)) — assign monotonic commit_seq (burned on failure)
  → 2. Segment writes — encrypt (AES-256-GCM) and append to per-stream .wseg files
  → 3. Commit index — build CommitIndexEntry with all StreamRefs, submit to batcher
  → 4. Durability-await — batcher group-flushes, caller waits for fsync
  → 5. Barrier advance — linearizability barrier makes commit visible to readers
  → 6. Projection dispatch — spawn_projection_dispatcher() updates materialized views
  → 7. Response — outcome (including commit_seq) returned via oneshot channel
```

## Storage

| File | Purpose |
|------|---------|
| `.wseg` | Append-only segment files, max ~64 MiB each. Records: 48-byte header + payload + 16-byte padding. Magic `b"WABI"`, CRC32C on header and payload. |
| `.widx` | Global commit index, batcher with configurable batch size/age. Maps events to segment locations. Magic `b"WIDX"`. |
| `.wsnap` | Point-in-time serialized projection state for fast recovery. Magic `b"WSNP"`. |
| `.bin` + `.meta` | BLAKE3-addressed large binary data. Metadata magic `b"BMTA"`. |
| `storage-manifest.json` | Schema version, commit watermark, per-stream metadata. |

## Security

- **Per-stream keys**: each stream has a unique 32-byte key via `register_stream_key()`
- **AES-256-GCM**: event payloads encrypted with `commit_seq` as nonce
- **Key exchange**: double ratchet protocol with X3DH initial handshake
- **Key destruction**: cryptographic deletion for retention compliance

## Projections

In-memory materialized views backed by `crossbeam-skiplist::SkipMap` indexes. Rebuilt from snapshots + commit journal on restart. All read methods hit projections, not raw segments.

## WabiStore trait

`src/engine/wabi_store.rs` — the typed domain API (50+ methods). Two implementations:
- **`WdbAdapter`** (wabi-server) — real engine, writes events via `self.run()`
- **`LocalWabiStore`** (wabidb) — HashMap-backed in-memory store for testing

## Testing

| Layer | Coverage |
|-------|----------|
| Unit | 753+ tests across all modules |
| Property | Proptest round-trips for RecordHeader, CommitIndexEntry, projection records, key encoding injectivity, domain JSON |
| Integration | Full command-commit-readback flows |
| Fuzz | 4 inline targets (RecordHeader, StreamRef, CommitIndexEntry, parse_composite_key) |
| Power-loss | 5 physical subprocess crash tests (one per crash boundary) + 3 logical crash tests |

## Benchmarks

`benches/projection_read.rs` — 24 benchmarks across get/list/compact groups. Each populates 10k records across 100 groups. Run with `cargo bench -p wabidb -- projection_read`.

## Key pitfalls

- **Not a KV store** — no `get(key)`/`put(key, value)`. The API is command/event-based.
- **No SQL** — no MVCC, bloom filters, or WAL.
- **Single-threaded sequencer** — write throughput bounded by single-core commit processing.
- **Projections are in-memory** — large datasets may have slow recovery.
- **Batcher restarts from widx_number=0** — stale `.widx` files can conflict after unclean shutdown.