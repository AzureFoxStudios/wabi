# Planner + Lore Fixes — 2026-08-08

Hermes (deepseek) dispatch. All 4 tasks landed; `bun run check` clean (only pre-existing `bun:test` type noise in test files remains).

## Task 1 — Kanban "falling through the floor" (root cause found)
**Cause:** `frontend/src/styles/components/todo-list.css` re-defined `.kanban-board { display: grid }` (no grid-template-columns) + `.kanban-column { min-height: 400px }` and three `@media` blocks with `grid-template-columns: ... !important`. It imports AFTER `kanban-board.css` (styles.css line 77 vs 60) → same specificity → later wins → grid stomped the flex horizontal spread at every width ≤1200px. Deterministic cascade war, not a cache ghost.
**Fix:** removed the legacy grid rules + `.column-header`/`.count`/`.column-content` dupes + the `!important` media overrides from todo-list.css. `kanban-board-part1.css` flex rule is now the sole `.kanban-board { display:` definition.
**Note:** `.card-actions { opacity: 0 }` in todo-list.css is an unscoped pre-existing leak that can hide TransferCard/FfxivReferencePanel actions (reveal rule requires `.todo-card:hover`, which never matches). NOT touched — out of scope, flagging for a follow-up.
**Files:** frontend/src/styles/components/todo-list.css

## Task 2 — Planner add buttons
- Removed the embedded-only duplicate `kanban-add-btn` from `KanbanBoardImpl.svelte` header (planner's New split-button is the sole primary; per-column `+` buttons kept).
- Changed the "Manage columns" plus icon to a three-bars columns icon so it no longer reads as another Add.
- Calendar: `+ Add Event` button hidden when `embedded` (planner New button covers it); header baseline already aligned (`min-height: 36px` on both buttons, `align-items: center` on `.header-right`).
**Files:** frontend/src/lib/components/business/KanbanBoardImpl.svelte, CalendarImpl.svelte

## Task 3 — Right-dock Code panel
- `WorkspacePanelComponentKey` + `KNOWN_COMPONENT_KEYS` + `BUILTIN_WORKSPACE_PANELS` got `'code'` (icon `box`, defaultDock right, sortOrder 56, capabilities `repo-browse`).
- `WorkspacePanelHost.svelte` renders `<LoreCodePanel />` for `component === 'code'`.
- New `LoreCodePanel.svelte`: hosts the existing `LoreFileTree` + `LoreFileViewer`, driven by the shared `loreRepo`/`loreFiles` stores + `loadLoreRepo()`; reads current channel via `parseLoreChannelId($currentChannel)`; refresh button; empty state when no repo. Read-only (context menu intentionally no-op in panel).
**Files:** frontend/src/lib/workspacePanels.ts, WorkspacePanelHost.svelte, + new LoreCodePanel.svelte
**NOT done:** auto-opening the Code panel when a lore channel becomes active — no established channel-type→panel pattern exists in the codebase; panel is available in the dock instead. Flag for future if wanted.

## Task 4 — Lore capability gate + dead buttons
- `hasAddonCapability()` no longer caches `false` forever — only `true` is sticky; a negative resolution is evicted so the next call re-probes (flaky first fetch can no longer hide the Code chip for the session). Added `resetAddonCapabilityCache()` export.
- `CreateChannelForm.svelte`: Code chip ALWAYS visible; when lore unavailable it renders disabled ("Addon unavailable" hint, aria-disabled, click ignored) and submit is gated — no more hidden chip + silent force-reset to text.
- `ChannelSidebar.svelte`: removed the `if (!ok && newChannelType === 'lore') newChannelType = 'text'` force-reset; updated comment.
- `LoreChannelShell.svelte`: implemented the TODO `handleContextMenu` — right-click a tree node now opens a real context menu (Lock / Unlock / Compare / Delete) wired to existing `handleLock`/`handleUnlock`/`handleDelete`/`handleCompare`; removed the dead `handleDeleteBranch` (backend has no delete-branch route) and its `onDelete` wiring; fixed `handleUpload` arg order bug (`uploadLoreFile(token, channelId, path, file, ...)` — was passing `file` as path, would have thrown at runtime).
- `LoreBranchPicker.svelte`: removed the dead right-click-delete affordance (no backend route); confirm-delete UI + `onDelete` prop removed.
- `LoreConnectModal.svelte`: already surfaces real server errors (`err.error || fallback` → `.error-message` block) — no change needed.
**Files:** addonInventory.ts, CreateChannelForm.svelte, ChannelSidebar.svelte, LoreChannelShell.svelte, LoreBranchPicker.svelte

## Backend notes
Lore addon confirmed live on Tim: `/api/addons/lore/health` → `{status:"ok"}`, `POST /api/addons/lore/repos` → 401 missing-auth (route alive), env has `WABI_LORE_ENABLED=true`, `WABI_LORE_AUTO_CREATE=true`. No backend changes needed.

## Follow-up (same day) — whiteboard errors + lore chip re-probe

**Whiteboard red-error-behind-UI (fixed):**
- Root cause 1: `.whiteboard-banner.error` rendered at `top: 4.2rem; z-index: 17` — the floating toolbar `.wb-toolbar` sits at `top: 4.25rem; z-index: 20` and covered it exactly. Error was invisible behind the toolbar. Now `top: 8.2rem; z-index: 30`, flex layout, drop shadow, dismiss button.
- Root cause 2: socket `whiteboard:error` messages set `errorMessage` which NEVER auto-cleared — a transient error (e.g. payload-too-large, sync conflict) lingered as a stuck red bar. Now auto-clears after 6s (`showTransientError`), same as the import-error pattern.
- Root cause 3: `boardSyncError` store messages ("Sync failed — reload the board", "Your changes conflicted…") were set but NEVER rendered anywhere — only `desktop-only`/`read-only` strings were consumed for the gate UIs. Now surfaced in the banner via `syncErrorToShow`.
- Import-error HUD raised from z-10 to z-40 (was also under the toolbar), max-width + centered text.
- Fixed one pre-existing mixed-syntax event (`on:change` → `onchange`) — count of mixed-syntax errors dropped 4 → 3 (rest are pre-existing, untouched).

**Lore "Addon unavailable" (fixed):**
- Root cause: `ChannelSidebar` probed `hasAddonCapability('lore')` ONCE in `onMount`. Even though negative results no longer cache (previous fix), the sidebar stored the single probe result in a plain `let loreAvailable = false` and never re-checked. A flaky mount-time probe = "Addon unavailable" for the session despite the server returning `enabled: true` (verified: `https://wabi.chat/api/addons` → lore `enabled:true`).
- Fix: new `refreshLoreCapability()` re-probes whenever the create form opens (`toggleCreateInputForType` + `openCreateFormForCategory`), so the chip corrects itself seconds after opening the form.

Files: frontend/src/lib/components/WhiteboardTab.svelte, WhiteboardCanvas.css, ChannelSidebar.svelte. Commit a46cacd.
