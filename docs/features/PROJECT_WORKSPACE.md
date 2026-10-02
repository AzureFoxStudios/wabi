# Shared Project workspace — current worktree candidate

The Project view groups a shared Board, Wiki, Assistant and Discussion for a Planning channel. Discussion is the channel's ordinary message stream and composer, reached from the same top-level Project navigation; the broken bottom Project/Chat toggle has been removed. Existing Lore channels also open the Project view and retain their optional versioned Files tab. The separate **My Planner** remains private to the current device/account; opening a Project never uploads its tasks, calendar, or diary.

**Maturity:** implemented and exercised locally and on a disposable Iyoku Authority, including bounded external-agent tool calls; not deployed to Tim or accepted as a production release. See [PROJECT_STATUS](../PROJECT_STATUS.md) for the release boundary and the [acceptance plan](../plans/2026-09-27-ai-workspace-first-slice.md) for outstanding tests.

## Shared cards

Cards are durable WabiDB records keyed by channel and card ID. The Authority owns them. The Project Plan uses the same API for people and bot credentials, and WabiDB replays edits after a restart. A card records its creator, latest editor, revision, status, priority, due date, assignee, and archive state, plus notes, a checklist, linked cards and a human estimate. In-progress cards identify their assignee as working on the task. **Claim this task** assigns an unassigned unfinished card to the signed-in human (or authenticated bot through the API) and moves it In progress; a competing claim conflicts. Assignment is recorded responsibility, not live cursor/presence detection. Archiving preserves the record and history event; it does not delete it. The current interface refreshes periodically and after saves. A stale edit returns HTTP 409 and leaves the editor's draft open.

For an authorized Planning or Lore channel `CHANNEL_ID`:

| Operation | Endpoint | Body |
| --- | --- | --- |
| List cards, including archived records | `GET /api/projects/CHANNEL_ID/tasks` | none |
| List current project members for the assignee picker | `GET /api/projects/CHANNEL_ID/members` | none |
| Claim an unassigned unfinished card | `POST /api/projects/CHANNEL_ID/tasks/TASK_ID/claim` | `expectedRevision`; actor comes from authentication |
| Human revision history / estimate burndown | `GET /api/projects/CHANNEL_ID/history` | none; forbidden for bots |
| Read one card | `GET /api/projects/CHANNEL_ID/tasks/TASK_ID` | none |
| Create card | `POST /api/projects/CHANNEL_ID/tasks` | `operationId` UUID, `title`, `description`, `status`, `priority`, optional `dueDateMillis`, `assigneeUserId`, `notes`, `checklist`, `relatedTaskIds`; humans may set `humanEstimateMinutes` (null clears it) |
| Replace/edit/archive card | `PUT /api/projects/CHANNEL_ID/tasks/TASK_ID` | `expectedRevision` plus the full editable fields; status `archived` archives |

Statuses: `ideas`, `todo`, `in_progress`, `done`, `scrapped`, `archived`. Priorities: `low`, `medium`, `high`, `urgent`. A repeated create with the same `operationId` and unchanged original fields returns the existing card; a conflicting reuse returns 409. An edit requires the card's current revision. Assignments must name a current channel member. These endpoints use the normal channel access and server-rule checks, including for bots; IDs alone grant no access.

Human estimates are omitted from every bot card response and refused on bot writes, including explicit null. Bot edits and claims preserve the estimate. Missing notes/checklists/linked cards preserve them on update. Each checklist entry has a stable ID, title and completion flag. Separate cards are used when a step needs its own assignee, status or review; links must name cards in the same Project. The human burndown uses recorded revisions, shows remaining and total estimated scope, and identifies unestimated work instead of inventing effort.

The optional [Project Assistant](PROJECT_ASSISTANT.md) adds a native conversation and bounded card/wiki worker. Its acceptance and current limits are separate from the initial one-shot bridge trials below.

## Bot admission and wiki

The server owner creates a bot through `POST /api/bot/create` and retains the returned token securely. Project membership is explicit: `POST /api/bot/project-access` with `{ "botUserId": 123, "channelId": "ch_...", "allow": true }` grants one Planning/Lore project, and `allow: false` removes it. The owner authenticates that request with their account token. A bot cannot self-join a Project channel. Bot reads/writes use `Authorization: Bot <token>` and the same card and wiki routes as a person. Project admission changes serialize with card and wiki mutations; each mutation rechecks current membership while holding that gate. A revocation that completes before a write begins denies the write. Disabling the bot token revokes further requests.

