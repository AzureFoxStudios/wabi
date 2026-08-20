# ServerRail Evolution — Handoff Brief for DeepSeek

## Context

Wabi is a self-hosted Discord-alternative (Svelte frontend + Rust `wabi-server`
backend, custom event-store DB "WabiDB"). A community member sketched a mockup
proposing an Obsidian/Trello-influenced navigation model. We're evolving the
existing far-left rail rather than adding a second one.

Design plan (source of truth): `docs/plans/2026-08-18-bookmarks-sections.md`
Mockup: a far-left vertical icon rail containing (top→bottom): server logo,
then surface icons (Home, Chat, Calendar, Tasks, Files), then Settings at the
bottom. Plus per-user density + side (left/right) preferences.

## The decision already made

Ronin's call: **evolve the existing `ServerRail.svelte`** into a dual-purpose
rail rather than creating a separate `SurfaceRail.svelte`. We need your read on
how to do that cleanly, because the existing component is doing a *different
job* and there's real tension in merging them.

## Ground truth — what exists TODAY (verified by reading the code)

### `frontend/src/lib/components/ServerRail.svelte` (390 lines, no `<style>` block)

Its job is **server switching** (which community am I in) — NOT surface
switching (which view am I looking at). Current anatomy, top to bottom:

1. `.rail-home` — Wabi logo button → dispatches `manage` (opens server switcher panel)
2. `.rail-divider`
3. `.rail-list` — `{#each $savedServerRailItems}`: saved servers + server folders
   - full drag-and-drop reorder (`handleDragStart/DragOver/Drop`)
   - drop positions `'before' | 'after' | 'inside'` — dropping a server *inside*
     another creates a folder (`createSavedServerFolder`)
   - folder pills render a 2x2 `.folder-grid` preview of member icons
   - desktop: `.folder-popout` flyout listing folder members
   - mobile: `.mobile-folder-tray` instead of popout
   - per-server unread badges from `$followUnreadCountsByServer`
   - `use:longpress` gesture (mobile) → `beginManageGesture()` with a
     `suppressTapUntil` tap-suppression window
4. Bottom (desktop only): two `.rail-manage` buttons — a gear → `centerPanelView.set('admin')`,
   and a `+` → dispatches `manage`

Props: `export let mobile = false;`
Events: `dispatch('manage')`
Key imports: `$lib/savedServers` (switchToSavedServer, reorderSavedServer,
createSavedServerFolder, moveSavedServerToFolder, reorderSavedServerRailItem),
`$lib/followingSnapshots` (followUnreadCountsByServer),
`$lib/layoutStoreStates` (centerPanelView), `$lib/actions/longpress`, `$lib/branding`

### Styles live OUTSIDE the component

`frontend/src/styles/components/server-rail.css` owns `.rail-home`,
`.server-pill`, `.rail-manage`, `.rail-divider`, `.folder-grid`, etc.
Also referenced in `main-layout-part1.css`, `mobile-breakpoints.css`,
`sidebar-channels.css`, `styles.css`. This project does NOT use `<style>` blocks
for the rail — CSS is centralized. There is **no lucide-svelte**; icons are
inline `<svg>` (see the gear at line 381) or images.

### Related existing surfaces (do not duplicate these)

- `FollowingFeed.svelte` — cross-server "watch" feed, device-local, alert levels.
  This is a GLOBAL manager, deliberately distinct from per-server organization.
- `WorkspaceViewBar.svelte` — existing center-stage workspace pills
  (Messages/Whiteboard/Media/Reader/3D/Map/Planner). **Surface switching already
  partly lives here.** Convention in this repo: new center-stage workspace views
  belong in the workspace view bar, NOT bolted into the sidebar.
- `ChannelSidebar.svelte` — the per-server channel list. Its top-level grouping is
  currently **hardcoded by channel kind** (`isVoiceSectionExpanded`,
  `isTextSectionExpanded`, `VoiceChannelList`, `TextChannelList`, etc.), which a
  separate slice of the plan will replace with user-definable "sections".
