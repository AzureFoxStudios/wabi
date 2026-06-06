# Wabi Web-First Windowing System Implementation Plan

> **For Hermes:** Use this plan to implement Wabi's Odysseus-style frontend windowing system task-by-task. Push `main` directly after verified checkpoints unless Ronin explicitly asks for PRs. Do not start general visual polish until the windowing foundation is landed or deliberately parked.

**Goal:** Build a web-first floating/docking/snap panel system for Wabi so channels and tools can pop out, be dragged, resized, and slammed into edges in browser and Tauri, with Tauri OS windows as an optional presentation layer rather than the only path.

**Architecture:** Tauri is Wabi's primary presentation target, but the Odysseus-style interaction should still be implemented as a well-presented in-app sub-window layer first: fixed-position panels inside the app webview with drag, resize, snap ghost, dock classes, and safe-rect math. Keep OS-level Tauri `WebviewWindow` detached windows separate behind an adapter for true multi-monitor/native windows. Introduce a small `windowing/` module with a store, snap math, Svelte drag/resize actions, a host component, and CSS. Migrate the current dirty popout experiment into that module instead of scattering behavior across sidebar components.

**Tech Stack:** SvelteKit, TypeScript, Svelte stores/actions, CSS variables/classes, Tauri v2 API for optional OS windows, Bun.

---

## Current State

Branch: `main`

Already pushed:

- `0f23e45 feat: add frontend-only local mock dev mode`
- `3e8798b docs: document local dev and windowing research`

Current dirty/unpushed windowing experiment:

- Modified:
  - `frontend/src/lib/components/ChannelSidebar.svelte`
  - `frontend/src/lib/components/context-menu/ContextMenu.svelte`
  - `frontend/src/lib/components/sidebar/TextChannelList.svelte`
  - `frontend/src/lib/components/sidebar/VoiceChannelList.svelte`
  - `frontend/src/lib/context-menu/types.ts`
  - `frontend/src/routes/detached/+page.svelte`
  - `frontend/src/styles/components/sidebar-channels.css`
- Untracked:
  - `frontend/src/lib/tauri-window.ts`
  - `frontend/src/lib/tilingStore.ts`

The dirty code currently type-checks/builds after fixes, but it should not be shipped as-is because it mixes several concerns:

- channel context-menu launching
- channel drag-to-detach
- Tauri OS window snapping
- an unused tiling store
- detached route UI chrome

This plan turns that into a deliberate web-first windowing system.

---

## Design Principles

1. **Web-first:** The core windowing UX is DOM-based and works in normal browser dev mode.
2. **Tauri optional:** Tauri OS windows are an adapter for true multi-monitor/native windows, not the foundation.
3. **No scattered drag logic:** Sidebar components should only call `openFloatingPanel()` / `openDetachedPanel()`; drag, snap, and resize live in `windowing/` actions/components.
4. **Do not break voice drag/drop:** Existing voice channel drag/drop behavior must keep working.
5. **Mock mode is enough for most runtime proof:** `bun run dev:mock` should exercise the windowing layer without backend/STDB.
6. **Small reachable slices:** Do not land hidden, unused stores unless they are part of a reachable host.

---

## Target File Structure

Create:

- `frontend/src/lib/windowing/types.ts`
- `frontend/src/lib/windowing/snapMath.ts`
- `frontend/src/lib/windowing/floatingPanelStore.ts`
- `frontend/src/lib/windowing/panelRegistry.ts`
- `frontend/src/lib/actions/draggablePanel.ts`
- `frontend/src/lib/actions/resizablePanel.ts`
- `frontend/src/lib/components/windowing/FloatingPanelHost.svelte`
- `frontend/src/lib/components/windowing/FloatingPanel.svelte`
- `frontend/src/lib/components/windowing/FloatingPanelGhost.svelte`
- `frontend/src/styles/components/windowing.css`

Keep / migrate:

- `frontend/src/lib/detachedPanels.ts`
- `frontend/src/lib/tauri-window.ts` only for Tauri OS window snap helper
- `frontend/src/routes/detached/+page.svelte` only for OS detached route, not the in-page windowing host

