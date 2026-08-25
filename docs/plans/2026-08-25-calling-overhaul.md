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

### Phase 3 — Focused stage (goal 3)
- Runes `CallStage.svelte`: avatar chips, camera tiles, screen hero (reuse
  `callLayoutManager`/`callRenderModel`/`wabidbVideoLane` keys).
- Spatial stage: drag chips → `spatialSeats` + `spatialEngine.updateSourcePosition`
  real-time; auto-circle default; persists per channel; works for wabidb + p2p.
- Wire the in-call spatial quick toggle (dead code today).

### Phase 4 — Voice view + right-panel controller (goal 5)
- `voice` workspace view → `VoiceView.svelte`: live cards per voice channel,
  focused card with tiles, background/silenced with volume, connect/leave,
  Mute All / Deafen All / Leave All.
- `calls` panel in `workspacePanels.ts`: per-call cards, badges, avatars,
  per-call controls + volume.

### Phase 5 — Fluidity + ship gates (goal 2)
- Optimistic self-chip, connecting→connected, occupancy counts, per-call sounds.
- Full regression suite, `bun run check`, `cargo test`, 2-client live smoke
  (real browser — headless cannot render Wabi). Scoped commits. No push/deploy
  without the word.

## Threat model note (post-Phase-1)

- p2p/SFU calls: DTLS-SRTP end-to-end between peers (server sees signaling only).
- wabidb relay calls: media transits the server in the clear over authenticated
  WSS; the server CAN inspect relayed media. Membership is enforced; identities
  are server-attested. E2EE for relayed media is a future opt-in (SFrame-style).

## Risks

- Svelte legacy-mode components must not read stores inside helper function
  bodies (P0 class) — new components runes-only, tripwire extended.
- Single shared AudioContext replaces N relay AudioContexts (watch CPU).
- Golden rule 5 untouched: sessions are socket/in-memory state only, no
  postcard record changes.
