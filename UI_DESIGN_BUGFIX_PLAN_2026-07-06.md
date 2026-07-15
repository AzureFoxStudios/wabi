# Wabi Frontend Design Bug Fix Plan — 2026-07-06

## Problem Statement

User reports two visible issues:
1. "Weird grabber bars" — unwanted visual grabber/resize handles showing on screen (specifically on left and right panels for dragging)
2. "The top row went poof" — a top horizontal row of UI elements has disappeared
3. Additionally mentions handles are "frozen on drag"

## Root Cause Analysis (from source)

### Bug 1: Weird Grabber Bars on Left/Right Panels

**Root cause: `obvious-grab-rails` debug mode is a user-facing toggle that should not exist in the settings panel.**

The `obviousGrabRails` store (layoutStoreStates.ts:54) defaults to `false` but is:
- Persisted to localStorage key `wabi:obvious-grab-rails` (layoutStore.ts:92)
- Exposed as a toggle in AppearanceSettingsTab.svelte:341-349 labeled "Obvious Grab Rails" with description "Debug mode: draw exact draggable resize hitboxes"
- Applied as `class:obvious-grab-rails` on the app-container (MainLayout.svelte:761)

When ON, the CSS at main-layout-part1.css:138-163 renders every `.resize-handle` as:
- Bright orange/amber background (`rgba(status-away-rgb, 0.35)`)
- 1px orange outline
- Rotated "6px grab" text label (::after pseudo-element)
- Full opacity (no longer transparent until hover)

This affects ONLY the left and right panel resize handles because:
- Left panel handle: `<button class="resize-handle resize-handle-channel" ...>` (MainLayout.svelte:814)
- Right panel handle: `<button class="resize-handle resize-handle-right" ...>` (MainLayout.svelte:841)
- Other resize-like elements use different class names:
  - Quick resources: `quick-resize-handle` (different class)
  - Panel splits: `stack-resize-handle` (different class)
  - Reopen rails: `nav-reopen-rail`/`right-reopen-rail` (different classes)

Thus, when obvious-grab-rails is enabled, ONLY the left/right panel drag handles show the weird orange bars with "6px grab" text — matching the user's observation: "its only on left and right panels for dragging left and right."

Regarding "frozen on drag": the obvious-grab-rails CSS doesn't modify pointer events or disable dragging. The base `.resize-handle` class still has `cursor: col-resize` and the mousedown handlers (`layoutStore.isResizingChannel.set(true)`/.set(true)`) are still attached. However:
- The dramatic visual change (from invisible to prominent orange bars with text) might alter the perceived drag initiation point
- If there's a JS error in the drag handlers that only manifests under certain conditions, it could cause freezing
- After fixing the visual issue, we'll verify drag functionality works

### Bug 2: Top Row Went Poof

**Most likely root cause: `.right-reopen-rail.dock-right` is missing `right: 0` positioning.**

When the right panel is closed (width=0) and nav is docked right, the "reopen" rail button should appear at the right edge. The CSS at main-layout-part1.css:383-388:
```css
.right-reopen-rail.dock-right {
    left: auto;           /* clears left */
    /* MISSING: right: 0; — no horizontal anchor! */
    border-right: 1px solid var(--border-subtle);
    border-left: none;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
}
```
Without `right: 0`, the rail has `position: absolute` with no left or right anchor — it floats at an unpredictable position (often off-screen or overlapping).

The inline styles (MainLayout.svelte:896-901) attempt to set `style:right` but contain a dead `style:left` expression:
```svelte
style:right={$layoutStore.navDock === 'right'
    ? `${desktopServerRailOffset + $layoutStore.channelSidebarWidth}px`
    : '0px'}
style:left={$layoutStore.navDock !== 'right'
    ? null
    : null}  <!-- BOTH branches are null! This is a no-op -->
```
This looks like a copy-paste error. The `style:left` is useless in both branches.

**Secondary possibility: chat-header workspace view buttons collapsing**
ChatHeader.svelte has a "compactable" hover behavior (chat-header.css:122-171) that collapses non-active workspace view buttons to 8px width with opacity:0 on desktop. This could make 4 of 5 buttons nearly invisible, resembling a missing top row.

### Additional Note on Drag Functionality

After reviewing the drag handlers:
- Left handle: `on:mousedown|preventDefault={() => layoutStore.isResizingChannel.set(true)}`
- Right handle: `on:mousedown|preventDefault={() => layoutStore.isResizingRight.set(true)}`
These set resize state flags that should trigger mousemove/mouseup handlers in layoutStore.ts to update panel widths.

The obvious-grab-rails CSS alone shouldn't break this functionality. After fixing the visual issues, we'll specifically test that:
1. Handles show normal appearance (transparent until hover, then accent color)
2. Click-and-drag resizes the panels smoothly
3. Releasing the mouse ends the drag and returns handles to normal state

## Fix Plan

### P0 — Immediate visible bugs (no build risk)

