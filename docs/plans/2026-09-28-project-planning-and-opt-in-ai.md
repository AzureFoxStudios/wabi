# Preserve the full Planner and add opt-in AI assistance

Date: 2026-09-28. Status: **implementation started**, authorized by Ronin's “let's get on it.”
No deployment or automatic provider spending is implied. The primary demonstration stays inside Wabi.

### First implementation batch

- My Planner Projects: searchable inventory, selected-project Overview with an optional project tree, optional Reports & sprints; task rollups include descendants and guard malformed cycles.
- Standalone Insights navigation removed; saved/deep-linked Insights opens Projects.
- Journal: full-width entry stream, sidebar only alongside a selected entry, clearer heading and functional new-entry editor. Markdown, tables, fenced code, safe text/code-file imports, image attachments and pasted images are supported; images-only entries can be saved.
- Shared board links: searchable card inventory with owner/status, removable selections and draft-preserving context previews. Existing untyped related-card contract remains.
- Personal channel references now explicitly say they do not publish/share the plan.
- Worker failure wording preserves the truth about earlier successful steps.
- Create requests stay in their originating view.
- Names/endorsements are explicitly independent of publication; “Add my name” replaces Sign off.

These are worktree changes. Shared calendar/journal/project entities, typed relationships, event rules, budgets and dynamic child runs remain outstanding. Local Planner data remains local.

## Product decision

A shared Project must support the original human planning use cases: an artist
organizing conventions, posters, print deadlines and decisions. AI is an optional
participant in that workspace. A navigation merge is not complete when it offers
a board but leaves calendar, journal and nested planning inaccessible from the
shared work. Preserve these capabilities and their existing personal versions.

There are three separate workstreams: full shared planning, usable relationships
between real entities, and optional event-triggered/delegated AI. None requires
building or training an AI model. Existing supported runtimes provide assistance.

## Current facts, checked against source and the browser

| Area | What exists | Gap in shared Project |
| --- | --- | --- |
| My Planner | Workspace menu → My Planner; Calendar, Board, Journal, Projects and Insights. Browser explicitly says saved on this device/account. | Separate local data, not published to a Project and not exposed to the new worker. |
| Calendar | Local events, recurring events and local task due dates. | Shared card due dates do not feed this calendar; no shared calendar tools. CalendarEvent has no project/task reference. |
| Journal | Dated local diary entries with text, images, tags and privacy fields. | No shared dated Project journal or AI journal tools. An Assistant-created wiki page titled “journal” is not this feature. |
| Projects and subprojects | Project.parentId and Add sub-project UI; project start/target dates. | Shared Project currently selects Planning/Lore channels, not a shared project/subproject tree. Existing sidebar renders three levels; descendant progress is not correctly rolled up by merely counting direct tasks. |
| Sprints and timeline | Project-linked sprint date windows/goals and local Insights/Gantt. | Sprints are not subprojects. Tasks do not currently carry sprint membership. Shared timeline/rollups need explicit data relationships. |
| Linked cards | Native multi-select populated with titles and stored as stable relatedTaskIds; server validates Project scope. | No useful searchable previews, reverse links or distinction between related, blocked-by and child-task relationships. |
| Assistant | Permission-checked shared cards/wiki, claims, run checkpoints and explicit human controls. | No calendar/journal/project-tree tools, event-triggered launch or dynamic child-run orchestration. Current contract allows one active run per Project. |

Source anchors: `WorkspaceViewBar.svelte:15`,
`business/PlannerWorkspaceContent.svelte:454`, `shared/businessContracts.ts:66`
(events), `:83` (journal), `:108` (parent projects), `:134` (sprints),
`business/ProjectSidebar.svelte:78`, `business/ProjectDetail.svelte:36`,
`business/CalendarImpl.svelte:144`, `ProjectWorkspace.svelte:52`,
`business/SharedProjectBoard.svelte:277`, and `scripts/wabi-project-worker.mjs:14`.
Component paths are relative to `frontend/src/lib/components/` unless qualified.
Current storage authority remains [Local Planner](../features/LOCAL_PLANNER.md)
and [Project workspace](../features/PROJECT_WORKSPACE.md).

## Shared planning and the art-convention acceptance case

