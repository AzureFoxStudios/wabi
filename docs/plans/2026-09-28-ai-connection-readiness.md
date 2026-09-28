# AI connection readiness — remaining Wabi and Lore work

Date: 2026-09-28. Status: proposed implementation roadmap. This consolidates the [organizing-center proposal](../proposals/multi-computer-ai-workers-and-kanban.md) and [Lore workspace direction](2026-09-28-lore-ai-workspace-direction.md). It does not mark these capabilities implemented or deployed.

## Meaning of “AI-handshakeable”

An authorized person can connect a supported agent runtime through a documented flow. The runtime identifies the Wabi server and supported protocol, authenticates its own identity, discovers its actual tools/resources and grants, gets a bounded Project brief, performs an authorized action, receives its durable result, observes changes and handles interruption or revocation without guessing. Connecting requires no bespoke database access or unpublished operator instructions.

A model API, an agent runtime and a computer worker are distinct participants. A model provider generates output; a runtime selects and invokes tools; a worker executes in an environment. Capability levels allow a card/wiki collaborator to be fully supported without pretending it can run commands, manage machines or resume a remote process. No universal compatibility claim follows from one API-compatible model test.

## Existing foundation

The local candidate has shared cards/wiki, authenticated bot Project membership, card claims and revision checks, native Project Assistant, a bounded API worker, saved run checkpoints and human controls. Its limited acceptance is [recorded separately](../testing/PROJECT_ASSISTANT_ACCEPTANCE_2026-09-28.md). Lore has an existing optional human workspace, API and separate folder-sync client; the new Assistant has no Lore tools. Card comments, automatic channel/DM connectors, worker enrollment, repository reservations and multi-computer execution remain future work.

## Remaining contracts and completion tests

| Area | Required behavior | Completion evidence |
|---|---|---|
| Discovery and compatibility | Publish versioned tool/resource descriptions, schemas, limits and supported operations. Effective tools are the intersection of server support, connector support and granted access. Distinguish available, configured, connected and healthy. | A new connector discovers card/wiki support; missing Lore/execution is explicit; an incompatible required version fails clearly; a supported older connector still works. |
| Identity, onboarding and lifecycle | An owner connects a service through existing settings, selects Project/repository scope and an allowed data destination, and can rotate/revoke access. Keep service, runtime, device, run and delegated child identities separate. Children receive no broader grants. | Connect, grant one Project, perform a test action, rotate credentials and remove the service. Old credentials and delegated attempts stop working; unrelated Projects remain inaccessible. |
| Project bootstrap and context | Supply a small “start here” brief: objective, current instructions and revisions, active work, relevant wiki/Lore references, permitted tools and budgets. Separate maintained instructions from untrusted content. Use pagination, bounded search/reads and explicit truncation. | A new agent starts a disposable task without a full-history dump. Source changes invalidate cached summaries; access revocation invalidates retrieval. Human estimate values never appear in bot context. |
| Change delivery and resume | Define versioned events or a cursor-based poll contract with stable IDs, ordering rules, gap detection, acknowledgement and snapshot fallback. Deduplicate requests/callbacks; report confirmed, refused and uncertain outcomes distinctly. | A disconnected connector catches up on changed cards, mentions, review decisions and revoked access. Duplicate/out-of-order delivery neither loses changes nor repeats an edit. |
| Conversation and collaboration | Add card comments, addressed help/review requests, one canonical overlap thread and a human attention view. Ordinary comments do not automatically create work. Scope-changing steering gets an acknowledged instruction revision. | Human and bot coordinate an overlapping task, make an explicit handoff and see the same state. Bot reply loops stop; old instructions cannot publish after supersession. |
| Lore work and publication | Establish an explicit repository binding, actual base-revision identity, isolated workspaces, scoped reads, checked proposals and review tied to exact revisions. Define commit, publish/sync and deploy as separate outcomes. | AI reads a file, proposes a change, supplies evidence, obtains required acceptance, and a second client retrieves the accepted revision. Stale edits and embedded-mode no-op remote sync cannot masquerade as success. |
| Execution and resources | Define approved environment profiles, scoped directory/tool/network access, machine capabilities, worker-owned temporary resources, quotas and expiry. Separate permission to provision compute from permission to edit or publish. | A disposable Linux worker runs approved checks and returns attributable results. Cancellation/restart cleans up or visibly retains owned resources; no abandoned VM/process silently continues consuming resources. |
| Scheduling and collisions | Atomically claim tasks and repository/resource scope, expose human work, bound delegation, preserve queue fairness and reject stale worker generations. Separate workspaces are mandatory for concurrent edits. | Two simultaneous claims resolve correctly; disjoint work proceeds; overlapping work coordinates through card comments. The combined proposed revision passes the required checks. |
| Recovery, budgets and removal | Reconcile uncertain operations, verify artifact uploads before acknowledging checkpoints, reserve shared budgets, stop new dispatch when disabled, and preserve useful work before cleanup. Support export and backup/restore of records plus referenced Lore content. | Stop worker A, recover a verified checkpoint on eligible B, then reconnect A and reject its old writes. Provider/Authority loss, interrupted upload, exhausted budget and revoked identity each leave an understandable state. |
| Adapter conformance | Publish small examples and a reusable test suite. Record capabilities per tested runtime/version, including tool invocation, auth, output/error shapes, pause/cancel and context transfer. | Prioritize OpenCode, Codex and Hermes using their supported integration mechanisms. Other providers/runtimes join through the same checks; an API-key handshake or hello reply alone is insufficient. |

