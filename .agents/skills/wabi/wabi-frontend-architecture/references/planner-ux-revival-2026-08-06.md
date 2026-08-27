# Planner UX revival (2026-08-06)

Full critique: `docs/plans/2026-08-06-planner-ux-critique-and-revival.md`.

## Dual surface map

| Path | Host | Reality |
|------|------|---------|
| Main app center stage | `PlannerWorkspace.svelte` | Thin: tabs + dead New + fake stats |
| `/business` | `BusinessSurface.svelte` | Full hub: real stats, tasks, import/export |

Children shared: Calendar, KanbanBoard, DiaryView, ProjectsView (`lib/business/*` localStorage).

## P0 honesty (Phase A)

1. Wire **New ▾** by active view (event / task / journal / project).
2. Stats from `overdueTodos` / `todaysTodos` / week helpers — **hide zeros**.
3. `loadFromStorage` / business store init on Planner mount.
4. Tasks: in-planner split preferred over bare `rightPanelView: 'tasks'`.
5. Fix Kanban `Authorization: Bearer ${authToken}` user fetch.
6. Demote LOCAL badge.

## Token unify (Phase B)

- Shim `--biz-*` → main tokens under `.planner-surface`.
- Drop default orange planner accent; use `--accent-primary-color`.
- Scope `lib/business/theme.css` under surface root (no global `:root` bleed).

## Kanban revival (Phase C) — highest emotional ROI

- One toolbar: Board · project filter · priority · Columns · + Task.
- Columns min-width ~280px, horizontal scroll.
- Cards: title + meta; no button soup on face.
- Empty column ghost “Add task” + drag target.

## Anti-squish law

- ≥36px hit targets; one primary per toolbar.
- Max one app header + one local toolbar.
- No dead controls; no four zero metric pills.

## Verify

- Real stats; New works every tab; board drag/filter/CRUD.
- No toolbar button <36px; no bare `--biz-*` outside planner surface.
- Real browser eyeball (headless Skia useless for Wabi).
- `/business` must not land on a worse shell than main Planner.