- `MainLayout.svelte` (1479 lines) — the shell; imports `ServerRail`, passes `mobile`,
  handles `on:manage`.

## The actual tension we want your judgment on

The mockup's rail and the existing rail are **two different taxonomies stacked in
the same physical strip**:

- **Server axis** (existing): which community? — saved servers, folders, DnD, unread
- **Surface axis** (mockup): which view? — Home, Chat, Calendar, Tasks, Files

Merging them into one strip risks:

1. **Semantic collision.** A user cannot tell whether clicking a pill switches
   *community* or *view*. Both are round icon buttons in one vertical column.
2. **DnD ambiguity.** Server pills are draggable with a 3-way drop model
   (before/after/**inside**→creates folder). Surface icons must NOT be
   drag-reorderable into server folders. The drop handlers currently key off
   `item.kind === 'server' | 'folder'` — a third kind needs explicit exclusion
   from `dropPosition === 'inside'`.
3. **Overlap with `WorkspaceViewBar`.** Chat/Media/Reader/Planner surfaces already
   have a home. Duplicating them in the rail creates two competing controls for
   the same navigation, and the repo convention says center-stage views belong in
   the workspace bar.
4. **Mobile.** The rail already has a distinct mobile mode (tray instead of popout,
   longpress gestures, tap suppression). A second icon group + density states
   multiplies mobile states.
5. **Density × side × mobile matrix.** Plan calls for 3 density states
   (full / icons-only / hidden) and left/right placement. Combined with the
   existing mobile branch and folder popout direction (which must flip when the
   rail is on the right), this is a real combinatorial surface.

## Questions we want your opinion on

1. **Is merging correct at all?** Given `WorkspaceViewBar` already owns surface
   switching and the repo convention says center-stage views go there — should the
   rail gain surface icons, or should it stay server-only and the mockup's surface
   icons be satisfied by the existing workspace bar? Argue the strongest case
   against merging, then the strongest case for.

2. **If merging: how do you keep the two axes legible in one strip?** Concrete
   proposal for visual/structural separation (grouping, divider treatment, shape
   language — e.g. do surface icons get a different silhouette than server pills?).

3. **DnD containment.** Exact guard strategy so surface icons are inert to the
   drag system without special-casing the handlers into spaghetti. Where does the
   `kind` discrimination live?

4. **Density/side state.** Where should this live — `layoutStore`, a new store, or
   localStorage-only? Note the project already has `layoutStore` +
   `layoutStoreStates` + a `SavedLayout` domain type in WabiDB
   ("A user's saved layout (position/sizing of UI panels)"), so there may be a
   natural home. Should the folder popout flip direction when side=right, and how?

5. **Ordering.** Should the logo stay top (identity anchor → server hub) with
   surface icons below it and settings at bottom, per the mockup? Or does putting
   surface icons ABOVE the server list read better?

6. **What would you refuse to do here?** Name the part of this that's a bad idea
   even though it's in the mockup.

## Constraints (hard)

- Do NOT touch: `core/crates/wabi-server/src/{api/auth.rs,main.rs,rate_limit.rs,state.rs}`,
  `core/crates/wabi-server/Cargo.toml`, `Cargo.lock` — those are concurrent WIP.
- Styles go in `frontend/src/styles/components/server-rail.css`, NOT a `<style>` block.
- Use existing CSS custom-property tokens; do not invent new color/spacing tokens.
- No new npm dependencies (no lucide) — inline SVG only.
- Preserve every existing behavior: DnD reorder, folder creation via inside-drop,
  folder popout/tray, unread badges, longpress→manage, tap suppression, mobile mode.
- No `git commit` unless explicitly asked.

## Deliverable requested from you

A written architectural opinion (not code yet): answer the 6 questions, flag
anything in the plan you think is wrong, and give a recommended structure for the
evolved component. We'll turn your answer into the implementation dispatch.
