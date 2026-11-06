# Spike results: messages read model, in-memory vs SQLite (Task 0.1)

Throwaway branch `spike/messages-projection-sqlite`. Do not merge. Run on 2026-11-06.

**Dataset:** 1,000,000 messages across 50 channels, written through the real engine (sequencer, encrypted segments, commit index, room-owner precondition) in 712 s. Log on disk: 1,246 MiB. Both engines started from byte-identical copies of that log.

**Machine:** 4 vCPU Intel Xeon @ 2.10 GHz (cloud VM), 15 GiB RAM, process memory cgroup limit ≈ 15 GiB, ext4 on a virtio disk (`/dev/vda`), Linux 6.18.44, Ubuntu 24.04.5, Rust 1.93.1 release build, tokio multi-thread runtime with 4 workers. The OS page cache was dropped before every startup.

| Measurement | Current engine (in-memory skip maps) | Spike (SQLite read model) |
|---|---:|---:|
| Startup, cold data directory (log only, full replay) | **48.6 s** | 222.1 s |
| Resident memory after startup | 3,373 MiB | **654 MiB** |
| Peak resident memory during startup | 3,876 MiB | **1,198 MiB** |
| `send_message` p50, 8 concurrent writers | **3.9 ms** | 4.6 ms |
| `send_message` p99, 8 concurrent writers | 27.8 ms | **26.8 ms** |
| `list_messages_page` p50, 50 messages, newest page | 0.046 ms | **0.039 ms** |
| `list_messages_page` p99, 50 messages, newest page | **0.078 ms** | 0.088 ms |
| `list_messages_page` p50, 50 messages, before a random older message | 0.055 ms | **0.050 ms** |
| `list_messages_page` p99, 50 messages, before a random older message | **0.090 ms** | 0.105 ms |
| *Extra:* `send_message` worst single call | 46,015 ms | **44 ms** |
| *Extra:* wall time for the 16,000 measured sends | 440 s | **12.9 s** |
| *Extra:* peak resident memory over the whole run | 13,630 MiB | **1,198 MiB** |
| *Extra:* clean shutdown | **killed for memory** | 0.02 s |
| *Extra:* read model on disk | 3,016 MiB (`snapshot.json`, plaintext) | 901 MiB (SQLite + WAL) |
| *Extra:* normal restart from its own checkpoint | 39.7 s | **6.6 s** |
| *Extra:* resident memory after normal restart | 4,252 MiB | **125 MiB** |
| *Extra:* peak resident memory during normal restart | 7,513 MiB | **548 MiB** |

## Method

- `cargo bench -p wabidb --bench messages_sqlite_spike` builds the binary; `benches/messages_sqlite_spike.sh <dir>` runs everything. Each step is a separate process, so resident memory belongs to that step alone (`VmRSS` / `VmHWM`).
- Writes use the same command `WdbAdapter::send_message` builds: stream key, room-owner precondition, one `message_created` event, command idempotency key. 8 writers × 2,000 sends, each to a random one of the 50 channels. Latency covers the whole call, through durable commit and projection application.
- Reads: 5,000 newest-page reads on random channels, and 5,000 reads of the page before a random message sampled from the whole history (every 500th generated message). These run single-threaded on an idle engine, before the writes.
- Read latency is measured on the projection call (`MessagesProjection::list_messages_page`), which is what `WdbAdapter::list_messages_page` calls.

## What the numbers say

- **Reads are a wash.** Both engines serve a 50-message page in well under 0.1 ms at p50.
- **The median write costs SQLite about 0.7 ms more; p99 is the same.** Both are dominated by the two fsyncs per group commit.
- **The current engine's tail is unbounded at this size.** Every 1,000 commits it serializes the whole read model to JSON under the application lock (audit W15). At 1M messages that is a 3 GB write: one send waited 46 s, the 16,000 sends took 34× longer end to end, memory peaked at 13.3 GiB, and the final checkpoint on shutdown was killed for memory. An earlier full run of the same benchmark was killed for memory during the write phase. The current engine cannot run this dataset on this 15 GiB machine without crashing on shutdown.
- **SQLite's cold replay is 4.6× slower (222 s vs 49 s).** This is the "one transaction per commit" rule applied to 1,000,000 replayed commits; the task said not to optimize it. Batching replay commits into larger transactions is the obvious next step and was not tried.
- **SQLite's normal restart is 6.6 s and 125 MiB.** It is not near zero because replay still reads the whole commit index and walks every segment even below the watermark (audit W14). That is unchanged by the spike.

## Caveats

- The dataset was generated without the command idempotency key. Past 100,000 keyed commands, `CommandIdempotencyTable::insert` scans and sorts all entries on every write (`commands/idempotency.rs`, already on `main`). That would have turned generation into ~8 hours (measured: 65 s for the first 100k, 52 min for the second). The measured sends do carry the key, and the table starts empty in each process.
- 16,000 measured sends means the current engine hit about 16 full checkpoints; its p99 does not reflect them because each checkpoint stalls only the few sends in flight. Its worst-case and wall-time rows do.
- Only the messages projection moved. Every other projection still lives in RAM and in `snapshot.json` in both columns.
- One machine, one run each. No variance measured.
- Timestamps in the dataset span about 12 minutes; a real history spans years. Page queries depend on per-channel order, not on the span, so this should not change the read results.
