# DM Socket Room Join Pattern

## Problem (2026-08-07)

Two symptoms reported:
1. **Sending a DM doesn't update chat history** — optimistic message appears briefly then disappears; no server echo arrives.
2. **Any DM interaction forces the view of DMs everywhere** — clicking back to channels still shows the DM layout.

## Root causes

### Cause 1: Client never joins DM socket rooms

The server echoes messages via `io.to(channel_id).emit("message", ...)` in `socketio/messages.rs`. Only clients **joined to that room** receive the echo. DM/group channels were never joined:

- `DMTab.selectConversation()` → `layoutStore.openDM()` but NO `joinChannel()`
- `DmHub.openConversation()` → `layoutStore.openCenterDm()` but NO `joinChannel()`
- `socketConnectionCore.ts` DM events (`dm-created`, `dm-channel-added`, etc.) → upsert channel but NO `joinChannel()`
- `DmConversationView` → no `joinChannel` on mount/channel change

Result: optimistic message appended locally, but server echo never arrives → message "disappears" after a moment.

### Cause 2: `closeDM()` doesn't clear center-panel state

`closeDM()` cleared `selectedDmChannelId` (right panel) but NOT `centerDmChannelId` (center panel). `MainLayout` checks `$layoutStore.centerDmChannelId || activeView === 'dm'` — once set, it stays set forever.

## Fix diff summary

| File | Change |
|------|--------|
| `socketConnectionCore.ts` | Add `joinChannel(cid)` in `dm-created`, `dm-channel-added`, `group-created`, `group-channel-added` handlers |
| `DmHub.svelte` | Add `joinChannel(channel.id)` in `openInCenter()`, `openInSidePanel()`, `handlePersonSelected()` |
| `DMTab.svelte` | Add `joinChannel(channel.id)` in `selectConversation()` |
| `DmConversationView.svelte` | Add `$: if (channelId) joinChannel(channelId)` reactive |
| `QuickResourcesPanel.svelte` | Add `joinChannel(microDmChannelId)` in `openFullDms()` |
| `MainLayout.svelte` | Add `joinChannel(channel.id)` in `openUnreadDM()` |
| `+page.svelte` | Add `joinChannel($dmPanelSignal.channelId)` in `dmPanelSignal` reactive |
| `layoutStore.ts` | `closeDM()` now also calls `centerDmChannelId.set(null)` |

## Audit pattern for future DM work

Search for `layoutStore.openDM`, `layoutStore.openCenterDm`, `layoutStore.openGroupDM`, `layoutStore.openCenterGroupDm` — every call site should be followed by `joinChannel(channelId)`.

Also check `dmPanelSignal` consumers and any new DM entry points added by future features.