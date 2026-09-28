# Lore in the AI workspace — direction and staged plan

Date: 2026-09-28. Status: planning proposal requested by Ronin. None of the proposed AI/Lore capabilities below are implied by completion of the first three Project Assistant slices. See the [current boundary](../features/PROJECT_ASSISTANT.md#lore-boundary) and [broader organizing-center proposal](../proposals/multi-computer-ai-workers-and-kanban.md).

## Product destination

A Project can become a shared workshop where humans and agents discuss a goal, claim work, inspect the same versioned material, propose changes, review results and leave recoverable work for another authorized computer. Lore supplies versioned project files and artifacts; Wabi supplies the conversation, task ownership, permissions and run record. An external agent runtime supplies execution. Lore alone does not make a model an agent, create a scheduler or provide Authority failover.

The user should see Board, Wiki, Files, Assistant and Review as related views of their Project. A card should answer: who owns this, what revision they started from, what changed, what checks ran, what needs review, and where the accepted result lives. Existing channels, center stage, stubs and optional right panels retain their roles.

## Ownership of data

| Information | Proposed authoritative home |
|---|---|
| Cards, assignees, human estimates, membership, run attempts and approvals | WabiDB through the Authority |
| Source files, assets, proposed changes, saved work bundles and result artifacts | Connected Lore repository |
| Collaborative wiki pages and their edit history | Existing Wabi wiki |
| Repository procedures/specifications | Versioned Lore files, linked from the wiki where useful |
| Model/provider credentials and machine secrets | Scoped worker/operator credential store |

Choose one editable source for each document. A wiki page may link to a Lore document or explicitly publish a versioned snapshot with its source wiki revision. Do not silently create two independently editable copies and call that synchronization. Board/wiki editing must keep working when Lore is unavailable.

## Capability progression

### 1. Connected context

Attach a Lore repository to a Project through an explicit binding and capability check. Reuse the existing channel/repository permission system; access to a Project must not implicitly grant access to another channel's repository.

Add file/revision citations to shared cards and Assistant replies, and create a card from a file or selected passage. Let an agent list relevant files, read bounded content and inspect supported history/diffs. Record the exact repository/revision/path used. Clearly distinguish a pinned revision from a link that tracks later changes.

Acceptance: a human points at a disposable file, the AI reads the authorized version and creates a card citing it. A revoked or out-of-scope read fails. No private repository is included in a provider prompt without the appropriate handoff authorization.

### 2. Proposed work and review

Allow a worker to submit a bounded file change, stage it through the existing Lore review workflow and attach the proposed revision/change to its card. Display the actual diff or asset comparison alongside the explanation and test evidence. A review request names the requested reviewer and exact proposed version; a review becomes stale when that version changes.

Separate the card's workflow status from the repository result: a saved file is not necessarily committed, a commit is not necessarily synchronized remotely, and neither proves a deployed result. Resolve uncertain write outcomes before retrying. Editing, committing, accepting review, syncing and deploying need distinct capabilities and visible outcomes.

Acceptance: read → propose change → human review → accepted revision → second client retrieves that exact result. Exercise a stale edit, rejected proposal, interrupted publish and real configured remote push/pull. Do not count the embedded/offline sync no-op as a remote test.

### 3. Reusable project knowledge and artifact library

Version project procedures, small context indexes, evaluation fixtures and reusable templates. A procedure can identify relevant documents, required tools, expected outputs and checks; executing it still requires the worker's explicit permissions. Text in a repository must not grant itself execution authority.

An AI starts with a small index and retrieves the relevant documents or changes since a known revision. Cached summaries identify their source revisions and are invalidated or marked stale when those sources change. Lore provides a version boundary for retrieval; actual token savings come from selecting less context and must be measured.

Generated or imported artifacts can be explicitly saved into the Project repository, linked from cards and displayed through album/gallery views. Preserve origin, generating run, input revisions and output revision. A display surface must not become a second independently mutable file store. Define retention and storage quotas before retaining large generated outputs by default.

### 4. Work that can move between computers

Store portable work bundles: base revision, saved edits, artifact references, task brief, completed checks, outstanding actions and environment requirements. The Authority records a usable checkpoint only after the referenced content has been saved and verified.

A replacement worker can retrieve that bundle into its own workspace and continue from the last confirmed state. Unsaved edits and live process memory are not recovered. Ronin/Iyoku/etc. should advertise verified capabilities instead of having hard-coded roles. Select a compatible machine for each task; keep live service deployment as a separate policy-controlled action.

This requires worker enrollment, attempt fencing, environment restoration and reconciliation of uncertain external actions. Lore synchronization supplies files, not machine scheduling or Authority high availability.

### 5. A team that leaves reusable evidence

Parallel workers can take independent linked cards with separate workspaces and proposed changes: one implements, another tests on an eligible environment, another reviews documentation or assets. A coordinator gathers results against a specific base revision. Conflicts return to visible review; workers must not share one mutable checkout/current branch.

AI-to-AI discussion is attached to the work request and readable by the same authorized humans. Use concise handoffs and artifact/revision references. Preserve one accountable card owner; helping, reviewing and approving are separate roles. An agent's self-review is not independent signoff.

Accepted fixes can produce regression fixtures and propose improvements to project procedures. This supports “Wabi helping finish Wabi”: future runs reuse reviewed knowledge and checks. It does not imply autonomous model training, automatic deployment or accepting a workflow change solely because an AI scored itself highly.

## Remote execution, validation and overlapping agents

A proposed execution adapter could provision a disposable Linux container or VM from an approved environment profile, retrieve a specific Lore revision into a per-run workspace, run scoped commands/tests and return proposed changes plus evidence. Provisioning permission, allowed resources/spend, network access and expiry are separate from permission to edit repository files. Lore transfers versioned content; the adapter provisions and controls compute. Merely pointing an AI at Lore does not provide this service.

### Review is a publication boundary

“Review changes before accepting” need not mean “ask before every local edit.” A worker can autonomously edit and test in its isolated workspace, then submit its complete proposed result for review. Some tasks only need a document review; executable changes need the source and relevant dependencies available in an appropriate execution environment. Download only the material needed, but report missing dependencies and unrun checks honestly.

Attach evidence to the exact candidate revision: base and proposed revisions, environment/tool versions, check definitions, exit status and output artifacts. Check definitions come from the approved workflow; a worker must not establish acceptance solely by changing a test to agree with its implementation. Screenshots and UI checks remain necessary for visual behavior. Human estimates remain excluded from agent context and execution budgets.

A clean diff or conflict-free merge does not prove correctness. Before accepting several agents' changes, create the combined candidate and run the required checks against that candidate. Any subsequent change invalidates earlier approval/checks as appropriate. Surface “not tested,” “tests passed for this version” and “changed since review” explicitly.

### Collision prevention

**Required pre-edit rule (Ronin, September 28):** Before changing repository code, check the Project's In progress work, active runs and file/resource reservations for the same repository. Identify the files or components you intend to change, claim your task and obtain the required scope reservation. If another human or agent owns overlapping work, coordinate an explicit handoff or agreed parallel approach before editing that scope. Leave unrelated work available to other participants.

Checking is followed by an Authority-checked claim/reservation, not just a prompt instruction. Two agents may both observe an empty board; the reservation operation must resolve that race atomically. A card claim alone does not prevent two different cards from targeting the same file. Compare canonical repository identity across any Project bindings so separate channel views cannot bypass the overlap check.

Repeat the check when expanding scope, resuming after interruption and before publishing. Recheck the expected repository revision at publication. If current ownership cannot be verified, continue read-only investigation rather than assume the files are free. Do not automatically clear someone else's In progress card or steal a human claim because their client went offline; stale ownership needs the defined release/recovery procedure.

Human live work must be represented through a manual claim/reservation or an explicitly enabled editor integration. Board status is declared responsibility, not proof that Wabi can observe every local editor. Unreported local edits remain a reason to preserve isolated workspaces and check file/repository versions when applying results.

Acceptance must include simultaneous claims for the same path on different cards, a human-owned overlapping scope, permitted disjoint work, scope expansion, stale/offline status and a delayed worker returning after handoff. The current Assistant's task claim and single-active-run checks are a starting point; repository reservations and editor presence are proposed additions.

| Layer | Proposed rule |
|---|---|
| Task ownership | Atomically claim a card/run; show owner, active attempt and requested file/resource scope. Helpers get linked work or explicit delegation. |
| Working files | One isolated writable workspace per run. Never have agents switch branches or edit files in the same mutable directory. |
| Overlapping scope | Warn about overlapping paths/components. Reserve non-mergeable assets or exclusive resources. A reservation is not proof that non-overlapping changes are semantically independent. |
| Accepted repository state | Submit a proposal tied to its base revision. Serialize acceptance for the target branch, reject stale expected revisions, and reconcile conflicts explicitly. |
| Validation | Test the resulting combined revision. Bind review and test evidence to that exact result. |
| Worker replacement | Use expiring attempts with a generation checked at every publication. Results from replaced workers cannot update the accepted task/repository state. |
| Outside effects | Give workers draft/workspace access; retain accepted-branch publishing and deployment credentials in the controlled service. Reconcile uncertain external actions rather than blindly repeating them. |

An expired lease does not kill a remote process or revoke credentials held by an uncontrolled CLI. The execution adapter must enforce stop/isolation, and publication must pass through the checked service. If a delayed worker keeps editing its private workspace, those edits cannot overwrite accepted work. File locks help with exclusive assets but do not replace run ownership, version checks or integration tests.

Existing code is not yet this parallel execution contract. The current Assistant allows one active Project run. The Lore service operates through a repository working-tree path; its `create_branch` wrapper currently ignores the supplied base-revision parameter and branch listings return an empty revision hash. Pinned-base creation, per-run isolation and returned revision identity require implementation and acceptance before parallel workers may rely on them.

### Coordination conversations and disputes

Use **card comments/discussion as the default coordination surface**. A separate AI dispute channel is unnecessary. Keep the task description/notes as the maintained brief, comments as the attributed conversation, and detailed tool output in linked run records. Human and AI participants use the same discussion, with clear identities and selected bot replies triggered by explicit requests rather than every comment.

An overlap involving multiple cards has one canonical coordination thread, normally on the currently owning/blocking card, linked from each other affected card. Do not duplicate messages between cards or create a new card for every small disagreement. An independently assigned help/review task can have its own linked card and discussion. An optional Project activity summary can point to unresolved discussions without becoming another required inbox or channel.

Each thread links the affected cards, repository/revision, overlapping scope, current reservation and participating run identities. Humans with the appropriate Project access can inspect and join it. Cross-card links do not grant access to a different Project's private comments. A concise “Needs coordination” item on the card directs attention to the thread; unrelated work can continue. Comments support questions, evidence, review requests and a recorded resolution, while ownership changes use explicit authorized actions.

An overlap creates one deduplicated coordination request. Participants briefly explain their objective, intended changes and dependencies, then propose an allowed resolution: wait for the current owner, divide the scope, accept a handoff, or work in separate agreed workspaces and reconcile later. If the overlap changes the goal or requires priority/policy judgment, ask the authorized human owner once. A broader rewrite does not outrank an existing task merely because an agent asserts it is more important.

Default arbitration preserves the current valid reservation while coordination proceeds. Use explicit project priority/dependency rules for scheduling; timestamps can settle simultaneous claims but are not a measure of a task's importance. The Authority is responsible for validating ownership and applying the resolution. Model confidence, persuasive messages and claims of seniority cannot transfer a reservation.

Conversation and action remain linked but distinct. A proposed resolution names its participants, scope and current state version; acceptance must produce an authenticated control/claim transition. Display “pause requested” until the worker/execution service acknowledges the applicable stop boundary. Preserve the last checkpoint before a handoff. A branch agreement means a separate writable workspace and subsequent version-checked integration; it does not authorize overwriting the original owner's files or bypassing review.

Bound the exchange: for the first design, permit one position from each participant and one proposed resolution, then proceed under existing authority, wait, or escalate once to a human. Deduplicate the same conflict, prevent bot self-replies and repeated mutual summons, and leave the thread visibly waiting while unresolved. An AI conversation must not become an unlimited negotiation loop.

Example: one worker is adjusting a layout while another proposes changing the component structure. Wabi identifies the shared file and current owner. They may agree that the layout worker finishes and saves a revision first, after which the structural worker starts from that revision; alternatively they propose a split or isolated parallel work. A change to a different implementation language is a scope decision for the project owner, not a reason to automatically evict the first worker.

This is a proposed UX and execution contract. Current shared cards have notes but no implemented card-comment discussion. The current Assistant does not start agent-to-agent conversations, implement helper/dispute threads or arbitrate parallel Lore jobs.

### Organizing an existing computer

File organization is a separate workflow from editing a checked-out repository. Start with an explicitly selected directory and a proposed move/rename manifest, then apply an approved bounded batch with an undo record. Refuse changed source files and existing/conflicting destinations rather than overwriting them. Exclude system/private areas outside the granted scope. A user can choose more automation for a dedicated inbox folder; that does not grant control over the whole computer. Lore can version deliberately imported project content, but it is not an implicit backup of every local file.

## First demonstration to build

Use a disposable repository containing a short README and a deliberately inconsistent specification. Ask the Assistant to read the relevant revision, create a linked card, propose one document correction, request human review and record the accepted revision in the wiki/card. Retrieve that revision on a second computer and verify its contents.

This single loop exercises context, file writes, review, durable attribution and real transfer. Add generic repository execution, automatic recovery and parallel workers only after this loop is independently verified.

## Decisions to settle during design

Use the [AI connection readiness roadmap](2026-09-28-ai-connection-readiness.md) for the common handshake, onboarding, change delivery, adapter testing and operational requirements surrounding this Lore flow.

- How an ordinary existing Project gains an optional repository binding without requiring users to recreate the channel.
- Which view owns review requests and how they link to card discussions without duplicate inboxes.
- The first permitted worker write: proposed text changes is the smallest useful start; executable code and large binary workflows need their own acceptance.
- Retention, storage limits and recovery rules for saved work bundles and generated assets.
- The default review policy and separate capabilities for proposing, accepting and publishing work.

The existing Lore workspace/API, citations and sync client are implementation assets to reuse, not evidence that this proposed end-to-end AI loop already works. The July Lore vision and August Planner integration notes are historical context; current source, Project status and new acceptance records govern maturity claims.
