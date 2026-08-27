---
name: wabi-planner-workspace
description: "Use when reviving or extending Wabi Planner UX."
version: 1.0.0
metadata:
  hermes:
    tags: [wabi, frontend, planner, kanban, ux]
    related_skills: [wabi-frontend-architecture, wabi-opencode-dispatch, wabi-frontend-polish]
---

# Wabi Planner Workspace

## When to use

- Planner pill / center-stage calendar, kanban board, journal, projects
- “Revive business hub” / make main Planner as good as `/business`
- Dead New button, fake zero stats, orange `--biz-*` bleed, squished toolbar buttons

## Dual surface (do not confuse)

| Path | Host | Role |
|------|------|------|
| Main app | `PlannerWorkspace.svelte` | **Real host** after 2026-08-06 A–F revival |
| `/business` | redirect → `openPlannerSurface()` + optional `?view=` | Alias only |
| Donor | `BusinessSurface.svelte` | Density reference; guest/export until confirmed unused |

Data: `frontend/src/lib/business/*` (localStorage). Children: Calendar, KanbanBoard, DiaryView, ProjectsView, TaskPanel.

## Contract after revival (do not re-stub)

1. **New split-button:** primary creates for *current* view; caret opens Event/Task/Journal/Project menu. Children use `embedded` + `addSignal`.
2. **Stats:** only non-zero pills (`overdueTodos`, `todaysTodos`, week, `upcomingEvents`).
3. **`reloadFromStorage()`** on mount (exported, idempotent).
4. **Tasks:** in-surface resizable `TaskPanel` — not bare `rightPanelView: 'tasks'`.
5. **Tokens:** `.planner-surface` shims `--biz-*` → main indigo; accent = `--accent-primary-color`.
6. **Kanban:** embedded toolbar, ~280px columns, empty CTA, dialog modal, `` Authorization: `Bearer ${token}` ``.
7. Entry: `ChatHeader` / `WorkspaceViewBar` pills — **not** a duplicate ChannelSidebar button.

## Anti-squish law

- Hit targets ≥36px; one primary CTA per toolbar
- Max one app header + one local toolbar when embedded
- No dead controls; no four zero metric pills
- Steal BusinessSurface **density**, not isolation/orange brand

## Svelte style

Business tree is still largely Svelte 4 (`export let` / `on:click` / `$:`) — **match the file**. Do not force a full runes rewrite mid-task.

## OpenCode pattern

- Prefer `opencode/deepseek-v4-flash-free`; Python subprocess prompt-as-arg; background + notify
- Attach: critique plan MD + PlannerWorkspace + BusinessSurface
- Allowed: `frontend/src/lib/components/business/**`, `lib/business/**`, kanban/calendar/diary CSS, `routes/business/**`
- Hermes verifies: path-scoped git, New primary not menu-only, Bearer via base64 if tools redact as `***`, `bun run check` + STATIC_BUILD
- Reports under `docs/plans/`, never `/tmp`

## SoT docs

- `docs/plans/2026-08-06-planner-ux-critique-and-revival.md`
- `docs/plans/2026-08-06-planner-ux-implementation-report.md`
- Broader shell: skill `wabi-frontend-architecture` (WorkspaceViewBar, softlock rules)

## Double-check bar (post-OpenCode, 2026-08-07)

OpenCode A–F is **necessary but not sufficient**. Hermes taste-pass verifies hierarchy, not re-token:

1. **No dual primaries** when `embedded` — hide child Add Event/Task/New Entry; host owns New.
2. **Contextual New** — `New Event|Task|Entry|Project`; caret = menu; Escape closes.
3. **Full-bleed board** — `.view-board { padding: 0 }`; columns ≥~280px.
4. **Journal** — short empty + one CTA; icon day chevrons + aria-labels.
5. **Assignees** — Bearer; array or `{users}`; Map lookup not `.find()` per card.
6. Concurrent wipe of host mid-pass → re-read for `newPrimaryLabel`/`view-board`/Escape; if wiped **whole-file rewrite**.

## Kanban "columns fall through the floor" — CSS cascade war (2026-08-08)

**Root cause:** TWO stylesheets define `.kanban-board` with conflicting layout and the WRONG one wins every load:

