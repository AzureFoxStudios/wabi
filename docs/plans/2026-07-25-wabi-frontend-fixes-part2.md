# Wabi Frontend Fixes Part 2 - Kanban Cards (Updated)

## FIXED

### [x] SERVER-001: Server Banner Not Showing in Rail
**Problem**: The 4px banner strip was not visible.
**Solution**: Changed to use CSS pseudo-element `::before` with CSS variable `--server-banner-url` for proper positioning within the circular pill.
**Files**: `ServerRail.svelte`, `server-rail.css`

### [x] UI-001: Right Panel Width Issue
**Problem**: NotesDmDock was squished horizontally.
**Investigation**: 
- Right panel has `flex-basis: 320px` minimum
- Notes content needs horizontal scrolling when narrower than content
- Changed to `overflow-x: auto; overflow-y: hidden` on dock container
- Added `overflow-x: hidden` on `.notes-list-cards` to contain scroll
**Files**: `NotesDmDock.svelte`, `NotesWorkspace.svelte`

## IN PROGRESS

### [ ] UI-002: Voice Channel Icon Oversized
**Problem**: Speaker icon for voice channels is too large and doesn't scale with text.
**Investigation needed**: Find the icon sizing in ChannelSidebar.svelte or VoiceChannelList.svelte.
**Files**: `ChannelSidebar.svelte`, `VoiceChannelList.svelte`

### [ ] UI-003: Send Message Button State Flickering
**Problem**: Button appears/disappears on click, disorienting user.
**Investigation needed**: Find the send button logic in Chat.svelte or MessageInput.svelte.
**Files**: `Chat.svelte`, `MessageInput.svelte`

### [ ] UI-004: Notes Center View Navigation
**Problem**: No way to navigate from notes center view to other center views.
**Status**: Nav buttons were added in MainLayout.svelte but need review.
**Files**: `MainLayout.svelte`

## PENDING - Admin Workspace

### [ ] ADMIN-001: Channel Rename/Delete
**Problem**: Can't rename text/voice/gallery channels or delete them.
**Files**: `ChannelSidebar.svelte`, `TextChannelList.svelte`, `VoiceChannelList.svelte`

### [ ] ADMIN-002: Channel Reordering Between Categories
**Problem**: Can't move channels between organizer sections.
**Files**: `ChannelSidebar.svelte`, `channelOrganizers.ts`

### [ ] ADMIN-003: Roles UI Needs Work
**Problems**:
- "Add Role" button takes full width
- Default roles need editable fields
- Missing save button
**Files**: `AdminWorkspace.svelte`

### [ ] ADMIN-004: Overview Panel Not Loading
**Problem**: Overview section content not loading.
**Files**: `AdminWorkspace.svelte`

## PENDING - Other Features

### [ ] NOTES-001: Notes Center View Full Implementation
**Scope**: Markdown toolbar, live preview, note list sidebar, keyboard shortcuts.
**Files**: `MainLayout.svelte`, `NotesWorkspace.svelte`

### [ ] MAP-001: MapWorkspace Component Missing
**Problem**: No `MapWorkspace.svelte` exists - only stubs.
**Files**: `WorkspacePanelHost.svelte`, `map/` directory

### [ ] EMOJI-001: Emoji Picker Unfinished
**Problems**: No scroll, no sticker/gif tab switching.
**Files**: `EmojiPicker.svelte`

---

**Current Status**: Build passes. Server banner and right panel fixes applied. Remaining items require investigation and implementation.