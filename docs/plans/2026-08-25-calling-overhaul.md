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

## Smoke test 2026-08-26 — findings & remediation

Ronin's field test (computer + mobile, same room, TWO DIFFERENT ACCOUNTS —
confirmed). Remediated same day; details in
`docs/plans/2026-08-26-smoke-remediation-handoff.md`:

1. **No audio** (real bug — accounts differ, so not the self-filter theory).
   Video envelopes flowed, audio didn't. Relay + lane now carry full counters
   surfaced in the Diag overlay (`Audio: tx= rx= dec= play= err= (ctx=)`) so
   the next 2-computer test localizes in seconds. Root cause still open
   pending retest.
2. **Screen share broken past the picker** (desktop picked a window, nothing
   rendered; mobile UI too bloated to tell). Lane counters per source +
   visible failure notices added; likely-suspect list in the handoff §WO-2d.
3. **Remote video never torn down on leave/DC** (confirmed gap) —
   `wabidbStopRemoteVideo` now fires from `handleVoiceParticipantLeft`
   (scoped to channels we listen to) and `handleRemoteDirectCallEnded`.
4. **Call panel doesn't auto-spawn** — CONTRACT REVERSAL (decision below).
5. **Cards labeled by channel id** — sessions register `name: channelId`;
   VoiceView/CallsPanel now resolve via `$channels` at render time.
6. **FOCUSED badge text removed** — decision below.
7. **Emoji control icons replaced** with the site's feather-style SVGs.

### Decisions (Ronin, 2026-08-26)

- **Auto-spawn/auto-dissolve panel** (reverses docked-first): joining any
  call auto-opens the embedded call panel; leaving auto-dissolves it;
  explicit minimize/dismiss keeps it closed for THAT call only; listen-only
  channel joins stay docked; a surviving voice-channel session re-spawns the
  panel after a DM/group call ends unless dismissed. The sidebar second-click
  embed path is unchanged (tripwire stays green).
- **Focus = glow, not a label**: badge chips render only for
  background/silenced; focused cards get border+glow emphasis.
  `sessionBadge()` model and its tests unchanged.
- **Self-filter is socket-scoped**: server stamps `senderSocket` on
  `wabidb-media`; relay AND lane drop by connection id, keeping the userId
  check only as a legacy-server fallback. Same-account two-device audio and
  video now flow (retest item 2).

### Scope amendments made during implementation

- WO-4 also flipped the group-call START site (the handoff's line map listed
  only establish/answer paths) per Ronin's "auto-open like joins".
- WO-1c extended to the video lane's own receiver filter — without it,
  two-device video still died at `handleRemoteEnvelope`.
- WO-7 scope widened to CallStage + CallModal spatial buttons (they carried
  emoji too); ◎ replaced by a composed surround-sound glyph built from the
  existing volume-icon arc paths; inline copies only (no shared icon module).
- WO-3 teardown placed inside the `connectedToChannel` branch so tiles from
  another shared channel a user remains in survive.

Phase 5 checklist items superseded: the "docked-first" contract line is
REVERSED (auto-spawn); the FOCUSED badge line is replaced by glow emphasis;
panel/view controls use site-standard icons.

## Smoke test 2026-08-27 — findings & remediation (round 2)

Field report (wabi + itstafkat, wabi.chat, two accounts): no audio; no live
chip sync in the sidebar list; screenshare worked one-way and lagged; zero
indication to the audience that a remote share had started; `[Wabidb]
Disconnected/Connected` churn; `/api/user/layout` PUT 422; TURN endpoint 400.

Root causes found (all verified against source, most proven by probe/build):

1. **Audio — decoder worker wasm never shipped.** opus-recorder's
   `encoderWorker.min.js` inlines its wasm (base64) but `decoderWorker.min.js`
   loads `decoderWorker.min.wasm` as a SIBLING file. Vite emits the worker JS
   (hashed asset) but not the sibling; the wasm request hits the SPA fallback
   (index.html, text/html) → `wasm validation error: failed to match magic
   number` → worker aborts → every decode times out → receiver hears nothing
   while the sender's counters climb. This also explains the 2026-08-26
   "sound: none". Fix: import the wasm via `?url` and the worker source via
   `?raw`, build the worker from a Blob with a `Module.locateFile` prelude
   (wabidbMediaRelay.ts; opus-assets.d.ts). Proven by
   `frontend/scripts/probe-decoder-worker-wasm.mjs` (control reproduces the
   abort, fix instantiates the real wasm) and by the static build emitting
   `assets/decoderWorker.min.<hash>.wasm`. Decode timeouts now count as
   decodeFail so Diag localizes instantly. Contributing factor: itstafkat was
   joined `listening` (multi-listen, non-transmitting) — his direction is
   silent by design; retests need both sides actively connected.
