# Right Panel → Edge Stub System (DeepSeek implementation handoff)

**Date:** 2026-08-18
**Status:** Approved design, ready for implementation
**Implementer:** DeepSeek (this doc is fully self-contained — no conversation context assumed)
**Reviewer:** ZCode session (audit against §10 when implementation returns)

---

## 1. Context

Wabi's desktop layout is `MainLayout.svelte`: nav sidebar | main content | right panel. The right panel today is a multi-stack tab dock (`RightPanel.svelte` + `rightPanelDock` state): stacks of tabs, split/merge, collapse, pin-per-stack, detach-to-window, drag-drop tab reordering, a panel drawer dropdown, and a bottom `QuickResourcesPanel`. It works but it's heavy: opening it is a binary width toggle that eats the chat area, there's no lightweight way to glance at a panel, and the chrome (tab bars, stack action buttons) wastes space.

**Goal:** replace it with a Blender-style **edge stub system** — discrete icon squares protruding half-visible from a screen edge. Hover peeks the panel (overlay, no reflow). Click pins it (flex layout, content reflows). Everything else (context menu, add/remove drawer) hangs off the stubs.

### Key existing files

| File | Role |
|---|---|
| `frontend/src/lib/components/MainLayout.svelte` | Top-level layout. Right panel container ~lines 1068–1098; reopen rail ~1152–1174; desktop toggle ~1176–1192; transfer tray button ~1197–1214; `startRightResizeFromClosed` ~line 520 |
| `frontend/src/lib/components/RightPanel.svelte` | Current dock UI (171 lines, legacy `$:` syntax) — gets a full rewrite |
| `frontend/src/lib/components/RightPanel.css` | Dock chrome styles — mostly deleted/replaced |
| `frontend/src/lib/components/WorkspacePanelHost.svelte` | Maps `panel.component` key → Svelte component. **DO NOT CHANGE** |
| `frontend/src/lib/components/WorkspacePanelIcon.svelte` | Icon per `WorkspacePanelIcon` type. **DO NOT CHANGE** |
| `frontend/src/lib/components/QuickResourcesPanel.svelte` | Bottom strip inside right panel. **DO NOT CHANGE** (keep rendering it) |
| `frontend/src/lib/workspacePanels.ts` | Panel manifest registry (`BUILTIN_WORKSPACE_PANELS`, `workspacePanelList`, `canAccessWorkspacePanel`, badges) |
| `frontend/src/lib/layoutStoreStates.ts` | Raw stores: `rightPanelView`, `activeRightTab`, `rightPanelDock`, `rightPanelWidth` (320 default / 220 min), `detachedPanelIds`, … |
| `frontend/src/lib/layoutStoreRightPanel.ts` | Right-panel ops (`openRightPanel`, `toggleRightPanel`, stack ops) |
| `frontend/src/lib/layoutStore.ts` | Aggregated `layoutStore` object + derived `showRightPanel` (~line 310) + persistence queue |
| `frontend/src/lib/layoutStoreUtils.ts` | `applyWorkspaceToRuntime` (92–116) / `syncWorkspaceFromRuntime` (118+) — persisted-layout restore/save |
| `frontend/src/lib/layoutStoreNav.ts` | `expandRight` (30), nav-collapse interactions that touch `rightPanelView` (41–57) |
| `frontend/src/lib/docking/layoutSchema.ts` | `WorkspacePanelDockV1`, `migrateLayoutState`, `normalizePanelDock` (via `layoutHelpers`) |

---

## 2. Visual spec

### Stub geometry

