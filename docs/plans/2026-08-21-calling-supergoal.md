# Calling Supergoal — Voice/Video/Screenshare on WabiDB + P2P, One UI

Date: 2026-08-21. Owner: Hermes (verify) + OpenCode workers (implement).
Status: ACTIVE. Task-only plan (no estimates), per Ronin standing rule.

## Super goal

Voice AND calling through wabiDB **and** P2P, screenshare standard, Discord-grade
avatar chips and UX, first-click-join / second-click-call-workspace. Aggressively
best-in-class calling. Cross-compared against Discord.

## Audit findings (disk truth 2026-08-21)

1. **Default transport = wabidb relay, but it is AUDIO-ONLY.**
   `frontend/src/lib/wabidbMediaRelay.ts` carries mono opus audio via
   socket.io base64. Zero video code. Camera + screenshare only function on
   P2P (`callingScreenShare.ts` → WebRTC) or LiveKit SFU.
   **Bug:** under default transport, `startScreenShare()` captures display,
   sets `isSharing=true`, emits `start-screen-share` presence — no video ever
   reaches peers. Silent failure users will hit immediately.
2. **Two overlapping call UI systems (Ronin: "mess needs organizing").**
   - `CallView.svelte` — mounted globally in `+layout.svelte`, fullscreen
     `media-overlay` for `$callMode !== 'channel'` (DM/group/video/shares).
   - `CallModal.svelte` — docked bar / embedded panel / focus shell, all modes.
   DM group+video calls therefore can render BOTH stacked. Channel voice uses
   only CallModal. Tile/grid logic split across `callRenderModel`,
   `callLayoutManager`, `callModalHelpers`, `CallParticipantGrid/Tile`.
3. **First/second-click contract is live** (join → docked bar; second click →
   embedded panel via `openChannelCallPanel` + CallModal watcher :340). Needs
   upgrade into a real call workspace, not just an embed.
4. Multi-listen (TeamSpeak-style) roster + deterministic session keys +
   base64 binary fix are landed and verified per prior audits.
5. Server fan-out rooms exist (`join-wabidb-call`, `wabidb-media`,
   `media_reactions_signaling.rs`). socketioxide `Data<Value>` DROPS binary —
   payloads MUST stay base64 strings.

## Discord UX comparison (research summary driving tasks)

| Discord behavior | Wabi target |
|---|---|
| Click voice channel = instant join, docked bottom-left panel | KEEP (already matches) |
| Click again → expandable voice "stage" with tiles | Second click → full call workspace embed |
| Speaking ring around avatars; screenshare becomes stage, participants shrink to right filmstrip | Spotlight layout: stage + filmstrip |
| Avatar tiles: stable, no reflow on join/leave; camera tiles above voice-only | Stable keyed tiles, camera row prioritized |
| Connection quality indicator per user | Transport badge per tile (relay/p2p/sfu) |
| Noise suppression toggle, input/output device picker | Device picker in workspace settings row |
| Overlay-free chat while in voice | Docked bar never blocks center stage |

## Tasks (kanban-tracked)

### K1 — Unify call UI into ONE renderer [frontend]
- Absorb CallView's overlay duties INTO CallModal shell (or gate CallView to
  render nothing and port its unique bits: recording pill, diagnostics).
- Single component tree: CallModal owns docked bar + embedded workspace +
  focus; delete duplicate overlay CSS/markup once parity proven.
- No behavior change to docked-first contract. `bun run check` diff vs baseline.

### K2 — Video + screenshare on wabidb relay [backend+frontend lib]
- Extend `WabidbMediaRelay`: add video lane alongside audio. Encode via
  WebCodecs (VP8/software ok) → frame-chunked base64 over existing
  `wabidb-media` event with `{kind:'audio'|'video', seq}` envelope; receiver
  jitter-buffer + WebCodecs decode → `<video>` render.
- Adaptive: keyframe request on loss, resolution downscale under bandwidth
  pressure (measure sent bytes/s client-side).
- Screenshare rides same lane (higher res profile, cap ~1080p15).
- Camera parity for DM/group video calls on wabidb.
- Server unchanged (fan-out already payload-agnostic; keep base64!).

### K3 — Avatar chips & tiles, Discord grade [frontend]
- Speaking-ring animation from existing audio monitors.
- Stable tile keys (no reshuffle on join/leave), camera-first ordering.
- Spotlight/stage layout when screenshare active (stage + right filmstrip).
- Per-tile transport badge (wabidb/p2p/sfu) + muted/deafened icons.

### K4 — Call workspace embed (second click) [frontend]
- Embedded panel becomes workspace: participant grid, pin speaker, controls
  row (mute/deafen/video/screenshare/settings/leave), device picker.
- Auto-dock on navigate-away stays. Hatch toggle unaffected.

### K5 — Cleanup dead calling UI [frontend]
- After K1 parity: remove absorbed CallView markup/CSS, orphan helpers.
- Update `wabi-calling` skill file map + stale notes (second-click inert note
  is outdated; relay path notes refreshed).

### K6 — Runtime smoke, 2 clients [verification]
- Local stack: wabi-server :3001 + vite :5173. Two browser profiles.
- Matrix: DM voice (wabidb), DM video (wabidb), channel voice multi-listen,
  screenshare on wabidb, screenshare on p2p-only mode, leave/unsubscribe
  isolation. Console trace per skill diagnostic strings.

## Execution order

Batch A (parallel workers): K2 (isolated: wabidbMediaRelay + callingWabidb),
K1 (isolated: CallView/CallModal).
Batch B (after A): K3 + K4 (same surface, one worker or sequenced).
Then: K5 cleanup + Hermes verify each step (`cargo test -p wabi-server`,
`bun run check`, grep markers) → K6 smoke with Ronin.

## Hard rules (from wabi-calling skill)

- Workers: plain edits, scoped commits only (`git add <exact files>`), no
  stash/checkout. Peer session active on tree.
- Base64 payloads only over socket.io. Never `Math.random()` user ids.
- Join paths never open center stage; embedded only via explicit action.
- Build-verified ≠ audio-proven; K6 gates "done".