- `frontend/src/styles/components/kanban-board-part1.css` (~line 360): `.kanban-board { display:flex; flex-direction:row; flex-wrap:nowrap; width:max-content; min-width:100%; height:100% }` — the CORRECT horizontal spread.
- `frontend/src/styles/components/todo-list.css` (~line 160, legacy): `.kanban-board { display:grid; gap:1rem; flex:1; overflow-x:auto; min-width:0 }` — grid with NO `grid-template-columns` → every column stacks vertically (falls through the floor) — PLUS `@media (max-width:1200px/900px/600px) { .kanban-board { grid-template-columns: repeat(3|2|1, 1fr) !important } }` that stomp at every width.

`styles.css` imports `kanban-board.css` at line ~60 and `todo-list.css` at line ~77. Same specificity → **later import wins** → the legacy grid rule stomps the modern flex rule deterministically. This is NOT a cache/regression ghost — verify by grepping for both definitions:

```bash
grep -rn "\.kanban-board {" frontend/src/styles/   # must be only kanban-board-part1.css
grep -rn "kanban-board" frontend/src/styles/components/todo-list.css   # must be nothing
```

**Fix (landed 2026-08-08):** delete the legacy `.kanban-board`/`.kanban-column`/`.column-header`/`.count`/`.column-content` rules AND the three `!important` grid media queries from `todo-list.css` (keep rules genuinely used by the standalone todo list: `.todo-card`, `.list-view`, `.todo-table`, `.filters` for non-kanban). Also delete the `.card-title` legacy override risk (part1 defines its own). Rule of thumb: **kanban/planner DOM must be styled ONLY by `kanban-board-part1/2.css` + `PlannerWorkspace.css` — never re-declared in `todo-list.css` or `calendar-view*.css`.**

## Add-button consolidation (same ship)

Planner used to show THREE add entry points when embedded; now exactly one:
- Host `PlannerWorkspace.svelte` New split-button = the ONLY primary (its `triggerNew()` bumps `addSignal` for the active child).
- `KanbanBoardImpl.svelte`: removed the embedded-only `kanban-add-btn` ("Add Task" header button, was a duplicate). Per-column `+` buttons in `KanbanBoardColumns.svelte` are intentional — keep.
- The "Manage columns" button used a PLUS icon (`M12 5v14M5 12h14`) which read as another Add — swapped to a three-bars columns glyph (`M4 5h4v14H4zM10 5h4v14h-4zM16 5h4v14h-4z`). Gear stays for show/hide columns.
- `CalendarImpl.svelte`: `+ Add Event` hidden when `embedded` (host New covers it); header alignment already fine (`min-height:36px` on `.today-btn`/`.add-btn`, `align-items:center` on `.header-right`).

Verification: `grep -n "kanban-add-btn" KanbanBoardImpl.svelte` → nothing; planner shows exactly one primary New control per view.

## Local-first performance

See `references/local-first-performance.md`. Highlights: debounce localStorage 250ms + hide flush; `persistGate` batch apply; calendar day Maps; no fake kanban user dep; single-pass `todosByStatus`. Do not reintroduce sync save on every subscription.

## Server sync is DEAD on current backend (2026-08-21, verified)

`lib/business/sync.ts` targets `GET /api/business/get` + `POST /api/business/sync` + socket `business-data-updated`. **The Rust backend never had these routes** (verified across full git history incl. tags; `api/routes.rs` has no business nest). Default mode is `'manual'` and no UI ever called pull/push/triggerSync, so every browser keeps a private `localStorage["business_data"]` copy. Cross-device "calendar not in sync with kanban" = this, not a view bug; within one browser calendar+board share `$todos` fine.

Shipped honesty layer: `businessSyncAvailable` store + `probeBusinessSyncCapability()` (one GET probe at sync-init; 404 → device-local forever, zero doomed traffic). Planner header badge shows "On this device" vs "Synced to server" from the store; ⋯ menu has Export/Import JSON as the real cross-device bridge. When backend routes land, everything flips automatically.

Backend design (deferred): channel-scoped snapshot routes mirroring wiki — `GET/PUT /api/planner/{channel_id}/snapshot`, blob per channel in WDB. Channels-as-roadmaps: a Planner channel owns roadmap content; views stay personal/local.

## Sign-off contract (2026-08-21 overhaul)

The old checkbox ("Sign this X with my username") is GONE from all 5 forms. It silently coupled signing to `visibility` public/private — that coupling is removed (behavior change, disclosed).

