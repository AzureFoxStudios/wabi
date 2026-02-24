# Wabi Docking System Deep Dive + Phase 1 Refactor Report

## 1) Phase 0 Audit: Current Layout Structure

### Existing shell layout (before refactor)
- Main shell lived in `frontend/src/lib/components/MainLayout.svelte`.
- Layout behavior used manual flex columns + ad hoc width stores:
  - `channelSidebarWidth`
  - `rightPanelWidth`
  - `rightPanelView`
- State lived in `frontend/src/lib/layoutStore.ts` as UI booleans and scalar widths, not as a dock tree.
- No schema versioning, no migration contract, no workspace model.
- Persistence for layout was effectively missing (panel widths/toggles were transient).

### Store/routing boundaries
- App entry: `frontend/src/routes/+page.svelte` mounts `MainLayout`.
- Core mobile/desktop branching happened inside `MainLayout.svelte`.
- Settings UI is in `frontend/src/lib/components/Settings.svelte`.
- Tauri command surface is in `frontend/src-tauri/src/handlers.rs` and registered in `main.rs`.

### Pain points identified
- Layout behavior was "anchored columns" rather than dock model.
- No shared JSON layout state for web + Tauri.
- No reset-safe migration path for corrupted/legacy layout.
- No workspace presets/save/load/rename.
- Nav docking side was not configurable.

## Refactor map (old -> new)
- `layoutStore.ts` scalar panel flags -> schema-driven workspace dock state + compatibility API.
- `MainLayout.svelte` fixed left nav -> bidirectional nav dock with side-aware resize math.
- Settings appearance options -> dock side/collapse/workspace management controls.
- No layout persistence contract -> versioned JSON persistence with web+Tauri backends.

## 2) A vs B Recommendation (Wabi Context)

## Decision
- **Recommend Option B (custom Svelte-first docking model)** for Phase 1 and Phase 1.5.

## Rationale
- Existing shell already has custom interaction logic (mobile gestures, panel behaviors) tightly integrated with Svelte stores.
- A lightweight model-first custom layer minimizes integration risk and avoids framework bridge complexity.
- Current Phase 1 scope (left/right nav dock, collapse, persistence, reset) is straightforward with a constrained custom model.
- This keeps bundle/control overhead low and preserves path to phased expansion (tab drag, nested splits, pop-out later).

## Why not Golden Layout first
- Golden Layout is viable but increases integration/theming cost immediately.
- Wabi needs constraints aligned with its existing shell semantics; custom model is lower-risk for incremental rollout.

## 3) Implemented Phase 1 Deliverables

### 3.1 Versioned layout schema + migration
- Added `frontend/src/lib/docking/layoutSchema.ts`.
- Introduced `layoutVersion: 1`.
- Added workspace-aware layout state with dock split/tabset model.
- Added defaults/presets:
  - `default`
  - `focus`
  - `mod`
- Added migration path:
  - Schema v1 validation/normalization.
  - Legacy conversion from pre-docking `layoutStore` fields (`channelSidebarWidth`, `rightPanelWidth`, `rightPanelView`, `navDock`).
- Added interfaces:
  - `LayoutStateV1`
  - `ModuleRegistryEntry`
  - `DockActions`

### 3.2 Persistence (web + Tauri)
- Added `frontend/src/lib/docking/layoutPersistence.ts`.
- Web persistence: `localStorage` (`wabi:dock-layout:v1`).
- Tauri persistence:
  - Added `save_layout_state` and `load_layout_state` commands in `frontend/src-tauri/src/handlers.rs`.
  - Registered commands in `frontend/src-tauri/src/main.rs`.
  - Writes/reads `dock_layout_state.json` in app data directory.
- Corruption fallback always resets to default layout safely.

### 3.3 Refactored runtime layout store
- Replaced `frontend/src/lib/layoutStore.ts` implementation with schema-driven workspace model.
- Preserved existing external API used by existing components.
- Added Phase 1 docking/workspace actions:
  - `setNavDock`, `toggleNavDock`
  - `collapseNav`, `expandNav`, `toggleNavCollapsed`
  - `saveWorkspace`, `loadWorkspace`, `renameWorkspace`
  - `resetWorkspace`, `resetAllLayouts`
  - `exportLayoutJson`, `importLayoutJson`

### 3.4 Desktop dock behavior in app shell
- Updated `frontend/src/lib/components/MainLayout.svelte`:
  - Desktop nav docking now supports left/right.
  - Resizing math now respects right-docked nav.
  - Right panel resize respects nav offset when nav is right-docked.
  - Desktop affordances (notification rail and side toggle) offset when nav is right-docked.

### 3.5 Settings UI controls
- Updated `frontend/src/lib/components/Settings.svelte` (Appearance tab):
  - Nav dock side selector (left/right).
  - Nav collapse toggle.
  - Workspace selector.
  - Save As / Rename / Reset workspace.
  - Export / Import workspace JSON.

### 3.6 Dev demo route
- Added `frontend/src/routes/dock-demo/+page.svelte`.
- Added reusable Phase 1 container primitive `frontend/src/lib/components/docking/DockContainer.svelte`.
- Provides isolated playground for:
  - Left/right docking
  - Collapse/expand
  - Resizing
  - Workspace save/load/reset
  - JSON export/import

## 4) Layout Schema + Migration Strategy

## Current schema contract
- `layoutVersion: 1`
- Top-level:
  - `activeWorkspace`
  - `workspaces`
  - `updatedAt`
- Workspace:
  - `name`
  - `navDock` (`left`/`right`)
  - `root` split tree (tabsets + sizes + collapsed states)

## Migration strategy
- On load:
  - If v1 layout is present: normalize and sanitize.
  - If legacy shape present: convert into v1 default workspace.
  - If parse/shape failure: default v1 layout.
- This guarantees "Reset to default" behavior and corruption recovery.

## 5) Tests Added

- Added `frontend/src/lib/docking/layoutSchema.test.ts` covering:
  - serialize/deserialize
  - legacy migration
  - reset/default preset values

## 6) Known Gaps / Next Phase Targets

- Phase 1.5 still pending:
  - true tab drag reorder and cross-zone tab reparenting
  - close/re-open module menu semantics beyond current right-panel behavior
- Gate Switcher visual module is modeled and reserved in schema but still represented as part of nav shell composition; dedicated UI module can be split in Phase 1.5.
- Nested splits/min-size constraints beyond fixed Phase 1 topology remain for Phase 2.

## 7) Validation Notes

- Runtime/package tooling (`node`, `npm`, `bun`) was unavailable in this environment, so automated check execution could not be run here.
- Refactor was completed with static code consistency checks and integration-safe API preservation.
