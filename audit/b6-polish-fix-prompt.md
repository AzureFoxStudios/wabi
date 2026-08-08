# Dispatch: Channel sidebar + forum + profile polish fixes

## Context
Multiple UI issues reported on wabi.chat (deployed at commit 61f53a7 / SHA 56d3cff6):

### 1. Channel folders / categories — "we're welding text channels to text channels folder, should allow new category folders like 'sfw art', 'nsfw art'"
The `ChannelSidebar.svelte` has a `groupByCategory` function (line 151) that groups channels by `parentId`. Channels with `parentId` pointing to another channel become children of that channel (category). The "weld" issue is in `sameChannelFamily` (line 278) and the drag-and-drop `handleChannelDrop` which refuses cross-type drops but may not properly support creating NEW category channels.

**Files**: ChannelSidebar.svelte (lines 151-172 groupByCategory, 278-285 sameChannelFamily, 326-419 handleChannelDrop), context menu items (line 484+ buildChannelMenuItems), ChannelSettingsModal.svelte

**Check**: Does the context menu / create channel form allow creating a "category" channel type? Is the `channel_type` for categories properly handled? Can users drag a channel into a NEW category (not just existing ones)?

### 2. If a channel is selected, channel icons stay up instead of only on hover
This is a CSS issue — icons in the channel list are always visible instead of only on hover.

**Files**: CSS files used by ChannelSidebar, look for `.channel-btn` hover rules

### 3. Gear icon is messed up — "no longer looks like a gear for settings"
In `ProfileCard.svelte` line 214-219, the settings button renders a **sun/ray icon** SVG (circle with rays), not a gear/cog. The path `M19.4 15a1.65 1.65...V21a2 2 0 0 1-4 0...` is a sun icon.

**Fix**: Replace with a proper gear SVG: `<circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 10v6..."/>` or similar.

**Files**: ProfileCard.svelte (lines 206-219)

### 4. Clicking share link has no feedback
The `shareProfile()` function in ProfileCard.svelte (line 91-100) calls `navigator.share` or `navigator.clipboard.writeText` with `.catch(() => {})` — silently swallowing errors and providing no success feedback.

**Files**: ProfileCard.svelte (lines 183-212, the share button + shareProfile function)

### 5. Profile pictures upload but don't stick — "they don't stick, wait there was another flicker and it stuck"
**FIXED** in commit 94647a6 — the `on_update_profile` handler now merges the update patch into the pre-write user snapshot instead of re-reading from the store. **However**, the user may still be experiencing this if:
- The frontend doesn't receive the `profile-updated` broadcast
- The `currentUser` store doesn't merge the update properly
- There's a local IndexedDB sync issue overriding the server value

**Verify**: Check that `Settings.svelte` `uploadProfilePicture()` (lines 197-222) properly handles the `profile-updated` event. Check `currentUser` store merging.

### 6. Forum "New Thread" — move to middle category "All Threads" area, right-aligned with +, get rid of double title and button row
In `ForumChannel.svelte`, the `SurfaceHeader` (line 171-176) shows `title={activeChannel?.name}` with `primaryLabel={canCurrentUserPost ? '+ New Thread'}` — a large button on the right. Below it is a `SurfaceToolbar` (line 178-190) with search + category pills.

**Requested**: Move the "+ New Thread" button to be right-aligned inside the "All Threads" category pill area in the SurfaceToolbar, eliminating the double title row ("#ChannelName" then "#ChannelName For[ + NEW THREAD                                               ]").

**Files**: ForumChannel.svelte (lines 170-190), SurfaceHeader.svelte, SurfaceToolbar.svelte

## Requirements
- Write report to `audit/b6-polish-fix-report.md`
- Run `cargo check -p wabi-server`, `bun run check`, `bun run build:only`
- Use Svelte 5 runes syntax
- Don't touch lore code
- Scope: ChannelSidebar.svelte, ProfileCard.svelte, ForumChannel.svelte, SurfaceHeader.svelte, SurfaceToolbar.svelte, Settings.svelte, ChannelSettingsModal.svelte, related CSS files
