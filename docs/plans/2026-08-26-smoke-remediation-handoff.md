# HANDOFF — Smoke-Test Remediation for the Calling Overhaul — 2026-08-26

**For:** Ox-Alpha (or any competent Rust/Svelte 5 agent — model-agnostic).
**From:** ZCode (GLM-5.3, max-mode session), relay chain: GLM-5.3 → Muse-Spark → GLM-5.3.
**SoT plan:** `docs/plans/2026-08-25-calling-overhaul.md` (phases, decisions, review log).
**Prior handoff:** `docs/plans/2026-08-25-calling-overhaul-handoff.md` (Phase 1 era — historical).
**Read AGENTS.md first.** Golden rule 10 applies to you too: ONE subagent per message, never
batched; prefer direct reads. Svelte 5 runes only in NEW components; legacy-mode components
must not read stores inside helper-function bodies (the P0 untrack class — tripwired).

---

## 1. Where the codebase stands (do not re-litigate — all verified green)

The full calling overhaul P1–P5 is code-complete on `main`, plus a max-mode review pass.
Every commit below passed `bun run check` 0 errors, `bun test` (now 168), and where Rust
was touched `cargo test -p wabi-server`:

| Commit | What |
|---|---|
| `157c261` | View pills stuck extended — JS-driven reveal replaces sticky `:hover` |
| `fffc645` | P1: server hardening SEC-1..4 (media room auth, stamped userId, rate limits, signaling consent, scoped screen-share) + 7 unit tests |
| `cc1f18c` | P1 FE: presence-before-transport ordering + `wabidb-call-denied` → watchdog |
| `40fb647` | P2 core: CallSessionManager + shared audio graph + attributed sounds |
| `d02fba9` | P2 complete: DM/group sessions; relay worklets through shared graph |
| `6acb48f` | P2.5: kick path, watchdog transitions, roster snapshots → sessions |
| `64e23e6` | P3: CallStage (runes), avatar chips, spatial seat drag, per-user relay chains |
| `14f9611` | P4: VoiceView page + CallsPanel right panel + voice pill |
| `b265128` | P5: optimistic join chip, connection badge, tripwire extension |
| `aacfbf9` | Review: 7 findings fixed (F1–F6, F8, F9), F7 documented |

The review pass (F1–F9) already fixed: the seat-stage effect slam-shut, lazy-chain seat
drops, the infinite seat-application churn loop, DM/group empty avatars, the
reconnect-kills-relay-rooms bug (`rejoinWabidbCallRooms()` in the drain path), and a
three-lock hold in Rust. Know these before touching spatial/reconnect code — the details
are in the plan doc §"Review pass".

## 2. The field report (Ronin, 2026-08-26, computer + mobile, same room)

Verbatim findings, with his clarifying answers from Q&A:

1. **Sound: none.** Test was scuffed (same room, mobile) — not condemned yet, BUT the
   accounts were **two different accounts** (confirmed), so this is a REAL bug, not the
   self-filter theory. Needs runtime localization (WO-1).
2. **Video: success**, but "mobile had troubles losing its screen when DC" — ambiguous;
   the confirmed related gap is remote-video streams never torn down on leave/DC (WO-3).
3. **Screen share: still doesn't work.** Desktop "summoned the 'what screen do you want'
   window but nothing rendered." Mobile was "too bloated in UI to see if any windows
   popped up." So: desktop picker works, post-getDisplayMedia path is broken (WO-2).
4. **Call view: "doesn't work? can't go to it."** Second-click → openChannelCallPanel
   path exists and the tripwire covers it; may be perception, may be the empty-looking
   stage. The approved fix (WO-4) makes the panel auto-spawn, which also disambiguates.
5. **Call panel doesn't auto-spawn on first call join** (nor auto-dissolve). Ronin
   **decided**: auto-spawn on join + auto-dissolve on leave, sticky if pinned/summoned.
   This REVERSES the old docked-first contract — deliberate, dated 2026-08-26 (WO-4).
6. **Cards labeled by channel id/number, not name.** Root cause known: sessions register
   with `name: channelId` and nothing resolves it (WO-5).
