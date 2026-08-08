# Dispatch: Channel folder creation + forum New Thread reposition

## Context
Multiple UI issues reported on wabi.chat:

### 1. Channel folders/categories — "we're welding text channels to the text channels folder, should allow new category folders like 'sfw art', 'nsfw art'"
The `ChannelSidebar.svelte` has a `groupByCategory` function that groups channels by `parentId`. Channels with `parentId` become children of the channel that is their category parent. The "weld" issue: when you drag a text channel, `sameChannelFamily` (line 278) only allows same-type drops, and new categories can't be created.

**Need to add**: Ability to create a new CATEGORY channel that other channels can be dragged into. The category should be creatable via the "Create Channel" form (add a "Category" type) or via context menu on existing channels.

**Key constraint**: Must NOT weld text channels to the "Text Channels" header — the header should be auto-collapsed or removed so all text channels are truly free-floating in categories.

**Files to examine**: ChannelSidebar.svelte, CreateChannelForm.svelte, channelSidebarHelpers.*, ChannelSettingsModal.svelte

### 2. If a channel is selected, channel icons stay up instead of only on hover
When a channel is selected, its hover icons (bookmark, settings, etc.) should only show on hover, not permanently. The selected state should change the background/color but not force icons visible.

**Files**: ChannelSidebar.svelte, channel button CSS in sidebar-core*.css

### 3. Forum: Move "New Thread" to the category pills row, right-aligned, eliminate double title
Currently in `ForumChannel.svelte`:
- `SurfaceHeader` shows `title={activeChannel?.name}` + `primaryLabel={'+ New Thread'}` button (large row)
- Below: `SurfaceToolbar` with search + category pills (All, categories...)

**Requested**: 
- Remove the `+ New Thread` from primaryLabel in SurfaceHeader
- Add `+ New Thread` as a right-aligned button inside the SurfaceToolbar, next to the category pills
- Remove the double title (SurfaceHeader shows "Forum" as description, and the channel name is shown)
- Result: `#ChannelName` [row 1] | Search... [pills: All, cat1, cat2] [+ New Thread] [row 2]

**Files**: ForumChannel.svelte, SurfaceHeader.svelte, SurfaceToolbar.svelte

## Requirements
- Write report to `audit/b6-forum-sidebar-fix-report.md`
- Run `cargo check -p wabi-server`, `bun run check`, `bun run build:only`
- Use Svelte 5 runes syntax (no export let, no $:)
- Use deepseek-v4-flash-free model
- Scope: ChannelSidebar.svelte, CreateChannelForm.svelte, ForumChannel.svelte, SurfaceHeader.svelte, SurfaceToolbar.svelte, related CSS, channelSidebarHelpers.*
- Do NOT touch lore code or backend Rust