- **Data:** `ItemSignature { by, name, at }` in `shared/businessContracts.ts`; optional `signatures?: ItemSignature[]` on Todo/CalendarEvent/DiaryEntry/Project/Sprint. Legacy `signedBy` still written = first signer's name (older-client mirror); validation has `sanitizeSignatures()`.
- **UI:** `SignatureRow.svelte` — chips (name + rel time, own chip removable) or quiet "+ Sign off"; legacy-only items render one read-only chip. Wired into KanbanTaskModal, CalendarEventModal, ProjectModal, SprintModal, DiaryView editor.
- **Display:** kanban card `✍ N` badge (`.card-signed` in kanban-board-part1.css), day-modal/diary show joined names.
- Form flow: host holds `draftSignatures` (+ `legacySignedBy` for read-only display), binds into modal, writes both fields on submit.

## Shell upgrades (same ship)

- `planner.activeView` persisted per device (views-local decision); deep-link still wins on mount.
- Header ⋯ overflow menu: truthful sync status line + Export JSON + Import JSON (E3 closed).
- Stat pills are buttons: Overdue/Today → Tasks panel pre-filtered (`initialFilter` prop + `{#key taskPanelEpoch}` remount); Week→upcoming filter; Events → Calendar tab.
- `TodoTaskModal.svelte` confirmed orphan (zero importers) but kept consistent with new signature props anyway.

## Avatars + Tasks dock (2026-08-21, second ship)

- **`PlannerAvatar.svelte`** — pfp with colored-initial fallback (xs 16 / sm 20 / md 28). Wired into: kanban card assignee chips, calendar day-grid task pills, calendar sidebar rows, day-modal task rows, TaskPanel assignee tags, SignatureRow chips. Replaces the flat color-dot chips.
- **`lib/business/plannerUsers.ts`** — ONE `/api/users` fetch per session (`ensurePlannerDirectory()`, idempotent) + `plannerUserById` derived Map + helpers. KanbanBoardImpl and TaskPanel previously each fetched on mount; both now mirror the shared store into their legacy `registeredUsers` shape.
- **Tasks right-dock panel** — registry pattern, exactly 4 touches: `'planner-tasks'` manifest in `workspacePanels.ts` (+ `'tasks'` icon union + KNOWN_COMPONENT_KEYS), tasks glyph in `WorkspacePanelIcon.svelte`, `{:else if panel.component === 'planner-tasks'}` branch in `WorkspacePanelHost.svelte`, and `compact` prop on TaskPanel (+ `.task-panel-container.compact` block at end of `task-panel.css`; that file is globally imported by styles.css so the dock gets it free).
- Gotcha: `svelte-check` may report a pre-existing error in the peer session's dirty `callingWabidb.ts` — scope-check before attributing; vite build does not typecheck.

## Channel-as-project + scopes + charts (2026-08-21, third ship — 5 commits)

- **`Project.channelId?`** (optional, additive): piped-to-channel vs personal. `plannerScopes.ts`: `PERSONAL_SCOPE`, `pipableChannels` (no DMs/threads), `projectsForCurrentChannel`, `filterTodosByScope`. ProjectModal has "Pipe to channel" select. No planner channel type ever — sharing rides membership.
- **Insights tab** (5th Planner pill, `InsightsView.svelte`): status chips, per-assignee workload bars w/ overdue marks, piped-plans list, all-projects Gantt (`selectedProjectId={null}` already worked). Read-only aggregation only.
- **Gantt rebuilt**: task due-date lanes under project rows (priority sticks + PlannerAvatar, cap 40), sprint shaded bands replace 2px markers, today line, false "drag" copy fixed, timeline bounds include dueDates.
- **Burndown honesty**: `generateBurnChartData(id,start,end,{scopeIn})` — scope grows at createdAt (legacy flat = `{scopeIn:false}`); range picker Auto/30d/90d; labels now "Remaining/Completed (h)".
- **Lore citations on tasks**: shared `LoreCitationRef` contract; `Todo.loreRefs`; KanbanTaskModal parses `ch_x ^c/path:line` paste notation; `LoreRefChips.svelte` renders mono chips on cards, opens signed lore URL. Fully inert without addon.

Gotchas hit: patch tool once corrupted businessContracts.ts via `@@` inside old_string (matched literally) — re-read after any suspicious diff. `currentChannel` store is a plain `string|null` id, not an object. Stale LSP repeatedly reported missing exports that exist (verify with grep before "fixing").

## Remaining gaps

- Import/export in Planner menu (E3)
- Real-browser visual pass
- Guest/privacy on BusinessSurface if still needed
- No list virtualization yet (hundreds OK)

## Overlap

Absorbed `wabi-planner-workspace-ux`. Shell/routing → `wabi-frontend-architecture`. This skill = host UX + business-store perf.

