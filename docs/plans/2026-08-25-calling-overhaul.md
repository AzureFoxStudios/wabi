# Calling Overhaul — 2026-08-25 ("9th attempt, do it right")

SoT for the full calling rework. Audit history: `2026-08-24-calling-audit-fixes.md`
(P0–P2 + T1–T4 all shipped at `232dea4..9acce88`). This doc is the next phase.

## Locked decisions (Ronin, 2026-08-25)

1. **Replace the middle, keep the ends.** Keep: transport adapter registry +
   fallback chains + watchdog (built this week), dual-source `wabidbVideoLane`,
   backend roster broadcast, TURN, sounds engine, recording suite. Replace:
   `calling_impl_core.ts` orchestration + `CallModal.svelte` shell → multi-session
   `CallSessionManager` + runes-mode UI. The current "one primary + listening[]
   + bolted-on DM call" model cannot express N concurrent calls with
   focused/background/silenced states.
2. **Security bar: auth + membership hardening only.** No relay E2EE this pass
   (p2p stays DTLS-SRTP; relayed media is server-readable like Discord's
   non-E2EE servers — documented in the threat model below).
3. **Voice view = dedicated `voice` workspace view** in `WorkspaceViewBar`
   (1 click from any channel, 1 click back).
4. **Spatial: drag avatar chips = set 3D pan position**, active only when
   spatial hearing mode is ON (default off). Personal layout per channel
   (localStorage). Auto-circle = default seating. Playful physics deferred.

## Security findings (Phase 1 work list)

- **SEC-1 (Critical)** `wabidb-media` relay (`socketio/media_reactions_signaling.rs`):
  `join-wabidb-call` joins any socket to any `wabidb-call-{sessionId}` room — no
  membership check, no identity requirement (guests allowed). Envelopes carry a
  client-supplied unverified `userId` → spoofable speaker attribution,
  eavesdropping, media injection. No rate/size limits.
- **SEC-2 (High)** `/api/media/rooms*` (`api/media.rs`): create/list/get/assign/
  close/mark-active fully unauthenticated; `assign_room` has no admin check.
- **SEC-3 (Medium)** `webrtc-offer/answer/ice`, `call-answer-sdp`,
  `call-ice-candidate`: no consent/relationship check — any socket can push SDP
  at any other socket.
- **SEC-4 (Low)** `start/stop-screen-share` broadcasts to ALL users globally.
- OK: TURN = ephemeral HMAC-SHA1 behind `AuthUser` (`api/auth.rs:713`);
  socket handshake validates JWT when present (empty-token guests stay
  connected — media events must reject them explicitly).

## Discord fluidity research (goal 2)

Discord clients never poll occupancy: every join/leave/mute broadcasts
`VOICE_STATE_UPDATE` over the gateway; clients keep a local voice-state cache
and diff `channel_id`; initial state arrives with subscribe/READY. Wabi's
backend already does this (full-roster `voice-channel-state` on
join/subscribe/leave + disconnect sweep — verified 08-24). Goal 2 is therefore
client-side: optimistic self-membership on click, connecting→connected badge,
per-call sounds, keep P0 reactivity tripwires green.

## Phases

### Phase 1 — Backend security hardening (goal 1) — FIRST, independent
1. `join-wabidb-call`: derive membership server-side — verify caller identity
   (`resolve_sio_identity`) is in `state.voice_channels` for the target channel
   (or in an active call session); reject guests from media rooms.
2. `wabidb-media`: stamp `userId` from socket identity (ignore client field);
   verify room membership before relay; per-socket rate limit (msgs/s + bytes)
   with drop counters.
3. `/api/media/rooms*`: `AuthUser` everywhere; assign/close/mark-active
   admin-gated; list scoped.
4. Signaling consent: `webrtc-*` + `call-answer-sdp`/`call-ice-candidate`
   require shared voice channel or active DM call relationship.
5. Screen-share events scoped to the call room, not `io.broadcast()`.
6. Integration tests per finding; `cargo test -p wabi-server`.

