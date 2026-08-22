# Kill the nesting doll? Channel-as-Project analysis — 2026-08-21

Ronin's question: `/business` invented Projects (→ sub-projects → tasks) to organize work *inside one page*. But Wabi now **has channels** — and Lore "Project" channels already exist. So: is `channel → project → sub-project` a nesting doll we should collapse into **one channel = one project**?

---

## 1. Verified current state (the collision is real)

Three different things are all called "Project" right now:

| Surface | What it is | Backing |
|---|---|---|
| **Project channels** (`type: 'lore'`) | Repo workspace per channel — Files/Chat toggle, history, review | Server Lore addon |
| **Planner → Projects tab** (`ProjectsView.svelte`) | Business-entity projects with sub-project tree + sprints + Gantt/burndown | localStorage `business_data` |
| **WorkspaceViewBar "Project" pill** | Opens the Lore hub for the current lore channel | — |

And the two project systems don't know about each other:
- `Project.channelId` does not exist. Nothing in `lib/business/*` reads `$currentChannel`. Zero references.
- Planner content is device-local; Lore channel repos live on the server. Different universes.
- A user creating a "New Project Channel" gets a repo; creating a planner "New Project" gets a local planning entity with a sub-project button. Same word, unrelated machinery.
- Sub-project nesting exists but is nearly vestigial: `parentId` used only by `ProjectSidebar.getSubProjects()`, the ProjectModal parent picker, breadcrumb in ProjectDetail, and root-filtering in GanttChart.

So yes — the doll is real: **Channel ▸ (lore) repo + Planner ▸ project ▸ sub-project ▸ tasks**, where tasks can point at a project that has no relation to the channel you're in.

## 2. The design call

**Yes: adopt channel = project as the primary mental model — but as a LINK, not a merge.**

Two reasons not to hard-merge:

1. **Planner must stay usable without a channel context.** Calendar/Board/Journal are personal surfaces ("On this device"). Personal planning (groceries, life stuff) has no channel. If projects require a channel, personal planning breaks.
2. **Lore repos are heavyweight and optional.** Not every project needs versioned files. Forcing every plan to create a `.lore` repo IS the bureaucracy Ronin wants to avoid.

The move that kills the nesting doll without either cost:

> **Add optional `channelId?: string` to the Project contract. When set, the Planner scopes to it; when unset, the project is personal/global exactly as today.**

- Channel = project becomes *literally true* wherever a project is channel-linked.
- Sub-projects become **rare and explicit**: keep the capability (real org need: v1/v2, workstreams), but the default flow creates flat channel-scoped projects. No channel → no tree pressure.
- The sidebar tree inside Planner collapses from "all my nested business entities" to "projects for what I'm looking at (+ personal)".

## 3. What this buys concretely

1. **One word, one meaning.** "Project" = the thing in your sidebar. Its planning surface (board filtered by project) lives in the Planner pill; its repo surface lives in the same channel's Files view. No second taxonomy.
2. **Kanban auto-scope:** opening Planner while in a channel-linked project could default the board filter to that project (opt-in toggle, not forced).
3. **Gantt/burndown get their missing context for free:** charts are per-project; with channel=project the question "how is THIS channel's project doing" has an answer one pill away.
4. **Migration is data-only:** backfill `channelId` by matching names (project name == channel name) or leave null; nothing breaks because the field is optional.

## 4. What I'd explicitly NOT do

- ❌ Hard-delete `parentId`/sub-projects now — it's cheap to keep, and flattening existing trees is destructive. Revisit after channel-linking proves out.
- ❌ Make Lore repo creation automatic when linking a channel to a project — link first, repo optional ("Set up folder" flow already exists for that).
- ❌ Move planner storage per-channel server-side yet — that's the deferred snapshot-routes slice; channelId is just the pointer that makes that slice trivial later (`GET /api/planner/{channel_id}/snapshot` maps 1:1).
- ❌ Rename anything user-facing again — "Project" stays; we're unifying meaning, not churning labels (the last relabel was days ago).

## 5. Task list if approved (small, frontend-only)

1. Contract: optional `channelId?: string` on Project (+ validation passthrough).
2. ProjectModal: optional "Linked channel" select (channels list; none = personal).
3. ProjectsView: scope indicator chip when current channel has a linked project; board/project filter suggestion.
4. KanbanBoardImpl: honor a `projectFilterSignal` so channel-context scoping is one prop away.
5. Migration helper script: match-by-name backfill (dry-run first).

Non-goals: deleting sub-projects, auto-repos, server-side per-channel storage (deferred slice), renames.

## Verdict

Different channels being different projects is **right as the default shape**, and the nesting doll dissolves into: channel (identity + conversation + optional repo) ▸ linked planner project (board/calendar/charts). Sub-projects survive as an explicit edge case, personal projects survive for non-channel life planning, and nothing user-facing gets renamed.
