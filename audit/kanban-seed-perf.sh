#!/usr/bin/env bash
# Seed perf-audit-2026-08-21 board with remaining audit findings (card 1 already created: t_871980d6)
set -e
cd /var/home/Ronin/wabi

mk() {
  hermes kanban create "$1" --priority "$2" --body "$3"
}

mk "[P0] FE: split channelMessages god-store into per-channel stores" 1 "Goal: Scope message invalidation to the channel that changed so a message in channel A does not recompute every subscriber of every other channel.

Audit source: perf-audit finding #2 (P0).
Cross-check: single writable Record at messageStore.ts:24; every mutation spreads the whole map (:44,:50,:62). ~15 subscribers (Chat.svelte:112, DMTab, DmHub, TextChannelList, MainLayout...).

Scope:
- Per-channel writables (keyed atom helper); keep socket-manager.ts re-export surface working.
- Mutations touch only the affected channel store.
- Migrate/verify all subscriber components.

Acceptance:
- npm run check: 0 errors (75 pre-existing warnings OK)
- Manual proof: message in one channel does not recompute unrelated channels

Blocked on: nothing."

mk "[P0] FE: MessageList 1s ticker re-processes full history every second" 1 "Goal: Park the deletion-countdown ticker when no visible row has an active deadline; stop re-running filter+slice+dedupe over full array per second.

Audit source: perf-audit finding #3 (P0).
Cross-check: ticker MessageList.svelte:1589-1594 sets nowMs each second; reactive block :1712-1740 re-runs filter->slice->lastByKey->seen on every nowMs change.

Files:
- frontend/src/lib/components/MessageList.svelte (:288, :327, :1589-1594, :1712-1740)

Scope:
- Tick only while >=1 visible row has future deletion deadline; park timer otherwise.
- Derive window from bounded render slice, not full history.
- Coordinate with ingest-dedupe card to end at exactly one dedupe layer.

Acceptance:
- npm run check clean
- Proof derive block does not run per-second when nothing expiring is visible
- Expiring countdowns still render live/correct

Blocked on: nothing (coordinate with dedupe card)."

mk "[P1] wabidb: zero-pad msg id encoding, kill collect-sort-truncate in list_messages" 3 "Goal: Index order == commit_seq order so history queries reverse-iterate + early-exit at limit instead of decode-all + sort + truncate.

Audit source: perf-audit finding #4 (P1).
Cross-check: list_messages scans+decodes all records (projections/messages.rs:200); sort parses hex ids (:330-362) because mixed-width hex breaks index order. Same shape in dm_messages.rs:57 and engine/wabi_store.rs:1080.

Scope:
- Zero-pad new key encodings (msg_{:016x}); migration story for legacy mixed-width rows on disk (lazy rewrite or bounded fallback).
- Bounded reverse iteration + early exit at limit for (channel_id, limit) query.
- Delete the dead sort; do not keep both paths.

Acceptance:
- cargo test -p wabidb passes
- Invariant test: iteration order == seq order across width boundaries (msg_f vs msg_10 vs msg_100000)
- limit=50 query touches O(limit) records (scan-count hook or instrumentation)

Blocked on: nothing. NOTE: touches on-disk key encoding - needs migration story before any Tim deploy."

mk "[P1] BE: delete per-message sleep timers, keep durable retention reaper" 3 "Goal: One retention mechanism. Remove per-message tokio::spawn(sleep(ttl)) timers duplicating the restart-safe reaper.

Audit source: perf-audit finding #5 (P1).
Cross-check: spawn+sleep per auto-delete message socketio/messages.rs:173-186 (cloned handles parked up to 24h); reaper sweeps by policy main.rs:711-742.

Scope:
- Remove spawned timers in socketio/messages.rs (:131 DEFAULT_CHANNEL_AUTO_DELETE_MS, :150-186 spawn).
- Reaper must also do session_messages cleanup AND broadcast message-deleted (what the spawn did); extend if it only deletes today.
- Check api/channels.rs:241 and api/auth.rs:170 paths too.
- Reaper tick must handle seconds-scale TTLs or document the floor.

Acceptance:
- cargo check/test clean
- Test: expired message gone after next reaper tick + message-deleted event fires
- No spawn-per-message left on create path

Blocked on: nothing."

mk "[P1] FE: collapse triple message dedupe into single ingest layer" 3 "Goal: Exactly one dedupe layer on the hot path (socket ingest), removing redundant per-event and render-time passes.

Audit source: perf-audit finding #6 (P1).
Cross-check: three layers - ingest findIndex+merge+dedupeMessagesKeepOrder per event (socketConnectionCore.ts:721-742), MessageList render double-pass (:1728-1739), history-load merge (~:700).

Scope:
- One canonical keep-last-of-key order-preserving dedupe at ingest covering live events + history load.
- Remove render-path pass once ingest guarantees uniqueness; keyed each stays stable.
- Preserve optimistic reconcile semantics (clientMessageId vs server echo).

Acceptance:
- npm run check clean
- Regression test: duplicate echo+broadcast renders once
- Smoke: send/receive/reconnect => no dupes, no losses

Blocked on: nothing (edits same block as ticker card - coordinate)."

mk "[P2] BE: shared reqwest client for Steam status fetches" 5 "Goal: Stop building fresh reqwest::Client per cache-miss Steam fetch.

Audit source: perf-audit finding #7a (P2).
Cross-check: Client::builder().build() inside handler api/steam.rs:197. helper_client.rs models shared-client pattern. anchor/bot_delivery hits were test-only.

Scope:
- Arc<reqwest::Client> in AppState (api/state.rs:100 area), timeout per-request via RequestBuilder.
- Build once at state construction.

Acceptance:
- cargo check clean, steam tests pass
- No Client::builder/new in steam.rs request path

Blocked on: nothing."

mk "[P2] FE: fix unread-count ordering bug in markChannelAsRead" 5 "Goal: Fix global unread badge drift: markChannelAsRead zeroes channel count THEN reads it to decrement global => always subtracts 0.

Audit source: perf-audit finding #7b (correctness).
Cross-check: messageStore.ts:103-104 ordering verified.

Scope:
- Read prior count BEFORE zeroing; subtract from unreadCount.

Acceptance:
- npm run check clean
- Unit test: counts {a:3,b:2}; markChannelAsRead('a') => unreadCount 2

Blocked on: nothing."

echo "--- board after seed ---"
hermes kanban list