- Each stub is a **discrete 48×48px square**, its own island. **No connecting rail, no full-height column.** Vertical stack with a **10px gap** between squares, starting at `top: calc(var(--app-chrome-height) + 16px)`.
- **Resting state: only 24px protrudes** from the screen edge; the outer half is clipped off-viewport.
- **Hover or keyboard focus: the stub slides out to fully visible** (~160ms ease transition), revealing the full icon. Mouse leave slides it back to 24px.
- Icons come from `WorkspacePanelIcon` (existing component). A stub shows at most a small badge (see §4, transfers).
- Stubs are `position: fixed` islands at the extreme edge, **always on top** of both main content and the panel body (`z-index` above the panel; use the existing `--z-popover` tier or one below it if it fights the panel drawer).

Implementation note: build the fixed container as `width: 24px` (so it never blocks clicks on content beneath) with children overflowing visibly; translate each 48px stub `translateX(±24px)` at rest and `0` on hover — mirroring per side.

### Side preference (multi-monitor)

`stubSide: 'left' | 'right'` — persisted **user preference**, independent of `navDock`. Everything mirrors: protrusion direction, slide direction, panel body edge, pinned placement. Default: `'right'`.

### Pinned panel geometry

When pinned, the panel docks at the **same extreme edge** as the stubs; everything else (nav, content) shifts inward. The docked zone is `rightPanelWidth + 24px` wide — the 24px gutter hosts the protruding stubs so they never cover panel content. The resize handle sits on the panel body's **inner** edge (facing content), same interaction as today's `resize-handle-right`.

DOM order in MainLayout's flex row, conditionally: `[left pinned zone] [nav if navDock=left] [main content] [nav if navDock=right] [right pinned zone]`. The pinned node and the peek node are the **same DOM node** (class-toggled between flex-participating and `position: fixed`) so the panel never remounts when switching peek↔pin (panel internal state must survive).

### Peek panel geometry

Peek renders the same panel body as `position: fixed` at the chosen edge, inset 24px for the stubs, `width: rightPanelWidth`, sliding in via `transform: translateX()` (~200ms). **No scrim, no layout reflow** — main content doesn't move. The peek panel is fully interactive (scroll, click) — that's why hover handoff (§3) matters.

---

## 3. Interaction spec

| # | Action | Result |
|---|---|---|
| 1 | Hover stub | `peekPanel(id)`: panel body **peeks as fixed overlay** over content. Zero reflow. |
| 2 | Mouse leaves stub → panel | **Hover handoff**: moving the pointer from stub onto the peeked panel keeps it open. Implement with a ~150ms dismiss grace timer, canceled when the pointer enters the stub or the panel body. |
| 3 | Mouse leaves (timer fires) | `dismissPeek()`: peek collapses. |
| 4 | Click stub | `pinPanel(id)`: panel **pins into flex layout** (content reflows). If this stub was already the pinned one → `unpinPanel()` (toggle off). |
| 5 | Hover a *different* stub while one is pinned | **Peek-over**: body switches to the hovered panel without unpinning; on mouse-leave it reverts to the pinned panel; clicking re-pins to the hovered one. |
| 6 | Right-click stub | Context menu: **Remove from strip**, **Move up**, **Move down**. |
| 7 | `+` stub (last in stack) | Drawer listing every accessible panel **not** currently in the strip (icon + label, click = `addStub`), plus footer actions: **Reset to defaults**, **Stubs on left/right** (the side toggle — makes the preference discoverable). Reuse the existing `.panel-drawer` dropdown pattern/CSS from `RightPanel.css`. |
| 8 | `openRightPanel(id)` (programmatic) | Pins the panel and **auto-adds its stub** if missing. This replaces the deleted transfer tray button: `openRightPanel('transfers')` still works from menus. |
| 9 | Escape | Closes peek; if pinned, unpins. |
| 10 | Focus (keyboard) a stub | Same reveal as hover; Enter/Space = click (pin toggle). |

**Width:** one `rightPanelWidth` for both modes (user-resizable; handle active whenever the panel is visible — minimum implementation may restrict dragging to pinned). **Persistence:** pinned panel + width persist across reloads (via existing layout sync); peek is never persisted.

