# Live proof inside Wabi — 2026-09-28

Ronin clarified that the useful demonstration belongs in the actual Wabi app,
not a separate HTML simulation. This test uses the existing Project Board, Wiki
and Assistant on the disposable loopback Authority at `127.0.0.1:47311`.
It is not a deployment to the public `wabi.chat` service.

## Task and observed result

The human test account created **Live in-app proof: repair a reconnect sample**
in **Disposable AI project**, with four synthetic events on the input wiki page.
The task was to remove a repeated ID while preserving first-seen order and the
latest value, write a result wiki page, and leave the card for review.

All three requests were submitted through the native Assistant UI, using work
mode and the existing approved disposable-content provider handoff. The existing
worker called `cohere/north-mini-code:free` live. No prerecorded model responses,
mock provider, new model development or new product UI was used.

Observed behavior:

1. The bot read and claimed the real shared card, changing it to In progress with
   bot attribution. It read the input wiki and created the result wiki.
2. The event list was correct, but the model incorrectly reported two unique IDs
   while returning three. Its next action was malformed, so the run stopped.
3. Explicit feedback through Assistant corrected the same wiki page to three
   unique IDs. Its subsequent card update omitted required fields and was
   rejected. A final narrow continuation also returned an invalid action.
4. Independent API readback verified the corrected JSON against the original
   sample: four inputs, three unique IDs, duplicate `event-a`, correct order and
   latest text, with the original input unchanged.
5. Through the real browser, the human test account saved these findings and
   limitations in the card notes and moved it to Done. A separate API read
   confirmed human editor #25, retained bot assignee #17 and the saved outcome.

The result page is **Live proof result: repaired reconnect sample** (`page_69`);
the input is `page_5e`. The card is
`task_8feb05388ee1480e86f98af26bfa472d` in `ch_9`.

## Honest acceptance boundary

The real card/wiki integration worked, and a reviewed data task was completed.
**The model did not complete the workflow autonomously.** All three runs retain
their failed status and recorded steps in Assistant history. Human correction,
verification and final card editing were necessary. Moving the task to Done
does not turn its failed AI runs into successful ones.

This is a useful integration proof and a failed unattended-acceptance attempt.
It is not a code bugfix, code execution test, second AI reviewer, card-comments
implementation, Lore round trip, remote-worker failover or public deployment.
The test account's review was operated by Codex; it is not an assertion that
Ronin personally reviewed or approved the result.

Credential-free [saved evidence](PROJECT_IN_APP_PROOF_2026-09-28.json) records the
input/output, bot claim, three run outcomes and final human-account review.

## Follow-up selected by this test

- Improve structured action reliability and test the chosen model/adapter
  against a tiny repeatable task before promising unattended work.
- Make card update tools easier to use correctly while preserving revision,
  admission and field-preservation checks. Do not weaken validation to make a
  malformed action succeed.
- Fix partial-run wording: “no edit was attempted” describes only the rejected
  response, yet can read as if earlier successful writes never happened. Show
  completed writes and remaining work clearly on a stopped run.
- Keep the primary demonstration inside Wabi: task, bot ownership, saved result,
  verification and human decision. Expand to a small repository bugfix only when
  an existing coding-agent adapter can provide actual source/test evidence.

The separate `experiments/ai-team-demo` page is retained as a workflow sketch,
not the primary proof of Wabi integration.

## Requested screenshots

Captured from the real in-app browser on 2026-09-28 during the subsequent
planning discussion. They show saved state from the earlier live proof; they are
not images of another AI run or of the standalone HTML demo. No product behavior
or test data was changed for these captures.

- [Shared board and human-only burndown](screenshots/2026-09-28-project-proof/01-shared-board.png)
- [Reviewed card, bot assignee and current linked-card picker](screenshots/2026-09-28-project-proof/02-reviewed-card.png)
- [Corrected wiki result](screenshots/2026-09-28-project-proof/03-corrected-wiki.png)
- [Existing My Planner Calendar/Journal/Projects navigation](screenshots/2026-09-28-project-proof/04-existing-my-planner.png)

Additional existing-UI references captured for the requested planning critique:

- [Insights empty state](screenshots/2026-09-28-project-proof/05-insights-before.png)
- [Journal empty state](screenshots/2026-09-28-project-proof/06-journal-before.png)
- [Projects empty state](screenshots/2026-09-28-project-proof/07-projects-before.png)

These three show the empty disposable account, not a populated visual acceptance
test or an implemented redesign. The [redesign mandate](../plans/2026-09-28-project-planning-and-opt-in-ai.md#visual-redesign-mandate--insights-journal-and-projects)
records the decisions and remaining validation.

The earlier independent API check is the evidence for the saved wiki revision;
the screenshot's revision-count label is not an acceptance assertion about the
history UI. Calendar screenshot shows the existing **personal** Planner, not a
new shared or AI-accessible calendar.