Modify:

- `frontend/src/lib/components/MainLayout.svelte` to mount `FloatingPanelHost`
- `frontend/src/lib/components/ChannelSidebar.svelte` to add context menu entries through a small API
- `frontend/src/lib/components/sidebar/TextChannelList.svelte` only if drag-to-float is enabled
- `frontend/src/lib/components/sidebar/VoiceChannelList.svelte` only if drag-to-float is enabled, preserving voice drag/drop
- a global stylesheet import chain to include `windowing.css`

Remove or replace:

- `frontend/src/lib/tilingStore.ts` if unused after `floatingPanelStore.ts` exists

---

## Acceptance Criteria

### Build/static checks

Run from `/var/home/Ronin/wabi`:

```bash
cd frontend && bun run check
cd frontend && STATIC_BUILD=1 bun run build
bun run desktop:check
```

Expected:

- `bun run check`: 0 errors
- build: pass
- desktop check: pass

Warnings may remain from existing Svelte unused exports/a11y noise, but no new errors.

### Runtime browser mock smoke

Run:

```bash
bun run dev:mock
scripts/local-dev-smoke.sh mock
```

Then verify in browser/headless/manual:

- login as guest works
- main app shell loads
- right-click `general` or use visible affordance to open a floating panel
- floating panel appears in-page, not only as browser popup
- panel can be dragged
- panel can be resized
- dragging to left/right/top/bottom shows a snap ghost
- releasing in a snap zone docks/snaps panel
- panel can be restored/floated again
- closing panel removes it from store/DOM
- voice channel drag/drop still works or is explicitly verified not broken by the new drag handlers

### Tauri smoke

At minimum:

```bash
bun run desktop:check
```

If possible before final push:

```bash
bun run desktop:dev
```

Manual verify:

- detached OS window still opens if using `Open in OS window`
- Tauri snap controls do not throw console errors

---

## Phase 0: Preserve Current Dirty Work

### Task 0.1: Save a patch before refactor

**Objective:** Make the current unfinished popout experiment recoverable before restructuring.

**Files:**

- Create outside repo: `/var/home/Ronin/wabi-backups/manual-patches/windowing-experiment-before-web-first-refactor-YYYYMMDD-HHMMSS.patch`

**Steps:**

```bash
mkdir -p /var/home/Ronin/wabi-backups/manual-patches
git diff > /var/home/Ronin/wabi-backups/manual-patches/windowing-experiment-before-web-first-refactor-$(date +%Y%m%d-%H%M%S).patch
git status --short
```

**Expected:** patch file exists; repo state unchanged.

---

## Phase 1: Core Types and Snap Math

### Task 1.1: Create windowing types

**Objective:** Define the panel model without touching UI.

**Files:**

- Create: `frontend/src/lib/windowing/types.ts`

**Content outline:**

```ts
export type FloatingPanelKind = 'channel-chat' | 'server-map' | 'workspace-panel';

export type FloatingPanelMode = 'floating' | 'docked' | 'maximized' | 'minimized';

export type SnapZone =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'maximize';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingPanelPayload {
  channelId?: string;
  channelName?: string;
  placeId?: string;
  panelId?: string;
}

export interface FloatingPanelState {
  id: string;
  kind: FloatingPanelKind;
  title: string;
  payload: FloatingPanelPayload;
  mode: FloatingPanelMode;
  rect: Rect;
  previousRect?: Rect;
  snapZone?: SnapZone;
  zIndex: number;
}
```

**Verify:**

```bash
cd frontend && bun run check
```

Expected: 0 errors.

### Task 1.2: Create snap math helper

**Objective:** Centralize hit-zone and snap-rect calculations.

**Files:**

- Create: `frontend/src/lib/windowing/snapMath.ts`

**Behavior:**

- `getSnapZone(pointer, viewport, threshold)` returns a `SnapZone | null`.
- `getSnapRect(zone, viewport)` returns a `Rect`.
- Prefer Odysseus behavior:
  - top edge = maximize
  - left/right = half-screen
  - optional quarters only at corners if we decide to keep them