### Phase 2 — Multi-session CallSessionManager (goal 4)
**Status 2026-08-25: COMPLETE.** `callSessionTypes.ts` (types + sessionBadge +
`directCallSessionId`), `callSessionManager.ts` (manager + stores, focus
handoff, audio bindings hook, 12 contract tests), `callAudioGraph.ts` (shared
48kHz AudioContext, per-session gain→panner→master, browser-guarded without
$app/environment so bun tests can import it), `callSounds.ts` per-call
attribution. All call surfaces registered: channel join/leave/move,
group `enterEstablishedGroupCall`, DM `beginEstablishedDirectCall` +
`answerCall`; teardown via `teardownCallSessionOnly` (direct/group only,
surviving channel inherits focus) and `finalizeLocalCallEndState` (all).
Wabidb relays now create their playback worklet IN the shared context and
attach to the per-session chain (`audioSessionId` = manager session id:
channelId for channels/groups, `direct:{peer}` for DMs — matches legacy
`directCallSessionKey`); relay stop disposes the chain but never closes the
shared context. Volume/mute changes flow manager → graph via
`bindCallSessionAudio` (wired in callingWabidb.ts). Socket roster events fire
attributed join/leave sounds for connected channels only.
- `CallSession` per connected call: kind channel/direct/group, transport
  instance, direction transmit|listen, focus focused|background|silenced,
  volume 0-100, muted/deafened, participants, streams, spatialSeats, lifecycle
  state. Exactly one focused session; broadcast transmit toggle kept.
- ONE shared AudioContext; per-session GainNode → optional panner → master.
  wabidb relay audio rerouted through this graph (enables wabidb spatialization).
- Per-call sounds: attribution (pitch/pan per session, volume follows session).
- Mic/cam/screen captures stay singletons; sessions attach/detach transmitters.
- DM/group calls migrate into the same session model (signaling unchanged).
- Old exports shimmed via `calling.ts` during migration.
- Tests: session state machine, sound attribution, audio graph, tripwires.

### Phase 2.5 — Session-model hardening (2026-08-25, COMPLETE)
Three lifecycle paths that bypassed the session model, closed so Phase 3/4
UI never reads stale state:
1. **Forced kick/leave** (`handleForcedVoiceLeave`, `voice-self-kicked`):
   unregisters the session + disposes its audio chain, attributed leave sound.
2. **Watchdog transitions**: one module-level `transportWatchdog.onTransition`
   subscription in callingWabidb (serving `activeWatchdogSessionId`, the
   audioSessionId of the most recent wabidb connect, cleared on disconnects):
   `demoting` → markReconnecting, `demoted`/`monitoring` → markConnected on
   `riding` (the fallback link or healed primary). `stopped` deliberately
   ignored (fires on both total loss and normal re-arm).
3. **Roster snapshots**: `voice-channel-state` full rosters now populate
   session participants (not just incremental join/left), so fresh clients
   render full participant lists immediately.

### Phase 3 — Focused stage (goal 3)
**Status 2026-08-25: LANDED.** `CallStage.svelte` (runes) renders for channel
mode inside CallModal: participant avatar chips (speaking rings, mute icons,
listen-only style), camera tiles + screen hero filtered to the focused
session's users (the wabidb video lane store is global — keys
`userId:camera|screen`), local mirrored preview, empty-state hint. DM calls
keep the legacy grid this pass. The spatial quick toggle is wired (◎ button
in both the docked bar and the in-shell toolbar — was dead code).

Spatial seat stage: visible when spatial hearing is on (◎ Seats toggle) —
draggable avatar chips on a top-down stage (world ±6 x/z → %), listener at
center. Drag → `applySpatialSeat` = persist (localStorage per call,
`wabi:spatial-seats:{id}`) + session model + BOTH audio paths live: p2p
spatial engine (`call:{userId}`) and the wabidb relay's per-user chain.
Double-click resets to auto-circle. Manual seats survive re-registration.