2. **Live chip sync — UnifiedChannelList regressed the P0 untrack class.**
   The sidebar renders UnifiedChannelList, whose "ported from
   VoiceChannelList" helpers read `$voiceChannelMembers`/`$speakingUsers`/
   props inside function bodies called from the template (`$.untrack`
   wrapped — proven by compiler probe: 3 hits). Roster chips/connected
   styling were blind to join/leave/speaking until an unrelated re-render.
   Refactored to the `voiceRowsById` derivation contract (same as
   VoiceChannelList); compiler probe now 0 hits; tripwire test extended to
   cover UnifiedChannelList so this class cannot silently return.
3. **Screenshare ran over BOTH transports simultaneously.** On the wabidb
   transport the share button drove startScreenShare (WebRTC offers) AND the
   localScreenStream subscription drove the wabidb video lane — double
   encode + ~1.5 Mbps of base64 JSON on the shared socket.io connection →
   engine.io heartbeat miss → `transport close` → `[Wabidb] Disconnected`
   churn + lag + ICE consent flaps. Fix: single-path routing —
   startScreenShare/stopScreenShare use the wabidb lane exclusively when
   `wabidbTransportLive()` (WebRTC path untouched for p2p/LiveKit); the
   `screen-share-targets` handler skips offer creation on the wabidb
   transport. Screen ladder lowered to 720p12 start, ceiling 1.5→0.9 Mbps
   (socket-health, not image quality, was the binding constraint).
4. **No audience confirmation.** The server has always emitted
   `screen-share-started`; the client had NO listener (only
   screen-share-targets / webrtc-* / screen-share-stopped). Added the
   listener → `presentRemoteScreenShare()` notice + auto-open of the call
   panel (honors the user's dismissal; self-filtered server-side id shape
   `user-{id}`). This is why the remote share "connected" at ICE level with
   zero user-visible indication.
5. **Layout PUT 422.** `SaveLayoutRequest` expected snake_case `layout_json`
   while every client writer sends camelCase `layoutJson` — every docking
   save 422'd. Field now `rename="layoutJson"` + snake alias. Also fixed
   `save_theme` rebuilding the container as `{layout, theme}` and dropping
   `railDensity`/`railSide` (the clobber class mergeIntoServerContainer
   guards client-side); it now merges into the existing container.
6. **TURN 400 is deployment config, not code** (`turn_enabled=false`). Enable
   via `docker compose --profile turn` + `TURN_HMAC_KEY` + wabi.config
   `turn_enabled/turn_uri/turn_secret`. Public STUN fallback already works.
7. **DB reset question — answered NO.** The browser `[Wabidb]
   Connected/Disconnected` lines are the WabiDbCallState WebSocket client
   (call-state socket), not the embedded database; the drops were transport
   strain from (3) and self-healed. Old on-disk data is not implicated by
   any symptom in the log; the engine replays through dual-decode fallbacks.
   If DB health is ever in doubt: `wabidb-cli check` / `backup` — not a reset
   (a reset destroys accounts/channels/messages for zero diagnostic gain).

`bun run check` 0 errors; `bun test` 171 pass (1 pre-existing unrelated
failure: `setAuthToken` export — present on a clean tree); `STATIC_BUILD=1`
build emits the wasm asset; Rust touched (user.rs) — run `cargo test -p
wabi-server` before deploy (no Rust toolchain was available in the authoring
sandbox). Retest: both accounts actively connected (not listen-only), expect
Diag `recv>0 dec>0 play>0`, chips updating live in the sidebar, one share
path only, and a toast+panel when the remote side shares.

---

## Round 3 — 2026-08-27: voice view reachability, stub summon, transport swap, dual-transport diagnostics

User report: (1) the call "view" is unreachable from the messages view, (2) joining a
call doesn't summon the Calls right-panel stub, (3) confirm multi-call joins, (4) want a
clean wabiDB↔p2p swap, (5) debug must show ping/packets/loss on BOTH transports.