**Verification:**

If there is an existing frontend unit test harness, add tests. If not, make this pure enough to test later and verify via `bun run check`.

---

## Phase 2: Store and Panel Registry

### Task 2.1: Create floating panel store

**Objective:** Provide open/close/focus/move/resize/snap operations.

**Files:**

- Create: `frontend/src/lib/windowing/floatingPanelStore.ts`

**API:**

```ts
openFloatingPanel(input: {
  kind: FloatingPanelKind;
  title?: string;
  payload?: FloatingPanelPayload;
  rect?: Partial<Rect>;
}): string

closeFloatingPanel(id: string): void
focusFloatingPanel(id: string): void
moveFloatingPanel(id: string, rect: Rect): void
resizeFloatingPanel(id: string, rect: Rect): void
snapFloatingPanel(id: string, zone: SnapZone, viewport: Rect): void
restoreFloatingPanel(id: string): void
```

**Rules:**

- New panels cascade positions slightly.
- Clamp minimum size.
- Track z-index.
- No backend calls.

**Verify:**

```bash
cd frontend && bun run check
```

### Task 2.2: Create panel registry

**Objective:** Map panel kind/payload to renderable component props.

**Files:**

- Create: `frontend/src/lib/windowing/panelRegistry.ts`

**Initial supported panel:**

- `channel-chat`

For first implementation, channel chat can render existing `Chat` with selected channel state if current app architecture supports global selected channel. If not, first render a minimal read-only placeholder with the channel name and document what is needed to route channel-specific Chat.

**Important:** Do not fake behavior silently. If full chat rendering needs more wiring, the panel should say “Channel panel shell” and the plan should add the wiring task.

---

## Phase 3: Floating Panel Components

### Task 3.1: Create FloatingPanelGhost

**Objective:** Show Odysseus-style snap preview rectangle.

**Files:**

- Create: `frontend/src/lib/components/windowing/FloatingPanelGhost.svelte`
- Create/modify: `frontend/src/styles/components/windowing.css`

**Props:**

```ts
export let rect: Rect | null = null;
export let visible = false;
```

**CSS:**

- fixed position
- pointer-events none
- accent translucent background
- border/ring
- subtle transition

### Task 3.2: Create draggablePanel action

**Objective:** Make a panel header drive move/snap preview logic.

**Files:**

- Create: `frontend/src/lib/actions/draggablePanel.ts`

**Behavior:**

- pointerdown stores starting pointer + panel rect
- pointermove updates rect
- if pointer near snap zone, publish ghost rect
- pointerup commits snap or floating rect
- suppress accidental click after drag

**Note:** This should not live inside sidebar components.

### Task 3.3: Create resizablePanel action

**Objective:** Add panel edge/corner resizing.

**Files:**

- Create: `frontend/src/lib/actions/resizablePanel.ts`

**Behavior:**

- handles at least right, bottom, bottom-right first
- clamp min width/height
- preserve viewport bounds

### Task 3.4: Create FloatingPanel component

**Objective:** Render one panel with header, close, drag, resize handles, and slot content.

**Files:**

- Create: `frontend/src/lib/components/windowing/FloatingPanel.svelte`

**Props:**

```ts
export let panel: FloatingPanelState;
```

**Behavior:**

- header uses draggable action
- body renders slot
- close button calls store
- mode classes reflect snapped/docked/maximized

### Task 3.5: Create FloatingPanelHost

**Objective:** Mount all floating panels once near app root.

**Files:**

- Create: `frontend/src/lib/components/windowing/FloatingPanelHost.svelte`

**Behavior:**

- subscribes to store
- renders `FloatingPanel` for each panel
- renders `FloatingPanelGhost`
- dispatches panel content based on registry

---

## Phase 4: Integrate Into Wabi App Shell

### Task 4.1: Mount host in MainLayout

**Objective:** Make in-page panels reachable in normal app runtime.

**Files:**

- Modify: `frontend/src/lib/components/MainLayout.svelte`

**Steps:**

