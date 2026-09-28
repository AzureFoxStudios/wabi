# AI workspace: shared Project board and wiki handoff

**Recorded:** 2026-09-27. **Updated:** 2026-09-28. **Status:** first-slice worktree candidate exercised on Ronin and a disposable Iyoku Authority, including Hermes and OpenCode free-model tool calls; not deployed to Tim. See [Project workspace evidence](../features/PROJECT_WORKSPACE.md) and [dated acceptance](../testing/PROJECT_AI_WORKSPACE_ACCEPTANCE_2026-09-28.md).

## Read first

Read the root [AGENTS.md](../../AGENTS.md), [PROJECT_STATUS](../PROJECT_STATUS.md), applicable directory instructions, and the [AI organizing center proposal](../proposals/multi-computer-ai-workers-and-kanban.md). The user's latest priority is an editable Project planning board that people and authorized agents can use immediately, with wiki access in the same project. Recheck source before choosing an implementation.

The repository has substantial unrelated modified and untracked work. Preserve it. The proposal itself is currently an untracked file, so a fresh worktree will not automatically contain it. If isolating development, carry over the relevant planning documents explicitly and select a known baseline; do not stash, reset, overwrite or commit the whole working tree to simplify setup.

## Product decisions to preserve

- Wabi is a shared workplace for humans, AI agents and subagents. Existing external runtimes participate through adapters; a model API alone still needs an execution host.
- Project is the intended common home. Planning, journal, knowledge, files/review and AI activity are views of that work. Preserve personal planning and journals and existing Lore capabilities; Lore and AI remain optional.
- AI chat is an optional behavior of an existing text channel, with mention-only replies by default. An eventual Create AI chat shortcut need not add a durable channel kind.
- One Authority owns shared state. Agent hosts may share hardware with Anchors, but the roles remain distinct. Worker recovery does not imply Authority failover or federation.
- Humans and AI use the same task records. Source attribution, human edits, explicit audience boundaries and inspectable outcomes matter.
- Wiki pages are part of the first experiment path; selective retrieval, approved playbooks, asset routing, Jev decisions and multi-computer takeover are later extensions.
- Pokee is a potential participant, not a mandated dependency or partnership. The user prefers to let its team ask about involvement; do not initiate outreach or produce a sales pitch.

## First milestone: a shared Project board that an agent can edit

Make an existing Planning channel open an editable Project planning view backed by Authority data. Two authorized people and one scoped bot/agent must see and edit the same Kanban cards. The agent must be able to read and create wiki pages for that channel through the normal permission checks. This lets the user connect an existing agent runtime and start a real Wabi work experiment before native AI chat or multi-computer takeover is ready.

Make Planning the natural Project entry in the UI; preserve the old channel kind and links. The current "Project" label points to Lore and requires its optional addon, while the rich Planner still writes only to per-device IndexedDB. Merge the *experience* first: Project opens a Plan/board view and a Wiki/knowledge view, with Lore as an optional files/versioning view when available. Do not remove Lore, the personal Planner, independent drafts, stubs or right-panel multitasking. Do not silently upload existing personal Planner data into a shared channel.

### Resolve these details from evidence first

1. Trace [`deviceStorage.ts`](../../frontend/src/lib/business/deviceStorage.ts) and the existing Kanban component/store before connecting shared data. Its current session owns a complete local snapshot, including private diary records. A shared board must have separate channel-scoped state and persistence, and must not serialize personal collections into an Authority snapshot.
2. Add a durable, versioned task model through the normal WabiDB command/event/projection path. Do not edit postcard record layouts without a migration. Scope every task to one current channel/project, preserve stable task IDs, author and update attribution, expected revision on edits, and a replayable archive state. Keep task status distinct from any worker-run state.
3. Expose a small authenticated board API for list/create/update/archive, with channel access and rules checks on every operation. Humans and bots use the same handlers and permissions. Validate field lengths, statuses, due dates and operation IDs. Reject stale revisions with a conflict response that lets the editor keep its draft.
4. Reuse/adapt the existing Kanban UI under Project rather than growing a second unrelated board. Handle loading, offline, conflict, empty and revoked-access states. Preserve local personal Planner data and existing Planning/Lore channel links; avoid a parallel global navigation store.
5. An enrolled bot account with owner-granted Planning-channel membership can call [`/api/wiki/{channelId}/pages` routes](../../core/crates/wabi-server/src/api/wiki.rs) with its `Bot` credential. The [focused route test](../../core/crates/wabi-server/tests/project_wiki_bot_contract.rs) covers create/read, denied nonmember access, owner grant/removal and token disable. Wiki PUT and DELETE now require the page's current `expectedUpdatedAtMicros` token and reject stale edits. The owner-only HTTP admission flow is exercised; a self-service runtime enrollment UI is not claimed.

Keep a simple capability description for external agents: the board and wiki endpoints, their required channel membership, expected revisions, and error semantics. An HTTP API is enough for the first experiment. An MCP facade can follow, backed by those handlers; do not create a separate unprotected bot-only data store.

### Minimum behavior