### Root causes found (read-only pass)
- **Voice view unreachable**: the workspace pill bar visible in the messages view is
  rendered by `ChatHeader.svelte` (not MainLayout — that bar only shows once a
  non-messages surface is open). `ChatHeader.handleWorkspaceViewSelect` had no
  `case 'voice'` → silent no-op; `WorkspaceViewKey` (chat/types.ts) also omitted
  `'voice'`, so `Chat.svelte`'s `selectedWorkspaceView` could never report it and the
  pill never highlighted.
- **Stub never summoned**: `autoOpenChannelCallPanel()` only flipped a modal flag
  (`channelCallPanelOpen`); it never touched the right-panel stub strip.
- **Transport swap didn't exist as a user action**: `setCallTransportMode` had no UI
  caller; the only way onto p2p was the watchdog demoting a broken wabidb link.
- **Debug was WebRTC-only AND dev-only**: `CallDebugPanel` mounts behind
  `import.meta.env.DEV`, and `callingDiagnostics` sampled `pc.getStats()` exclusively —
  on wabidb calls (no RTCPeerConnection) every metric reset to null.

### Changes
1. **Voice view reachability** — `voiceView.ts` gains `openVoiceView()` (closes the six
   center addon tabs, then flips the store) + `closeVoiceView()`; `WorkspaceViewKey`
   adds `'voice'`; `Chat.svelte` derives/maps/labels it and `returnToMessagesView()`
   closes it; `ChatHeader` handles `case 'voice'` via the shared opener; MainLayout's
   bar case now uses the same opener.
2. **Stub summon on join** — `autoOpenChannelCallPanel()` calls `summonCallsStubOnJoin()`:
   `addStub('calls')` (persistent, appears on the edge strip) + `peekPanel('calls')`
   when nothing is pinned (visible confirmation without stealing chat width). Applies
   to every auto-open site (join, DM answer, group establish, forced move).
3. **Multi-call** — verified (no code needed): sidebar click while transmitting =
   listen-subscribe; VoiceView lists joinable channels with Join/Listen-Join;
   callSessionManager tracks one transmit + N listen sessions; swap preserves
   listen-direction (connectWabidbCall listenOnly flag / shouldTransmitToChannel gate).
4. **Clean transport swap** — `switchCallTransport(socket, 'wabidb' | 'p2p')` in
   calling_impl_core (re-exported via calling.ts): stores the mode FIRST (offer routing
   agrees), stops the watchdog before teardown (no phantom demotion), tears down the
   old transport per session, rebuilds on the new one (mesh offers with channelId /
   relay reconnect), updates session + transport-state stores, refuses meshes >
   MESH_MAX_PARTICIPANTS. UI: "Swap to P2P / Swap to WabiDB" button in VoiceView footer
   (visible when sessions exist).
5. **Dual-transport debug** —
   - Server: `wabidb-ping` stateless echo handler → `wabidb-pong` (wiring.rs).
   - Relay: byte counters (sent/recv), seq-gap inbound loss estimate (per-user, seq>0
     senders only), inter-arrival jitter EMA in `WabidbMediaRelayDiagnostics`.
   - Sampler: when no peer connections exist, `callingDiagnostics` aggregates relay
     counters + socket RTT echo (dynamic imports, no static cycles) and tags
     `source: 'wabidb'`; WebRTC samples carry packetsSent/Received + `source: 'webrtc'`.
   - Panel: CallDebugPanel adds Packets ↑/↓ rows and a Transport line showing which
     metric source is live. MainLayout no longer gates the overlay to DEV builds —
     the floating toggle mounts whenever a call surface is active.
   - Note: outbound loss is unobservable on wabidb from the sender side (the relay
     drops nothing it accepts); reported as `--`. Jitter is an inter-arrival
     deviation EMA, not RFC3550 — labelled a stability proxy.

### Gates
- `npm run check`: 0 errors (180 pre-existing warnings)
- `bun test src/lib`: 171 pass / 3 skip / 1 fail — the fail is the pre-existing
  `setAuthToken` export baseline, untouched by this change
