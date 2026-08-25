# Calling Audit + Fix Plan — 2026-08-24

Task list only, no estimates. Branch: `wip/combined-handoff-2026-08-18`. Baseline: clean tree,
HEAD `1b245230`, deployed binary `ba475e857e4e81f44956` (Tim).

**Kanban mirror (default board, linear dependency chain):**
P0 `t_5b3762c5` → P1 `t_33c0a902` → P2 `t_cfd3ad64` → T1 `t_ce07adbb` → T2 `t_0052507c` →
T3 `t_ecf7716e` → T4 `t_cb98ea28` → T5 `t_8445ea93` → Ship gates `t_42f43acc`.
This doc is the detail SoT; cards are execution tracking.

---

## Root-cause findings (audit results)

### F1 — LIVE ROSTERS BROKEN: Svelte 5 untracks function-body store reads (PRIMARY BUG)
**Proven empirically** with this repo's own Svelte 5.56.8 compiler. In legacy mode, any
template expression that calls a helper function gets compiled as:

```js
const members = $.derived_safe_equal(() => (
    $.deep_read_state(channelId()),          // args ARE tracked
    $.untrack(() => getVoiceMembers(channelId()))  // function BODY is UNTRACKED
));
```

Any store/prop read **inside the function body** (`$voiceChannelMembers[...]`,
`connectedVoiceChannelIds.has(...)`) never registers a dependency. The roster UI therefore
cannot re-render when someone joins/leaves — until an unrelated signal forces the each-block
to re-run. That unrelated signal is exactly "move/drag a channel". Svelte didn't fail us;
the Svelte-4→5 migration changed the semantics under this code shape.

Affected sites (all share the class):
- `frontend/src/lib/components/sidebar/VoiceChannelList.svelte`
  - `getVoiceMembers()` L40–42 (member lists, occupancy counts)
  - `isConnectedToVoice()` L44–46 (connected tint/self chip)
  - `isPrimaryVoiceChannel()` L48–50
  - `isMemberSpeaking()` / `isSelfSpeakingInChannel()` L68–82 (speaking rings)
  - `visibleVoiceMembers()` L131, `showVoiceMembers()` L127
  - recording helpers L91–111
- `frontend/src/lib/components/sidebar/VoiceUserCard.svelte` (bottom-left card)
  - `getCurrentVoiceChannelName()` L39–43 — header shows a STALE channel name;
    this is precisely "bottom left controller doesn't update when you join multiple calls"
- `UnifiedChannelList.svelte` forwards these — verify no additional hidden reads there.

Backend is NOT the problem: verified `voice_channels.rs` emits full-roster
`voice-channel-state` on join/subscribe/unsubscribe/leave, and `presence.rs::on_disconnect`
removes the socket from every voice channel and broadcasts `voice-channel-left` +
`voice-channel-user-left`. FE handlers in `socketConnectionCore.ts` correctly feed
`presenceStore` writables. The data was always arriving; the render layer couldn't see it.

### F2 — CAMERA + SCREENSHARE CANNOT COEXIST ON WABIDB TRANSPORT
`WabidbVideoLane.startLocalVideo()` (`wabidbVideoLane.ts` L386–397) begins with
`if (this.active) return;` — one lane instance, one `source` ('camera'|'screen'), one
encoder. Whoever starts second silently loses. Envelopes carry `kind:'video'` but no
source discriminator, so receivers also couldn't tell feeds apart even with two lanes.

### F3 — NO PASSIVE VIDEO SURFACE FOR DOCKED CHANNEL CALLS
Docked-first contract (correct, keep it) means joining a voice channel never takes the
stage. But there is currently zero always-visible surface where a channel's incoming
camera/screen tiles live while docked — you must know to second-click the channel to open
the embedded shell. "Channel can't see video/screenshares" is partly F2, partly this.