- A member edits a card in Project > Plan; another member sees the saved result after reload and reconnect. The board shows that it is shared, not "On this device."
- A permitted bot reads the same cards, creates a task, updates its status using the expected revision, and creates or updates a wiki page. All writes identify the bot. Removal/revocation denies its next read and mutation.
- Channel/project membership is the access boundary. Joining a related chat, viewing a card link or knowing an ID does not grant unrelated private content. A project that includes several channels later needs an explicit access model.
- Conflict and failed-save drafts remain available to their human editor; a stale bot update must not overwrite a newer human edit. Archiving must be distinguishable from deleting history.
- Existing personal Planner records, diary entries and unrelated wiki pages are never auto-published. The selected project context is visible to a person before they ask an AI to use it.

### Acceptance evidence

Add regression tests for authorization, create/edit/archive replay, stale revision rejection, duplicated operation ID, revocation, malformed payload, and channel isolation. Run the repository's relevant checks using its pinned toolchain. Use a real browser with two disposable accounts and a narrow viewport for creating and editing a shared board; use a disposable bot account for the same API plus wiki. Restart the Authority and verify the exact board/wiki content survives. Check a denied bot and a bot removed during an attempted write. Verify no existing local Planner snapshot was uploaded.

A controlled API client proves agent access without claiming a working Pokee/Hermes/Claude Code integration. If a real agent is available, use a disposable scoped run to create a card and page, then distinguish that result from API-only validation. Report implementation, checks, rendered acceptance and deployment separately. This handoff does not authorize deployment or external messaging.

The end-to-end agent check must also ping a Wabi bot in a disposable text channel, confirm the attributed reply arrives in the human client's view, and run one bounded Hermes task using an actually available free model. That Hermes task should read the shared Project board and wiki and make one clearly attributed card or page change. Record the exact connector/model, successful output, and any provider limits; a successful API-only request or bot echo does not prove the free-model path. Never put bot credentials, provider keys, or private project content in test logs or documentation.

The milestone is complete when two authorized people and one explicitly admitted bot can collaborate on the same Authority-backed Kanban board and wiki in one Project context, with safe conflicts, access checks and restart recovery.

## Computers and execution order

Read-only inventory on 2026-09-27 found three reachable x86-64 machines. Availability and installed tools can change; repeat these checks before any remote run.

| Computer | Observed capacity and state | Role for this milestone |
| --- | --- | --- |
| Ronin (`dotRonin`) | This working checkout; 8 logical CPUs, 14 GiB RAM, roughly 157 GiB free. Cargo and Bun are available. | Implement and run focused Rust/frontend checks. Keep the large unrelated dirty tree intact. |
| Iyoku | SSH reachable; 8 logical CPUs, 15 GiB RAM, roughly 381 GiB free. Cargo and Podman are available; Bun was not found on the normal path. | Run a disposable WabiDB Authority and disposable accounts/bot using an isolated checkout and data directory. Exercise restart, revocation, and remote-client behavior without touching its existing Wabi directories. If a frontend build is needed there, first verify or provision a compatible runtime. |
| Tim | SSH reachable; 8 logical CPUs, 7.6 GiB RAM, roughly 54 GiB free. The live `wabi-server` container reported healthy. Cargo and Bun were not found on the normal path. | Treat as the live Authority, not a development worker. After local and Iyoku acceptance, audit its current WabiDB deployment and release artifact before a separately tracked rollout. A live smoke check can verify the release but cannot stand in for disposable tests. |

The existing [Tim/Iyoku update runbook](../deployment/TIM_IYOKU_UPDATE_RUNBOOK.md) describes an older SpacetimeDB stack and blanket `rsync --delete`; do not execute it for this milestone. Use the current WabiDB deployment procedure and inspect the actual running stack first. Do not copy the active Authority database to an unfenced writable peer or claim automatic failover. Iyoku can host an independent *test* Authority; an agent process on Iyoku may later call a project on Tim through normal authenticated API access, but that does not turn Iyoku into a second Authority for Tim's community.

Build order: durable board contract and API on Ronin; Project/Plan UI and wiki bot access on Ronin; disposable two-human/one-bot acceptance with Iyoku as server and Ronin as a remote client; then a release candidate and Tim rollout only when the evidence and current deployment audit support it. Multi-computer worker takeover is a later milestone after the shared project works.

## September 28 continuation

The next two core slices now have a Project Assistant conversation surface and bounded Project card/wiki worker in the candidate. Cards also gained notes/checklists/links, human-only estimates/history and human/bot claims. See [the continuation plan](2026-09-28-project-assistant-and-cards.md), [worker contract](../features/PROJECT_ASSISTANT.md) and [acceptance record](../testing/PROJECT_ASSISTANT_ACCEPTANCE_2026-09-28.md). The following list retains the broader intended extensions; it is not a claim that ordinary-DM enrollment, code execution or multi-computer takeover shipped.

## Subsequent slices

1. Add an identifiable AI contact and one connector that uses the same task/wiki API. Start with mention-only channel replies, visible context and disable/error states; test bot loops and private-to-shared leakage separately.
2. Add shared project journal, selective wiki retrieval and one scoped asset Inbox. Validate stale-source handling, deletion/revocation and audience-safe routing before automated extraction.
3. Add one execution worker with actual process restrictions, durable checkpoints, bounded tools and human takeover. Then test a second worker recovering acknowledged work.
4. Add richer project views and optional Jev-assisted routing after recording trustworthy work events and measuring the simpler baseline.

For each slice, update the proposal/status/operator documentation only to match the evidence achieved. Reassess provider-specific capabilities at implementation time. Connector compatibility, runtime isolation, migrations and recovery still need implementation decisions and proof.
