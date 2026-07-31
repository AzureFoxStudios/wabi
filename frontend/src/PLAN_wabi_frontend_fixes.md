# Wabi Frontend Fixes Plan

## Issue inventory

1. Right panel media: "Failed to list media albums" error + wasted space with redundant "Media" word + need dropdown for channels/DMs
2. Center view: no way to get out of notes/center view to other views (admin, etc.)
3. Admin right panel: two links open the exact same spot; admin full view slow to boot (possible crash)
4. Maps: where to fix them if not in admin view
5. Notes: dedicated overhaul — obsidian-like centerview, right panel formatting cuts off
6. Upper left server hub: server banner not displaying properly
7. Channel categories (text/voice/gallery) are immutable; channels are undraggable/reorganizable

---

## 1. Right Panel Media — Error + Redundant Label + Channel/DM Dropdown

### Root causes
- `MediaAlbumsTabImpl.svelte` line 769: hardcoded `<h3>Media</h3>` — redundant because the panel tab already says "Media". The scope label below it (`scopeLabel`) already shows the channel/DM context.
- The "Failed to list media albums" error comes from the `refreshAlbums` catch block (line 452): `errorMessage = error instanceof Error ? error.message : 'Failed to load media albums'`. This fires when `listMediaAlbums` API call fails — likely a 401/403 or network error. Need to check if the auth token is being sent correctly.
- No dropdown to switch between channels/DMs — the media tab is locked to the current channel.

### Fix plan
- Remove the redundant `<h3>Media</h3>` header (line 769). The scope label already provides context.
- Add a channel/DM dropdown selector above the album list that lets users switch which channel's albums they're browsing. Populate it from `$channels` filtered to channels where the user has album access.
- For DMs, show the other participant's name/PFP (use `$users` store to look up DM participants).
- Investigate the API error: check if `getAuthToken()` returns null in some cases (e.g., after token refresh), causing `refreshAlbums` to bail early with an empty token but still showing the error banner from a previous failed call.

### Files
- `lib/components/media-albums/MediaAlbumsTabImpl.svelte` — remove h3, add dropdown, fix token null handling
- `lib/components/media-albums/MediaAlbumsTabImpl.css` — style dropdown

---

## 2. Center View Exit Navigation

### Problem
When `activeView === 'notes'` (center view), the only exit is "Back to chat". There's no way to navigate to admin, following, or other center views from within the notes center view.

### Fix plan
- Add a nav bar/toolbar to the center notes view (in `MainLayout.svelte` around line 919) with links to other center views: Chat, Admin (if role permits), Following.
- Alternatively, add a persistent minimal nav bar when in any center view (notes, following) that lets users switch between center views.
- The admin center stage already has a "Back" button — mirror that pattern for notes.

### Files
- `lib/components/MainLayout.svelte` — add center view nav bar for notes view
- `styles/components/main-layout.css` — style the center nav bar

---

## 3. Admin Right Panel Overhaul — Dedupe Links + Slow Boot

### Problem A: Two links opening the same spot
In `AdminTab.svelte` lines 107-119:
- Button 1 "Open full admin" → calls `layoutStore.showAdminCenterStage()` (sets `centerPanelView = 'admin'`)
- Button 2 "Open full dashboard" → also calls `layoutStore.showAdminCenterStage()`
Both do the exact same thing. The "Open full admin" button should open the admin settings/settings panel instead, or the second button should be removed/replaced with something that actually opens a different view.

### Fix plan A
- Remove the duplicate "Open full dashboard" button (line 111-119).
- Replace "Open full admin" with a single clear button labeled "Open Admin Dashboard" that opens the admin center stage.
- OR: make "Open full admin" open the admin settings tab (right panel admin), and keep "Open full dashboard" for the center stage admin. This gives two distinct actions.

### Problem B: Admin full view slow boot / crash
`AdminWorkspace.svelte` (920 lines) loads 4 async panels simultaneously on mount:
- `refreshCompressionPanel()` — fetches config + metrics
- `refreshRuntimePanel()` — fetches policy + guardrails
- `refreshFrontendMetadata()` — fetches metadata
- `refreshPaymentControls()` — fetches payment policy

All fire in reactive `$:` blocks that trigger on mount. This is 4 concurrent API calls on a page that already fetches stats + payment policy in `AdminCenterStage.svelte`. The cumulative load causes the slow boot.

### Fix plan B
- Stagger the loads: only load the active section's data, not all 4 panels upfront.
- Add loading skeletons per section instead of a global loading state.
- The `section` prop controls which panel is visible — lazy-load each panel's data only when its section becomes active.

### Files
- `lib/components/AdminTab.svelte` — dedupe the two admin buttons
- `lib/components/AdminWorkspace.svelte` — lazy-load panel data per active section
- `lib/components/AdminCenterStage.svelte` — already ok, just needs the section lazy-load coordination

---

## 4. Maps — Where to Fix

### Current state
Map is a workspace panel (`MapWorkspace` component, `lib/components/map/`). It's NOT in the admin view. The map lives in the right panel as a workspace tab and has its own full-center view via `MapWorkspace variant="full"`.

### Fix plan
- If the map needs fixes (styling, data, controls), the relevant files are in `lib/components/map/`:
  - `MapWorkspace.svelte` — main map component
  - `MapCompactToolbar.svelte` — toolbar when compact
  - `MapEmptyStage.svelte` — empty state (currently redirects to admin center stage)
  - `MapPlaceHeader.svelte`, `MapPlaceSidebar.svelte`, `MapViewportDetails.svelte` — place detail UI