### F4 — BOTTOM-RIGHT CONTROLLER = `.docked-bar` (CallModal.svelte L919–975, CSS
call-modal-part1.css L144+). Fixed `right:1rem; bottom:1rem`; holds Open/Focus/Diag/Mute/
Deafen/Record/End. To remove for channel mode WITHOUT losing capabilities:
- Mute/Deafen/End → already duplicated in sidebar `.voice-self-controls` ✓
- Camera/Screenshare → already in VoiceUserCard actions ✓
- Record → ONLY here. Must port to VoiceUserCard before removal.
- Open (embedded view) → also reachable via second-click on connected channel ✓ (keep that
  path intact; peer sessions have reverted it twice — guard with a tripwire test)
- (Not to be confused with `business-hub-btn` / `pureref-button-container` bottom-right
  widgets — unrelated to calling, left alone. Dev-only `.call-debug-toggle` is bottom-LEFT.)

### Verified healthy (no work needed)
- Server roster fan-out incl. disconnect cleanup (see F1).
- Relay→lane video routing (`wabidbMediaRelay.attachVideoLane` + `handleRemoteEnvelope`),
  key normalization `toStableUserKey` (fixed earlier today), token-per-request (fixed).
- Screen-share auto-lane subscription (`screenShareSub`) reacts to `localScreenStream`.
- Store writers (`_set/_update/_removeVoiceChannelMember`) — correct immutable updates.
- Drain/reconnect map includes voice-channel-join/subscripe (fixed earlier today).

---

## P0 — Restore live rosters (F1)
- [ ] P0.1 `VoiceChannelList.svelte`: eliminate untracked reads — inline store reads into
      template expression positions (`{@const members = $voiceChannelMembers[channel.id] || []}`)
      or pass reactive values as helper ARGUMENTS (`getMembers(membersMap, id)` — args are
      tracked). Apply to: member list, occupancy count, self chip gating, connected/primary
      classes, speaking rings, REC badges, presence-duration lookups.
- [ ] P0.2 `VoiceUserCard.svelte`: replace `getCurrentVoiceChannelName()` with a top-level
      `$:` derivation over `voiceChannels` + `runtimeActiveVoiceChannelId` (+ `$listeningVoiceChannels`
      names for multi-listen header — see P2.2). Sweep remaining helper-body prop reads.
- [ ] P0.3 Compile-proof: node script compiles both files and asserts the generated
      `derived` bodies no longer wrap the roster/prop reads in `$.untrack(...)` (reuse the
      probe from the audit). Add as `tests/` vitest case so this class can't regress.
- [ ] P0.4 `bun run check` — diff counts against baseline (6 errors / 107 warnings).
- [ ] P0.5 Runtime smoke (2 clients): A joins → B's channel row + member count update with
      ZERO interaction; A hard-disconnects (kill tab) → B updates live; multi-listen chips
      appear/disappear live; bottom-left card name follows primary switch.

## P1 — Channel sees video + screenshares (F2 + F3)
- [ ] P1.1 Add `source: 'camera'|'screen'` to video chunk envelopes (rides existing meta
      fields; server fan-out is payload-agnostic — proven). Receiver keys remote streams by
      `` `${toStableUserKey(userId)}:${source}` ``; absent source ⇒ 'camera' (legacy compat).
- [ ] P1.2 Allow two concurrent outbound sources: per-source lane instances (shared socket,
      distinct `source`), or extend lane to multiplex two encoders — pick smaller diff at
      implementation time. `wabidbStartVideo('camera')` must no longer be blocked by an
      active screen lane and vice versa.
- [ ] P1.3 `buildWabidbAwareParticipants` / `callRenderModel`: map `userId:source` streams
      to participant video vs `kind:'screen'` tiles; screen tiles keep priority layout.
- [ ] P1.4 Docked live-preview strip: when the connected channel has ANY inbound video/
      screen stream, render a compact tile strip docked above the composer (inside chat
      stack, no center-stage takeover, respects docked-first contract; click tile = open
      embedded shell). Hidden when empty. This is "channel sees video" without breaking
      docked-first.
- [ ] P1.5 Teardown correctness: browser-chrome "Stop sharing", `stopScreenShare`, channel
      leave, and call end must clear lanes AND strips for exactly that source/channel
      (listen-only channels receive-only — no capture side effects).
- [ ] P1.6 Unit tests: envelope round-trip with `source`, receiver defaulting, dual-source
      lane gating. Run relay test suite (bun) + `cargo check -p wabi-server` (expect clean,
      untouched).
