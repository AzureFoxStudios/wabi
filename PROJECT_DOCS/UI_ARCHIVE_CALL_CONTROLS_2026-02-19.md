# UI Archive: Retired Call/Channel Controls (2026-02-19)

This file preserves removed UI code so it can be referenced later.

## 1) MainLayout Mobile Voice Strip (retired controls)

```svelte
<button class:active={$isMuted} on:click={toggleMute}>...</button>
<button class:active={$isDeafened} on:click={toggleDeafen}>...</button>
<button class:active={!$isVideoOff} on:click={handleToggleVideoFromStrip}>
  {$isVideoOff ? 'Camera' : 'Camera On'}
</button>
<button class:active={$isSharing} on:click={handleToggleScreenShareFromStrip}>
  {$isSharing ? 'Stop Share' : 'Share'}
</button>
<button class:active={$channelCallPanelOpen} on:click={toggleChannelCallPanel}>
  {$channelCallPanelOpen ? 'Hide View' : 'Open View'}
</button>
<button class="leave" on:click={handleLeaveVoiceChannel}>Leave</button>
```

Replaced with:
- camera icon button
- door-style leave icon button
- no mic/deafen/share/open-view buttons in this strip

## 2) MainLayout In-Call Toast (removed)

```svelte
{#if $layoutStore.isInCall && !$channelCallPanelOpen && $layoutStore.isMobile}
  <div class="voice-toast" role="status">
    ...
    <button class="voice-toast-action" on:click={openChannelCallPanel}>Return to call</button>
    <button class="voice-toast-action" on:click={handleOpenCallFullscreen}>Full Screen</button>
  </div>
{/if}
```

Removed due redundancy with existing in-call UI context.

## 3) ChannelSidebar Top Header Buttons (removed)

```svelte
<button
  class="screen-share-icon-btn"
  class:active={activeView === 'screen'}
  on:click={() => activeView = 'screen'}
  title="Screen Share"
>
  ...
</button>

<button class="add-btn" on:click={() => showCreateInput = !showCreateInput} title="Create channel">+</button>
```

Replaced with:
- logo-centric header
- section-local `+` buttons beside `TEXT CHANNELS` and `VOICE CHANNELS`

## 4) ChannelSidebar Voice Usercard Actions (removed entries)

```svelte
<button class:active={$isSharing} on:click={handleToggleScreenShareInSidebar}>Share</button>
<button class:active={$channelCallPanelOpen} on:click={openChannelCallPanel}>Open View</button>
```

Removed due routing/UX changes.