For a disposable external-agent experiment, [the narrow Project bridge](../../scripts/wabi-project-agent.mjs) accepts `WABI_PROJECT_URL`, `WABI_PROJECT_CHANNEL_ID`, and `WABI_BOT_TOKEN` from its environment, then offers `list-cards`, `list-pages`, `create-card`, `set-card-status`, `claim-card`, `assign-card`, `create-page`, and `ping`. It sends the token only as an HTTP header and never prints it. Use an owner-granted test bot and disposable project; the bridge is a convenience client, not a sandbox or a new permission system.

Wiki pages use `GET/POST /api/wiki/CHANNEL_ID/pages`; edits use `PUT /api/wiki/CHANNEL_ID/pages/PAGE_ID` with `expectedUpdatedAtMicros` from the page read plus title/body. Deletion uses `DELETE` at the same page URL with an `expectedUpdatedAtMicros` query parameter. A stale edit or delete returns 409. Existing wiki revisions remain available. Wiki content is server-readable to the Authority; granting a bot access permits that bot to read the project's pages. Do not hand an agent a general account token or silently include personal Planner data in its context.

## Acceptance evidence and release boundary

A September 30 follow-up connected an actual Codex CLI session through the new
local stdio [Project MCP connector](../../scripts/wabi-project-mcp.mjs) to a
disposable Project on **wabi.chat**. It read/claimed a card, updated Notes and
read revision 3 back; a human browser verified bot assignment and the unchanged
human estimate. This demonstrates external Codex tools on the live board. The
new in-app owner connection panel is a local candidate, not shipped. Automatic
Wabi-to-Codex chat dispatch, comments and native coding-session recovery are
still unimplemented. Optional bounded card/wiki worker recovery is documented
in [Connections](PROJECT_CONNECTIONS.md). See [dated evidence](../testing/CODEX_AND_PERSONAL_ACCEPTANCE_2026-09-30.md).

The connector accepts a private version-1 connection JSON with `serverUrl`,
`channelId` and `botToken`, or the existing three WABI Project environment
variables. Launch it with `wabi-project-helper mcp --connection FILE`.
It exposes ten tools: `project_brief`, paged card/wiki indexes, card/wiki reads,
card create/claim/update and wiki create/update. No personal or Lore content is included. Read `project_brief`
first; writes require observed revisions or a stable create operation UUID.
Keep credential files outside Git and use one admitted service per intended
identity. A shared credential across chats does not identify independent workers.

Three focused server tests pass, including stale wiki edits and deletion, malformed card rejection, duplicate-operation conflict, project bot grant/revoke, a controlled bot edit attempt held behind the membership gate while removal completes, bot ping/history, and board replay after restart. The revoked edit is forbidden and leaves the saved revision unchanged. On a disposable loopback Authority, two human accounts and an admitted bot used the same board/wiki. The narrow bridge created a bot-attributed card and page, moved a card, and sent an attributed ping visible in human history. In a real browser, one human created a Project card, read the bot page, saved a human wiki edit, and sent a message in the Project Discussion view. A second disposable human then signed in, moved that card to Done, and edited its description; the first human signed back in and saw the change and 33% progress. A separate API read matched the saved editor ID to the second human. Settings Logout was repaired in the layout wrapper and exercised during both account switches. With a pinned People panel, the board reflowed and retained its New card action; the card editor listed the admitted bot and human members as assignees. Hermes and OpenCode 1.18.32/2.0.18 each completed a bounded free-OpenRouter task: read the shared board/wiki and create exactly one card through the admitted bot bridge. Independent human and bot reads confirmed all three cards and their bot attribution. The open browser board picked up the new cards through periodic refresh. Hermes needed a separate temporary local-terminal profile after its saved SSH configuration failed; the user explicitly approved this test, and normal runtime settings were preserved.

A disposable Iyoku Authority passed two-human/bot board and wiki access, attributed ping/reply history, stale-edit rejection, exact saved-state reads after restart, and bot revocation denying reads/writes without changing the saved human-readable card. The first debug binary lacked a self-contained frontend; the existing `field-embed` feature fixed that packaging issue. A real browser on Ronin then signed into Iyoku through an SSH tunnel and rendered the shared Project board and read the bot-created wiki page. The three focused tests also pass with `field-embed` enabled. Tim's live WabiDB Authority was audited read-only and was healthy; nothing was deployed or changed there.

See [the dated acceptance evidence](../testing/PROJECT_AI_WORKSPACE_ACCEPTANCE_2026-09-28.md) for artifact fingerprints, exact runtime versions, checks and limits. These are one-shot runtime experiments and an explicitly orchestrated bot ping/reply, not an installed AI chat listener, Pokee connector, durable worker scheduler, encrypted bot DM or worker/Authority failover. Release preparation and a Tim rollout remain separate work.