- import `FloatingPanelHost`
- mount it near the end of the layout so it overlays the app
- include `windowing.css` in global CSS import chain

**Verify:**

```bash
cd frontend && bun run check
```

### Task 4.2: Convert ChannelSidebar context menu to open floating panel

**Objective:** Replace direct OS detached behavior as the default with in-page floating panel.

**Files:**

- Modify: `frontend/src/lib/components/ChannelSidebar.svelte`

**Menu entries:**

- `Open floating panel` → `openFloatingPanel({ kind: 'channel-chat', title: '#general', payload: { channelId, channelName } })`
- Optional secondary entry: `Open OS window` → existing `openDetachedPanel(...)`

**Important:** Keep labels clear so browser/Tauri behavior is not confusing.

### Task 4.3: Remove sidebar-owned drag-to-detach or route it through one tiny helper

**Objective:** Avoid scattering drag/windowing logic across text/voice list components.

**Files:**

- Modify: `TextChannelList.svelte`
- Modify: `VoiceChannelList.svelte`

**Preferred first ship:** Park drag-to-detach entirely. Let right-click/context menu open floating panels first.

**If drag-to-detach ships:** Use a shared helper/action, not duplicated logic in both list components, and preserve voice drag/drop.

---

## Phase 5: Tauri Boundary Cleanup

### Task 5.1: Keep Tauri OS snapping separate

**Objective:** Make `tauri-window.ts` only handle real OS window bounds/snapping.

**Files:**

- Keep/create: `frontend/src/lib/tauri-window.ts`
- Modify: `frontend/src/routes/detached/+page.svelte`

**Rules:**

- `tauri-window.ts` should import Tauri APIs dynamically.
- It should safely no-op in browser.
- It should use Tauri v2 API:
  - `outerPosition()`
  - `outerSize()`
  - `currentMonitor()`
  - `PhysicalPosition`
  - `PhysicalSize`

### Task 5.2: Decide fate of tilingStore

**Objective:** Avoid shipping unused duplicate architecture.

**Files:**

- Remove: `frontend/src/lib/tilingStore.ts`

Unless it becomes the actual `floatingPanelStore`, remove it. The new store should live under `windowing/` and use clear terms.

---

## Phase 6: Runtime Verification

### Task 6.1: Static verification

Run:

```bash
cd /var/home/Ronin/wabi/frontend
bun run check
STATIC_BUILD=1 bun run build
cd /var/home/Ronin/wabi
bun run desktop:check
```

Expected:

- check: 0 errors
- build: pass
- desktop: pass

### Task 6.2: Mock runtime smoke

Run:

```bash
cd /var/home/Ronin/wabi
bun run dev:mock
scripts/local-dev-smoke.sh mock
```

Manual/headless checks:

- guest login works
- app shell loads
- context menu opens floating panel
- panel drags
- panel resizes
- panel snaps to edge with ghost preview
- panel closes
- no console errors from windowing code

### Task 6.3: Real local smoke

Run:

```bash
bun run dev:local
scripts/local-dev-smoke.sh local
```

Expected:

- frontend HTTP 200
- backend `/health` HTTP 200

Known acceptable warning until backend task:

- `Reducer call failed: Failed to call reducer`

---

## Commit Strategy

Use small direct commits to main after verification:

1. `refactor: add web-first floating panel foundation`
2. `feat: open channels in floating panels`
3. `feat: add floating panel drag resize and snap`
4. `chore: separate tauri detached window snapping`
5. `docs: document wabi windowing model`

If implementing in one session, do not push a commit that fails `bun run check`.

---

## Current Recommendation

Proceed with Option B, but do it as a web-first frontend architecture, not as “make Tauri windows imitate Odysseus.”

Immediate next execution move:

1. Save current dirty patch.
2. Create `windowing/` types + store + snap math.
3. Mount `FloatingPanelHost`.
4. Convert channel context menu to open in-page floating panel by default.
5. Remove or defer duplicated sidebar drag-to-detach.
6. Keep Tauri detached route as optional OS-window path.
7. Verify with `dev:mock` before touching visual polish.
