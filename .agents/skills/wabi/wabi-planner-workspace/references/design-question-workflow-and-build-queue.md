# Design-question workflow + pending build queue (2026-08-21 late)

## How to answer Ronin's product-design questions

When Ronin asks "research X vs Trello/Monday", "is there a world where…", or any product-design question:

1. **Audit live code FIRST** — grep actual stores/components before opining. Session proof (2026-08-21): burndown math works but assumes static scope; Gantt header claims "Drag bars" and nothing is draggable; `Project.channelId` did not exist while three unrelated surfaces were all named "Project" (lore Project channels `type:'lore'`, Planner Projects tab, WorkspaceViewBar pill).
2. Competitor cross-exam from product knowledge is fine — **disclose when web search was unavailable** instead of implying live verification.
3. Answer ships as `docs/plans/<date>-<topic>.md` with this fixed shape:
   - verified current-state table
   - design call
   - explicit NOT-doing list (with reasons)
   - task-only list (never estimates)
   - direct answers to his exact questions
   - source-honesty note
   Commit path-scoped immediately. Mirror a condensed version into `references/charts-and-channel-project-research.md`.
4. **Anti-bureaucracy filter** on every recommendation: does it require NEW fields/forms from the user? Zero-new-field passes (e.g. Insights tab derives read-only from existing stores); dependencies / milestone entities / time tracking / custom fields never pass. This is Ronin's standing constraint: planning must not become forms/files/bureaucracy.

## Approved directions (docs committed 2026-08-21: `4b338f1`, `8f67c74`, `9b1841e`; implementation queued)

1. **Insights tab (P0)** — fifth pill in PlannerWorkspace; all-projects Gantt + status chips + workload-by-assignee + overdue list, all derived read-only.
2. **Task bars in Gantt (P0)** — thin per-todo bars under project rows (priority color + PlannerAvatar); zero new data model (`dueDate` exists).
3. **Burndown honesty pass (P1)** — scope-in steps from createdAt, range picker, labels "Remaining (h)"/"Completed (h)".
4. **Channel-as-project** — optional `Project.channelId`; LINK don't merge. Personal projects and repoless projects must survive; sub-projects demote to explicit edge case (keep `parentId`, never delete existing trees); NO user-facing renames. Future payoff: channelId is the key for the deferred `/api/planner/{channel_id}/snapshot` slice.
5. **Lore × planning** — consolidate citation shape into shared `LoreCitationRef {channelId, path, startLine?, endLine?, label?}` in businessContracts (MessageContent + LoreCitationChip duplicate it today); optional `attachments?` on Todo/CalendarEvent; "Plan task from this" action in Lore file viewer/blame. Calendar commit heat-dots AFTER channelId lands (data already flows via `getLoreRepoHistory`). Standing rule: **link, never depend** — everything behind `hasAddonCapability('lore')`; Planner fully functional with lore absent.

SoT docs in repo: `docs/plans/2026-08-21-planning-charts-research.md`, `docs/plans/2026-08-21-channel-as-project.md`, `docs/plans/2026-08-21-lore-planning-integration.md`.

## User style signal

*"you can do so much more"* = run the full rich pass unprompted (he then lists the obvious richer items himself — avatars everywhere, dock panel). Treating an open-ended polish ask minimally is the failure mode; "whatever looks prettiest and makes most logical sense" delegates taste authority to you.

## Svelte 4 traps hit this session (business tree is Svelte 4 — match it)

- `export let x?: T` optional markers are INVALID outside runes `$props()` — hard parse error. Use `export let x: T = defaultValue`.
- A `key={epoch}` prop does nothing on a Svelte component (React thinking). Force remount with `{#key epoch}<Child … />{/key}` — shipped for TaskPanel `initialFilter` re-mount from stat pills.
- Stale diagnostics: svelte-check/LSP can emit phantom `has no exported member` immediately after an export is added — verify with a typescript AST grep before "fixing". Errors from PEER dirty files (`callingWabidb.ts` relay scope) appear in your runs — `git status`/`git diff` to attribute before touching anything. Vite build does NOT typecheck, so peer-file type errors don't block STATIC_BUILD verification.

## Registry-panel recipe (validated twice now)

Adding a right-dock panel = exactly 4 touches: manifest in `workspacePanels.ts` (+ icon union + KNOWN_COMPONENT_KEYS), glyph in `WorkspacePanelIcon.svelte`, branch in `WorkspacePanelHost.svelte`, compact/density prop on the panel component (+ CSS appended to its global stylesheet — those CSS files are imported by styles.css so the dock inherits them free). Applied for lore Code panel, then again for planner Tasks panel.