- `npm run build`: exit 0
- `cargo test -p wabi-server`: still REQUIRED before deploy (no Rust toolchain in the
  sandbox — wiring.rs handler is a stateless echo, hand-reviewed against the
  adjacent `call-offer` pattern)

### Retest recipe
1. Fresh login → messages view → **Voice** pill in the chat header → voice view opens,
   pill highlights; Messages pill returns.
2. Join a voice channel → Calls stub appears on the right edge + panel peeks (unless a
   panel is pinned — user intent wins).
3. Join a second channel from the sidebar/VoiceView → two session cards, one transmit
   badge, per-call volume/mute/leave work.
4. VoiceView footer → "Swap to P2P" → transport badge flips, audio continues, notice
   with peer count; "Swap to WabiDB" → relay reconnects. Watchdog stays quiet.
5. During a call (either transport) → floating debug toggle (bottom corner, no longer
   dev-only) → ping/jitter/loss/rates/packets populated, Transport row names the
   metric source. On wabidb, ping = socket echo RTT; loss = inbound envelope gaps.
<<<<<<< HEAD

---

## Round 4 — 2026-08-27: wabi.chat field-test laundry list

Reported live from wabi.chat (testing grounds). Root causes found + fixes:

1. **Sent messages invisible until channel switch** — `MessageList.svelte`'s
   render-window block cached the expiry-filtered list (`lastFilteredMessages`)
   and skipped recompute whenever no ephemeral deadline had expired; channels
   with no ephemeral messages NEVER picked up new messages. Fix: force
   re-filter whenever the `messages` array reference changes; the deadline
   check remains only as a nowMs-tick optimization.
2. **Joining a channel call forced a translucent modal over chat** —
   `callUiActive` mounted CallModal for ANY `$isInCall`, including
   `callMode === 'channel'`. Discord model restored: channel calls live in
   sidebar roster + Calls panel + Voice view; the modal stays for DM/group
   rings + DM streams. `autoOpenChannelCallPanel` no longer flips
   `channelCallPanelOpen` (stub summon only). Sidebar voice click: 1st click
   joins in place, 2nd click on a connected channel opens Voice view focused
   on that call (tripwire test updated to guard the new contract).
3. **Recording was placebo** — `startCallRecording` awaited a
   `call-recording-set-active` socket ack that the SERVER NEVER IMPLEMENTS →
   the await hung forever: banner showed "REC 00:00", no MediaRecorder ever
   started, stop() no-oped, leaving cut it silently. Fixes: 4s presence-ack
   timeout (non-fatal — recording proceeds, transparency warns), timer starts
   when the banner flips, `stopCallRecording` hard-resets ghost state,
   CallRecordingPanel's `export const` props (silently-ignored!) fixed to
   `export let` + a real Stop button in the banner, leave-guards
   (`confirmLeaveWhileRecording`) on CallModal hangup / callSurfaces leaves /
   sidebar leave-voice, VoiceView footer gains ⏺ Record/Stop with live timer
   (channel calls no longer have the modal), and the mixed recorder taps the
   shared callAudioGraph master bus when remote audio rides wabidb (no
   per-peer MediaStreams exist there — remote voices were previously
   unrecorded on that transport).
   NOTE: the server-side recording-presence broadcast remains unimplemented
   (client-side only); the timeout makes it safe but "recording transparency"
   to other participants is still absent.
4. **No self screen preview** — the wabidb video lane self-filters your own
   stream; VoiceView session cards now render a "Your screen" tile from
   `localScreenStream`.
5. **GIF/emoji panel pushed messages up + stuck "Loading..."** —
   `.emoji-picker-container` lost its positioning CSS in the d4d8162
   extraction and rendered as an inline block; the container now lives inside
   `.input-wrapper` as an anchored popover (like mention suggestions). The
   lazy chunk load gets a failure state + Retry button instead of an eternal
   spinner. The "GIF caption uses composer text (max 280 characters)" hint is
   removed (owner: "why do we show that at all?").
6. **Payments visible on a payments-disabled server** —
   `resolvePaymentAccessSnapshot` failed OPEN on unknown policy; now fails
   CLOSED (owner directive: disabled => omit all payment UI). Profile settings'
   payment row (History/Refs/Support) hides unless `canViewPaymentUi`; tests
   updated.
7. **React bar** — Forward added to the hover bar (was context-menu only);
   quick-reaction emoji `<img>`s get an `:name:` text fallback on error
   (broken URLs no longer render broken-image boxes).
