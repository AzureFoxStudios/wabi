# Task: Unified workspace-view bar (anti-softlock pass)

Repo: /var/home/Ronin/wabi (frontend only). Do NOT touch backend/crates/core Rust files. Do NOT commit.

## Problem

Wabi has center-stage "workspace views": Messages (chat), Whiteboard, Reader, 3D Model Viewer, Map, Media Albums, Planner, Notes. The pill bar that lets users switch between them and get BACK to Messages lives ONLY inside `frontend/src/lib/components/chat/ChatHeader.svelte` (the `.workspace-view-actions` div with `.view-open-btn` buttons, plus the "Messages" `.surface-return-btn`).

In `frontend/src/lib/components/MainLayout.svelte` (~lines 943-958), when an addon tab is active (`isModelViewportTabActive` / `isReaderTabActive` / `isMediaAlbumsTabActive` / `isMapTabActive` / `isPlannerTabActive` / `isNotesTabActive`), MainLayout renders the full view component (`<ModelViewportTab />`, `<ReaderTab />`, `<MediaAlbumsTab variant="full" />`, `<MapWorkspace variant="full" />`, `<PlannerWorkspace variant="full" />`, `<KeepNotesView />`) INSTEAD of `<Chat />`. That REPLACES the whole Chat component including ChatHeader, so the pill bar disappears. Users get stuck in Reader/3D/Map/Media/Planner/Notes with no way back except reload. This is the bug to fix.

## Design

Create a NEW shared component `frontend/src/lib/components/WorkspaceViewBar.svelte` — the pill row extracted from ChatHeader — and mount it in MainLayout above the full-view branches so EVERY workspace view has the bar and users can always navigate back to Messages.

### WorkspaceViewBar.svelte spec

Props (Svelte 5 runes style: `let` props, no `export let`; match repo conventions — check an existing simple component like `frontend/src/lib/components/SurfaceHeader.svelte` for style):

- `activeView: string` — one of `'messages' | 'whiteboard' | 'reader' | 'model' | 'map' | 'media' | 'planner' | 'notes'`
- `onSelectView: (view: string) => void` — called with the clicked view key
- optional `showReturnToMessages?: boolean` (default true) — whether to render the "Messages" return button

Render:
1. A "Messages" button (class `surface-return-btn btn-secondary`, same markup as ChatHeader's) when `showReturnToMessages` and `activeView !== 'messages'` — clicking calls `onSelectView('messages')`.
2. The pill row (class `workspace-view-actions`, role="tablist", aria-label="Channel views") with `.view-open-btn` buttons for: messages, whiteboard, planner, notes, media, reader, model (3D), map — in that order (same order as ChatHeader). Each button gets `class:active={activeView === '<key>'}` and calls `onSelectView('<key>')`. Copy the exact SVG icons from ChatHeader.svelte lines ~95-205 for each button (chat bubble, whiteboard rect, planner calendar, notes document, media image, reader book, 3D cube, map flag).

The component must be self-contained (no imports of stores needed — it's purely presentational; parent decides what clicking means).

### ChatHeader.svelte refactor

Replace the inline `.workspace-view-actions` div (and the `{#if selectedWorkspaceView !== 'messages'}` return button) with `<WorkspaceViewBar activeView={selectedWorkspaceView} onSelectView={handleWorkspaceViewSelect} />`, where `handleWorkspaceViewSelect(view)` dispatches to the existing behavior:
- `'messages'` → `onReturnToMessages()`
- `'whiteboard'` → `setWhiteboardSurface(currentChannel, 'whiteboard')`
- `'planner'` → `openPlannerSurface()`
- `'notes'` → `openNotesSurface()`
- `'media'` → `openMediaAlbumsSurface()`
- `'reader'` → `openReaderSurface()`
- `'model'` → `openModelViewportSurface()`
- `'map'` → `void openFullMapTab()`

Keep ChatHeader's layout intact otherwise (the `header-action-group` wrappers, DM call buttons, etc. must remain).

### MainLayout.svelte wiring

Above the `{#if isModelViewportTabActive}` chain inside `.chat-surface` (line ~947), render:

```
<WorkspaceViewBar
  activeView={workspaceActiveView}
  onSelectView={handleWorkspaceViewSelect}
/>
```

only when a workspace tab is active (i.e. when `isModelViewportTabActive || isReaderTabActive || isMediaAlbumsTabActive || isMapTabActive || isPlannerTabActive || isNotesTabActive`). Compute `workspaceActiveView` reactively from the same flags (`'model' | 'reader' | 'media' | 'map' | 'planner' | 'notes'`). `handleWorkspaceViewSelect(view)`:
- `'messages'` → close whichever addon tab is active (call `mobileTabQueue.closeAddonTab(READER_ADDON_ID)`, `closeAddonTab(MODEL_VIEWPORT_ADDON_ID)`, `closeAddonTab(MAP_ADDON_ID)`, `closeAddonTab(MEDIA_ALBUMS_ADDON_ID)`, `closeAddonTab(PLANNER_ADDON_ID)`, `closeAddonTab(NOTES_ADDON_ID)` — or a small helper that closes all six; MainLayout already imports these ADDON_IDs and `mobileTabQueue`)
- `'reader'` → `mobileTabQueue.openAddonTab(READER_ADDON_ID)` etc. for each of reader/model/map/media/planner/notes
- `'whiteboard'` → just return to messages (close addon tabs) — whiteboard is a chat-surface view; don't overcomplicate

Import WorkspaceViewBar in MainLayout.

### CSS

The `.view-open-btn`, `.workspace-view-actions`, `.surface-return-btn` classes already exist and are styled (used by ChatHeader) — reuse them, do NOT invent new class names. If WorkspaceViewBar needs its own wrapper, use class `workspace-view-bar` and add minimal CSS (flex row, gap, padding) to `frontend/src/styles/components/surfaces.css` (check that file for where the existing surface styles live).

## Constraints

- Svelte 5 (runes): use `let` for props (the repo's older components still use `export let` — check what WorkspaceViewBar's sibling components do, but prefer runes `let` for NEW components if the file uses `<script>` with runes; Svelte 5 auto-detects. Match `ChatHeader.svelte` which uses `export let` — for consistency with the file you import into, `export let` is acceptable there. Use whatever compiles cleanly.)
- Do NOT modify: `Chat.svelte` behavior, backend Rust, `QuickResourcesPanel.svelte`, `UnifiedChannelList.svelte`, layoutStore, or any CSS file other than possibly `surfaces.css` for the new wrapper.
- Do NOT commit.
- Verify with `cd frontend && npx svelte-check --tsconfig tsconfig.json 2>&1 | grep -E 'WorkspaceViewBar|ChatHeader|MainLayout'` and `STATIC_BUILD=1 bun run build`.

## Deliverable

Report at the end: files created/changed, svelte-check status for the touched files, build status, and anything you had to adjust from this plan.