- [ ] P1.7 Smoke: A cam+screen simultaneously → B sees TWO distinct tiles live; B on
      listen-only second channel also sees them; stops propagate within ~1s.

## P2 — Controller consolidation (F4)
- [ ] P2.1 Port Record control into VoiceUserCard actions row (same handler as docked bar's
      `handleToggleRecording`). No capability loss ⇒ safe removal.
- [ ] P2.2 Bottom-left card = multi-call aware: title area lists EVERY connected channel —
      primary first with resolved `$channels` name (fallback raw id), then "Listening:"
      names; live via P0 fixes. Broadcasting badge unchanged.
- [ ] P2.3 Remove `.docked-bar` for `$callMode === 'channel'` only (DM/group calls keep it
      this pass — their only docked-state surface; explicitly deferred, not forgotten).
- [ ] P2.4 Delete dead channel-docked CSS branch; keep `--z-call-docked` (still used by
      DM/group path). Tripwire test asserting `handleVoiceChannelClick` still calls
      `openChannelCallPanel()` on connected channels (second-click embed survives).
- [ ] P2.5 `bun run check` diff vs baseline again.

## P3 — Ship gates
- [ ] P3.1 Scoped commits, exact file lists (never `-A`): (a) reactivity fixes, (b) video
      source/lane, (c) controller consolidation + tests.
- [ ] P3.2 `STATIC_BUILD=1 npm run build`; deploy per runbook: scp as OWN command → stop →
      mv swap → chmod → up -d → SHA match local==remote → container StartedAt > mtime →
      strings grep new marker (new CSS hash + `wabidb-video-source` symbol) → version.json
      equality → byte-diff served CSS vs local build asset → `/health`.
- [ ] P3.3 Live verification WITH Ronin (headless cannot render Wabi — Skia crash): he
      refreshes two clients; run P0.5 + P1.7 checklists; honest state labels per step.

## Explicitly deferred (needs Ronin's call later, not blocking)
- Fate of the docked bar for DM/group calls once VoiceUserCard generalizes beyond channels.
- Speaking-ring propagation for listen-only channels (works today via relay activity pulse;
  re-verify after P0 lands).

---

# Addendum: Transport switch + fallback research (P2P backup lane)

Question: WabiDB can't be everything — people need a way to route to different setups
(rebuilds, plugin transports, whatever). P2P is the example. How does swapping/fallbacking
work today, and what should it become?

## What exists today (verified)

**The switch itself**
- `CallTransportMode = 'auto' | 'p2p-only' | 'sfu-preferred' | 'wabidb'` (mediaRuntime.ts L37),
  persisted in localStorage, migrated `'stdb'` → `'wabidb'` on read.
- Settings UI: AudioSettingsTab.svelte "Call Mode" select. **BUG:** offers only
  `p2p-only` / `sfu-preferred` / `wabidb` — the ACTUAL default `auto` is missing from the
  dropdown — and labels `p2p-only` as "P2P (Default)" while the note below admits
  "wabiDB default relay". The UI actively misleads about what the default is.
- Resolution: `resolveCallTransportPlan()` — auto ⇒ wabidb (unconditional); `wabidb` ⇒
  wabidb (+ soft-fail when `/api/media/runtime` unreachable); `sfu-preferred` ⇒ sfu if
  LiveKit ready, else **falls back to p2p**; `p2p-only` ⇒ always p2p.
- `resolveActiveTransport(channelId?)` post-processes the plan and **lies for DMs**: no
  `channelId` ⇒ forces `'p2p'` regardless of the plan (callingTransport.ts). Known-bad —
  it's why DM camera gating was patched to check `wabidbTransportLive()` runtime truth
  instead of fixing the router (8eaad157).

**Fallback behavior per call surface — three hand-rolled, mutually inconsistent chains:**
| Surface | wabidb fails | SFU fails | Mid-call death |
|---|---|---|---|
| Voice channel (`joinVoiceChannel`) | caught + logged, **no fallback**, user silently deaf | n/a (never tried) | nothing |
| Group (`enterEstablishedGroupCall`) | tries LiveKit SFU | logs "will use P2P" — **no P2P actually established** | nothing |
| DM callee (`answerCall`) | tears down relay, **does fall through to real P2P answer path** | n/a | nothing |