Use **a Project workspace with a project tree and several views of its data**.
Do not require another channel for every poster, task or subproject. Channels
continue to establish location and audience; center stage owns the selected
project/subproject and primary view. Preserve independent optional right-panel
views and drafts.

For example:

```text
Convention season                         overarching project
  Autumn convention                       subproject + event dates
    Poster collection                     subproject
      Forest poster                       subproject/deliverable
        Sketch                            card, artist owns it
        Color proof                       card, reviewer owns it
        Print-ready export                card, depends on proof approval
      Ocean poster                        parallel subproject
    Booth and stock                       subproject
      Book booth                          card + deadline
      Confirm print delivery              card + calendar deadline
      Pack inventory                      card
```

Use a checklist when the pieces share one owner and do not need independent
tracking. Use cards when pieces need their own status, owner or review. Use a
subproject when a substantial deliverable groups multiple cards, documents and
milestones. Sprints, where useful, remain optional time windows.

The proposed views are Overview/project tree, Board, Calendar, Journal, Wiki,
Assistant and Discussion, with Files where configured. Design navigation around
the selected work, not a row of equally prominent controls at every size.

- **Calendar:** convention dates, print deadlines, milestones and linked task due
  dates. A card's due date has one authoritative value; the calendar renders it
  rather than keeping another independently editable copy. Standalone events have
  their own IDs, source references, time zone and all-day/recurrence semantics.
  Rescheduling previews affected milestones/dependencies before saving. Calendar
  access does not authorize invitations, external calendar writes or messages.
- **Journal:** dated progress, decisions, blockers and retrospective entries with
  author, referenced cards/artifacts and revision history. Keep the personal diary
  private. A Project journal is shared deliberate documentation, distinct from
  long-lived wiki guidance, task comments and raw worker logs. Summaries should
  link to evidence and be correctable, not automatically copy every AI message.
- **Project tree:** stable parent/child entities, goals and completion criteria,
  milestones, people, linked artifacts and explicit scope. Prevent parent cycles.
  First shared version inherits the owning Project workspace's audience; creating
  a child must not silently create a new permission system or broaden access.
- **Rollups:** let users distinguish this project's direct cards from all
  descendants. Count each card once; a relationship link is not duplicate work.
  Parent completion requires its acceptance criteria, not merely one child's Done
  status. Gantt dates and dependency effects must reflect real linked records.
- **Personal-to-shared:** explicit previewed copy/publish of selected records,
  retaining the originals, source references and export/recovery path. No automatic
  upload of the artist's private journal/calendar or reassignment of old data.

The AI should be able to read the granted project tree, inspect deadlines, propose
subprojects/cards and dependencies, summarize progress in the Project journal,
and suggest schedule changes. Large plans first produce a reviewable proposal;
applying a hundred new tasks is a separate approved/budgeted batch with a visible
limit and record. Retrieval starts from the selected subtree and relevant linked
items rather than dumping an entire large Project into every prompt.

**Human effort estimates remain excluded from AI access entirely.** Deadlines,
event dates, dependency order and task state are different fields and may be
shared through their own grants. Do not leak estimates through calendar metadata,
rollup summaries, journal automation or model-visible chart data. Human burndown
views may use estimates; AI planning must not read or reconstruct that field.

## Entity links that humans and agents can both use

Replace the visually weak multi-select with **Link a card** and a searchable
inventory. Search by title/short ID and filter by project/subproject, state and
owner. Show selected cards as clickable previews with title, state, owner and
relationship; open the real card from the preview. Offer explicit remove-link,
not deletion of the target card. Plain-language labels are sufficient for humans;
stable IDs stay underneath for tools.

Proposed relation kinds are **Related to**, **Blocked by / Blocks**, and
**Child task / Parent task**. Project membership is a separate relationship.
Define direction and inverse views once; derive backlinks from the canonical
edge rather than asking humans/AI to maintain two copies. Parent/dependency
cycles need validation. Model-facing tools should resolve references, list
relations and update them through the same permission/revision checks.

Start with the existing same-Project boundary. Cross-Project references require
an explicit future access contract; a link never grants access or exposes hidden
titles. Archived/deleted/unavailable targets need clear states. Disambiguate
duplicate titles; never silently link the first title match. Return actionable
not-found/conflict/forbidden responses to agents.

