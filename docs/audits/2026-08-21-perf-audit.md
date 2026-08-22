# Wabi Performance Audit — 2026-08-21

**Author:** Hermes session (ox-alpha) · **Method:** static code read, no benchmarks yet.
**Purpose:** durable record of findings + CLAIM LANES so concurrent sessions/workers don't collide. If you're fixing something in this doc, mark the card on kanban board `perf-audit-2026-08-21` and note your lane here before touching files.

## Claim lanes (file ownership)

| Lane | Files | Status |
|---|---|---|
| L1 commit path | `wabidb/src/sequencer/*`, `commit_index/batcher.rs`, `adapter/mod.rs` (run/get_or_create_stream_key) | DONE — peer session, group commit wired (card t_871980d6) |
| L2 idempotency | `wabidb/src/commands/idempotency.rs` + eviction caller site | DONE — this session; bounded table (MAX_RECORDS=100k, evict-before-insert). Committed by peer inside 87b8f7d (t_b0a441b4) |
| L3 HTTP clients | `bot_delivery.rs`, `anchor.rs`, `mesh.rs` client reuse | DONE — this session for bot_delivery (09e2f95); steam by peer (t_8bef244e); anchor/mesh left as low-frequency |
| L4 reaper/timers | `wabi-server/src/main.rs` reaper, `socketio/messages.rs` sleep timers | DONE — peer session (t_219b766b) |
| L5 message queries | `wabidb/src/projections/messages.rs`, adapter list/get paths | OPEN — card t_ee2420fe (fixed-width keys) unassigned |
| L6 presence/init | `socketio/presence.rs` layout cache | OPEN — card t_55544bc2 unassigned |
| L7 frontend stores | `messageStore.ts`, `socketConnectionCore.ts`, MessageList dedupe/render | OPEN — cards t_13934652, t_28bc75b1, t_14d68056 |

### This session's commits
- `09e2f95` perf(server): point lookups + shared webhook client (lanes L3 partial, finding #10)

## Findings

### Backend — write path

1. **Commit batcher is structurally dead.** Sequencer is a strict serial loop (`sequencer/mod.rs:181-206`): each command fully processed incl. `batcher.flush_now().await` (`sequencer/mod.rs:350`) before the next arrives. Batcher config (batch=10 / 50ms, `batcher.rs:1-4`) can never see >1 entry → every write pays a solo fsync. Fix = group commit: submit entry, continue loop, resolve waiters when their batch flushes.
2. **Idempotency table leak.** Every send mints a fresh UUID key (`adapter/mod.rs:195-199`), inserts a 24h-expiry record into an in-memory HashMap (`run_command.rs:115-125`). `remove_expired` (`commands/idempotency.rs:96`) has NO caller outside tests. Insert-only map grows forever per process.
3. **Double key-registry lock per write.** Adapter takes registry mutex (`adapter/mod.rs:113`) AND sequencer again (`sequencer/mod.rs:233`) to short-circuit. Cache known streams locally.
4. **Payload copied ~5× per message** (`adapter/mod.rs:110`, ReplayEnvelope build, encrypt, blake3, per-subscriber `.to_vec()` in `deliver_event` engine/mod.rs:526-540). Consider `Bytes`.
5. **reqwest::Client built per webhook delivery** (`bot_delivery.rs:62`) — new pool+TLS per message-with-webhooks. Reuse one Arc<Client>. Same pattern in `anchor.rs`, `mesh.rs`.

### Backend — reads / maintenance

6. **History query collect-all-sort-truncate ×2 sorts.** `filter_since_and_limit` (`projections/messages.rs:339-362`) scans full channel index, decodes all, sorts by parsed id — which is DEAD WORK since UUID ids make hex-parse fail (all `u64::MAX`), correctness saved only by adapter's second sort on created_at_micros (`adapter/mod.rs:597`). Fix: fixed-width keys (`msg_{:016x}`) → index order == seq order → reverse iterate + early exit.
7. **Secondary-index id override inconsistency.** `extract_keys`/`reencoded_payload` unconditionally rewrite id to `msg_{:x}` (`messages.rs:386-388, 451-453`) while primary apply only rewrites when empty (`messages.rs:243-246`). "byte-consistent" comment is stale since UUID change — VERIFY live data.
8. **Retention reaper burns CPU idle.** Every 60s × all channels × decode+sort up to 1000 msgs (`main.rs:720-760`). Add per-channel cutoff watermark; batch deletes; fewer session_messages lock acquisitions.
9. **Two auto-delete mechanisms.** Per-message 24h sleep tasks (`socketio/messages.rs:169-186`, dead on restart, thousands of parked tasks) + durable reaper doing same job. Kill timers, keep sweep.
10. **Per-message channel lookup does full scan.** `get_channels_raw()` to find ONE channel's kind (`messages.rs:38, :291`; also dm_moderation/shared/direct_calls). Use `get_channel(id)` point lookup (`adapter/mod.rs:676`).
11. **Init re-parses layout JSON per user per connect.** `build_user_view` → `profile_media_for` → serde_json parse of layout_json for EVERY registered user on EVERY socket connect (`presence.rs:77-91, 182-192`). Cache parsed media keyed by user_id+version.

### Frontend

12. **God-store invalidation.** `channelMessages` single Record; every insert spreads whole object (`messageStore.ts:44-51`, `socketConnectionCore.ts:666-746`) → all channels' subscribers recompute on any message. Split per-channel writables.
13. **Reaction handlers scan every channel × every message** (`socketConnectionCore.ts:1277-1310`). Maintain messageId→channel index.
14. **Triple dedupe layers.** Ingest dedupe (`dedupeMessagesKeepOrder`), MessageList reactive block double-pass (`MessageList.svelte:1712-1741`), plus `messageById` rebuilt over FULL array per mutation (:365-370). Keep ingest layer only. Note: 1s nowMs ticker reruns whole filter/slice/dedupe when any deletion deadline exists.

### Philosophy

- Good bones: lock-free SkipMap fast path (`locks.rs:184-201`), strict WAL ordering, crash-point tests, FE burst suppression. Findings are gaps, not absence of discipline.
- Speculative infra never consumed: batcher knobs exist, design docs describe batching, code defeats it. Wire it or delete the config.
- Redundant parallel mechanisms everywhere: two dedupe layers, two reapers, two id schemes, two sorts/query.
- `serde_json::Value` as lingua franca at the adapter boundary erases typed-domain benefit; Value belongs at socket edge only.
- Rule going forward: any insert-only in-memory structure ships WITH its eviction caller or a reaper tick.

## Priority

- **P0:** group commit (or rip batcher config); idempotency eviction caller; reqwest Client reuse.
- **P1:** reaper watermark + batched deletes; drop sleep timers; get_channel point lookups; layout cache; resolve #7 inconsistency.
- **P2:** fixed-width msg keys; single dedupe layer; per-channel stores; reaction index; Value→typed DTOs at seam.

## Verification baseline (TODO)

Before L1 work: throughput loop vs current binary (N sequential sends, p50/p99) so group-commit win is provable.
