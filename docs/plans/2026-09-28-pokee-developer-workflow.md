# Pokee's developers as Wabi users

Date: 2026-09-28. Status: product-planning hypothesis, following Ronin's clarification. The people considered here are the engineers building PokeeAI. They may use any supported AI development tool in the same way Ronin uses an assistant through an application. No assumption is made about their current tools, internal bottlenecks or willingness to change workflow.

The intended value is that a team's separate human/AI work sessions can share a reliable project record: current instructions, who is changing what, relevant source versions, reproducible failures, proposed fixes and verified results. Connecting Pokee's own product as a provider is optional and not a prerequisite for this development workflow.

## What should be immediately understandable

An engineer opens a task and can see the brief, current owner, relevant files, discussion, proposed change and evidence. Their chosen assistant can retrieve the same authorized context, claim the work, submit a result and leave a useful handoff. Another engineer or assistant can continue without reconstructing the project from private chat transcripts.

Wabi provides the shared task/conversation/permission/run record. The developer's existing AI tool supplies assistance through a tested adapter. Lore can preserve deliberately saved artifacts, work bundles, documents and file revisions. Repository integrations must identify which system owns the editable source: a team already using Git must not need a wholesale migration or silent bidirectional duplication merely to try Wabi. Links to existing commits/PRs and explicit versioned artifact exports are a smaller initial adoption step; their implementation still needs a defined contract.

## Benefits to test with a development team

| Development situation | Proposed useful outcome |
|---|---|
| A fresh AI session needs to understand a task | Retrieve a small maintained brief, relevant source references, accepted decisions and active work instead of repeating the full background. |
| Two engineers use different assistants on related code | Shared claims/scope and card discussion expose overlap; separate workspaces and checked integration preserve both contributions. |
| A behavior is reported as broken | Save an authorized, reproducible example linked to the relevant code/configuration revision, environment and observed result. Turn it into a task and regression fixture. |
| Someone submits an AI-assisted fix | Review the actual proposal, checks and known limitations on the same card. Tie evidence to the exact candidate revision. |
| A person, session or computer stops midway | Leave verified saved work, a concise handoff and the next action. A new eligible worker recovers confirmed state instead of repeating or guessing. |

Because they build an AI product, a useful optional extension is versioned evaluation cases: input fixture, prompt/tool configuration, code/model identifiers where available, expected behavior and measured outcome. A human-reviewed failure can become a regression case. Changes to prompts, tools or runtime behavior can then be compared against the same cases. Preserve nondeterminism and environment differences in the report; this is not proof that arbitrary agent runs reproduce exactly. No automatic collection of private chats/customer data or automatic training is implied.

## The first convincing demonstration

Use one disposable representative bug or small product change with two human roles and two supported assistant sessions. Do not require access to Pokee's private source or accounts to demonstrate the mechanics.

1. A developer turns an observed failure into a card with a minimal reproduction, relevant file/revision and acceptance check.
2. Their assistant retrieves that context, checks active work and claims the task. A second developer can see the claim from their own session.
3. A second assistant attempts overlapping work. Wabi exposes the conflict, links the card discussion and records an agreed split or wait instead of permitting a silent overwrite.
4. The first assistant proposes a fix from an isolated workspace. Checks run against the actual candidate and leave inspectable evidence.
5. The second developer reviews the result, requests a correction if necessary and accepts the final version. The card links the accepted source revision and saved artifacts/regression case.
6. A fresh session reads the result and explains what changed and what remains, using the shared record without access to either developer's entire private conversation.

The visual demonstration should make ownership, overlap, test evidence and human acceptance obvious. A Linux worker or Lore transfer is valuable when it supports this outcome; a machine-topology diagram alone does not demonstrate developer benefit.

## Adoption and evaluation

The [full planning and opt-in AI direction](2026-09-28-project-planning-and-opt-in-ai.md)
keeps the original human workflow central: calendars, project journals, nested
projects and navigable entity relationships. It also specifies optional
event-triggered checks and bounded helpers with explicit cost consent. These
are planning requirements, not existing runtime capabilities.

Ronin clarified that the proof must happen in Wabi itself. The
[live in-app test](../testing/PROJECT_IN_APP_PROOF_2026-09-28.md) now exercises the
real Project Assistant, bot claim, input/result wiki and human-account review
with a tiny disposable deduplication task. Live free-model calls performed real
writes, but needed correction and failed to finish the card update; the human
test account completed the reviewed task. This proves the integration path,
not unattended reliability. It identifies concrete adapter/tool improvements
before a repository bugfix demonstration.

The separate [`experiments/ai-team-demo`](../../experiments/ai-team-demo/README.md)
is retained only as a workflow sketch. Its recorded model responses and scripted
coordination are not the primary Wabi integration proof.

The useful entry point is one real task using familiar AI tools, with a clear connection flow and limited project grants. Keep card/wiki collaboration functional without Lore or remote execution. Avoid requiring a new model, repository migration or a new place to duplicate every existing discussion.

Measure time to get a fresh session working, time to reproduce a reported issue, avoidable repeated context setup, human corrections, missed/handled overlaps and review effort. Record observed outcomes without inventing ROI or promising that more agents always increase throughput. A credible demonstration includes one interruption or conflicting edit as well as the successful result.

Questions worth learning in the conversation, rather than assuming answers: where their team currently loses time, whether assistants already share task context, which repository/review workflow is authoritative, and whether reproducing agent failures is a frequent problem. Their answers should select the first pilot slice; the wider Wabi roadmap remains provider-neutral.

Ronin prefers that the team express interest themselves. This is an internal design lens and demonstration plan, not an outreach message, partnership proposal or promise of compatibility. Nothing has been sent to Pokee. Current implemented/tested boundaries remain in the [Assistant acceptance record](../testing/PROJECT_ASSISTANT_ACCEPTANCE_2026-09-28.md); the broader [connection roadmap](2026-09-28-ai-connection-readiness.md) contains the remaining work.
