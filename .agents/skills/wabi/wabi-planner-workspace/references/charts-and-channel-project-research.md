# Planning charts + channel-as-project research (2026-08-21)

Condensed from two committed repo docs (SoT copies):
`wabi/docs/plans/2026-08-21-planning-charts-research.md` and
`wabi/docs/plans/2026-08-21-channel-as-project.md`.
Read this reference before any Planner charts / project-taxonomy work.

## Burndown audit (`ProjectDetail.svelte` → Analysis tab; `store.ts::generateBurnChartData`)

- Math is sound: per-day loop, subtracts `estimatedMinutes/60` on `completedAt`, stable 1h fallback per unestimated task.
- **Lies to avoid re-introducing:** scope treated as static forever (tasks added mid-range don't dent the line at their createdAt — fix = scope-in steps); range auto-picked (active-or-next sprint, else start→target/end) with no user control; legend says "Remaining/Burned Time" while y=hours, x=days. Correct labels: "Remaining (h)" / "Completed (h)".

## Gantt audit (`GanttChart.svelte`)

- Works: rows × month columns, %-positioned bars, progress-bucket colors (<50 red, <75 amber, <100 blue, 100 green).
- Gaps: **project bars only** — no task rows even though every todo has optional `dueDate`; header falsely claims "Drag bars" (read-only, hover-scale only); `.sprint-marker` = decorative 2px line at sprint *start* with weird `top:-12px`; supports all-projects mode already via `selectedProjectId=null` (root projects).
- Highest-value upgrade: thin task bars under each project row (priority color + PlannerAvatar at bar edge). Zero new data model.

## Insights tab design (approved direction, not built)

Fifth pill in PlannerWorkspace tabs. Widgets, all derived read-only:
1. All-projects Gantt (reuse component as-is).
2. Status summary chips (count by TodoStatus).
3. Workload-by-assignee bars (plannerUsers store).
4. Overdue list / trend.
5. Cross-project aggregate burndown (same generator minus projectId filter).

**Anti-bureaucracy filter (Ronin, standing):** no feature that requires new fields or entities. Permanent non-goals: dependencies, milestone entities, time logging, custom fields, portfolio view systems. Derived-read-only passes; data-entry fails.

## Channel-as-project decision

Verified collision: three unrelated "Project" surfaces — lore Project channels (`type:'lore'`), Planner Projects tab (localStorage), WorkspaceViewBar pill — zero linkage (`Project.channelId` absent; `lib/business/*` never reads `$currentChannel`; `parentId` sub-projects nearly vestigial).

Decision: **link don't merge.** Optional `channelId?: string` on Project contract.
- Set → Planner scopes to that channel (board filter prop, per-channel charts).
- Unset → personal/global exactly as today (personal planning has no channel; must survive).
- Sub-projects demote to explicit edge case; keep `parentId`, never delete existing trees.
- NO user-facing renames (Will relabeled Code→Project days prior).
- Future payoff: `channelId` = key for deferred `/api/planner/{channel_id}/snapshot` server slice.

Implementation checklist when approved (frontend-only): contract+validation passthrough; ProjectModal "Linked channel" select; ProjectsView scope chip for current channel; Kanban filter-signal prop; name-match migration script (dry-run first).

## Competitor notes (model knowledge, web search unavailable that session)

- Trello Timeline/Dashboard & Monday widgets: charts-first aggregation over boards is the core dashboard value; their weight comes from widget builders/config forms — Wabi skips that by deriving everything read-only.
- Linear cycles: burndown includes scope-change events, not just completions.
- Verify specifics live before quoting as current product fact.