This benefits AI as well as people: it can ask for a card's blockers or inspect
its parent scope without interpreting prose, guessing an ID or searching every
conversation. Raw file/line text is not a substitute for an entity reference.

## Opt-in event rules: checking is separate from acting

Proposed setup is **Off** by default. An authorized user chooses a trigger,
filter, eligible runtime/model, data scope, allowed action and spending limits.
Example: “When someone requests review in this Project, ask my configured helper
to inspect the linked result and leave one comment.” Ordinary edits or comments
must not implicitly start paid calls.

Offer understandable modes:

| Mode | Behavior |
| --- | --- |
| Notify only | Ordinary code records the event and offers a notification/action. No model call. |
| Ask before running AI | Show the proposed check, provider/model, context scope and cost ceiling; queue no billable call until approved. |
| Run within my limits | Explicit standing permission for the chosen triggers/actions, with reserved budgets and a stop control. |

Even a read-only AI check can incur cost. Before enabling a rule, disclose the
provider/account to charge, content sent, per-run and aggregate limits, maximum
calls/runtime, concurrency and expiry. Child runs use the same reserved overall
budget. Reserve capacity before dispatch so parallel work cannot spend the same
allowance twice. If cost cannot be bounded or a free route is unavailable, pause
and report that fact; never silently switch to paid fallback. Provider billing
uncertainty remains visible rather than claiming estimates are exact charges.

Use deterministic event matching first: durable event/cursor → rule filter →
deduplicated queued job → permission/budget check → optional model invocation.
Do not pay an LLM to watch every board change. Coalesce bursts, use cooldowns and
deduplicate by event/rule/subject identity. Track which run caused an event;
ordinary agent comments must not trigger an endless agent-reply loop. Test a rule
without calling a model before enabling it.

Useful triggers include an explicit help/review request, a newly unblocked task,
a scheduled milestone check or an expired worker heartbeat/lease. Deadlines and
heartbeat thresholds are distinct. A user going offline is not proof that their
worker stopped. A network outage can make several machines appear absent.

## Dynamic helpers and the GPT/Longcat example

Yes, an existing runtime could start a short-lived helper when requested. It is
a **new bounded run**, not a permanently running personality that must be paid to
idle. “GPT” and “Longcat” in the example describe configured participants; no
compatibility with a particular product is established by this plan.

Each child run needs a visible parent, requesting actor, purpose, scoped context,
allowed tools, timeout and budget. Its permissions are no broader than the
intersection of the requester, configured service, Project and rule grants.
Start helpers in read-only review mode unless editing was explicitly granted.
Cap child count, delegation depth and concurrent runs; a child cannot invent its
own unlimited family. Cancellation/revocation propagates and reports what already
completed. The current single-active-run implementation does not yet support this
tree; it needs a deliberate scheduler/lease contract, not an extra spawn button.

The proposed exchange could appear on the relevant card:

> GPT: Is this worker still active, and what can be recovered?
>
> Coordinator: Its heartbeat expired after the grace period. The last verified
> checkpoint references revision R, an unmerged patch and the last test result.
> Its current execution state is unknown. Read-only recovery review is available.
>
> Longcat: I inspected that checkpoint. The remaining work concerns this linked
> function. I recommend resuming from the verified patch after ownership is
> transferred.

The coordinator can report saved status without any AI call. If an AI is useful
for interpretation, invoke it under the opt-in rule. The displayed suggestion
does not itself transfer ownership. A separate permitted atomic takeover must
invalidate the old worker generation before edits, verify available artifacts,
allocate an isolated working copy and acquire the required scope. Unknown or
uncommitted work is reported missing/uncertain, not invented or assumed synced.

“File line 279” should resolve to repository + exact revision + path + line range,
with the checkpoint/patch and test provenance. Line numbers alone drift. Do not
confuse reconnecting a model conversation, restarting a process, retrieving a
saved artifact and recovering an entire worker; each has different guarantees.

Keep help/review discussion on the card. The child run is the execution record;
the comment explains the result; the Project journal may summarize an accepted
milestone. No separate AI dispute channel is required.

## Visual redesign mandate — Insights, Journal and Projects

