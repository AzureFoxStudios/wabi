# Odysseus Windowing UX Comparison for Wabi

Status: investigation notes from `/var/home/Ronin/odysseus` and current Wabi dirty work.

## The short version

Odysseus' nice "pop out / slam into an edge / resize" behavior is mostly not native desktop window magic. It is a browser-side windowing system built out of fixed-position DOM panels:

- draggable modal headers
- pointer/mouse tracking
- edge/corner hit zones
- a translucent snap preview ghost
- inline `position: fixed` geometry applied with `!important`
- body/root CSS classes that reserve layout space when a panel docks
- resize/reclamp handlers that keep docked panels pinned after viewport/sidebar changes

That means Wabi can get most of the same feel on the web first. Tauri should be a presentation layer for true OS-level detached windows, not the only implementation path.

## Odysseus files that matter

- `/var/home/Ronin/odysseus/static/js/windowDrag.js`
  - Shared `makeWindowDraggable(modal, { content, header, ...options })` helper.
  - Converts a modal into a movable fixed-position pane.
  - Handles top-edge fullscreen snap and side-edge dock gestures.
  - Uses drag thresholds and suppresses synthetic click after real dragging.

- `/var/home/Ronin/odysseus/static/js/modalSnap.js`
  - Side docking controller.
  - Applies left/right dock classes and CSS vars.
  - Manages dock width, left nav offsets, body layout reservation, and dock cleanup.

- `/var/home/Ronin/odysseus/static/js/tileManager.js`
  - Global desktop tiling manager for modal headers.
  - Defines snap zones:
    - true fullscreen when cursor crosses top edge
    - maximize inside safe rect when near top edge
    - right half
    - bottom half
    - older comments mention corners, but current code disables corner quarter-snaps for user preference
  - Creates `#tile-ghost` preview rectangle.
  - On release, applies fixed geometry to `.modal-content`.
  - Stores previous geometry in `dataset._tilePreSnap` so dragging away can restore a floating window.
  - Re-clamps snapped windows on viewport resize/sidebar changes.

- `/var/home/Ronin/odysseus/static/style.css`
  - Defines `#tile-ghost` visual preview.
  - Defines modal/dock layout classes such as `.modal-right-docked`, `.modal-left-docked`, and body dock active states.
  - Uses CSS variables for dock widths and layout offsets.

## Why Odysseus feels web-native but desktop-like

Odysseus does not need actual separate browser windows for the main tiling feel. It treats each modal as a fake desktop window inside the page:

1. On mousedown/pointerdown over a header, store initial cursor and panel rect.
2. During pointermove, set `content.style.position = 'fixed'`, `left`, `top`, `transform = none`.
3. If cursor enters a snap zone, show a ghost rectangle.
4. On mouseup/pointerup, commit the snap by applying exact `left/top/width/height` geometry.
5. If a side dock is committed, apply body/root classes/CSS vars so the underlying app reserves space.
6. On later viewport/sidebar changes, recompute the snapped zone and re-apply geometry.

The key is that the UI is in control of its own panel geometry. Browser popup limitations do not matter because these are not OS popups.

## Current Wabi dirty work found

There is already unfinished Wabi code attempting the popout/windowing direction:

- `frontend/src/lib/tauri-window.ts`
  - Tauri desktop helper for real OS window bounds/snapping.
  - I fixed its type errors against current Tauri v2 API:
    - use `outerPosition()` + `outerSize()` instead of nonexistent `outerBounds()`
    - use `currentMonitor()` from `@tauri-apps/api/window`
    - use `PhysicalPosition` / `PhysicalSize` objects for `setPosition` / `setSize`

- `frontend/src/routes/detached/+page.svelte`
  - Detached panel route now has hover-revealed Tauri snap buttons and keyboard shortcuts.
  - This is OS-window snapping, not Odysseus-style in-page tiling.

- `frontend/src/lib/tilingStore.ts`
  - Early store for split/tiling panes.
  - It is not yet integrated into visible layout.
  - I fixed its `get()` typing errors.

- `ChannelSidebar.svelte`, `TextChannelList.svelte`, `VoiceChannelList.svelte`
  - Adds context-menu item: “Open in new window”.
  - Adds drag-to-detach experiments.
  - I fixed a regression where the voice channel drag/drop handlers were overwritten; voice user/channel drop behavior is now preserved when the drag is not a channel-detach drag.

- `docs/local-dev.md` and `scripts/local-dev-smoke.sh`
  - Phase 3 local-dev portability docs/script in progress.

## Design judgment

Do not make Wabi depend only on Tauri OS windows for this UX.

Best architecture for Wabi:

1. Build a web-first in-page floating/tiling panel system, similar to Odysseus.
2. Reuse that system in normal browser and Tauri main window.
3. Keep Tauri `WebviewWindow` detached windows as an optional escalation path:
   - useful for multi-monitor / true OS-level windows
   - not necessary for normal drag-to-edge / resize / snap UX
4. Keep all windowing behaviors behind a small boundary:
   - `floatingPanelStore` or `windowingStore`
   - one Svelte action for drag/snap/resize
   - CSS vars/classes for docked layout reservations

## Recommended next implementation direction

### Step 1: Finish Phase 3 local-dev portability

Commit docs/script once checked:

- `docs/local-dev.md`
- `scripts/local-dev-smoke.sh`

### Step 2: Stabilize existing unfinished popout code

Before adding more features:

- keep `Open in new window` context-menu path if it checks/builds
- keep Tauri snap helper if it checks/builds
- decide whether drag-to-detach should ship now or be deferred
- do not ship `tilingStore.ts` unless it is either used or documented as a planned API

### Step 3: Add Odysseus-style web tiling as a separate, minimal layer

Create later, not mixed into sidebar code:

- `frontend/src/lib/windowing/floatingPanelStore.ts`
- `frontend/src/lib/actions/draggablePanel.ts`
- `frontend/src/lib/components/windowing/FloatingPanelHost.svelte`
- CSS for:
  - `.floating-panel`
  - `.floating-panel-header`
  - `.floating-panel-docked-left/right`
  - `.floating-panel-maximized`
  - `.floating-panel-ghost`

### Step 4: Runtime-smoke before frontend polish

Required smoke checks:

- `bun run check`
- `STATIC_BUILD=1 bun run build`
- `bun run dev:mock`
- open app as guest
- open/detach channel from context menu
- verify no broken voice drag/drop behavior
- if Tauri is touched: `bun run desktop:check` and ideally `bun run desktop:dev` smoke

## What not to do

- Do not copy Odysseus' whole JS system verbatim into Wabi.
- Do not mix OS window snapping and in-page panel snapping in one abstraction.
- Do not make every channel item draggable if it breaks normal click/voice drag behavior.
- Do not ship hidden stores/components that are not reachable unless they are documented as foundations.
- Do not start frontend visual polish until this windowing/local-dev work is either landed or deliberately parked.