7. **"Why are we labeling FOCUSED?"** — design change approved: no FOCUSED badge text;
   focused card gets glow/border emphasis instead. BACKGROUND/SILENCED badges stay (WO-6).
8. **Right panel uses emoji, not the site's symbols** (site has feather-style SVG
   mic-off/headphones/phone-off). Replace (WO-7).

## 3. Work orders (verbose — implementation sketches included)

### WO-1 — Audio path: instrument + fix the self-filter (PRIORITY: audio is goal 1)

**Facts:** two accounts, channel join, video envelopes FLOWED (video worked), audio did
not. Both ride the same socket event, same room, same relay — so the break is in the
audio-specific legs: capture (opus-recorder) → envelope emit → receiver jitter buffer →
decode worker → per-user worklet chain → shared graph. Static review of all of these
checks out; do not trust that — instrument so the next 2-computer test localizes in
seconds.

**1a. Relay counters** — `frontend/src/lib/wabidbMediaRelay.ts`. Add a counters object:
`{ sentEnvelopes, recvEnvelopes, droppedSelfFilter, droppedSessionMismatch, decodeOk,
decodeFail, playedChunks }` plus `audioContextState()` getter (`this.audioContext?.state`).
Increment at: `sendEnvelope` (or wherever `socket.emit('wabidb-media')` happens, ~line
207 region), `onIncomingMediaHandler` filter branches, `decodeAndPlay` success/catch,
`playbackViaAudioWorklet` post-message. Expose `getDiagnostics()` on the relay; export a
module-level aggregator over `wabidbMediaRelays` (callingWabidb.ts owns that Map). Also
one throttled `console.info('[WabidbMediaRelay] first audio envelope received', …)` on the
first recv — the presence/absence of that single log splits sender-side vs receiver-side
instantly.

**1b. Surface in the Diag overlay** — `CallModal.svelte` has `showSpatialDebugOverlay`
(debug seat dots) and a `call-status-row` with transport badges. Add one row: `Audio:
recv=N dec=N play=N (ctx=running)`. Keep it cheap (update on a 1s interval only while the
overlay is open, or derive from a lightweight writable the aggregator refreshes).

**1c. Self-filter fix (correctness, do regardless)** — today the relay drops inbound
envelopes with `msg.userId === this.userId` (`onIncomingMediaHandler`). That check is
REDUNDANT (the server relays with `.except(sender_socket)` — a socket never receives its
own emissions) and WRONG for same-account multi-device (each device drops the other's
audio as self-echo). Fix:
- Server `core/crates/wabi-server/src/socketio/media_reactions_signaling.rs`
  `on_wabidb_media`: alongside the existing `payload["userId"]` stamp, add
  `payload["senderSocket"] = json!(socket.id.to_string());`
- Client `onIncomingMediaHandler`: filter `msg.senderSocket === this.socket.id` when
  `senderSocket` is present; keep the userId check ONLY as a fallback when the field is
  absent (older server). The video-lane routing inside the same handler inherits the fix.
- Note: `socket.id` on the client is the client-side id and MATCHES the server-side
  `socket.id.to_string()` for the same connection (socket.io semantics) — verify at impl
  time with one console log pair during the retest.

