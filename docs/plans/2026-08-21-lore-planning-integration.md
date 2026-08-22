# Lore × Planning integration — is it worth it? — 2026-08-21

Ronin's question: Lore is an addon — does it make sense to wire lore functions into calendar/todo/etc.? "Connecting planning to all of the workspace… quality of life over so many things."

**Verdict: yes — link, never depend.** The Planner must run perfectly with lore disabled; everything lore adds is additive and capability-gated. Done that way it's cheap, because most of the plumbing already exists.

---

## 1. What's already built (verified in tree)

The expensive parts of this integration are done:

- **Capability gate:** `hasAddonCapability('lore')` probes `GET /api/addons` with sane cache semantics (positive sticky, negative re-probed) — already used by ChannelSidebar to show/hide the Project chip. Planner integration uses the same gate.
- **Citations are a real system, not an idea:** `^c/` in chat produces citation refs `{path, startLine?, endLine?, channelId}` (parsed in `MessageContent.svelte`), rendered as chips with **Pinned | Tracking** modes and **drift detection** (Current / Drifted / Missing) via `LoreCitationChip`, collected in a registry panel.
- **Commit history API:** `getLoreRepoHistory(token, channelId)` → `LoreRevision {hash, message, authorId, timestamp}`. LoreChannelShell already derives an activity feed AND a push-calendar heatmap from exactly this data.
- **Signed file URLs** (`getSignedLoreUrl`) mean a deep link from a task to `file.ts:42` needs no token plumbing in the chip itself.

Zero cross-references exist today between `lib/business/*` and lore/wiki — clean slate, no tangle to undo.

## 2. The integrations, ranked by value ÷ cost

### P0-A — Task/file citations (todos + events carry lore references)
A todo "Fix auth redirect bug" links to `src/auth.ts:120`; clicking opens the Lore viewer at that spot. Reuse the existing citation shape verbatim:
- Contract: optional `attachments?: LoreCitationRef[]` on Todo (+ CalendarEvent later). New shared type `LoreCitationRef {channelId, path, startLine?, endLine?, label?}` — currently this shape is duplicated ad-hoc in MessageContent + LoreCitationChip props; consolidate it once in `shared/businessContracts.ts`.
- UI: attach row in KanbanTaskModal (paste `^c/path:12` or pick from recent files); chips on cards/detail views, lore-gated clicks.
- Anti-bureaucracy: attaching = one paste or two clicks. Zero required fields.

### P0-B — Inverse: "create task from this file/line"
In the Lore file viewer / blame view, a small "Plan task from this" action pre-fills a todo with title from the line context and the citation attached. This is the Discord-grade QoL move: work discovered while reading becomes trackable without context switch.

### P1 — Repo commits on the Calendar (needs channel-as-project first)
Overlay per-day commit counts as subtle markers under a channel-linked project's days — "3 commits" heat dots beside events/tasks. All data exists (`LoreRevision.timestamp`); rendering slot exists (`eventsByDay` map pattern in CalendarImpl). **Blocked on** the optional `Project.channelId` link (previous doc) — without it the calendar can't know which repo feeds which month. Sequence: channelId slice → this.

### P1 — Burndown honesty from real activity
Once linked, revision timestamps give burndown a second signal: "scope moved / work happened" vs only `completedAt`. Cheap annotation layer on the existing chart (commit ticks along the x-axis), not a new chart.

### Explicitly NOT now
- ❌ Planner state stored inside lore repos (planner stays device-local until the snapshot-routes slice).
- ❌ Generic "addon → planner extension" framework — premature abstraction; lore first proves the pattern.
- ❌ Auto-creating tasks from every commit (noise generator).

## 3. Sequencing

1. **Now (frontend-only):** shared `LoreCitationRef` type → todo attachments (P0-A + P0-B). No dependency on anything else; fully functional when lore is absent (chips simply render inert/grey).
2. **Next:** `Project.channelId` link (approved direction, prior doc).
3. **Then:** calendar commit overlay + burndown activity ticks ride on both.

## 4. Why this mirrors what makes Discord strong

Discord's power isn't any single feature — it's that every object cross-references every other object with zero ceremony: message→channel, message→user, thread→message. Wabi already has the objects (tasks, files, commits, channels); this pass adds the missing edges. Each edge is optional metadata on things you were creating anyway.
