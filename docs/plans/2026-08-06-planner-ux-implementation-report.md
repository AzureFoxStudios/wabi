# Planner UX Revival — Implementation Report

Status: **implemented** (visual pass still required in a real browser — headless Chromium cannot render Wabi).

Implements `docs/plans/2026-08-06-planner-ux-critique-and-revival.md` phases A–F. No backend, protocol, or data-model changes. No commits made.

## Files changed

| File | What changed |
|------|--------------|
| `frontend/src/lib/business/store.ts` | `loadFromStorage` → exported, idempotent `reloadFromStorage()` with a `storageLoaded` guard; module-level init call updated. |
| `frontend/src/lib/components/business/PlannerWorkspace.svelte` | Full host rewrite: "Planner" brand, subtle "On this device" locality pill (no loud LOCAL badge), segmented tabs, working **New ▾** menu (calendar/board/journal/projects), honest non-zero-only stats strip (Overdue/Today/This week/Events), in-surface resizable Tasks split (no longer hijacks `layoutStore.rightPanelView`), `?view=` deep-link support via `sessionStorage`. |
| `frontend/src/lib/components/business/PlannerWorkspace.css` | Full rewrite: scoped `--biz-*` → Wabi semantic-token alias shim (indigo/glass), header/tabs/menu/stats/task-split styles, all controls ≥36px. |
| `frontend/src/lib/components/business/Calendar.svelte` / `CalendarImpl.svelte` | New `embedded` + `addSignal` props; hosted mode hides duplicate page title; icon chevron buttons with aria-labels; day cell shows up to 3 event pills + "+N more" overflow chip. |
| `frontend/src/styles/components/calendar-view-part1.css` | `.embedded` header layout, 36px icon/today/add buttons, `.more-events` chip. |
| `frontend/src/lib/components/business/KanbanBoard.svelte` / `KanbanBoardImpl.svelte` | New `embedded` + `addSignal` props; hosted mode hides duplicate "Kanban Board" title; filter selects get aria-labels; embedded-only **Add Task** toolbar button. |
| `frontend/src/styles/components/kanban-board-part1.css` | `.embedded` header, `.settings-btn.active`, `.kanban-add-btn` (≥36px), card title/description clamp + hover edit hint, `.empty-column` interactive CTA, `.column-management` calm pass. |
| `frontend/src/styles/components/kanban-board-part2.css` | Focus rings + submit-button glow now `color-mix` on `--biz-accent` (indigo in Planner) instead of hardcoded orange. |
| `frontend/src/lib/components/business/KanbanBoardColumns.svelte` | Card hierarchy (title row + hover pencil hint), 2-line clamps, empty column is a CTA button calling `openAddModal(column.id)` (disabled in read-only). |
| `frontend/src/lib/components/business/KanbanTaskModal.svelte` | `role="button"` → `role="dialog"` + `aria-modal="true"` + dynamic `aria-label` + `tabindex="-1"`. |
| `frontend/src/lib/components/business/DiaryView.svelte` | New `embedded` + `addSignal` props; single "+ New Entry" primary CTA; removed redundant third empty-state button. |
| `frontend/src/styles/components/diary-view-part2.css` | `.embedded` welcome-header layout, 36px primary button. |
| `frontend/src/lib/components/business/ProjectsView.svelte` | New `embedded` + `addSignal` props (deep-link "New project" path); `class:embedded` root. |
| `frontend/src/routes/business/+page.svelte` | Real redirect: `openPlannerSurface()` + `window.location.replace('/')`, honors `?view=calendar|board|journal|projects` via `sessionStorage`. |

## Phase-by-phase status

- **Phase A (honesty + host):** done. New works per tab, stats show nothing when everything is zero, store hydrates on mount (`reloadFromStorage`), Tasks lives in an in-surface split, "On this device" replaces the LOCAL badge, and the kanban auth header was already the corrected `Authorization: Bearer ${token}` form at review time (nothing to fix).
- **Phase B (tokens):** done. `.planner-surface` aliases all `--biz-*` → Wabi semantic tokens. `theme.css`'s global `:root` `--biz-*` block is only imported by `BusinessSurface.svelte`, which nothing currently imports, so it no longer leaks into the main app.
- **Phase C (kanban):** done. Single toolbar, columns `flex: 0 0 280px` with horizontal scroll (pre-existing and correct), card redesign + hover edit hint, empty-column CTA, modal dialog semantics + indigo focus rings, calm column-management UI.
- **Phase D (calendar/journal):** done. `embedded` compact toolbars, icon chevrons, "+N more" overflow, single journal CTA. Delete already sits behind a `confirm()` gate.
- **Phase E (projects/tasks):** done. New-project path via signal; TaskPanel in-surface split with resize; import/export not re-added (not reachable from main chat shell — flagged as a gap).
- **Phase F (parity):** done for F1 (redirect + `?view=` deep link). F2/F4 deferred; F3 (guest/privacy) unchanged as `BusinessSurface` remains for guest flows.

## Known gaps / follow-ups

- Visual pass in a real browser (headless Chromium crashes on Wabi).
- Import/export entry under Planner (E3) not wired — `exportBusinessData`/`importBusinessData` still live in `businessPageHelpers` behind `BusinessSurface`.
- `BusinessSurface.svelte` / `routes/business/businessPage.css` / `lib/business/theme.css` kept as donor/guest assets; can be pruned (F2) once guest flows are confirmed.
- Chat-hosted Planner (`Chat.svelte` mount) is untested visually.

## Verification

- `bun run check`: 0 errors/warnings in all touched files (remaining 6 errors are the pre-existing `bun:test` missing-module baseline).
- `STATIC_BUILD=1 bun run build`: passes.
