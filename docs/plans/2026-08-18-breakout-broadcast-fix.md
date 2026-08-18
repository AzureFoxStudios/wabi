# 2026-08-18 — Breakout Rooms + Broadcast on the wabidb Default Transport

Follow-up to the 2026-08-18 calling/screensharing audit. Both features were
originally built against the P2P group-call path; when the default transport
switched to wabidb (opus over socket.io), neither was re-wired, and the
breakout sidebar UX was additionally dead because `isBreakout` never reached
clients. This card makes both function end-to-end on the default transport.

## What changed

### Server (`core/crates/wabi-server/src/socketio/`)

- **`voice-self-moved` events** — `move_voice_participant` now returns the
  moved `VoiceParticipant`; `on_move_user_to_breakout`,
  `on_move_user_to_voice_channel`, and `on_close_breakout_rooms` emit a
  targeted `voice-self-moved { fromChannelId, toChannelId }` to the moved
  user's socket. The roster move alone never re-tuned the client's media
  session — audio stayed in the old channel's `channel:{id}` wabidb session.
- **`merge_breakout_flags`** — the init snapshot builder (presence.rs) now
  merges in-memory breakout metadata (`isBreakout`, `parentChannelId`,
  `breakoutIndex`) onto channel views. Previously NOTHING set `isBreakout`
  server-side, so sidebar grouping and the "Close Breakout Rooms" menu item
  could never appear. Live marking flows through the (already emitted)
  `breakout-rooms-created` event, which previously had no client handler.
- **Auto-assign is real** — `on_create_breakout_rooms` round-robins the
  parent channel's primary members into the new rooms (via the same move +
  notify path). Pure assignment in `assign_breakout_round_robin` (unit
  tested).

### Client (`frontend/src/lib/`)

- **`handleForcedVoiceMove`** (calling_impl_core.ts) — handles
  `voice-self-moved`: drops the old channel's relay/subscription, swaps the
  primary channel (or re-tunes listen-only), reconnects the wabidb relay
  (capture suppressed while a DM/group call is active, mirroring
  joinVoiceChannel's TeamSpeak-style listenOnly rule), keeps LiveKit parity,
  re-asserts `all-listening` transmit mode after the server-side join resets
  it, and surfaces a "Moved to …" notice.
- **`breakoutChannels.ts`** (new) — pure upsert/remove helpers for the
  breakout-rooms-created/closed socket events, wired in
  socketConnectionCore.ts (unit tested).
- **`BreakoutRoomsModal.svelte`** (new, runes) — replaces the raw
  `window.prompt` for room count; validated 2–20, auto-assign checkbox.
- **Broadcast on wabidb** — `WabidbMediaRelay.setCapture()` starts/stops the
  opus encoder without touching the receive path; `connectWabidbCall`
  captures on listen-only channels when transmit mode is `all-listening`;
  `syncWabidbCapture()` is called from `syncLocalAudioState`, so transmit
  routing, mute, and deafen now gate the wabidb transport identically to
  WebRTC/LiveKit (previously mute on wabidb only silenced the track —
  `outbound-only` mute behavior was not enforced at all).
- **Broadcast badge** — VoiceUserCard shows "Broadcasting to N channels"
  when all-listening is active on >1 channel and not muted.

## Tests

- Server: `assign_breakout_round_robin` unit tests (breakout_ops_tests);
  full `cargo test -p wabi-server` green (98 lib + 107 integration).
- Frontend: `breakoutChannels.test.ts` (6 tests); full `bun test src/lib`
  green (74 tests); `bun run check` 0 errors; `STATIC_BUILD=1` build green.
- Manual matrix (2 browsers + server, real browser per rule #7): create
  breakouts → rooms grouped, auto-assigned users' audio follows; drag-move a
  user → their audio re-tunes; all-listening transmit → mic audible in all
  subscribed channels; close breakouts → everyone returns with audio.

## Known limitations (deliberate)

- Breakout metadata is in-memory (`state.breakout_rooms`): after a server
  restart, open breakout rooms persist as ordinary (ungrouped) voice
  channels and "Close Breakout Rooms" is unreachable until deleted
  manually. Persisting the flag would require a Channel record change
  (golden rule #5 dual-decode work) — deferred.
- `breakout-rooms-created/closed` still broadcast server-wide, consistent
  with channels being globally visible. Tighter scoping awaits channel
  visibility/permissions work.
- The audit's P0 security items (auth/membership on `wabidb-media`, scoped
  P2P screenshare) remain open and matter more once breakouts multiply
  session rooms.

## Files touched

- `core/crates/wabi-server/src/socketio/breakout_ops.rs`
- `core/crates/wabi-server/src/socketio/presence.rs`
- `frontend/src/lib/calling_impl_core.ts`
- `frontend/src/lib/calling.ts`
- `frontend/src/lib/callingWabidb.ts`
- `frontend/src/lib/wabidbMediaRelay.ts`
- `frontend/src/lib/socketConnectionCore.ts`
- `frontend/src/lib/breakoutChannels.ts` (new) + `breakoutChannels.test.ts` (new)
- `frontend/src/lib/components/BreakoutRoomsModal.svelte` (new)
- `frontend/src/lib/components/ChannelSidebar.svelte`
- `frontend/src/lib/components/sidebar/VoiceUserCard.svelte`