## Decisions that prevent conflicting implementations

- Preserve WabiDB ownership of task/run/permission/review records and Lore ownership of versioned files/artifacts. Define one editable source per document; imports/exports name their source revision.
- Use ordinary Project permissions as a baseline, with explicit repository and execution capabilities. Binding another repository never unions audiences or grants access implicitly.
- Card discussions own task-specific coordination and review conversation. A Project attention view links to unresolved items; no mandatory new dispute channel or duplicate inbox.
- A proposed v1 connection contract must specify the wire schemas, error/retry semantics, grants, delivery rules and lifecycle. Existing HTTP operations are a foundation; an optional MCP facade or runtime-specific adapter must reuse the same enforcement.
- Approval applies to a specific action/scope/version. Editing a playbook, changing providers or delegating to another worker cannot silently expand it. Preserve existing DM device/encryption rules; Project context consent does not enroll a bot into private DMs.
- Host execution stays optional. A user can connect an AI that only handles cards/wiki, or disable AI and continue using the human Project.
- Maintain truthful availability and completion states: a claimed task is not proof of current activity; a requested stop is not an acknowledged stop; a saved file is not a remote publish; a passed check belongs to the tested revision.

## Build order

Ronin's subsequent [full planning and opt-in AI direction](2026-09-28-project-planning-and-opt-in-ai.md)
adds explicit preservation gates for Calendar, Journal, true subprojects,
entity-linked cards and human-controlled event triggers. The existing shared
Board/Wiki work is not full Planner parity. Carry those product gates alongside
the connector phases below; do not enable delegation before budget reservation,
revocation and event-loop prevention are proven.

The [Pokee developer-workflow lens](2026-09-28-pokee-developer-workflow.md) gives these technical phases a concrete team-development outcome: familiar assistants collaborating on a real task with shared context and inspectable evidence. It does not require Pokee to become Wabi's provider or their team to migrate its existing repository.

1. **Connection contract and onboarding:** specify v1 schemas, effective capabilities, grants/errors and bounded Project bootstrap. Prove the existing card/wiki loop through this flow with one priority runtime.
2. **Card collaboration and change delivery:** comments, explicit help/review actions, attention summaries, resumable updates and loop prevention.
3. **Lore context and citations:** binding, permission-checked bounded reads, actual revision identity and file/card links. Preserve full usability with Lore disabled.
4. **Lore proposals and review:** one isolated workspace, checked text changes, durable proposal/review evidence and a real second-client transfer test. Add approved executable checks when an execution profile exists.
5. **One managed execution worker:** environment setup, resource limits, checkpoints, acknowledged controls, cleanup and a stable adapter conformance suite.
6. **Two-computer recovery, then parallel work:** exercise failure and stale-worker cases before enabling overlapping jobs. Add reservations, bounded coordination and combined-result testing.
7. **Broader integrations and release:** validate each priority runtime, optional provider/service adapters, ordinary-channel/DM policies where supported, real browser/native UX, operator setup and backup/restore. Publish the tested capability matrix rather than a blanket “works with every AI” claim.

## Definition of done for the first connected Lore worker

From a fresh supported runtime, an authorized owner connects to a disposable Wabi Project without hand-editing private server data. The runtime discovers its grants, reads the bounded brief and a specific Lore revision, checks active work, claims its allowed scope, proposes one change, records tests where required, discusses review on the card and publishes only the accepted result. A second client reads that exact result. Duplicate delivery, a competing human edit, expired/revoked access, missing Lore/provider and interruption produce the specified safe, visible outcomes. The operator can stop and remove the connection without losing the human Project.

This is a complete map of the major intended work areas, not a claim that every schema or engineering detail has already been settled. Each phase needs a concrete contract and evidence before its status changes to implemented/tested/deployed. Automated model judging may assist review or routing; it cannot replace authenticated grants, actual checks or required human acceptance.