Ronin explicitly requested a “sledgehammer” redesign in the plan, not a cosmetic
retouch. This remains planning, with no UI implementation authorized by this
pass. Calendar's familiar month/date interaction can remain; improve integration,
spacing and labels without replacing it merely for novelty.

### Insights must justify its existence

Browser/source review shows that current Insights is an all-project aggregation:
task-state counts, assigned workload, “Piped plans” and a Gantt timeline. It is not
yet a useful selected-project dashboard. In the disposable account it renders
zero counts, empty workload and a large empty timeline. These are observed empty
states; a populated visual review remains a later implementation gate.

**Recommendation: remove Insights as a standalone top-level tab.** Retain useful
capabilities within a selected Project's **Overview** and, if separately useful,
an all-project summary inside Projects. Do not just rename the same widgets.
If no unique user decision requires an aggregate widget, omit it. Keep access to
genuine timeline/workload functionality rather than deleting data or features
because their current presentation is poor.

Overview must answer, in order:

1. What are we making, for whom, and what counts as finished?
2. What is the next deadline or milestone?
3. What needs attention: blockers, requested reviews, unavailable workers or an
   overdue task? Each item opens the underlying card or record.
4. What changed recently: relevant decisions/journal entries and accepted work?
5. How are the subprojects progressing, using explicitly defined task rollups?

Use a clear project heading/goal, a compact next-milestone area, an actionable
attention list and a readable subproject summary. Timeline and workload are
optional drilldowns when they answer a real question. Avoid dashboard filler,
decorative chart grids and zero-stat tiles. An empty project receives one useful
start state, not a collection of empty boxes. Do not call a project “on track”
without a defined basis. Missing dates or unestimated work must remain visible.

The current “pipe it to a channel and share its plan” copy is misleading under
the local-only contract. Replace it with truthful context-link wording until
real publication exists. Scope must distinguish selected project, subtree and
all accessible projects. No metric or AI summary may imply that private local
records are shared or that an assignee is currently online/working.

### Journal becomes a useful place to write and revisit work

The observed empty Journal has a large blank entries rail and three competing
creation controls: the host New Entry, a second New Entry and the empty-state
Write today's entry. Rebuild the composition and hierarchy.

- One obvious primary New entry action; its empty state replaces rather than
  competes with the populated-state toolbar. Remove redundant nested toolbars.
- A readable dated stream with title/excerpt, author, entry type and linked work.
  A restrained date/search index becomes useful when entries exist; do not give
  an empty rail permanent screen space.
- Generous writing width, clear heading/body typography and deliberate image/
  sketch presentation. Real artwork can be shown; no generic placeholder art.
- Distinguish progress, decision and retrospective entries without forcing long
  forms. Selected entries open in center stage with a clear return path.
- Keep attachments, signatures, dates, tags, history and draft recovery accessible
  where supported. Preserve personal privacy versus shared Project journal scope.
- AI suggestions are drafts with provenance; the journal is not a stream of raw
  tool calls. Publishing uses the configured human/agent permissions.

### Projects becomes the organizing home

The observed Projects empty state has another nearly empty sidebar, an isolated
center prompt and multiple creation controls. Rebuild it around an understandable
project inventory and selected-project experience.

- Inventory: readable project rows/cards showing title, purpose, next milestone,
  owner and a meaningful progress indicator. Optional real artwork previews are
  valuable for the poster use case. Provide a compact list for large inventories.
- Selection: a deliberate project header, goal, relevant dates and an expandable
  subproject tree, with breadcrumb navigation and clear create-subproject action.
  Distinguish hierarchy from card dependencies and sprint time windows.
- Work: preserve the selected project/subproject across Board, Calendar, Journal
  and Overview. Do not ask users to recreate or reselect scope in every view.
- Empty state: one useful invitation to create a project with an optional clearly
  labelled template; do not seed fake plans or progress into the user's account.
- Scale: search/filter, sensible collapsed trees and direct/subtree rollup labels.
  Check three levels of real convention/poster data and deeper-tree behavior.
- Editing: compact, legible forms for names, dates and ownership; show advanced
  controls progressively. Card links use the searchable entity inventory above.

### Shared visual and acceptance requirements