- If the user wants map settings/config in admin, that's a new admin panel in `AdminWorkspace.svelte`.
- If the map is crashing or misbehaving, the fix depends on the specific symptom — need more info from the user.

### Files (investigation targets)
- `lib/components/map/MapWorkspace.svelte`
- `lib/components/map/MapEmptyStage.svelte`
- `lib/components/map/MapPlaceSidebar.svelte`

---

## 5. Notes Overhaul — Obsidian-like Centerview + Right Panel Formatting

### Problem A: Notes centerview lacks punch
The current notes centerview (`activeView === 'notes'` in MainLayout.svelte line 918-926) is a bare `<NotesWorkspace compact={false} />` with minimal chrome — no toolbar, no markdown preview toggle, no obsidian-like features.

### Fix plan A
- Build a richer `NotesCenterView` component that includes:
  - Markdown toolbar (bold, italic, code, link, heading, list, quote)
  - Live markdown preview toggle (split view or toggle)
  - Note list sidebar within the center view (not just a textarea)
  - Keyboard shortcuts (Ctrl+S save, Ctrl+N new note)
  - Tags/labels for notes
  - The right panel notes stays as a quick-scratchpad (`compact={true}`)

### Problem B: Right panel notes formatting cuts off
The `NotesWorkspace` in the right panel uses `compact={true}` which renders the compact view (line 269-356 of NotesWorkspace.svelte). The compact view has a fixed-height textarea that may overflow. The `.notes-workspace` CSS has `height: 100%; min-height: 0; display: grid` but the grid template rows aren't set for the compact variant, causing content to be clipped.

### Fix plan B
- Fix the compact notes workspace CSS to properly constrain the textarea within the right panel bounds.
- Add `overflow-y: auto` to the compact notes list area.
- Ensure the right panel content area doesn't clip the notes workspace.

### Files
- `lib/components/NotesWorkspace.svelte` — fix compact view overflow, build center view variant
- `lib/components/MainLayout.svelte` — wire the richer notes center view
- New component: `lib/components/NotesCenterView.svelte` (obsidian-like editor)
- `styles/components/main-layout.css` — center notes layout styles

---

## 6. Server Hub Banner Not Displaying

### Problem
The upper-left server rail (`ServerRail.svelte`) shows server icons (`effectiveIconUrl`) but NOT server banners. The `ServerSwitcherPanel.svelte` (the full server switcher) DOES show banners via `effectiveBannerUrl` in its showcase area (line 662-667).

The "server hub" that the user refers to is likely the `ServerSwitcherPanel` (the full overlay) or the `ServerRail` (the persistent left rail). The rail only has avatar icons. The switcher panel has the banner but it's only visible when the switcher is open.

### Fix plan
- If the user means the persistent left rail should show banners: add `effectiveBannerUrl` display to `ServerRail.svelte` server pills (as a background banner or accent strip).
- If the user means the `ServerSwitcherPanel` showcase banner isn't showing: check `effectiveBannerUrl` resolution — it may be returning null/empty because `server.bannerUrl` isn't set in the saved server data.
- Check `savedServers.ts` to see how `effectiveBannerUrl` is computed and whether the backend is providing it.

### Files
- `lib/components/ServerRail.svelte` — add banner display support
- `lib/components/ServerSwitcherPanel.svelte` — debug banner display (line 662-667)
- `lib/savedServers.ts` — check effectiveBannerUrl computation

---

## 7. Channel Categories Immutable + Channels Undraggable

### Problem
The `ChannelSidebar.svelte` has text/voice/gallery sections that can be expanded/collapsed but:
- Channel ORDER within each section is fixed (sorted alphabetically, `general` always first)
- Channels cannot be dragged to reorder or move between sections
- The section categories themselves (text/voice/gallery) cannot be rearranged

### Fix plan
- Add drag-and-drop reordering within each section (like the server rail already supports).
- Allow channels to be dragged between sections (changing their `type`).
- Persist the custom order via `updateChannelSettings` or a new `channelOrder` field.
- Make section order configurable (text/voice/gallery can be rearranged).

This is a significant feature addition. The server rail already has drag-and-drop for servers — the pattern can be adapted for channels.

### Files
- `lib/components/ChannelSidebar.svelte` — add drag handlers for channels
- `lib/socket.ts` — ensure `reorderChannels` or `updateChannelSettings` supports type changes
- `styles/components/sidebar-channels.css` — drag visual feedback

---

## Execution Order (priority)

P0 (quick wins, clearly broken):
1. Admin right panel dedupe (two links same spot) — 10 min fix
2. Media tab redundant "Media" h3 removal — 5 min fix
3. Notes right panel formatting cut-off — CSS fix

P1 (meaningful UX improvements):
4. Channel/DM dropdown for media albums
5. Admin full view lazy-load (slow boot)
6. Center view exit navigation for notes
7. Server hub banner display fix

P2 (larger features):
8. Notes obsidian-like center view overhaul
9. Channel reordering/drag-and-drop
10. Maps fix (need more specifics from user)

---

## Verification

After each fix:
```bash
cd /var/home/Ronin/wabi/frontend
bun run check 2>&1 | tail -3
bun run build 2>&1 | tail -3
```
Visual verification in Ronin's real browser (headless Chromium crashes on Wabi).