No mid-call demotion anywhere: if the wabidb relay dies mid-call you stay broken until the
drain/reconnect heal fires. No health watchdog, no promotion back after heal.

**Server capability advertisement**
- `/api/media/runtime` (api/media.rs `media_runtime_snapshot`) publishes: TURN configured,
  gateway health (hardcoded false), `sfu.provider: 'livekit'` iff a `livekit-server`
  BINARY answers `--version` on the host, booster_relay (hardcoded off/self_hosted).
- There IS a media-room registry with external nodes: `assign_room` / `mark_active`
  take `node_id` + `sfu_endpoint` (api/media.rs L201–214) — i.e. the backend already has
  the shape for pluggable media planes, it just doesn't expose it as one.

**Extensibility gap (the "plugin call system" question)**
- `SfuProvider = 'none' | 'livekit'` and `CallTransportMode` are closed enums; adding a
  transport today means editing the union + resolver + every call site + the settings
  dropdown. All core files. No registry, no interface, no seam.

## Design verdict

The pieces exist (three independent connect paths, TURN prefetch, LiveKit token path,
relay connect, room registry). What's missing is ONE orchestrator and honest routing.
Build the ladder, don't invent new transports yet.

### T-series tasks (append to execution order after P2)

- [ ] T1 — Truthful router. Fix `resolveActiveTransport()` to stop forcing p2p for DMs
      (accept call-kind, consult runtime truth like toggleVideo already does). Retire the
      per-consumer runtime-truth patches where the router becomes trustworthy. Fix the
      settings dropdown: include `auto` (default, labeled as such), correct the "P2P
      (Default)" lie, describe each mode's fallback chain in the note.
- [ ] T2 — Declarative fallback chains. One table:
      `auto: [wabidb, p2p] · wabidb: [wabidb] · sfu-preferred: [sfu, wabidb, p2p] ·
      p2p-only: [p2p]`, surface-aware tail: DM/group may end in p2p mesh; large channels
      end at sfu (mesh of N>~6 is not a fallback, it's a outage). One
      `connectWithFallback(surface, channelId, chain)` replaces the three divergent
      sequences in joinVoiceChannel / enterEstablishedGroupCall / answerCall. Every
      demotion logs its reason into `callTransportState.reason`; exhaustion surfaces
      `callOfflineNotice`.
- [ ] T3 — Mid-call watchdog + heal-promotion. Relay socket death ⇒ one reconnect attempt
      ⇒ demote to next chain link (audio continues; UI badge flips to the fallback
      transport). On primary heal ⇒ offer promotion back (auto for listen-only, explicit
      click for transmit). Watchdog owns `callTransportState.checkedAt` freshness.
- [ ] T4 — Transport registry seam (the plugin door, minimal). Define
      `CallTransportAdapter { id, isAvailable(runtime), connect(ctx), destroy(), health() }`.
      Register built-ins (wabidb, p2p, livekit) as the first three adapters; T2's chain
      executor consumes ONLY the interface. Extend `SfuProvider` to a string + let
      `/api/media/runtime` list arbitrary `transports: [{id, endpoint, tokenUrl?}]`
      entries (room registry's node_id/sfu_endpoint already supports it server-side).
      Third-party/plugin transports then arrive as data + one adapter module — no core
      edits. Do NOT build plugin loading UI yet; ship the interface, prove it by making
      livekit consume it.
- [ ] T5 — Tests: chain-resolution table tests (mode × runtime-state → expected effective +
      reason), demotion/promotion state machine, adapter contract test each built-in
      satisfies. Keep them invariant-style (no snapshot of the chain contents).

Constraint notes:
- P2P as channel fallback means full-mesh renegotiation for every member — acceptable for
  small N only; chain must know N before choosing the p2p link.
- TURN stays orthogonal: p2p links soft-fail TURN credentials exactly as today.
- Offline/LAN rule unchanged: wabidb first for auto; router must keep treating
  runtime-unreachable as "stay local", not "go p2p through NAT hell".