Keep Wabi's theme tokens and shell contract, while changing layout, hierarchy,
spacing and control placement substantially. Reduce nested purple panels and
floating duplicate buttons; use purposeful contrast, readable type and calm
surfaces. Preserve channels, stubs, optional right panels and independent drafts.
Design narrow layouts intentionally; project trees become an accessible drawer
or center-stage navigation rather than a permanently squeezed sidebar. Support
keyboard linking/navigation and non-drag alternatives.

Before implementation is signed off, inspect real rendering with empty, one-item
and populated convention/poster fixtures, long titles, images, blocked work and
deep nesting; narrow/mobile width, keyboard focus, loading/error/recovery states;
and an optional right panel open. Confirm all preserved features are reachable.
A renamed tab, screenshot of an empty shell or typecheck alone does not pass.
Keep screenshots of the actual Wabi UI rather than building another independent
HTML showcase as the design deliverable.

Captured references:
[Insights before](../testing/screenshots/2026-09-28-project-proof/05-insights-before.png),
[Journal before](../testing/screenshots/2026-09-28-project-proof/06-journal-before.png),
[Projects before](../testing/screenshots/2026-09-28-project-proof/07-projects-before.png).

## Revised implementation order and acceptance

1. **Restore planning parity as a product requirement:** inventory/migration plan,
   shared project/subproject entities and usable card relationships. Preserve
   personal data and access to existing My Planner throughout. Apply the visual
   redesign mandate above; standalone Insights is not presumed to survive.
2. **Shared dates and documentation:** calendar/milestone projections and a dated
   Project journal, with human flows first and scoped agent tools alongside them.
3. **Reliable existing assistant loop:** fix the observed action-format/partial
   result weaknesses in the [in-app proof](../testing/PROJECT_IN_APP_PROOF_2026-09-28.md).
   Prove one task, result, review and handoff inside Wabi before automated dispatch.
4. **Event observation and ask-to-run:** durable delivery, deduplication, rule
   preview, consent, one read-only helper and visible cost/activity records.
5. **Budgeted helpers and recovery:** bounded parent/child runs, scope claims,
   exact-version artifacts, stale-worker rejection and explicit takeover. Start
   on one machine; prove two-machine recovery separately.

Acceptance scenarios must include:

- An artist creates a convention, poster subprojects and dependent print/pack
  cards; dates appear in the calendar, decisions in the journal, and parent
  progress counts descendants without duplicating linked cards.
- A scoped assistant reads that shared plan and proposes a change while personal
  diary data and human estimates remain absent from its context.
- A due-date edit updates one authoritative record and its calendar view.
- A human and assistant resolve the same card links without raw-ID guessing.
- With AI rules off, many card edits produce **zero model requests**. A dry run
  likewise calls no provider. Permission or budget exhaustion prevents dispatch.
- Duplicate/burst events and a helper's own reply do not create duplicate calls
  or recursive delegation. Revocation stops later tools and child dispatch.
- A lost heartbeat creates an uncertainty/checkpoint notice, not an immediate
  takeover. When permitted takeover occurs, the reconnecting old worker's writes
  are rejected; failed/uncertain artifacts cannot be reported as recovered work.

These are proposed acceptance gates, not claims of current availability. No new
AI trigger, helper, shared calendar or data migration was activated in this pass.

## Explicit private → shared publication (Ronin clarification)

“Sign off” was mistaken for publishing. Current code only appends signatures/name metadata; it neither writes shared entities nor changes admission. Rename it to “Add my name,” explain its purpose, and keep it independent from visibility.

Publication needs a separate action and real shared storage:

1. Choose an existing shared Project/channel and resolve its current audience and write permission.
2. Preview exactly what will be copied: content, images, dates, dependencies and any name metadata. Include the audience and retained/server-readable policy of the destination.
3. Publish only after the explicit user action. Retain the personal original; record the shared entity identity and publication revision. Subsequent updates require a visible publish/update action, not silent synchronization.
4. A name/endorsement must never publish. Checking a local privacy marker must never grant server access. AI cannot publish private Planner items or receive them as context implicitly.
5. Unpublishing/archiving shared copies is a separate permission-checked action with honest retention semantics; it cannot promise to retract copies already read.
6. Shared events, projects and dated journal entries require their canonical server records first. Do not fake publication by changing local metadata or calling a wiki page a shared journal.

Default proposed audience: members of the chosen Project/channel. Ronin prefers controlled visibility layers, including selected roles and server-wide audiences; see the policy below.

