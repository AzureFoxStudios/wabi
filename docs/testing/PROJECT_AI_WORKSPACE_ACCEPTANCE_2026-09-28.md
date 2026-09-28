# Shared Project and external agent acceptance — 2026-09-28

This records a **worktree candidate tested with disposable communities**. It is not a Tim release, a native AI contact, a Pokee integration, a worker scheduler or Authority failover. The [Project contract](../features/PROJECT_WORKSPACE.md) and [first-slice plan](../plans/2026-09-27-ai-workspace-first-slice.md) define the scope.

## External runtimes on Ronin

Each runtime used the same owner-admitted test bot through `scripts/wabi-project-agent.mjs`. Credentials remained inside the local bridge; the model received disposable board/wiki content and API results. Each run read cards and pages, then created exactly one card. Independent human and bot API reads confirmed the returned card ID and bot creator attribution. The open browser board picked up the new cards through its periodic refresh.

| Runtime | Inference selection | Result |
| --- | --- | --- |
| Hermes Agent v0.20.0 (2026.8.3) | OpenRouter `openrouter/free` | Read board/wiki and created `Hermes free-model acceptance`; four provider calls, usage report completed successfully. |
| Existing OpenCode 1.18.32 | `openrouter/openrouter/free` | Read board/wiki and created `OpenCode 1 acceptance`. Initial reads used an excessively short tool timeout; the runtime retried only those reads with 30 seconds, then created one card. |
| Separately installed OpenCode 2.0.18 | `openrouter/openrouter/free` | Read board/wiki and created `OpenCode 2 acceptance` through three shell calls. |

Hermes's normal configuration selected an unusable SSH terminal even when a shell override requested local execution. After the user's explicit approval for local-terminal access and OpenRouter egress, an isolated temporary Hermes profile selected local execution and completed the task. The normal Hermes configuration was not changed. Safe mode removes customizations; it is not a terminal sandbox. OpenCode trials used separate temporary data/configuration and command permission rules, not a claim of operating-system isolation. The failed first V2 trial did not load its custom agent; placing that agent in the isolated global configuration resolved the issue.

The model identifier is the **free router**, not a fixed underlying model. Hermes reported estimated cost zero with cost status `unknown`; OpenCode step events reported zero. These runtime reports do not independently certify account billing or a durable free quota. No paid-model fallback or purchase was requested.

The V2 package was identified in the [official installation documentation](https://opencode.ai/v2/docs) and pinned to `@opencode/cli@2.0.18`. It lives under `/home/ironin/.local/share/wabi-opencode-v2`. The `opencode2` launcher uses its own persistent configuration/data/cache/state directories; the original `opencode` remains 1.18.32. The inference trials used temporary profiles, so the ordinary V2 profile still needs its own provider connection. V1 and V2 use different [permission/configuration names](https://opencode.ai/v2/docs/permissions); copying the V1 configuration verbatim into V2 is not the tested setup.

Codex implemented and exercised this workspace; a separate Codex CLI connector invocation is not claimed. Claude was not found on Ronin's inspected command path. Zcode was present, but a version probe could not start its application inside the command sandbox; no GLM inference test was made. Nous Portal and secondary providers were not exercised. The user's preferred stack remains OpenCode, Codex and Hermes.

## Disposable Authority on Iyoku, clients on Ronin

Iyoku ran an independent test Authority bound only to loopback, with a fresh database under `/tmp/wabi-project-acceptance.48v4Lf/data-run2`. Ronin reached it through an SSH tunnel; it was never a writable copy of Tim's community.

The cross-machine API run passed:

- two registered humans read the bot-created shared card and wiki page;
- a second human edited the bot card, preserving creator and latest-editor attribution;
- a stale human edit returned 409;
- a human ping reached the bot's readable message history, and the attributed bot reply reached human history;
- after clean Authority stop/restart, all three clients read the exact saved card revision/status/description/editor and wiki body;
- owner removal of bot Project access denied both board/wiki reads and attempted card/wiki writes with 403, leaving the human-readable card revision unchanged; regrant restored access.

The first harness incorrectly expected an `isBot` property in ordinary message history. That response identifies the speaker with `user_id`; the corrected assertion matched the known bot ID. The initial disposable dataset was preserved, and the corrected run used a fresh dataset.

The first transferred development binary passed API checks but returned an empty index page on Iyoku: normal debug RustEmbed builds read Ronin's frontend directory at runtime. The replacement uses the existing `field-embed` feature and includes the static frontend. After removing debug symbols for transfer, its SHA-256 was `4232e81218eefe043ffdb87f5a53b101088da793f6265e7695330a155c350a4a`; Iyoku verified that exact hash before starting it. The prior binary and database were preserved. The replacement returned 23,723 bytes of HTML beginning with `<!doctype html>`, and the full remote saved-state/revocation checks passed again. A proper release build is still required before release rollout.

## Browser and build evidence

In a real browser on Ronin, the disposable browser member signed into Iyoku through the SSH tunnel, opened the shared Project board, saw the in-progress card and its second human's saved description, and read the bot-created wiki page. The ordinary text channel then displayed both the human ping and `IYOKU_BOT_PONG_OK` under the bot's username. The Wiki author caption used a fallback user ID for the offline bot; friendly offline-author names are still a presentation gap, while the API author identity was verified.

The standalone server build and the focused integration suite both passed:

```sh
cargo build -p wabi-server --bin wabi-server --features field-embed
cargo test -p wabi-server --features field-embed --test project_wiki_bot_contract
```

The suite reported **3 passed, 0 failed**. The tested stripped Iyoku artifact matched the final successful server build. An earlier all-binary build encountered an auxiliary backfill tool compiled against a temporarily older library while other work was changing; no all-binary/workspace check is claimed by these scoped commands. Frontend check/build and two-account/narrow-viewport local acceptance were completed in the preceding pass; no frontend implementation changed during these runtime experiments.

After acceptance, the disposable Iyoku server was stopped and the SSH tunnel closed. Its binary, data and logs were preserved for later isolated reruns. The local Project remained available for review. The temporary Hermes provider-credential copy was removed; original provider settings and credentials were retained.

## Tim audit

A read-only inspection found a healthy `wabi-server` container, `/health` reporting role `authority`, and setup completed. Compose is the WabiDB single-binary stack. The binary is read-only bind-mounted from `/home/tim/Desktop/Wabi/target/release/wabi-server`; data, uploads, plugins and optional Lore have separate mounts. Its SHA-256 at inspection was `57452407550d192214e6d4362325b84b689aea169a508f9e0e0ce0e2b87e565c`. That deployment directory did not contain a Git checkout, so no deployed commit SHA was inferred. No binary, container, live data or configuration was changed.

## Limits of this evidence

The ping check was an explicitly orchestrated bot read/reply, not an installed mention-triggered AI listener. The runtime tests were one-shot tasks using a shared test bot identity, not separate enrolled worker identities or durable agent runs. They do not establish cancellation, background conversation handling, checkpoint takeover, multi-worker scheduling, encrypted bot DMs, or Authority high availability. Those remain later slices of the [organizing-center proposal](../proposals/multi-computer-ai-workers-and-kanban.md). Release preparation and deployment to Tim remain separate work.
