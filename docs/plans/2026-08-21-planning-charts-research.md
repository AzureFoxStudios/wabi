# Planning Charts Research: Trello/Monday cross-examined against Wabi Planner — 2026-08-21

Question Ronin asked: what would help *planning* — Gantt (is it still working?), burndown (how healthy is it?), a dashboard for charts — **without turning Wabi into forms/files/bureaucracy**. Sources: live code audit of `GanttChart.svelte`, `ProjectDetail.svelte`, `store.ts::generateBurnChartData` + product knowledge of Trello/Monday/Linear (web search unavailable this session — Firecrawl credits; competitor claims are from training knowledge, patterns are stable, but verify specifics before quoting them as current fact).

---

## 1. Ground truth: what exists in Wabi today

### Burndown (`ProjectDetail.svelte` → Analysis tab)
- SVG chart, 3 lines: remaining (red), completed (green), ideal (dashed). Data from `generateBurnChartData()`.
- **How it actually computes:** per-day loop over the range; "points" = estimated hours (fallback **1h per task with no estimate**); `completedAt` timestamps drive the burn.
- Verdict: the math is sound and it DOES work. Real weaknesses below.

### Gantt (`GanttChart.svelte`)
- Works, renders project rows × month columns, bars positioned by % of timeline span, sprint markers as thin vertical lines, color = progress bucket (red<50 / amber<75 / blue<100 / green=100).
- Verdict: functional but shallow — see gaps below.

### What does NOT exist
- No cross-project dashboard. Charts are buried inside one project's detail view (Projects → select project → Analysis tab).
- No workload/by-assignee view anywhere.
- No velocity/aggregate trend.

## 2. Findings — where each chart falls short vs Trello/Monday/Linear

### F1 — Burndown lies when scope is static-only (correctness)
`generateBurnChartData` treats total scope as flat across the whole range and only subtracts on `completedAt`. Tasks added mid-sprint don't dent the line at their add-date; tasks deleted vanish retroactively. Classic burndown needs scope-in events too (Monday's widgets do this; Linear's cycle charts do this). Also: tasks with no estimate count as 1h — fine — but the legend says "Remaining/Burned Time", which reads like *time*, while x-axis is days and y is hours. Mixed metaphor.

### F2 — Burndown defaults to a range you didn't choose (UX)
Range = active-or-next sprint if one exists, else project start→target end (or start→today). If there are no sprints and no dates, the "chart" can be a single-day sliver or a multi-year smear (loop caps nothing; a 2-year project = ~730 points, fine perf-wise, useless visually). No range picker. Monday always shows a period control on chart widgets.

### F3 — Gantt has no dependencies and no drag (capability gap, acceptable for now)
Trello Timeline/Monday Gantt both let you drag bar edges to move dates. Wabi's bars are read-only with hover scale. That's fine to keep — BUT the header literally says "Drag bars to see project deadlines" which is false copy. Either make bars draggable or fix the copy.

### F4 — Gantt shows projects only, not tasks (the real planning gap)
A Gantt of 3 project-level bars answers almost no planning question. Trello Timeline draws cards/tasks; Monday draws items. Wabi has all the data (`dueDate` on every todo) — tasks with due dates could render as thin bars under their parent project row, colored by priority, avatar at the right edge (we just shipped PlannerAvatar). This is the single highest-value planning upgrade available with zero new data model.

### F5 — Sprint markers are decorative (small)
`.sprint-marker` = 2px white line at sprint *start* only, height overflows weirdly (`top:-12px`). Should be a shaded band start→end with the sprint name on hover. Cheap fix.

### F6 — Everything is buried (IA problem — the dashboard question)
To answer "how are all my projects doing?" you must click into each project. Monday's core insight is exactly the dashboard: pick widget type, pick board(s), done. Wabi already has every primitive needed:
- A new **Insights view** (5th tab in PlannerWorkspace: Calendar | Board | Journal | Projects | **Insights**) hosting:
  - **All-projects Gantt** (GanttChart already supports `selectedProjectId=null` → root projects!)
  - **Cross-project burndown** (aggregate by date across all todos, same generator minus projectId filter)
  - **Status donut / column summary** (count by status — Monday's most-used widget)
  - **Workload bars per assignee** (open tasks per person, using plannerUsers store we just shipped)
  - **Overdue trend** (overdue count by week — simple bar)
- Zero backend, zero new data model. All derivable from existing stores. This IS the dashboard, without forms/files/bureaucracy — it's read-only aggregation, not data entry.

### F7 — Legend/copy nits
"Remaining Time"/"Burned Time" should be "Remaining (h)"/"Completed (h)". Green line labeled Burned is confusing next to red Remaining. Ideal-line label good.

## 3. The anti-bureaucracy filter (Ronin's constraint, applied)

Every recommendation passes this test: **does it require the user to fill in more fields?**

| Recommendation | New fields required? | Pass? |
|---|---|---|
| Insights tab w/ derived charts | 0 — derives from existing data | ✅ |
| Task bars in Gantt | 0 — dueDate already optional & exists | ✅ |
| Burndown range picker | 0 | ✅ |
| Scope-aware burndown (add events) | 0 — createdAt already tracked | ✅ |
| Drag-to-reschedule gantt bars | 0 — writes existing dates | ✅ but P2 |
| Dependencies (blocks) | ❌ new field + UI + mental model | ⛔ defer |
| Milestones | ❌ new entity | ⛔ defer |
| Time tracking / logged hours | ❌ new concept entirely | ⛔ never |
| Custom fields/forms | ❌ the bureaucracy itself | ⛔ never |

## 4. Recommended build order (task list only, no estimates)

1. **P0 — Insights tab** in PlannerWorkspace (5th pill): All-projects Gantt + status summary chips + workload-by-assignee bars + overdue list. Reuses everything shipped yesterday.
2. **P0 — Task bars in Gantt**: under each project row, one thin bar per todo with a dueDate (priority color + PlannerAvatar). Fixes F4, kills the "gantt is useless" feel instantly.
3. **P1 — Burndown honesty pass**: scope-in steps (createdAt), range picker (Sprint ▾ / 30d / 90d / Project), fixed labels ("Remaining (h)" / "Completed (h)").
4. **P1 — Cross-project burndown** widget on Insights (same generator, aggregate mode).
5. **P2 — Sprint bands** replace marker lines; **fix "Drag bars" copy** or implement drag (write startDate/targetEndDate).
6. **Explicit non-goals:** dependencies, milestones-as-entity, time tracking, custom fields, portfolio "views" system. These are the bureaucratization path.

## 5. Answers to Ronin's three direct questions

- **"Gantt — not sure if that's still working?"** Yes, it works (renders from live stores), but it's project-bars-only with a false "drag" claim. Worth keeping; worth upgrading to show tasks.
- **"Burndown — how well is it doing?"** Math works, presentation misleads: static-scope assumption, uncontrolled range, mixed hour/time labels. Needs an honesty pass, not a rebuild.
- **"Dashboard?"** Not a separate surface — a fifth **Insights** tab inside Planner keeps one mental home for planning, costs zero new data, and directly mirrors what Monday gets right (charts-first aggregation) without what makes Monday heavy (widget builders, form configs).

*Honesty note: competitor behavior cited from model knowledge (Trello Timeline/Dashboard, Monday widgets, Linear cycles), not live-checked this session — web tools were unavailable. The Wabi-side audit is fully code-verified.*