Relay per-user spatialization: one playback chain per REMOTE user
(worklet→panner→gain→session input) instead of one mixed worklet — this is
what makes per-user panning possible for relayed audio. Seats default to
center until positioned; auto-circle default applies via the stage and p2p
path. `setWabidbSpatialPosition(graphSessionId, …)` looks relays up by
graph/session id (relays double-indexed by channel key + graph id).

Deferred to a later pass: pin/hero interactions on CallStage tiles,
presenter overlay on channel mode, DM-mode CallStage.
- Runes `CallStage.svelte`: avatar chips, camera tiles, screen hero (reuse
  `callLayoutManager`/`callRenderModel`/`wabidbVideoLane` keys).
- Spatial stage: drag chips → `spatialSeats` + `spatialEngine.updateSourcePosition`
  real-time; auto-circle default; persists per channel; works for wabidb + p2p.
- Wire the in-call spatial quick toggle (dead code today).

### Phase 4 — Voice view + right-panel controller (goal 5)
**Status 2026-08-25: LANDED.** Dedicated `voice` workspace view (first pill in
WorkspaceViewBar, 1 click from any channel): `VoiceView.svelte` renders
connected-call cards (badge focused/background/silenced, transport, live
video thumbs incl. screen shares, participant avatar row with +N overflow,
per-call volume slider, per-call speaker mute, Focus switch, Hang up) plus a
joinable list of every voice channel with live occupancy, and the global bar
(Mute All / Deafen All / Camera Off / Leave All). View state =
`voiceViewOpen` store; addon tabs take precedence and the view returns when
they close.

