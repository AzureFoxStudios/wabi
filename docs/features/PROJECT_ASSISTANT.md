# Project Assistant and bounded worker — worktree candidate

This is the second and third slice of the shared Project workspace. It is not yet a Tim release, a multi-computer recovery system, or a general coding-agent sandbox.

## Human experience

Open a Project and choose **Assistant**. Choose an admitted bot and either **Reply only** or **Work on cards and wiki**. Each submitted request explicitly confirms the model-provider handoff. Prompts, replies, and checkpoints are shared, server-readable, durable Project content. Reply-only sends the submitted prompt; it does not automatically include the board, wiki, ordinary Discussion, DMs, personal My Planner, or past conversations. **Continue this conversation** puts the prior question/reply into the visible prompt for editing before submission.

Work mode lets a model choose relevant cards and wiki pages through bounded tools. Humans can inspect recorded arguments/results and pause, cancel, resume a safe checkpoint, or take over. The selected bot, configured provider hostname/model, attempt, and last checkpoint remain visible. A queued request says it is waiting for the assigned worker, rather than pretending it is connected.

This implementation uses a Project conversation surface. It does not install an ordinary-channel mention listener or enroll a bot into encrypted DMs. Those integrations must retain the existing device/encryption and each-sender consent rules; no room is downgraded for AI convenience.

## Lore boundary

The [Lore AI workspace direction](../plans/2026-09-28-lore-ai-workspace-direction.md) records the proposed progression and first end-to-end demonstration.

The Assistant can use cards/wiki in a Planning or Lore channel, but its current tool allowlist has **no Lore file, history, branch, stage, review, folder-sync or remote push/pull operations**. Wiki pages and worker checkpoints live in WabiDB; creating an Assistant journal wiki page does not create a Lore file or commit. There is no automatic board/wiki-to-Lore export or import.

Lore channels retain their existing **Files** workspace for humans, including file/history/review and local-folder workflows when the optional Lore integration is available. The separate `wabi-sync` client implements folder push/pull/watch; it is not installed or invoked by this worker. Lore's remote `sync`/`push` path also depends on its configured mode: embedded/offline repositories skip remote operations. A visible Files tab or successful local write is not proof of remote synchronization.

The September 28 Assistant acceptance used `field-embed` without the optional Lore addon and tested a Planning channel. It therefore proves neither an AI Lore workflow nor a live Lore push/pull round trip. The next integration should expose scoped Lore reads, version-aware staged edits, review requests and revision/file citations through the existing Lore permissions, then test pull → proposed change → review/commit → second-client pull. Publishing/syncing must remain an explicit action; optional Lore failure must not break cards/wiki.

## Optional worker setup

The Authority remains the only owner of Project state. The worker can run on Ronin or another machine that can reach the Authority. An Anchor/proxy is not another state Authority. Stopping this process does not remove the recorded run.

Use an owner-created bot with an explicit grant for this Project, as described in [Project workspace](PROJECT_WORKSPACE.md). Keep its token and the provider key in a protected operator environment; do not place them in wiki pages, prompts, browser storage, or command-line arguments. No provider key is stored on Wabi by this worker.

Set:

- `WABI_PROJECT_URL`: Authority HTTPS origin, or loopback HTTP for a disposable test.
- `WABI_PROJECT_CHANNEL_ID`: the one Project this worker may serve.
- `WABI_BOT_TOKEN`: existing admitted bot token.
- `WABI_AI_PROVIDER_URL`: provider origin; defaults to OpenRouter.
- `WABI_AI_API_KEY`: the operator's provider key.
- `WABI_AI_MODEL`: explicit model identifier; there is no paid default or automatic paid fallback.
- `WABI_AI_MAX_TOKENS`: optional output allowance, default 8192, accepted range 512–16384. Reasoning can consume this allowance before an action is returned.
- `WABI_AI_REASONING_EFFORT`: optional OpenRouter setting (`none`, `minimal`, `low`, `medium`, `high`). Use only a setting supported by the selected model; mandatory-reasoning models can reject `none`.
- `WABI_AI_COMPLETION_PATH`: optionally `/v1/chat/completions` or `/api/v1/chat/completions`. OpenRouter uses the latter; other origins default to the former.

Run `node scripts/wabi-project-worker.mjs --once` to process one queued request, or omit `--once` to poll serially until stopped. Output contains run ID, state, step count and returned model/finish metadata, never tokens or raw model content/provider error bodies. OpenRouter requests JSON-object output. Empty or malformed actions stop the run without an edit or automatic retry. The worker does not execute commands, load repo instructions as authority, or expose filesystem tools to the model.