**1d. Static re-check list while you are in there** (all currently look correct — confirm
you don't disturb them): capture gating `capture: !listenOnly || voiceTransmitMode ===
'all-listening'` (relay config in callingWabidb.connectWabidbCall); sessionId equality —
both sides derive `channel:{channelId}` via `wabidbChannelSessionKey`; the server room
membership comes from `join-wabidb-call` which the ordering fix guarantees runs AFTER
voice presence (do not reorder); shared context is 48kHz explicit (decoder output rate —
do not remove); worklet module registration is WeakSet-guarded per context.

### WO-2 — Screen share (desktop): trace past the picker + visible failures

The desktop picker appearing means `getDisplayMedia` succeeded. The break is after
`localScreenStream.set(stream)` in `startScreenShare` (`frontend/src/lib/callingScreenShare.ts:86+`).
Chain: localScreenStream → `screenShareSub` subscription (callingWabidb.ts, inside the
video-lane block of `connectWabidbCall` — only registered when `wabidbVideoLaneInst`
exists) → `wabidbVideoLaneInst.startLocalVideo('screen', stream)` (wabidbVideoLane.ts:655,
no suspicious guards) → `LaneSender` encode → envelopes → receiver keys
`${toStableUserKey(userId)}:screen` → VoiceLiveStrip tiles / CallStage screen hero.

**2a. Lane counters** — `wabidbVideoLane.ts`: per-source sender counters
`{ framesEncoded, envelopesSent, encodeErrors }` and receiver counters
`{ envelopesReceived, framesDecoded }` keyed by stream key; aggregate + surface in the
same Diag row as WO-1b (`Video: cam f=N env=N | screen f=N env=N · rx=N`). Also log the
FIRST encoded frame per source.

**2b. Surface errors** — `LaneSender.start` failures currently go to `onError` → console.
Route them to `pushVoiceChannelNotice(...)` (calling_impl_core) so the sharer sees "screen
share failed to start: <reason>" instead of nothing.

**2c. canScreenShare() silent no-op** — `callingScreenShare.ts:87-90`: when
`canScreenShare()` is false (most mobile browsers have no getDisplayMedia), it warns to
console and returns null. Add a visible notice: "Screen sharing isn't supported on this
browser/device." This explains the mobile half of the report.

**2d. Likely suspects to check first when counters exist:** (a) `screenShareSub` never
fires because the sharer's relay was created WITHOUT the video-lane block (import
failure path is caught + swallowed — check console for "[Wabidb] Video lane import
failed"); (b) receiver-side: VoiceLiveStrip renders only when `$callMode === 'channel'`
and CallStage only for the FOCUSED session — if the receiver's focused session id ≠ the
channel (e.g. a DM was focused), tiles filter out; (c) `getScreenShareQualityProfile()
.constraints` producing an encoder config the desktop WebCodecs rejects (encodeErrors
counter will say).

### WO-3 — Remote video teardown on leave/DC

Confirmed gap: nobody calls `wabidbStopRemoteVideo(userId)` (exported,
callingWabidb.ts:125 → `wabidbVideoLaneInst.stopRemoteUser`). The server broadcasts
`voice-channel-user-left` on voluntary leave AND on socket disconnect (presence.rs
on_disconnect), and Phase 2 wired that event to `handleVoiceParticipantLeft(userId,
channelId)` in calling_impl_core.ts (~line 1900 region — it already plays the attributed
leave sound and updates the session roster). Add `wabidbStopRemoteVideo(userId)` there
(extend the existing callingWabidb import at the top of calling_impl_core). Consider the
same in `handleRemoteDirectCallEnded` for DM p2p shares (it already calls
removeCall/removeScreenShare for the p2p path — the wabidb lane needs the same).

### WO-4 — Auto-spawn / auto-dissolve call panel (APPROVED CONTRACT REVERSAL)

Ronin's decision (2026-08-26): joining a call auto-opens the embedded call panel; leaving
auto-dissolves it; sticky when pinned or user-summoned. This reverses "docked-first"
(voice-channel-ux-plan.md, audit P1) — the reversal is deliberate; update the comments in
CallModal.svelte (~lines 417–425, the docked-first block) and note it in the plan doc.

Mechanics:
- `channelCallPanelOpen` (callingStateStores.ts:70) is the switch; CallModal transitions
  docked→embedded when it's true while in-call (CallModal ~423).
- Join/establish paths currently FORCE it false: calling_impl_core.ts lines **1534**
  (group establish — flip to auto-open), **1609** (check context — group variant), **1780**
  (DM answer — flip), and `joinVoiceChannel` doesn't set it at all (add auto-open after
  successful `connectWithFallback`). KEEP the teardown sites closing it: **573**
  (finalizeLocalCallEndState), **661** (teardownCallSessionOnly), **1350** (forced kick),
  and the 1843/2525/2545 sites (read each context; teardowns stay false).
- Stickiness: introduce `callPanelDismissedByUser` (module state in calling_impl_core or a
  store). Set true ONLY from an explicit user close/minimize of the shell (CallModal's
  close/hatch handlers call a new `dismissChannelCallPanel()` export — do not hook
  `closeChannelCallPanel` itself, which teardown also uses). Reset it to false whenever a
  NEW call/session is joined. Auto-open sites open only `if (!callPanelDismissedByUser)`.
- "Pinned": treat `callViewportMode === 'focus'` (fullscreen) as pinned — when focus mode
  is active, the leave path must not force the shell away (it already doesn't — teardown
  unmounts everything; the pin matters for the leave-one-call-keep-another case: after
  `teardownCallSessionOnly`'s unregister loop, if a focused session survives and the panel
  was open, it stays open — verify; if the surviving-session focus handoff needs the panel
  re-opened, set it true there unless dismissed).
- The tripwire test "second-click embed survives: handleVoiceChannelClick calls
  openChannelCallPanel" must stay green — do not touch that handler
  (ChannelSidebar.svelte:329).

### WO-5 — Session display names

Root cause: `callSessionManager.register({ ..., name: channelId })` in joinVoiceChannel
and handleForcedVoiceMove — raw id as placeholder, never resolved. Channels load async,
so resolve at RENDER time, reactively:
- In VoiceView.svelte, CallsPanel.svelte, and CallStage labels: derive
  `displayName(session) = (session.channelId ? $channels.find(c => c.id ===
  session.channelId)?.name : undefined) ?? session.name ?? session.id`. `$channels` from
  `$lib/channelStore` (Channel.name exists; sidebar uses `ch.name ?? ch.id`).
- DM sessions: keep the name set at registration (peer username via
  outgoingCall/activeCalls); VoiceView's F4 fallback already maps activeCalls usernames.
- Optional hardening: when the channels store loads/changes, call
  `callSessionManager.setName(channelId, name)` for known sessions (one-pass in
  socketConnectionCore's channel hydration) so any future consumer gets resolved names.
- The "Voice Connected / {channel}" header in VoiceUserCard already resolves names
  correctly — leave it.

### WO-6 — Focus = glow, not a label

Ronin: "why are we labeling focused? if it's in center stage why don't we use UI emphasis
like glows?"
- Model unchanged: `sessionBadge()` stays (tests depend on it; background/silenced still
  need it).
- Render changes: in VoiceView.svelte and CallsPanel.svelte, show the badge chip ONLY for
  `background` / `silenced`; the focused card gets emphasis via CSS — strengthen the
  existing `.vv-card.focused` / `.cpanel-card[data-badge='focused']` from a border tint
  to a clear glow (`box-shadow: 0 0 0 1px + 0 0 18px` accent, slightly raised z or scale).
  Add a subtle "on stage" affordance if helpful (e.g. the card's video area already IS
  the stage on the focused card).
- VoiceView's focused card already shows live video tiles — that plus glow reads as
  "this is the one".
- Do NOT remove the badge from the model or tests.

### WO-7 — Site-standard icons in the panel/view

Replace every emoji control icon in CallsPanel.svelte (`🔈 🎯 ✕`) and VoiceView.svelte
(`🔇 🔊 📺 🎥 ◎ 🔊` seat toggle, transport glyphs) with the site's feather-style inline
SVGs — copy the exact paths/styling from VoiceUserCard.svelte (~lines 220–237: monitor,
camera, phone-off) and CallModal.svelte dock buttons (mic, headphones, phone). Conventions:
`viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
stroke-linecap="round" stroke-linejoin="round"`, 14–16px, `aria-hidden` + button
`title`/`aria-label`. Buttons keep their `.active` state styling. The headphones SVG for
the voice pill already exists in WorkspaceViewBar.svelte (copy source for panel header).

### WO-8 — Documentation

Append to `docs/plans/2026-08-25-calling-overhaul.md`: a "Smoke test 2026-08-26 —
findings & remediation" section (the 8 findings, the decisions: auto-spawn reversal,
glow-not-label, two-account audio bug), and update the Phase 5 checklist items that this
changes. Commit docs with the code.

## 4. Order of execution

1. WO-3 (tiny, user-visible correctness), WO-5, WO-6, WO-7 (UI polish, low risk).
2. WO-4 (behavior change + comments).
3. WO-1 + WO-2 instrumentation (the next test session depends on these being in the
   build!). Self-filter fix (1c) rides along.
4. Gates: `bun run check` (0 errors), `bun test` (168+, tripwires green), `cargo test -p
   wabi-server` (Rust touched by 1c). `STATIC_BUILD=1 bun run build` before deploy.
5. Scoped commits per work order. NEVER `git add -A`. No push/deploy without Ronin's word.

## 5. Retest checklist (2 computers, 2 accounts, counters visible in Diag)

1. Audio: join same channel both machines; Diag row shows recv/dec/play climbing on the
   receiver; if recv=0 → sender-side (check sender counters); if recv>0 dec=0 → decoder
   worker; dec>0 play>0 but silent → graph/autoplay (check ctx=running).
2. Same-account two-device (optional but now supported): audio flows between devices of
   one account (self-filter is socket-scoped after 1c).
3. Screen share desktop→desktop: lane counters climb; tiles on receiver; stop propagates;
   DC the sharer → receiver tiles dissolve (WO-3).
4. Panel: join → auto-spawns; leave → dissolves; pin/focus → survives; dismiss → stays
   dismissed for that call.
5. Cards: real channel names; focused card glows (no FOCUSED text); background/silenced
   badges; volume slider changes loudness live.
6. Reconnect: kill network 5s → audio returns without interaction (F6 rejoin).
7. Icons: panel buttons match site set.

## 6. Open / deferred (do NOT silently expand scope)

- **F7 (from review):** p2p file-transfer signaling (`p2p-offer/answer/ice`) has no
  consent check — needs its own primitive (DM-relationship lookup or accept-prompt);
  gating on call relationships would break DM file transfers. Documented in threat model.
- Mobile UI bloat (Ronin couldn't see popups) — separate UX pass.
- Playful seat physics (throwable chips) — explicitly deferred by Ronin.
- Relay-media E2EE (SFrame) — future opt-in; threat model documents server-readability.

## 7. Hard-won facts (compressed — full versions in the plan doc)

- Socketio Rust files are `include!`d into ONE flat module (`socketio_impl.rs`) — no
  duplicate `use`/`mod` names (E0428/E0252); test modules need unique names.
- Session keys: channel `channel:{id}`; DM `dm:{user-a}:{user-b}` sorted, ids normalized
  bare-digits→`user-{n}`. Manager/graph session ids: channelId for channels+groups,
  `direct:{peer}` for DMs (== legacy `directCallSessionKey`). Relays are double-indexed
  by channel key AND graph id.
- Envelope: `{sessionId, userId, payload}`; server stamps `userId` (and soon
  `senderSocket` per WO-1c) — never trust client identity fields.
- Voice roster: `state.voice_channels[channel_id] → Vec<VoiceParticipant{socket_id,
  stable_id "user-{n}", is_listening_only}>`; group calls: `group_call_sessions`
  connected_participants. Sockets join a room named their stable id.
- FE ordering: voice presence emits BEFORE `connectWabidbCall` (roster check), and the
  drain replay re-emits presence then `rejoinWabidbCallRooms()` — never reorder.
- Audio graph: ONE shared 48kHz AudioContext; per-SESSION gain→panner→master chain;
  per-USER worklet→panner→gain chains feed the session input. Relay stop disposes chains,
  never closes the shared context. Volume flows manager→graph via `bindCallSessionAudio`.
- Seats: manual = persisted (`wabi:spatial-seats:{sessionId}`) + session model; bulk
  application must use `applySpatialSeatToAudio` (audio-only) — the persisting variant
  re-triggers effects in a loop and freezes auto-circle into manual seats (F9).
- Runes components must compile with ZERO `$.untrack(` (tripwired — CallStage, VoiceView,
  CallsPanel, VideoSink are on the list).
- Rust locks: tokio RwLock is write-preferring — snapshot+drop `connected_users` before
  taking voice/group guards (see F8 fix in screen_share_audience).