#### Fix 1: Remove `obvious-grab-rails` from user-facing settings
- **File**: `frontend/src/lib/components/settings/AppearanceSettingsTab.svelte`
- **Action**: Remove the "Obvious Grab Rails" toggle block (lines ~341-349) and the `toggleObviousGrabRails` function (lines ~193-195)
- **Keep**: The `obviousGrabRails` store, CSS, and `class:obvious-grab-rails` binding in MainLayout — these remain useful for dev debugging via console (`layoutStore.setObviousGrabRails(true)`)
- **Reason**: Debug tools should not be in user settings. If the user toggled this ON, it explains the "weird grabber bars" on left/right panel handles immediately

#### Fix 2: De-duplicate `.resize-handle` CSS
- **Files**: `frontend/src/styles/components/main-layout-part1.css`, `frontend/src/styles/components/cards.css`
- **Action**: Remove the `.resize-handle` block from `cards.css` (lines 89-114) entirely — it's a duplicate that adds nothing except a dangerous `#ff00ff` magenta fallback. The `main-layout-part1.css` definition is the canonical one.
- **Reason**: Two definitions of the same class at the same specificity is a load-order bug. The cards.css version has a magenta fallback that could flash on token resolution failure.

#### Fix 3: Fix `.right-reopen-rail.dock-right` positioning
- **File**: `frontend/src/styles/components/main-layout-part1.css`
- **Action**: Add `right: 0;` to the `.right-reopen-rail.dock-right` rule (line ~383)
- **Reason**: Without a horizontal anchor, the reopen rail floats at an unpredictable position when nav is docked right

#### Fix 4: Fix dead `style:left` expression in MainLayout
- **File**: `frontend/src/lib/components/MainLayout.svelte`
- **Action**: Remove the useless `style:left` attribute on the right-reopen-rail (lines ~899-901) — both branches are `null`, making it a no-op
- **Reason**: Dead code that looks like a bug and confuses maintenance

### P1 — Polish and verification

#### Fix 5: Verify drag functionality after visual fixes
- **Action**: After applying P0 fixes, test that left/right panel resize handles:
  1. Appear normal (transparent until hovered, then semi-transparent accent color)
  2. Allow clicking and dragging to resize panels smoothly
  3. Return to normal state after dragging completes
- **Reason**: User mentioned handles are "frozen on drag" — we need to verify this works correctly after visual fixes

#### Fix 6: Verify workspace view button visibility
- **File**: `frontend/src/styles/components/chat-header.css`
- **Action**: Audit the `compactable` hover behavior (lines 122-171). Confirm this isn't causing the "top row went poof" issue by checking if all workspace view buttons remain visible enough to be usable.
- **Reason**: The collapse-to-8px behavior could make buttons hard to see, resembling a missing top row

#### Fix 7: Visual verification via browser
- **Action**: After fixes, load the dev server (http://127.0.0.1:5173/) in browser-harness and:
  1. Screenshot the main chat layout — verify no orange grabber bars on left/right handles
  2. Toggle obvious-grab-rails via console to confirm the debug mode still works but is hidden from settings
  3. Close the right panel and verify the reopen rail appears at the correct edge
  4. Test left/right panel drag handles for smooth resizing
  5. Check the chat header — verify workspace view buttons are visible
  6. Test with nav docked left AND right
  7. Check `localStorage.getItem('wabi:obvious-grab-rails')` — if 'true', reset to 'false'

### P2 — Deferred

- Consider whether the `obviousGrabRails` store should be removed entirely (it's a dev-only feature)
- Audit the `mobile-nav-grabber` — it's hidden on desktop and non-mobile, but the CSS is split across two files with a `display: none` default in part1 and another `display: none` in the mobile media query in part2. Consolidate.
- The `.user-panel-toggle` button (MainLayout.svelte:920) has empty attributes (lines 921-922 are blank) — clean up whitespace

## Allowed Files

- `frontend/src/lib/components/settings/AppearanceSettingsTab.svelte`
- `frontend/src/lib/components/MainLayout.svelte`
- `frontend/src/styles/components/main-layout-part1.css`
- `frontend/src/styles/components/cards.css`
- `frontend/src/lib/components/RightPanel.css` (if needed for stack-resize-handle tweak)
- `frontend/src/styles/components/chat-header.css`

## Forbidden Files

- Backend (Rust, wabi-server, wabidb)
- Stores, state, socket, calling, media transport
- Tauri shell, deployment infra
- Any file not listed in "Allowed Files" above without explicit approval

## Verification Gate

```bash
cd /var/home/Ronin/wabi/frontend && bun run check   # 0 errors
cd /var/home/Ronin/wabi/frontend && bun run build    # ✓ built
```

Plus browser-harness visual and functional verification per Fixes 5-7.

## Execution Order

1. Fix 1 (remove grab rails toggle from settings) — immediate, no build risk
2. Fix 2 (deduplicate resize-handle CSS) — immediate, no build risk
3. Fix 3 (fix right-reopen-rail positioning) — immediate, no build risk
4. Fix 4 (clean up dead style:left) — immediate, no build risk
5. Run `bun run check` + `bun run build`
6. Fix 5 (verify drag functionality) — functional test
7. Fix 6 (audit workspace view buttons) — visual check
8. Fix 7 (browser visual verification) — mandatory before reporting done
9. Write report