Right panel: `calls` workspace panel (`CallsPanel.svelte` — compact per-call
cards with badge/transport/avatars/controls/volume, right-docked default,
mobile sheet). Not in DEFAULT_WORKSPACE_PANEL_IDS — add via the panel picker
(the mockup's "extended controller").

Both surfaces share `callSurfaces.ts` semantics (join/leave/focus/volume/
speaker-mute/global bars) driving the SAME session model + audio graph.
- `voice` workspace view → `VoiceView.svelte`: live cards per voice channel,
  focused card with tiles, background/silenced with volume, connect/leave,
  Mute All / Deafen All / Leave All.
- `calls` panel in `workspacePanels.ts`: per-call cards, badges, avatars,
  per-call controls + volume.

### Phase 5 — Fluidity + ship gates (goal 2)
**Status 2026-08-25: COMPLETE (code).** Optimistic self-membership: the chip
renders on click before the server echo; a failed join rolls the chip back
AND mirrors the already-sent presence emits (leave/unsubscribe) so every
roster converges. Connecting→connected badge on the sidebar VoiceUserCard
from the session model (Connecting… / n-of-N / Connection trouble). Tripwire
suite extended: the four new runes components must compile with ZERO
`$.untrack(` windows (probe-verified), VoiceView/CallsPanel must bind
`$callSessions`, and the new stores joined TRACKED_STORES. Gates green:
`bun run check` 0 errors · `bun test` 168 pass · `cargo test -p wabi-server` ok.

**Live smoke checklist (with Ronin, 2 real browsers — headless can't render):**
1. Security (P1): uninvited account `join-wabidb-call` for a foreign channel →
   `wabidb-call-denied` + server DENIED log; spoofed `userId` rewritten;
   unauth `/api/media/rooms` → 401/403.
2. Relay audio (P2): voice channel join audible through the SHARED context;
   second channel listen-only mixes; per-call volume slider in voice view
   actually changes loudness; DM call still works.
3. Sessions (P2/2.5): end DM call while in a channel → focus returns to the
   channel; kick from a channel → card disappears everywhere; kill tab →
   rosters converge.
4. Stage (P3): focused channel view shows chips + camera/screen tiles;
   spatial on → ◎ Seats → drag pans that speaker LIVE (wabidb + p2p);
   seats persist across reload.
5. Surfaces (P4): voice pill opens the view from any channel and back;
   cards show correct badges; Leave All leaves everything; calls panel via
   panel picker shows the same cards.
6. Fluidity (P5): join click → own chip appears instantly; Connecting… badge
   while transport establishes; join/leave bleeps attributed per call.
- Optimistic self-chip, connecting→connected, occupancy counts, per-call sounds.
- Full regression suite, `bun run check`, `cargo test`, 2-client live smoke
  (real browser — headless cannot render Wabi). Scoped commits. No push/deploy
  without the word.

## Threat model note (post-Phase-1)

- p2p/SFU calls: DTLS-SRTP end-to-end between peers (server sees signaling only).
- wabidb relay calls: media transits the server in the clear over authenticated
  WSS; the server CAN inspect relayed media. Membership is enforced; identities
  are server-attested. E2EE for relayed media is a future opt-in (SFrame-style).
- **Open item (2026-08-26 review, F7):** `p2p-offer/answer/ice-candidate`
  (file-transfer signaling) still route SDP to any connected socket with no
  consent check — the same class as SEC-3. NOT hot-fixed: file transfers
  legitimately run between DM partners with no active call, so gating on call
  relationships (voice roster / group session / DM call link) would break them.
  Proper fix needs its own consent primitive (shared-DM-channel lookup with a
  cache, or a target-accept prompt). Until then the exposure is bounded: it
  initiates file-transfer PC offers, not media-call injection, and socket ids
  are only learnable from voice rosters.

## Review pass (2026-08-26, max-mode audit of P1–P5)

Findings fixed:
- **F1** CallStage's session-switch `$effect` re-ran on every session-object
  mutation (roster snapshots, volume ticks) — the seat stage slammed shut
  mid-drag and seats reloaded. Now guarded on actual id change.
- **F2** Relay playback chains are lazy (created on first decoded audio), so
  seats set for silent users were silently dropped. `pendingPositions` buffer
  applied at chain creation.
- **F3** Restored localStorage seats and the auto-circle never reached the
  audio paths on mount — only on the next drag. CallStage now applies all
  seats (audio-only) on mount, roster change, and spatial toggle.
- **F9 (found during F3)** bulk seat application wrote through
  `applySpatialSeat`, which (a) persisted auto-circle layouts as frozen manual
  seats and (b) re-triggered the applying effect via store→prop→derived
  identity chains — an infinite churn loop with a localStorage write per cycle.
  Split: `applySpatialSeatToAudio` (audio paths only) for bulk use; full
  persist remains on real drags.
- **F4** DM/group sessions never populate participants (roster events are
  channel-only) — their cards showed empty avatar rows. Both surfaces fall
  back to the live p2p `activeCalls` list.
- **F6** After a main-socket reconnect the server's socket.io rooms are gone —
  relayed media was denied while the watchdog's probe (separate wabiDb
  connection) falsely reported healthy. `rejoinWabidbCallRooms()` now re-emits
  `join-wabidb-call` for every live session at the end of the drain replay
  (presence first, media rooms second — the Phase-1 ordering).
- **F8** `screen_share_audience` held three read guards across the consent
  scan; now snapshots + drops the connected lock first (tokio RwLock is
  write-preferring — a pending writer on one guard must never park a task
  holding the others).

Verified safe (no change needed): media rate-limit math vs the video lane's
real envelope rate (16 KiB chunks under bandwidth ceilings ⇒ ~60 env/s,
far under the 800/s bucket); `signaling_consent`'s two-guard ordering
(voice→groups, consistent codebase-wide); runes-mode function-call reads are
tracked (tripwire: zero untrack windows); DM call consent chain
(initiate creates the link before any offer flows); control-toggle
signatures used by callSurfaces.

## Risks

- Svelte legacy-mode components must not read stores inside helper function
  bodies (P0 class) — new components runes-only, tripwire extended.
- Single shared AudioContext replaces N relay AudioContexts (watch CPU).
- Golden rule 5 untouched: sessions are socket/in-memory state only, no
  postcard record changes.
