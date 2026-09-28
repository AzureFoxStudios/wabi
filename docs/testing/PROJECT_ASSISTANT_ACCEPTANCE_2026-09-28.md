# Project Assistant acceptance — 2026-09-28

Scope: the local candidate for shared Project board/wiki, native Project assistant conversation, and a single bounded Project-tool worker. Tim was not deployed. This is separate from the earlier [two-computer shared-board and CLI bridge acceptance](PROJECT_AI_WORKSPACE_ACCEPTANCE_2026-09-28.md).

## Automated evidence

`cargo test -p wabi-server --features field-embed --test project_assistant_contract --test project_wiki_bot_contract`: **9 passed, 0 failed**. Log: `/tmp/wabi-project-assistant-final-contract.log`.

Six new real-router/real-WabiDB cases cover:

- human estimates excluded from bot single/list responses; bot setter/clear denied; bot edits preserve them; notes/checklist/estimate survive replay; humans can clear them;
- single-active-run claim admission; unrecognized terminal tools rejected; create card/wiki recorded; repeated acknowledged operation ID produces no duplicate; pause/resume/takeover invalidate stale attempts; saved run/steps replay;
- reply-only refuses Project tools; human requester or bot removal prevents the next tool;
- an intentionally pending checkpoint survives restart, cannot resume, and remains visible through takeover;
- authenticated-human claim sets the assignee and In progress, preserves notes/checklist/estimate, and competing/stale bot claims conflict; explicit bot reassignment works without estimate exposure;
- human-only request creation, provider consent, server-side twelve-tool limit, and permitted terminal completion.

Three existing board/wiki/bot cases remain green, including membership-gate revocation, stale card/wiki revisions, idempotency, channel isolation, durable archive/replay, and attributed message ping/history.

`node scripts/tests/wabi-project-worker.test.mjs`: **4 passed**. Tests validate origin/action rejection, provider/Project credential separation, bounded completion, a provider response arriving after human takeover, and a reasoning-only/empty response: the worker records failure without a Project edit or provider retry. Output-budget validation and OpenRouter JSON/reasoning request settings are covered. These runner tests use a fake provider; live evidence follows separately.

`bun test frontend/src/lib/business/projectBurndown.test.ts`: **1 passed**. Scope additions, completion, unestimated work, reopened/re-estimated work, stale revision and archive behavior are exercised.

## Browser and model acceptance

The real in-app browser signed into a disposable loopback Authority using an ordinary test-account login. In the Project board it created **Human planning acceptance**, with a 2.5-hour estimate, notes, a review checklist and a link to an existing card. **Claim this task** moved it to In progress and displayed the human's “is working on this” label. The burndown showed 2.5 hours remaining/scope and explicitly counted unestimated cards. A layout correction gives the expanded chart and board their own vertical space rather than collapsing the lanes.

The browser submitted a bounded Assistant request with the explicit provider-handoff checkbox. A **local simulated provider**, clearly labelled as such, completed `create_card`, `claim_card`, `create_page`, `complete`. The actual Authority tools saved the card, notes/checklist, bot assignment and wiki page; the native Assistant showed the reply and four recorded steps. This was not an LLM trial.

The user then explicitly authorized **disposable content only** to OpenRouter. Two `openrouter/free` attempts returned no usable action and stopped before any card edit. The next attempt created **Assistant free-model acceptance** with the requested notes/checklist, then a later provider request failed with HTTP 400. Wabi recorded the successful tool and subsequent failure; the worker neither retried nor recreated the card. The exact cause of that provider rejection was not established.

A fresh, bounded continuation using the explicit **`cohere/north-mini-code:free`** model completed five recorded steps: `list_cards`, `read_card`, `claim_card`, `create_page`, `complete`. It claimed that existing test card and created **Assistant free-model journal**, then returned a reply naming both results. Settings were JSON-object output, an 8192-token allowance and reasoning effort `none`; no paid fallback was used. The browser displayed the completed run and configured model. Provider progress logs also identified the returned model. This proves a live free-model Project-tool run, not universal model compatibility.

Independent human and bot API reads after stopping/restarting the Authority confirmed nine cards, the human's unchanged **150-minute** estimate, no `humanEstimateMinutes` field in bot card responses, exactly one live-model acceptance card, its checklist/notes and bot assignee/In progress state, three wiki pages, and replayed completed/failed run checkpoints. The browser restored the authenticated account and four channels after reload and rendered both human and bot work labels. No private repo files, credentials or human estimate field were sent in model prompts.

In the browser, a separate **Reply only** request was paused and resumed, then the explicit free-model worker returned **Hello!** through one `complete` step and no card/wiki tool. Another queued request was taken over through the UI before any provider call; it displayed that the worker may make no further edits. The server contracts separately exercise cancellation and stale-attempt rejection during worker activity.

Final candidate packaging: frontend check **0 errors, 120 existing warnings**; static build passed, offline asset fingerprint `c7dca9fe66d73153`; `cargo build -p wabi-server --bin wabi-server --features field-embed` passed. The tested debug embedded binary SHA-256 is `b6979b3491408bc900285248215b819ac66622d7e3bbade5609aa601582e6b35`. This is a worktree candidate, not a release build or full-workspace test claim. The pre-upgrade disposable data copy was retained; old binaries must not be pointed at new-event data as a rollback shortcut.

## Boundaries

The worker only invokes Project card/wiki tools and a terminal reply, never a terminal command. It has no generic repo-execution, arbitrary filesystem or upload tool. Project assistant conversation is shared, durable and server-readable, with explicit provider handoff. Ordinary Discussion/mention callbacks and encrypted-DM enrollment are not installed by this candidate. No computer-to-computer automatic worker takeover, parallel jobs, Authority HA, album routing or Pokee integration is claimed.

**Lore was not exercised by these trials.** The acceptance binary used `field-embed`, with no optional Lore addon enabled, and the fixture was a Planning channel. The worker has no Lore tools. Its wiki journal is a WabiDB page, not a Lore commit; it performs no Lore push/pull or folder synchronization. The existing human Lore workspace and separate sync client require their own configured integration and acceptance.