For reproducible free-model experiments, select an explicit available `:free` model. The dynamic `openrouter/free` router can select a different model on later requests; supported reasoning/output settings can differ. A provider failure after a successful tool preserves the tool checkpoint. Review it and write a new bounded continuation that avoids repeating that edit.

Provider behavior and settings follow [OpenRouter's structured-output](https://openrouter.ai/docs/guides/features/structured-outputs), [reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) and [free-variant](https://openrouter.ai/docs/guides/routing/model-variants/free) contracts. Other compatible providers need separate acceptance.

The API adapter uses [OpenRouter's chat-completion contract](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion). Other compatible providers are configuration options, not a claim that their authentication, models, reasoning parameters, quotas, or deployments have been tested. OpenCode/Codex/Hermes can consume the shared workspace bridge; earlier CLI trials are separate from the provider worker's acceptance. This first worker does not delegate general host execution to those CLIs.

## Execution contract

A human creates an idempotent request. Only its assigned bot can claim it, and only one run may be running in that Project. Claims report provider/model and receive a generation (`attempt`) and two-minute lease. Every tool request includes the run revision, attempt and a UUID operation ID. Current human requester and bot Project access are rechecked at claim and at every step; bot credentials must still be valid. Revision changes, pause, cancellation, takeover and an expired lease reject later steps.

Reply-only permits `complete`/`fail`. Work permits at most twelve Project tools plus a terminal response:

- `list_cards`, `read_card`, `claim_card`, `create_card`, `update_card`;
- `list_pages`, `read_page`, `create_page`, `update_page`.

Tools are executed by the Authority through existing durable board/wiki paths. The worker cannot select another channel or pass another actor identity. Card and wiki updates require the current edit revision. Linked cards must be from the same Project. Human estimates are not returned through bot card APIs, cannot be set or cleared by a bot, and are preserved when shared fields change. Estimate history is human-only. A card claim takes an unassigned unfinished card as the authenticated actor and marks it in progress; it cannot silently replace an existing assignee. Explicit reassignment uses the ordinary assignee field.

Before each tool, a pending intent is durably recorded. After the tool, its result is durably recorded and the lease renewed. An acknowledged operation ID can be replayed without repeating its side effect. If the server stops between intent and result, the outcome is **uncertain**: no automatic retry or lease-expiry takeover occurs. Inspect the Project, then cancel or take over. Safe paused/expired runs without a pending action can be explicitly requeued by a human; a new attempt reuses recorded results. Step budget remains cumulative.

Pause/cancel/takeover waits for any already-admitted local tool to finish, then fences the next tool. It does not undo accepted edits or prevent a provider response already in flight. The model receives no mutation credentials, so its late response cannot itself write to Wabi. If a request fails after an edit might have committed, the worker reloads the checkpoint and never blindly retries that action.

## Persistence and compatibility

`project_run_updated` is a new channel-stream event (kind 6), guarded by the actual-parent/local-owner workspace admission catalog. `project_runs` is a new projection with schema-version-1 JSON records: Project/run IDs, human/bot IDs, prompt, mode, reply/status, revision/attempt/lease, provider/model, timestamps, checkpoint, pending intent, and recorded steps. There is no durable postcard record mutation. New-event data requires the updated binary; rollback must preserve/restore the pre-upgrade data rather than assume an older binary understands it.

Card writes now use a `WPT2\0`-prefixed JSON record. The decoder retains the exact original postcard record as a legacy fallback and supplies empty notes/checklists/links and no estimate. New fields are notes, stable-ID checklist entries, linked card IDs, and optional human-estimate minutes. The existing card events also populate `project_task_history` with one snapshot per card revision for the human burndown. Old snapshots without that index provide history from subsequent writes until full event replay rebuilds it. The chart plots recorded remaining hours and scope; unestimated work is explicitly counted, and scope changes/reopened/archived cards change the curve. It is not a velocity prediction or an invented ideal line.

## Acceptance

See [the assistant acceptance record](../testing/PROJECT_ASSISTANT_ACCEPTANCE_2026-09-28.md) for actual checks. Compile success is not browser acceptance, and disposable worker trials are not a deployment claim. Multi-computer lease recovery, parallel workers, ordinary-DM connectors, album routing, richer journal integration and optional Pokee adapters remain later slices.