8. **Watchdog couldn't demote to p2p** — its connect callback only knew
   wabidb ("watchdog cannot re-establish p2p from here"), so a dead relay =
   dead call. New `reEstablishChannelP2P` (mesh offers) wired via dynamic
   import (no static cycle).
9. **wss://…/ws unreachable on wabi.chat** — Caddyfile.example's backend path
   list omitted `/ws`; the wabidb relay WebSocket fell through to the frontend
   container killing the whole transport. Added `/ws /ws/*` (deployment must
   apply this to the live Caddy config).
10. **TURN 400 console noise** — server answers 400 "TURN not enabled" when
    the profile is off; client now treats 400 as an expected quiet state.
11. **CI `test` baseline failure fixed** — the ancient `setAuthToken` bun
    failure was `$app/environment` (Vite virtual module) poisoning the shared
    module cache across suites. tsconfig now maps `$app/*` to real stubs
    (`test/stubs/`), a global `test/bunPreload.ts` mocks them, authSession
    uses a local browser guard, and the `$lib/authSession` test mock provides
    the full export surface. `bun test src/lib`: **175 pass / 0 fail**.

### Unresolved (needs live repro)
- **Alt+click channel glimpse** — wiring traced end-to-end (UnifiedChannelList
  click → handleChannelButtonClick altKey → openChannelGlimpse → fixed-position
  popout; CSS present; dismissal listeners exempt the button) and looks
  correct on read. No code change made; need a browser repro (console state,
  which sidebar surface, OS/browser) before touching it.

### Gates
- `npm run check`: 0 errors · `bun test src/lib`: 175/0/3 · `npm run build`: ✅
- No Rust changes this round (Caddyfile + tsconfig + frontend only).
- **Deploy note**: apply the `/ws` route to the live wabi.chat Caddy config,
  then re-test: wabidb transport connect, transport swap button, diagnostics
  source badge, recording (start → timer counts → Stop saves), join without
  modal, 2nd-click focused view.

---

## Round 5 — 2026-08-27: screenshare display path, recording presence, hot-mic teardown

Report: "call renders, screenshare doesn't"; recording is looks-only; suspicion
of mics that stay live after leaving. Root causes found (all verified against
source):

1. **Screenshare black tiles — unfed `MediaStreamTrackGenerator`.**
   `WabidbVideoLane.exposeRemoteStream` "preferred" constructing a
   MediaStreamTrackGenerator video track when the browser exposed it, falling
   back to `canvas.captureStream(15)`. NOTHING ever connected the generator's
   `writable` end — decoded frames were only `drawImage`-ed onto a hidden
   canvas nobody viewed once the generator branch won. The constructor ships
   enabled-by-default in Chrome/Edge/Opera since 94 (Firefox lacks it), so on
   Chromium every remote wabidb video stream was a live-but-frameless track:
   black tiles while Diag counted `rx>0 dec>0`. This retro-explains the
   2026-08-26 "picked a window, nothing rendered" (never root-caused — prior
   rounds fixed audio wasm, dual-transport flood, notices, self-preview, but
   never the display path) and round 2's "worked one-way" (the Firefox side
   took the working canvas fallback). Fix: generator path removed; the decode
   canvas is ALWAYS the exposed stream. Regression test installs a
   throwing MediaStreamTrackGenerator stub (`wabidbVideoLane.test.ts`).
2. **Screenshare invisible on P2P channel calls + sharer's own tile.**
   `CallStage` (the focused channel stage) read only
   `wabidbRemoteVideoStreams` — after "Swap to P2P" (or watchdog demotion)
   remote shares land in the `screenShares` store and rendered NOWHERE for
   channel calls (CallModal's grid is replaced by CallStage when a session is
   focused); the sharer's own screen had no tile on that stage either (only
   `localCamera`). Same P2P gap in `VoiceView.sessionVideos`. Fix: pure
   `mergeScreenShareEntries()` in callRenderModel (wabidb `:screen` entries +
   P2P `screenShares` + local preview, stable-id normalized, wabidb wins
   dedupe, roster-named labels); CallStage hero + VoiceView session cards
   render from it; CallModal passes roster displayNames to
   `buildWabidbScreenShares` ("Alice's Screen" instead of "Shared Screen").
