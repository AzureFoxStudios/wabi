# Voice Channel UX Plan — discard takeover, dock-first, second-click embeds

**Goal:** Voice channel join is ambient (Discord-like). First click = join, docked bar + sidebar chips. Second click on same channel = embedded center-stage panel.

**Architecture:** Remove state pollution from join path; make `callViewportMode` an opt-in, not a side effect.

## T1 — Stop join from forcing panel/viewport state

File: `frontend/src/lib/calling_impl_core.ts`

In `joinVoiceChannel` (around line 1040–1050), remove:
- `channelCallPanelOpen.set(false)` on join
- any assignment that forces `callViewportMode`

Join should set only: `callMode.set('channel')`, `activeVoiceChannel`, `listeningVoiceChannels`, `isInCall`.

## T2 — Channel calls default to docked, never embedded on join

File: `frontend/src/lib/components/CallModal.svelte`

At the top of the `$: if ($isInCall && !wasInCall)` block (line ~279), change the channel path:

```ts
if (get(callMode) === 'channel') {
  callViewportMode = 'docked';  // was 'docked' but then channelCallPanelOpen=false fight
} else {
  // DM/group/call-incoming keep their existing behavior
}
```

The key: channel calls arrive in docked and stay docked until the user explicitly opens the panel.

## T3 — Gate center-stage takeover for voice-only channel presence

File: `frontend/src/lib/components/CallModal.svelte`

Change `showCallShell` (line 120):
```ts
$: showCallShell = $isInCall && (
  callViewportMode !== 'docked'
  || $callMode !== 'channel'        // DM/group always show shell
  || ($activeCalls.some(c => c.isVideoEnabled))  // video active
  || $screenShares.length > 0        // screen share active
);
```

Voice-only channel presence: no center-stage grid, just the docked bar.

## T4 — Second click opens embedded panel (already mostly wired)

File: `frontend/src/lib/components/ChannelSidebar.svelte` line 175

Already does `openChannelCallPanel()` when `isConnectedToVoice(id)`. With T1 removing the join-time fight, this now works as the explicit "open center stage" action on second click.

Verify in CallModal: `channelCallPanelOpen=true` + `callMode==='channel'` → embedded mode activates (line 312 reactive block). No code change needed here, just confirm T1+T2 land cleanly.

## T5 — Self-sidebar-chip survives roster refreshes

File: `frontend/src/lib/components/sidebar/VoiceChannelList.svelte` line 210-227

Currently `channelIsConnected && $currentUser` gates the self chip. `channelIsConnected` is derived from `connectedVoiceChannelIds` (ChannelSidebar) which already tracks `listeningVoiceChannels` + `runtimeActiveVoiceChannelId`.

The roster (`voiceChannelMembers`) can wipe mid-call on reconnection or transport re-resolution, but `connectedVoiceChannelIds` only changes on explicit join/leave. Move the self chip to render whenever the channel is in `connectedVoiceChannelIds`, independent of roster membership.

## T6 — Emit profile_picture from backend voice roster

File: `core/crates/wabi-server/src/socketio/shared.rs` line 301 `voice_participant_to_view`

Add `profile_picture` field from `connected_users`:
```rs
let profile_picture = state.connected_users.read().await
    .get(&socket.id.to_string())
    .and_then(|u| u.profile_picture.clone());
```

And emit it in the JSON:
```rs
"profilePicture": profile_picture,
```

Frontend type `VoiceChannelParticipant.profilePicture` already exists (presenceStore.ts:34), just wasn't populated by the server.

## T7 — Verify

```bash
cd /var/home/Ronin/wabi && cargo check -p wabi-server
cd /var/home/Ronin/wabi/frontend && bun run check
```

Expected: 0 new type errors on both sides. `profile_picture` as optional string maps cleanly to existing optional `profilePicture` field.

## Smoke (after build-green)

1. Client A joins voice channel → docked bar appears, center stage unchanged, self chip visible under channel.
2. Client B joins → B's avatar appears in A's sidebar chips (real avatar, not just letter).
3. Client A clicks same channel again → embedded panel opens, grid appears.
4. Client A clicks dock in the panel → back to docked, center stage clears.
5. Client A subscribes to second channel (multi-listen) → chips appear under both channels, docked bar reflects total presence.