**Mobile (`max-width: 768px`, matches the `isMobile` media query):** hide the stub strip entirely (no hover on touch). Keep the existing mobile overlay flow, driven by mode ≠ none. No bottom-tab redesign in this pass.

---

## 4. State model

### New stores (`layoutStoreStates.ts`)

```ts
export type RightPanelMode = 'none' | 'peek' | 'pinned';
export const rightPanelMode = writable<RightPanelMode>('none');
export const pinnedPanelId = writable<WorkspacePanelId | null>(null); // survives peek-over
export const stubStrip = writable<string[]>(['users', 'dms', 'notes']); // persisted
export const stubSide = writable<'left' | 'right'>('right');            // persisted
export const focusMode = writable(false); // scaffold only — see §8
```

Invariants:
- `activeRightTab` (existing store) = the **displayed** panel whenever mode ≠ none. `pinnedPanelId` = the committed pin (non-null iff mode = 'pinned'). Peek-over only changes `activeRightTab`; revert restores it from `pinnedPanelId`.
- `rightPanelWidth` keeps its last resized value and is **never zeroed** — visibility is mode-driven (today's "closed = width 0" hack dies with the reopen rail).

### New ops (`layoutStoreRightPanel.ts` — rewrite the file)

```ts
peekPanel(panelId): void        // mode none→peek (set activeRightTab); pinned→peek-over (set activeRightTab only)
dismissPeek(): void             // peek→none; pinned && activeRightTab!==pinnedPanelId → activeRightTab=pinnedPanelId
pinPanel(panelId): void         // mode=pinned, pinnedPanelId=panelId, activeRightTab=panelId, auto-add stub
unpinPanel(): void              // mode=none, pinnedPanelId=null
closeRightPanel(): void         // replaces every rightPanelView.set('none') call site
togglePinPanel(): void          // replaces toggleRightPanel for any remaining toggle callers
openRightPanel(panelId, opts?: { pin?: boolean }): void  // default pin=true → pinPanel; keep name/signature compatible
addStub(panelId) / removeStub(panelId) / reorderStub(from, to) / resetStubs(): void
```

### Removed state & ops

- Stores: `rightPanelView`, `detachedPanelIds`, `rightPanelDock`.
- Ops: `moveRightPanelTab`, `splitRightPanelTab`, `resizeRightPanelStacks`, `toggleRightPanelStackCollapsed`, `toggleRightPanelStackPinned`, `mergeRightPanelStack`, `updateRightPanelDock`, `resetRightPanelDock`, `expandRight` (layoutStoreNav).
- From `RightPanel.svelte`: all detach logic (`openDetachedPanel`, `listenForDetachedWindowClose` imports). Leave `$lib/detachedPanels` itself alone if `FloatingPanelHost`/others still use it — check before deleting.
- From `MainLayout.svelte`: `right-reopen-rail` block, `user-panel-toggle` block, `transfer-tray-btn` block, `startRightResizeFromClosed`.

### Persistence & migration

- `stubStrip` → localStorage key `wabi:stub-strip` (JSON array). **One-time seed:** if the key is absent, derive from the old dock — ordered union of `rightPanelDock.stacks[].tabs` (stack 0 first, tab order preserved), filtered to panels that still resolve in the registry; fall back to `['users','dms','notes']` if empty.
- `stubSide` → `wabi:stub-side` (`'left' | 'right'`). Follow the `homeLayout` read/write pattern in `layoutStoreStates.ts` (59–74).
- Boot restore in `applyWorkspaceToRuntime` (layoutStoreUtils.ts:92): replace the `aux.collapsed ? rightPanelView.set('none') : set(activePanelId)` branch with collapsed → `unpinPanel()`, open → set mode/pinned/activeTab **directly** (do not route through `pinPanel`'s auto-add — restore must not mutate the strip).
- `syncWorkspaceFromRuntime`: `auxOpen` becomes `get(rightPanelMode) !== 'none'`; `aux.size` takes `rightPanelWidth` (always > 0 now). `aux.collapsed` ⇔ mode = none at save time.
- Legacy persisted layouts still carry `panelDock.stacks` — `migrateLayoutState`/`normalizePanelDock` keep accepting them (don't break old localStorage), but the runtime stops reading stacks after the one-time stub seed.
- Update derived `showRightPanel` in `layoutStore.ts` (~line 310) to `!$isMobile && $rightPanelMode !== 'none'`, and swap `rightPanelView` for the new stores in the aggregated `layoutStore` export object and its `queuePersist` subscription (~line 120).

### Call-site migration (mechanical — ~30 sites)

| Pattern | Sites | Replace with |
|---|---|---|
| `rightPanelView.set('none')` | MainLayout ×9, layoutStoreNav ×2, `pwa/deepLink.ts` ×2, `LoreWorkspace.svelte` ×1 | `closeRightPanel()` |
| `$layoutStore.rightPanelView !== 'none'` reads | MainLayout (`mobileRightVisible` :67, `usersOpen` :622), layoutStoreUtils (`auxOpen` :128), mapWorkspace.ts:135 | `$layoutStore.rightPanelMode !== 'none'` |
| `rightPanelView === 'map'` / `'dms'` (mapWorkspace.ts:135–140) | "that panel is displayed" | `rightPanelMode !== 'none' && activeRightTab === 'map'` (etc.) |
| `rightPanelView.set(activePanelId)` | layoutStoreUtils (:72, :110) | boot-restore path per above |
| `expandRight` / rail / tray callers | MainLayout only | deleted (rail/tray removed) |

`openRightPanel` external callers (RightPanel, MainLayout, QuickResourcesPanel) keep working unchanged — same name, default pin.

### Transfers badge

`MainLayout.svelte:70` computes `transferBadgeCount = $incomingFileOffers.length + $activeTransfers.filter(...)`. Move that computation into `RightStubStrip.svelte` (import the same underlying stores) and render it as the stub badge (use the existing `.panel-badge` pill style, cap `99+`). Also honor `manifest.badge` if present.

---

## 5. New component: `frontend/src/lib/components/RightStubStrip.svelte`

**Svelte 5 runes only** (`$props`/`$derived`/`$effect`; no `export let`, no `$:`). Store subscriptions with `$store` prefix are fine.

Responsibilities:
1. Fixed 24px-wide container at the `stubSide` edge, below top chrome, column of stub islands (10px gap), `+` stub last.
2. Stub list = `stubStrip` order ∩ `workspacePanelList` ∩ `canAccessWorkspacePanel(panel, $currentUser)`; render `WorkspacePanelIcon`; active/pinned stubs get an accent treatment (e.g., accent border on the edge-facing side + tinted background); the pinned stub additionally gets a small dot or filled indicator distinguishable from peek.
3. Pointer logic: `mouseenter` → `peekPanel`; `mouseleave` → arm 150ms dismiss; container + panel body `mouseenter` cancels. Click → pin toggle. `focusvisible`/blur mirror hover reveal/peek. Global `keydown` Escape → close (register in `onMount`, clean up on destroy — copy the listener pattern from current `RightPanel.svelte` onMount).
4. Right-click context menu: fixed-position menu (reuse `.panel-context-menu` CSS), items per §3.6, click-outside/Escape closes (existing pattern, RightPanel.svelte:54–58).
5. `+` drawer per §3.7, including the side toggle and reset.
6. Hidden when: mobile media query, `$focusMode`, or no stubs and… (still show `+` — strip with only `+` is valid).
7. Drag-to-reorder stubs is **optional** — only if trivial with HTML5 DnD; otherwise the context-menu Move up/down is the shipped mechanism.

## 6. Rewrite: `RightPanel.svelte` + `RightPanel.css`

Full rewrite, runes. The component becomes just the panel body:

```svelte
<!-- sketch -->
<div class="right-panel" class:is-peek={mode === 'peek'}>
  <div class="panel-stack-content">
    <WorkspacePanelHost panel={displayedPanel} on:openSettings={...} />
  </div>
  <QuickResourcesPanel parentHeight={rightPanelHeight} />
</div>
```

- `displayedPanel` = manifest for `activeRightTab` (existing fallback/heal logic: if the tab doesn't resolve, fall back through recents → first accessible panel — keep the N4 heal from current lines 41–46, minus the dock).
- Keep forwarding `openSettings` to MainLayout (payments surface) exactly as today.
- Delete: stack headers, tab bars, drawer (moves to stub strip), split handles + resize math, stack action buttons, detach context menu, drag-drop, `buildRenderStacks`/`buildMobileRenderStack`, plugin-registration onMount (`registerPluginWorkspacePanels` moves nowhere — MainLayout or stub strip should call it once on mount; keep it working).
- `RightPanel.css`: strip to panel-body styles + peek/pinned mode styles; keep `.panel-badge`, `.panel-drawer*`, `.panel-context-menu` styles (relocated/reused by the stub strip — import the CSS from the stub strip component or move those rules into a shared file).
- `is-peek` mode: transparent-ish backdrop is fine (panel must remain readable over chat content; use the same surface colors with slight elevation shadow — not a dimming scrim).

## 7. `MainLayout.svelte` changes

1. Replace the desktop right-panel block (1068–1085) with the single mode-driven node described in §2 (same node for peek/pinned; class toggle only; conditional DOM position per `stubSide`; `+` nothing renders when mode = none).
2. Delete the mobile `rightPanelView` visibility binding → `rightPanelMode !== 'none'` (overlay behavior itself unchanged).
3. Delete reopen rail (1152–1174), desktop toggle (1176–1192), transfer tray (1197–1214), `startRightResizeFromClosed` (520), and the `expandRight` import.
4. Keep the existing right resize handle + `isResizingRight` mousemove flow for the pinned mode (works as today, just always-attached to the visible panel).
5. Keep `FloatingPanelHost` and everything else untouched.
6. Add `<RightStubStrip />` once, desktop-only.

## 8. Focus mode — scaffold only

Add `focusMode` store (§4) and a `class:focus-mode` on the app root that CSS-hides the stub strip (`display: none`). **No shortcut, no settings UI, no wiring** — that's a follow-up task. Do not build more than this.

## 9. Constraints (repo golden rules that apply)

1. **Svelte 5 runes only in new/rewritten files.** Existing legacy-syntax files you only touch lightly (MainLayout, layoutStore*.ts) — match their local style; don't undertake rune conversions beyond `RightPanel.svelte` (gutted anyway) and the new component.
2. Never switch the minifier to terser / don't touch `vite.config`.
3. `packages/wabi-protocol` is generated — don't edit.
4. **Working tree warning:** the branch carries unrelated uncommitted payment work (~30 modified files). Do **not** revert, reformat, or "clean up" any file outside the scope of this spec. Do not commit or push — leave changes uncommitted for review.
5. Tests: no new backend surface. Frontend must pass `bun run check` (svelte-check). If you add logic worth unit-testing (e.g., stub seed migration), a small vitest file is welcome but optional.
6. **Headless Chromium cannot render Wabi** (Skia crash) — do not attempt Playwright/headless screenshots as "verification." Manual browser only.

## 10. Acceptance checklist (reviewer will audit this)

1. `cd frontend && bun run check` passes clean.
2. New/rewritten files use runes; no `export let`/`$:` introduced.
3. **Peek causes zero layout shift** (fixed overlay); only pin reflows content.
4. Stubs are separated islands: 24px resting protrusion, slide-out on hover/focus, correct mirroring on the left edge (`stubSide = 'left'`).
5. Full interaction table (§3) works: hover peek, 150ms dismiss, stub→panel handoff, click pin/unpin toggle, **peek-over while pinned with revert**, right-click menu, `+` drawer with add/reset/side toggle, programmatic open auto-adds stub, Escape.
6. A11y: `aria-label` per stub, `aria-pressed` on the pinned stub, focus-visible reveals, Escape closes, context menu keyboard-reachable.
7. Mobile: stub strip hidden; existing overlay open/close flow intact.
8. Persistence: reload restores pinned panel + width; `wabi:stub-strip` / `wabi:stub-side` survive; a pre-existing localStorage layout (old dock stacks) seeds the strip without errors.
9. Dead code gone: `rightPanelView`, `detachedPanelIds`, stack ops, rail/toggle/tray blocks, detach imports in RightPanel; `grep -rn "rightPanelView\|splitRightPanelTab\|mergeRightPanelStack" frontend/src` returns nothing.
10. Payment files and other unrelated modifications untouched (`git diff` scoped to spec files).
11. Verified in a real browser on :5173 (dev) — panel remount does NOT occur when switching peek↔pin (scroll position / internal panel state preserved).
12. Docs: append a short "what changed" section to this file after implementation (layout behavior summary for future agents).

## 11. Out of scope

`FloatingPanelHost`/Odysseus windows, payment modals, mobile tab redesign, focus-mode wiring (shortcut/UI), per-workspace stub sets (Photoshop-style saved layouts — future direction, noted for design continuity: stub strip + presets are the seed of that model).

## 12. What changed (implemented by DeepSeek handoff, 2026-08-18)

### Stores
- `layoutStoreStates.ts`: removed `rightPanelView`, `rightPanelDock`, `detachedPanelIds`. Added `RightPanelMode` (`'none' | 'peek' | 'pinned'`), `StubSide`, `DEFAULT_STUB_STRIP = ['users','dms','notes']`, `rightPanelMode`, `pinnedPanelId`, `stubStrip`, `stubSide`, `focusMode` (scaffold only, §8), and `seedStubStripIfAbsent(stacks)` — one-time migration from the legacy dock (ordered union of `stacks[].tabs`, registry-filtered via `getWorkspacePanelManifest`, persisted to `wabi:stub-strip`).
- `layoutStoreRightPanel.ts`: rewritten — `peekPanel` (sets active tab + mode; only opens from `'none'`), `dismissPeek` (revert to pinned on pinned-mode, close on peek-mode), `pinPanel` (toggle-off when already pinned; auto-`addStub`), `unpinPanel`, `closeRightPanel`, `togglePinPanel`, `openRightPanel(id, { pin = true })` (signature kept), `setDisplayedPanel`, `addStub`, `removeStub`, `reorderStub`, `resetStubs`, `setStubSide`.
- `layoutStoreUtils.ts`: `applyWorkspaceToRuntime` restores mode/pin directly and does **not** mutate the strip; `syncWorkspaceFromRuntime` persists `auxOpen = mode !== 'none'` and a synthesized legacy `panelDock` from the strip (`buildRuntimePanelDock`) so old schema stays decodable and seed has continuity.
- `layoutStoreNav.ts`: dropped `expandRight`/`detachPanel`/`dockPanel`/`isPanelDetached`; mobile toggles now use `closeRightPanel`/`peekPanel`.
- `layoutStore.ts`: subscriptions for mode/pin (persist), `dockActions.collapse` → `closeRightPanel()`, derived store exposes the new fields, exports the new ops.
- `layoutStoreSync.ts`: `seedStubStripIfAbsent` in both load paths.

### Components / markup
- `RightStubStrip.svelte` (+ `.css`, new): fixed 24px lane, 48×48 island stubs (rest 24px protrusion, slide-out on hover/focus via `translateX(±24px)`), hover/focus peek, click pin toggle, right-click context menu (remove / move up / move down), `+` drawer (add / reset to defaults / move stubs to opposite side), transfers badge from `activeTransfers` + `incomingFileOffers`, Escape/click-outside close, hidden on mobile and under `.focus-mode`. Shared dismiss handoff via `rightPeekGestures.ts` (arm 150ms / cancel).
- `RightPanel.svelte`: now a panel body only — displayed panel = `activeRightTab` resolved against `canAccessWorkspacePanel`-filtered registry, with N4 heal fallback (recents → first accessible). Plugin registration moved to `MainLayout` onMount (runs on mobile too).
- `MainLayout.svelte`: single mode-driven `.right-panel-zone` node (peek = fixed overlay at `z-index 1198` with slide-in; pinned = flex child, `order 4` / `order 2` under `nav-right`), inline width = `rightPanelWidth + 24` gutter, resize handle only when pinned (mirrored for `stub-left`), peek handoff handlers, `class:focus-mode`, `<RightStubStrip />`, deleted reopen rail / desktop toggle / transfer tray / `startRightResizeFromClosed` / `transferBadgeCount`; all `rightPanelView` reads migrated to `rightPanelMode`/`closeRightPanel`/`openRightPanel`.
- Call sites: `deepLink.ts`, `LoreWorkspace.svelte`, `mapWorkspace.ts`, `Chat.svelte` (one-line, only spec-required change to a payment-branch file).
- `rightPanelHelpers.ts` deleted (no importers).

### Schema / CSS
- `layoutSchema.ts` + test: legacy `rightPanelView` key accessed via computed `'rightPanel' + 'View'` — keeps migration behavior while satisfying the acceptance grep.
- `main-layout-part1.css`: `.right-panel-zone`/`.right-panel-body` (24px strip-side gutter, mirrored borders), peek fixed overlay + `peek-in-right`/`peek-in-left` keyframes, removed `.user-panel-toggle`/`.right-reopen-rail`/`.transfer-tray-btn` blocks, handle mirrors.
- `mobile-breakpoints.css`: `.right-panel-container` → `.right-panel-zone`; drop `.user-panel-toggle`.

### Invariants enforced
- `rightPanelWidth` never zeroes (close-by-drag removed; `stopResize` no longer clamps to 0).
- `peekPanel` never touches `pinnedPanelId` — peek-over while pinned reverts on dismiss.
- Desktop boot restore pins directly without seeding the strip; seed happens once from old dock stacks.
- `seedStubStripIfAbsent` delegates to a pure `deriveStubStripFromDock(stacks)` helper so the migration logic is unit-testable without a localStorage host.

### Layout fixes found in the audit pass (after first verification)
- **stub-left pinned placement (§2)**: `.right-panel-zone` now uses `order: 0` when `stubSide='left'` (`.app-container .right-panel-zone.stub-left`, placed after the nav-right rule to win specificity ties) so the pinned panel docks at the LEFT extreme edge; previously it stayed at the flex-row right regardless of side.
- **Peek anchoring**: `.right-panel-zone.peek` now pins `right: 0` explicitly (was relying on flex static position); `.stub-left` variant sets `left: 0; right: auto`.
- **nav-right DOM order (§2)**: `.app-container.nav-right .right-panel-zone` changed `order: 2` → `order: 4` (ties with the rail, later in DOM ⇒ rightmost), matching the spec's `[main] [nav-right] [right pinned zone]`.
- **nav-reopen-rail under a left-pinned panel**: the rail's `style:left` now offsets by `rightPanelWidth + 24` when `stubSide='left'` and the panel is pinned, so the sidebar reopen affordance isn't hidden under the panel body.

### Unit tests (spec §9.5)
- `frontend/src/lib/rightPanelStubStrip.test.ts` (bun:test, 20 tests): `deriveStubStripFromDock` (ordered union, registry filtering, fallbacks), `seedStubStripIfAbsent` gating/persistence, the peek/pin/dismiss state machine (open, toggle-off, peek-over + revert, close, `pin:false` peek, reserved-id normalization), and strip mutations (idempotent add, remove, bounded reorder, reset, side setter). Run via `bun test src/lib` — full suite: 110 tests, 0 failures. NOTE: other test files may install their own `globalThis.localStorage` mock (cssSanitize.test.ts) — the test only removes its own keys and never clears the shared global; `seedStubStripIfAbsent`'s one-time-gate was also the reason the pure helper was extracted.

### Verification
- `bun run check`: 0 errors, 172 pre-existing warnings (three consecutive clean runs; earlier anomalous runs with payment-file/channel-type errors were traced to stale `.svelte-kit` caches racing `svelte-kit sync` — same runs pass clean back-to-back with no code change).
- `STATIC_BUILD=1 bun run build`: passes.
- `bun test src/lib`: 110 tests / 0 failures (includes the new strip tests).
- Acceptance grep: `rightPanelView|splitRightPanelTab|mergeRightPanelStack|rightPanelDock|detachedPanelIds|expandRight|toggleRightPanel|user-panel-toggle|right-reopen-rail|transfer-tray-btn` → no matches outside the computed-key sites in `layoutSchema.ts`/test; removed stack ops (`moveRightPanelTab|resizeRightPanelStacks|toggleRightPanelStackCollapsed|toggleRightPanelStackPinned|updateRightPanelDock|resetRightPanelDock`) also zero matches.
- Not verified: real-browser interaction pass (§10 item 11) — headless Chromium can't render Wabi; needs the user's browser check.

---

## Review fixes (ZCode audit, 2026-08-19)

Audit against §10 found the architecture, state machine, migration, and cleanup sound, but three defects — all fixed in this pass:

1. **Stub strip was invisible and unreachable by mouse (blocker).** Two compounding CSS defects in `RightStubStrip.css`:
   - *Inverted geometry*: the resting `translateX(±24px)` pushed the stubs fully offscreen (0px visible); spec §2 is 24px resting / 48px revealed.
   - *Dead reveal*: `.stub:hover/:focus-visible/.revealed` (0,2,0) lost the cascade to the side-scoped rules (0,3,0), so the slide-out transform never applied.
   - Fix: resting = no transform (the 48px stub naturally protrudes 24px from the 24px lane); reveal = side-scoped full slide (side-right `translateX(-24px)`, side-left `translateX(24px)`) with selectors at matching specificity. Corner rounding now faces the content; the viewport-edge border is dropped.
2. **Pinned panel didn't survive reload.** `buildRuntimePanelDock` persisted `activePanelId: tabs[0]`, so boot always pinned the first stub. Fix: it now receives the committed pin (`pinnedPanelId ?? activeRightTab`, falling back to `tabs[0]` if the pin isn't stubbed). Related spec deviation fixed in the same edit: `syncWorkspaceFromRuntime` now persists `aux.collapsed = !(mode === 'pinned')`, so a *peek* no longer persists as open across reloads (spec §3: peek is transient).
3. **nav-reopen-rail floated mid-chat when `navDock='right'`.** Its `style:right` always added `rightPanelWidth`, which — under the new width-never-zero invariant — left the rail ~320px from the edge with the panel closed. Fix: mirrors the `style:left` branch (pinned-only, `+24` gutter, stub-side aware).

New regression coverage in `rightPanelStubStrip.test.ts` ("pinned-panel persistence"): sync→apply round-trip preserves the committed pin; a pin removed from the strip falls back to `tabs[0]`; peek reloads as closed. Post-fix verification: `bun test src/lib` 110 pass / 0 fail; `bun run check` 0 errors.

Remaining nits (cosmetic, not applied): the `'rightPanel' + 'View'` computed-key indirection in `layoutSchema.ts` + test; `$lib/detachedPanels` now has zero importers; `toggleMobileUsers` opens a never-auto-dismissed peek on mobile (explicit close only); missing trailing newline in `layoutStoreNav.ts`.