3. **Second wabidb relay dropped inbound video.** `connectWabidbCall`
   attached the video lane only inside the `if (!wabidbVideoLaneInst)` guard —
   a second concurrent channel's relay never routed inbound video envelopes.
   Fix: `relay?.attachVideoLane(wabidbVideoLaneInst ?? lane)` outside the
   guard (every relay routes to the shared lane).
4. **Recording presence was dead code.** The local record→save chain is real
   since round 4 (uncommitted then, placebo on wabi.chat), but no server
   handler existed for `call-recording-set-active` and nothing ever called
   `setRecordingPresence` — the entire REC-transparency UI rendered from
   permanently empty stores. Fix: server handler (media_reactions_signaling)
   + per-socket registry (call_security, unit-tested) that validates scope
   against SERVER truth (voice roster / group session membership — client
   channel claims are never trusted for addressing), acks `{ok}` via
   AckSender, and broadcasts per-recorder deltas `call-recording-presence-
   changed {active, scope, channelIds, recorder}` to the consent-scoped
   audience (same `screen_share_audience` scan as screen-share notices) +
   the recorder's own stable-id room; disconnect cleanup broadcasts
   deactivation to the recorded channels' members. Client: listener in
   socketConnectionCore feeds `applyRemoteRecordingPresence` (upsert/remove
   reducer, unit-tested); `handleRemoteDirectCallEnded` drops the peer's
   direct REC badge. Guest identities are rejected.
5. **Hot mics — client leaks.** `answerCall`'s catch and the group-call-start
   catch did `localStream.set(null)` WITHOUT stopping tracks or clearing the
   capture session — a failed answer/group-start left the mic (and camera,
   same stream) hot until the next call acquired a new session. Fix: both
   catches stop tracks + `clearActiveAudioCaptureSession()` (mirrors
   `startCall`'s catch).
6. **Hot mics — server ghost relay membership.** No code path ever left a
   `wabidb-call-{session}` room: voice-channel-leave, unsubscribe,
   group-call-leave, and DM call-end all left the socket in the media room —
   and room membership is the relay's ONLY authorization, so a departed
   socket that kept emitting (exactly leak #5, or an old build) kept
   streaming its mic to everyone remaining, and kept receiving all media
   envelopes, until it fully disconnected. Fix:
   `leave_wabidb_channel_room_if_unrostered` (evicts only when no roster slot
   — primary or listen-only — remains, so a stray unsubscribe from a primary
   keeps its room) on voice leave/unsubscribe + group leave;
   `dm_media_room_key` (mirrors client `wabidbDmSessionKey`, unit-tested)
   evicts the per-peer DM rooms on call-end. Socket disconnect dissolves
   rooms automatically.
7. **Drive-by (build blocker)**: round 3's `wabidb-pong` emit was authored
   without a Rust toolchain and never compiled — `socket.emit("wabidb-pong",
   data)` needed `&data` (wiring.rs). Fixed; `cargo test -p wabi-server` now
   runs green for the first time since round 3.

### Gates
- `bun run check`: 0 errors (182 warnings, pre-existing baseline)
- `bun test src/lib`: **188 pass / 0 fail / 3 skip** (13 new: video-lane
  display-path regression incl. throwing generator stub, merge helper,
  recording-presence reducer)
- `cargo test -p wabi-server`: **all green** (137 unit + integration suites;
  new: `dm_media_room_key_matches_client_derivation`,
  `recording_presence_registry_round_trips`)

### Retest recipe (two Chromium clients + one Firefox if available)
1. **Screenshare**: A shares in a channel call → B sees the hero tile with
   pixels immediately (Diag: `rx>0 dec>0` AND visible frames — the pre-fix
   signature was counters climbing over a black tile). A's own "Your Screen"
   tile shows on the focused stage + VoiceView.
2. **P2P parity**: Swap to P2P → share again → tiles still render (previously
   invisible on channel calls).
3. **Recording**: A records → B sees the REC banner/badge (presence now
   real); Stop → file downloads on A; B's badge clears. A disconnects
   mid-recording → B's badge clears.
4. **Hot mics**: after leaving a call, the browser tab mic indicator goes
   out; the remaining side never hears the departed user; Diag on the
   departed tab shows no relay counters moving.
=======
>>>>>>> origin/arena/01a04113-wabi