### Controlled visibility layers (Ronin's preferred direction)

Audience selection should support: only me; selected people/roles; everyone in a Project/channel; everyone on the server. Show effective audience rather than a bare public/private toggle. Choose stable member/role identities, and re-evaluate membership on every read/write, download, search result, export and AI tool/context request.

For the first publication slice, inherit the chosen channel's proven admission policy and display that audience. Do not offer narrower item-level role controls until the server enforces those policies across every access path. Do not silently create a public destination or make a personal item shared just because the account is an administrator.

Keep administration, publishing, moderation and content-reading permissions distinct in the intended model. Administrator status alone should not be presented as automatic content readership. Any exceptional moderation access needs a separately defined, explicit and audited policy; existing backend behavior must be audited before promising that separation. Account owner/admin role assignments cannot be inferred from a frontend badge.

Separately display the storage policy. On an ordinary server-readable Authority, the operator can access retained data outside Wabi's UI. UI admission controls do not establish operator-blind encryption. Preserve existing experimental encryption boundaries and explicit plaintext consent; do not route sensitive private content through an AI/provider based on a visibility label.

Publishing preview: **Audience** (who has app access), **Location** (Project/channel), **Storage & retention** (who operates the storage and how long it remains), **AI access** (admitted integrations and context grants), then the exact content being copied. Keep this readable for humans rather than exposing implementation jargon in the flow.

## Independent personal workspace via the Tauri sidecar (28 September clarification)

Personal Calendar, Board, Journal and Projects should be usable without joining a community or manually hosting a server/channel. Place the personal workspace at app level, independent of the selected community. Community connections and publication remain optional.

### Existing foundation versus remaining work

`src-tauri/tauri.conf.json` bundles `binaries/wabi-server`. The registered `hosting` commands support local server lifecycle and backup/restore; the hosting implementation has a loopback listener and application-local data directory. These are foundations, not proof that Planner uses that backend. Existing community-bound Planner snapshots use `frontend/src/lib/business/persistence.ts` (IndexedDB), with server/account-scoped identity. The personal implementation added below leaves these intact and supplies a separate sidecar path.

Implement a distinct personal identity and local workspace, authenticated access to canonical local Planner records, and frontend routing through a storage interface. Reuse domain and permission patterns. Do not create a required pretend community/channel, or conflate private local records with shared channel state. Preserve the browser storage path; independent browser identity/access needs its own explicit design.

### Migration and privacy boundaries

- Keep existing device/account snapshots intact. Offer backup and an explicit previewed import with conflict handling; never merge accounts automatically.
- Personal mode must work offline. Local sidecar startup must not enable LAN access, remote invitations, external AI calls or personal-content uploads. Bind loopback by default and authenticate local access.
- Publishing remains an explicit copy to a chosen community destination with audience/content preview and server permission checks. A personal Authority and a community Authority remain independent; this is not federation.
- Local AI tools require explicit grants. External-model disclosure is separate from local storage and tool access.
- Verified backup/restore comes before optional personal sync. Another-device access needs explicit enrollment, authenticated transport and conflict handling. A stopped laptop is unavailable; the sidecar is not automatic sync or failover.

### Acceptance before availability claims

1. A fresh desktop opens personal planning without a community account or channel setup.
2. Create a project, event and journal entry, restart offline, and verify readback.
3. Back up and restore into an isolated profile; preserve old Planner data during migration and conflicts.
4. With sharing and AI off, prove zero network/provider requests.
5. Publish one previewed item to an admitted community destination; unrelated private records stay local.
6. An unavailable sidecar produces a recoverable error and preserves drafts and existing records.

Implementation follow-through: the candidate now adds `/personal`, an independent identity and the Tauri sidecar storage path. It deliberately uses private one-operation stdin/stdout IPC, rather than launching a network Authority or duplicating Planner as a fake community. Native versioned JSON records preserve the snapshot contract; they are not WabiDB community projections. Browser personal records retain a separate IndexedDB path. Existing account snapshots are preserved; explicit export/import is the migration path. Personal sync, publication and AI grants remain unimplemented. See [acceptance and release limits](../testing/PERSONAL_PLANNER_ACCEPTANCE_2026-09-28.md).
