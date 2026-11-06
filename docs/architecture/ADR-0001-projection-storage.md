# ADR-0001: Where WabiDB's read model lives

- **Status:** Accepted, 2026-11-06 (proposed and accepted the same day, after the Task 0.1 spike).
- **Inputs:** [backend audit §6](../plans/2026-11-06-backend-audit-wabidb-lore.md#6-the-strategic-question-is-wabidb-worth-keeping); spike branch `spike/messages-projection-sqlite` (`core/crates/wabidb/benches/messages_sqlite_spike_RESULTS.md` has the full table, method and caveats).

## Context

WabiDB is an application-specific event store: one sequencer appends AES-GCM-encrypted records to per-stream segments and a global commit index, and fsyncs both before acknowledging a write. Everything the server reads comes from 52 projections held entirely in RAM as skip maps, rebuilt at startup from a plaintext JSON checkpoint (`projections/snapshot.json`, rewritten in full every 1,000 commits) plus replay of the log. The server reaches all of it through the `WabiStore` trait, which is the seam this decision is about.

## Decision

**Option B.** The WabiDB log stays the source of truth. Projections move to SQLite behind `WabiStore`. Each commit's projection changes go in one transaction, and each projection keeps its own `applied_commit_seq` row, used as its replay watermark. The SQLite file is derived: deleting it and restarting rebuilds it from the log. A config flag keeps an in-memory read model (`:memory:` or tmpfs) for operators who want nothing derived on disk.

The numbers support B. A required B to be clearly worse with no RAM or startup benefit. B matches the current engine on reads and tail writes, uses about a fifth of the RAM, and its one regression is cold rebuild time. The spike moved only the messages projection (1,000,000 messages in 50 channels; 4 vCPU / 15 GiB VM; page cache dropped before every startup):

| | In-memory (today) | SQLite (spike) |
|---|---:|---:|
| Cold startup, full replay of the log | **48.6 s** | 222.1 s |
| RAM after cold startup | 3,373 MiB | **654 MiB** |
| Normal restart from own checkpoint / RAM after | 39.7 s / 4,252 MiB | **6.6 s / 125 MiB** |
| `send_message` p50 / p99, 8 writers | **3.9** / 27.8 ms | 4.6 / **26.8** ms |
| `send_message` worst call / wall time for 16,000 sends | 46 s / 440 s | **44 ms / 12.9 s** |
| `list_messages_page`, 50 msgs, p50 / p99 (newest; random older cursor) | 0.046 / 0.078; 0.055 / 0.090 ms | 0.039 / 0.088; 0.050 / 0.105 ms |
| Peak RAM over the run; clean shutdown | 13,630 MiB; **killed for memory** | **1,198 MiB; 0.02 s** |

The deciding fact is not the median: at 1M messages, today's engine stalls writes for tens of seconds at every full-state checkpoint and cannot shut down cleanly on 15 GiB.

## The three strongest arguments against, and why we accept them

1. **Rebuilding from the log gets 4.6× slower (222 s vs 49 s at 1M messages).** A lost SQLite file or a table-changing migration pays it. *We accept it because* rebuilds are rare (a normal restart is 6.6 s, against 39.7 s today), and the spike deliberately used one transaction per replayed commit; batching replay is an untried, obvious fix that the plan below requires.
2. **Two stores means two ways to be wrong.** The log and the read model can disagree, and there is now a watermark per store instead of one. *We accept it because* the read model is derived, with one recovery rule: delete it and replay. The spike left `replay.rs` unchanged and has a test that deletes the SQLite file and gets identical answers. Today a bad checkpoint has no repair tool at all (audit W3).
3. **Long migration, a C dependency, and plaintext on disk.** 52 projections behind a 4,258-line adapter, a half-migrated period, and bundled SQLite writing an unencrypted file. *We accept it because* the work moves one projection per PR behind an existing seam, and the read model is already plaintext on disk today (a 3 GB `snapshot.json` at 1M messages, audit W5); the in-memory flag covers operators who must not have derived data on disk.

## What would make us revisit

Measured with the spike benchmark (or its successor) on the same class of machine, reconsider B if any of these holds:

- Cold rebuild of 1M messages stays above **100 s** (about 2× today's 48.6 s) after replay is batched.
- `send_message` p50 under SQLite is more than **2 ms** above the in-memory engine, or p99 is more than **25 %** above it, measured over at least three runs.
- `list_messages_page` p99 for a 50-message page exceeds **1 ms** at 1M messages (it is 0.105 ms now).
- After channels, channel_members and users have moved, resident memory after startup is not at least **3×** lower than the in-memory engine on the same data (it is 5.2× for messages).

## Consequences for the backend plan

- **Phase 1 adds two items, independent of A or B.** (a) Past 100,000 commands in 24 h, `CommandIdempotencyTable::insert` scans and sorts every entry on each write (`commands/idempotency.rs`); spike data generation fell from 65 s to 52 min per 100k messages. (b) Replay holds every event in memory before applying (1.2 GiB peak at 1M messages, even under SQLite).
- **3.3:** delete `snapshot.json` writing and loading; each SQLite file is its own checkpoint. The 0600 mode and the in-memory flag land here.
- **3.4** (W7) folds into the messages migration: SQL indexes replace the skip-map indexes it fixes.
- **3.5** starts from the spike's pattern (store attached to `ProjectionState`, per-projection watermark, transaction opened lazily per `commit_seq`, rebuild-by-delete test), with batched replay first. The spike's opt-in marker file is not the config flag.
- **3.1 is still required.** Replay still decodes postcard payloads from the log, so unversioned records (W8) can still break startup under B.
- **Not fixed by B:** W14 (the whole commit index is re-read at startup; most of the 6.6 s restart) and W23 (one time-index row per edit; the spike kept that schema). W15 and W16 shrink with each projection moved and end when the last one leaves `snapshot.json`.
