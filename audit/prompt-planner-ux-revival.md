# Wabi Planner UX Revival — Phases A–F (OpenCode)

You are implementing a thoughtful UX revival of Wabi's Planner workspace so it feels as complete as the old `/business` hub, but unified with main Wabi chat chrome.

## Source of truth
Read fully first:
- `docs/plans/2026-08-06-planner-ux-critique-and-revival.md`
- `frontend/src/lib/components/business/PlannerWorkspace.svelte`
- `frontend/src/lib/components/business/BusinessSurface.svelte` (donor density)
- `frontend/src/lib/business/store.ts` + `pageHelpers.ts`
- Kanban/Calendar/Diary components under `frontend/src/lib/components/business/`
- CSS: `PlannerWorkspace.css`, `frontend/src/lib/business/theme.css`, `frontend/src/styles/components/kanban-board-*.css`, `calendar-view-*.css`, `diary-view-*.css`

## UX principles (non-negotiable — think like a careful product designer)
1. **Space-first.** No wasted rows of zero stats. No double page titles. Nested headers max = Planner chrome + one local toolbar.
2. **No lying UI.** Never ship a button that does nothing. Never show four "0" metric pills.
3. **Anti-squish.** Toolbar buttons min-height 36px; padding ≥ 0.5rem 0.85rem for text buttons; icon hit targets 36×36; icon+label with gap.
4. **One primary CTA per toolbar.** Secondary quiet. Destructive behind confirm.
5. **User mental model:** "Planner" inside chat — not a second "Business Hub" brand. Steal density from BusinessSurface; don't clone isolation.
6. **Kanban should feel revived** — as good or better than old /business board, but indigo/Wabi tokens not foreign orange admin.
7. **Journal:** one primary "New entry" path, not three long CTAs for the same thing.
8. Prefer calm, readable hierarchy over more chrome.

## ALLOWED paths only
- `frontend/src/lib/components/business/**`
- `frontend/src/lib/business/**`
- `frontend/src/lib/components/business/PlannerWorkspace.css` (and sibling business CSS)
- `frontend/src/styles/components/kanban-board*.css`
- `frontend/src/styles/components/calendar-view*.css`
- `frontend/src/styles/components/diary-view*.css`
- `frontend/src/lib/plannerWorkspace.ts`
- `frontend/src/routes/business/**` (redirect parity only)
- `frontend/src/lib/components/MainLayout.svelte` ONLY if needed to mount TaskPanel / planner right column correctly
- `docs/plans/2026-08-06-planner-ux-critique-and-revival.md` (append short "Implemented" notes at bottom if useful)
- Write report: `docs/plans/2026-08-06-planner-ux-implementation-report.md`

## FORBIDDEN
- Do NOT touch: settings/*, login/*, theme/palettes (outside planner), messageStore, socket core, backend Rust, docker, AdminWorkspace, data/, packages/wabi-protocol
- Do NOT commit or push
- Do NOT run deploy
- Do NOT use `export let` / `$:` — this codebase mixes Svelte 4 and 5; **match the style of the file you edit**. PlannerWorkspace currently uses Svelte 4 `export let` — OK to keep consistent within that file. Do not convert entire trees to runes unless already runes.
- Do NOT switch vite minifier
- Do NOT invent backend APIs — business data is localStorage via `lib/business`

## Phase A — Honesty (do first)
1. On Planner mount, ensure business store is loaded (`loadFromStorage` / existing init).
2. Wire **New** as a dropdown or context-aware primary:
   - calendar → open add event (expose API from Calendar if needed: `export function openAdd()` or bindable/callback props)
   - board → open add task modal
   - journal → go to today / new entry
   - projects → open create project
3. Stats from real stores (`overdueTodos`, `todaysTodos`, calendar helpers). **Hide zero badges** or one compact line only when non-zero.
4. Task panel: mount `TaskPanel` inside planner surface as a resizable/split right column (preferred) rather than empty rightPanelView.
5. Demote or remove loud "LOCAL" badge — subtle "On this device" is OK.
6. Fix `KanbanBoardImpl.svelte` Authorization header if corrupted to: `` Authorization: `Bearer ${authToken}` `` (never `***`).

## Phase B — Tokens
1. Scope business theme under `.planner-surface` (and keep `.business-surface` / `.dashboard` if needed).
2. Alias `--biz-*` → main Wabi tokens on `.planner-surface` so indigo/glass wins.
3. Planner chrome accent = `var(--accent-primary-color)` not hardcoded orange.
4. Reduce global `:root --biz-*` bleed where safe.

## Phase C — Kanban revival (highest emotional ROI)
1. Single board toolbar when embedded: filters + columns + +Task; no duplicate "Kanban" page title if Planner says Board.
2. Column min-width ~280px, horizontal scroll, no squished headers.
3. Cards: title hierarchy, meta row (priority · due · assignee), actions on hover/menu not a button wall.
4. Empty column CTA + clear drop target.
5. Task modal inputs polished (focus rings, spacing).
6. Column management calm pass.

## Phase D — Calendar + Journal
1. `embedded` prop (or detect host): compact toolbar only.
2. Calendar: chevrons as proper icon buttons; day cell max ~3 events + "+N".
3. Journal: one primary New; simplify Edit/Delete; delete confirm.

## Phase E — Projects + Tasks
1. Projects New path works; empty state clear.
2. TaskPanel usable in split; filters readable.

## Phase F — Parity
1. `/business` redirects or thin-wraps into main Planner with `?view=` if easy without breaking guest flows.
2. Prefer not deleting BusinessSurface yet if guest still needs it — at least make Planner the better path.

## Implementation tips
- Reuse BusinessSurface patterns for quickStats (`computeQuickStats`).
- Prefer small surgical APIs: e.g. bind `openAddEvent` callbacks rather than rewriting CalendarImpl entirely.
- Match existing class names where CSS already exists; extend CSS thoughtfully.
- After edits run: `cd frontend && bun run check` — baseline has ~6 bun:test errors; introduce ZERO new errors in planner files.

## Done criteria
- Planner New works per tab
- Stats honest
- Board looks intentional and un-squished
- Tokens not fighting main app
- Report written at `docs/plans/2026-08-06-planner-ux-implementation-report.md` listing files changed and remaining gaps
- No commits

Start implementing now. Prioritize A → B → C → D → E → F. If time-constrained, finish A+B+C fully before partial D/E/F.
