# AI workspace: remaining implementation

Ronin authorized planning and implementation on 30 September 2026. Start state:
`codex/friends-dm-rebuild-20260925`, HEAD
`138abe39e08e400188d1812ed3bfd378df435315`, clean working tree. The September
28 handoff's dirty-tree notes describe its historical checkout, not this one.

## Delivery order

After iRonin's hard freeze, **recoverable worker handoff** is the next priority
alongside simple Codex onboarding. Ronin is the user's preferred stronger
execution computer; Iyoku is optional and lacks the development stack. Treat
iRonin and Ronin as distinct devices, not aliases inferred from this checkout's
hostname. The installed Codex/model version on Ronin must be discovered; no
automatic upgrade or silent model fallback is authorized.

Ronin's follow-up sets this week's first product target: **one existing Codex
chat connects simply to a disposable Wabi Project, reads/claims a card, records
work and leaves a reviewable result**. Prioritize that onboarding slice ahead of
shared planning parity and Lore. Talking to Codex entirely inside Wabi is a
later run/connector integration; attaching Project tools to Codex does not prove
an automatic Wabi chat worker.

The shared test target is **https://wabi.chat**, per Ronin's follow-up. Personal
Planner acceptance remains separate. Public checks on September 30 confirmed
readiness and authenticated Project/wiki routes; this does not prove the new
connection panel has been deployed. Do not deploy the concurrently changing
checkout just to make an external connector test work.

## Connection ownership: future design

Separate connection ownership from participation scope. A person or team owns
the runtime connection; each Project or conversation authorizes its access.
Record owner, operator, hosting device, runtime, model/provider destination,
credential owner, payer/budget and grants independently. A server owner manages
allowed integrations without automatically owning everyone's assistants or
receiving their personal credentials. Show these facts in a connection roster.

Personal AI can help draft with explicitly selected personal context. Enrollment
as a DM participant and automatic access to the other participants' messages
require their consent and compatible room encryption. Project grants never
authorize DMs, personal Planner or unrelated Projects. Team-owned connections
need transfer/rotation/revocation and activity attribution. Three Codex chats
sharing one bot credential are one service identity, not three independently
enrolled workers; distinct worker/run attribution remains subsequent work.

## Native harness commands and simple setup

Connecting Wabi must preserve the user's harness: its commands, session state,
model selection, context controls and approval behavior stay owned by that
harness. The present MCP connector only adds Project tools to an existing chat;
it neither intercepts commands nor forwards Wabi text into the harness. A future
request bridge must advertise supported native commands and preserve their
semantics, distinguish commands from model prompts, and target an explicit
worker/session. Unknown commands need a visible unsupported result. No silent
provider substitution, session reset or automatic subagent/model launch.

Show the AI application/harness, existing-chat vs API-worker mode, owner,
computer/workspace and model/billing source clearly. Owner-entered labels are
not proof of a running worker or a verified Lore binding. Setup should provide
one obvious path and keep command-line details optional. Current candidate
onboarding labels Codex and existing-chat mode, carries optional computer and
workspace labels in the private connection file, and separates Project access
checks from runtime connectivity. The worker request composer is explicitly a
separate queued-worker path. These UI changes are not deployed yet.

## Live board organization (September 30)

The **Codex test** Project now owns eight remaining-work cards: simple AI setup,
Lore/mirror acceptance, shared calendar, shared rich journal, Projects/subprojects,
publish-copy and audiences, multi-computer worker recovery, and native commands
with explicit request bridging. Each includes concrete acceptance criteria.
The setup card is claimed; implementation evidence belongs in card Notes until
comments exist. Other chats independently created geographic and security cards;
preserve their scopes rather than duplicating or claiming their work.

Current live Lore findings: `code-repo` (`ch_61`) is a native gallery upload,
not the full Wabi checkout. A separate disposable source mirror (`ch_c93`)
points at the public Git upstream. Git was missing in Tim's runtime container;
installing `git-core` enabled real listing, byte comparison and refresh. Its
Git tip is `f088da430add22e8b21b6779f1b3bec974c39083`, not this dirty checkout.
The native disposable proof (`ch_c9b`) passed upload/readback, revision and
stale-write refusal. Detach, mirror-manifest revision and mutable-head download
correctness require the candidate fixes and release acceptance. A separately
reported native Wabi-source repo must be audited before selecting one canonical
source. No repository retirement/deletion is authorized by another chat's
message. See the dated acceptance record for actual checks and open gates.

The real Tim Lore CLI subsequently verified the native Wabi-source repository
at `ch_460`: main revision 8, signature
`cb0badaa3907599f39136e0756238627400843872f614b60ca45554c857cc271`.
Its local folder binding is still separate/unverified. The MCP connector now
also supports bounded wiki creation and observed-token updates, with preserved
hierarchy and no blind retry after uncertain creation.

## Ronin workspace context for other AI chats

Verified September 30: this computer reports hostname `dotRonin`; the shared
local Wabi Git checkout is `/home/ironin/wabi`. The organizer is the independent
Authority at `https://wabi.chat`. Its disposable **Codex test** Project is
`ch_c72`. The registered local Codex MCP connection is
`wabi-codex-test-20260930`; its tools currently cover this Project's cards and
wiki, not Lore files or remote execution. Existing chats may need to reload
their MCP tools before discovering the connection.

Lore is the intended versioned file/repository connection, not another name
for this local Git checkout. No `.wabi-sync.json` link or
`.wabi-sync/state.json` baseline exists at this checkout in this inspection.
This does not rule out another desktop binding, but automatic folder sync and
a current live Lore revision are **not verified**. The next Lore task must
resolve the real target channel/repository and its class, compare the intended
files with an exact remote revision, and publish only an explicitly reviewed
set. A smoke fixture is not the complete Wabi repository. Preserve concurrent
changes and secrets; do not enable two-way watch on the busy checkout as an
unreviewed shortcut. Record the actual resulting revision and read it back.

Each AI should inspect its actual hostname, checkout, branch and working tree,
read `AGENTS.md` and `docs/PROJECT_STATUS.md`, then call `project_brief` and read
the assigned card before starting. Keep task progress, results and handoff
context in Wabi. Card ownership does not lock repository files: agree file
scope before editing, or use isolated worktrees for overlapping work. Report
the execution computer, local path and verified Lore binding/revision
separately. An AI that cannot discover the connector should report that gap,
rather than treating a pasted description as proof of a live connection.

1. **Personal desktop acceptance.** Build with both actual bundled resources;
   exercise the real WebView and personal IPC with an isolated profile. Create
   project, task, event and journal with code/image content; quit/reopen; check
   backup/import and missing-sidecar draft/retry behavior. Record Linux evidence
   separately from installed-package, other-OS and physical crash acceptance.
2. **Connect and coordinate.** Implement the existing connection-readiness plan:
   discoverable versioned tools, effective grants and a bounded Project brief.
   Then card comments with help/review requests and distinct owner/helper/reviewer
   roles. Preserve OpenCode, Codex and Hermes as the priority tools.
3. **Shared human planning and publication.** Server-owned calendar, dated
   journal and nested projects, followed by explicit publish-copy into a chosen
   shared destination. Inherit its proven membership first. Add narrower
   audiences only when all reads, searches, downloads and AI paths enforce them.
4. **Lore and execution.** Exact-revision reads, proposals, artifacts and real
   transfer; isolated repository workers; atomic resource claims, checkpoints,
   fencing and interruption recovery. Only then add opt-in event launches and
   bounded helpers with budgets, deduplication and inherited revocation.

Each batch needs actual product evidence and a status-doc update; a proposal or
compile is not acceptance. Keep calendar, journal, poster/convention organization
and personal mode useful without AI or a community account. Never describe the
experimental Anchor/replication paths as HA.

## Worker recovery: portable setup and next acceptance

This is a product feature for any self-hosted Wabi and any owner's computers.
Device names, private addresses, SSH users and local paths belong in owner
configuration, never in recovery code. Workers connect outward to the owner's
chosen HTTPS Wabi Authority using scoped enrollment. No Tailscale, LAN discovery,
inbound SSH or particular AI provider is a prerequisite. Local paths stay local;
a receiving worker resolves the logical repository to its own checkout.

The intended simple flow is **Add computer → verify harness/repository access →
choose backup → choose Ask to resume or opt-in automatic resume**. Show actual
availability, last contact, owner, capabilities and which task is running. A
computer being reachable does not prove a usable developer stack. Harness
commands and session controls remain native. Model availability and billing are
explicit; an unavailable selected model stops the request rather than substituting
another model. An already running standby and a newly launched paid session are
different actions, with separate permission and budget limits.

Recovery needs these implementation gates:

1. Distinct enrolled worker and attempt IDs, scoped grants and server-owned
   heartbeat/lease expiry. Network silence means contact lost; it cannot prove
   the computer is powered off. Authority unavailability stops worker writes and
   takeover rather than letting computers elect their own writer.
2. Durable checkpoints at meaningful steps: card/run, completed actions, next
   action, exact base revision, approved patch/artifact digest and check evidence.
   A card/wiki summary alone cannot recover uncommitted code. Publish only a
   reviewed task artifact, not the entire busy checkout or credentials. Lore
   binding and exact read-back revision must be verified before relying on it.
3. Capability-matched backup selection. Reserve the task/resources atomically,
   increment the attempt, and reject the returning worker's old writes. Do not
   steal an assignee's card merely because their browser disconnected.
4. Resume recorded steps without repeating accepted writes. An uncertain pending
   side effect requires reconciliation/review, never blind automatic replay.
5. Explicit resume policy, allowed backup pool, model/provider, cost ceiling and
   launch permission. Default to an actionable **Resume on another computer**
   control; automation is an opt-in policy, not a consequence of adding a bot.
6. Disposable two-physical-computer acceptance: interrupt A, continue on B from
   verified artifacts, reconnect A and refuse stale writes. Also test missing
   developer stack, unavailable model, revocation, budget exhaustion and loss of
   Authority connectivity. Do not count a mocked protocol test as physical
   computer acceptance.

Current boundary: the bounded Project API worker already has saved tool results,
human-controlled resume, attempt fencing and a two-minute lease. It cannot
execute repository commands. The Codex MCP connection only exposes card/wiki
tools and has no worker heartbeat, automatic dispatch or chat-session migration.
Automatic cross-computer code recovery remains unimplemented and unaccepted.

September 30 candidate hardening: the API worker now checks its current lease
and attempt before a provider call and again after generation, discards responses
after pause/transfer/expiry, and cannot mark the replacement attempt failed.
Lightweight tests exercise takeover during generation, expired lease, stale
returning worker and continuation with recorded results. No server deployment,
remote model call, remote installation or heavy build was performed for this
recovery change.

Subsequent September 30 implementation completed the first bounded recovery
foundation: durable Project-scoped worker enrollment/contact, explicit target
selection, manual transfer, opt-in compatible backups, recovery allowance and
stale-attempt fencing. An optional default-off Connections addon owns the roster,
keeping it out of the ordinary Assistant flow. Real desktop/mobile rendering
passed. Isolated builds and server/engine checks ran on the stronger computer;
two physical computers passed primary-process interruption, actual expiry,
saved-step continuation and returning-worker refusal with a deterministic
provider stub. No model call, native Codex migration or live deployment occurred.
See [contract](../features/PROJECT_CONNECTIONS.md) and
[evidence](../testing/PROJECT_WORKER_RECOVERY_2026-09-30.md).

The earlier hardening-only boundary above records that intermediate checkpoint.
Remaining gates are native harness integration and verified repository artifacts,
checkout/resource claims, unavailable-stack/model acceptance, one-click setup,
cost controls for native launches, and coordinated release/live acceptance.
The current recovery count is not a monetary ceiling. Codex MCP alone remains
card/wiki tools without a heartbeat or dispatching native coding session.

## First batch: known gaps at start

- The staged `wabi-server` predates personal mode. Stage the matching binary.
- Tailcat is missing from the staging directory; fetch the repository-pinned,
  checksum-verified resource rather than excluding resources from the build.
- No installed WebKitWebDriver or current desktop executable. Prepare the real
  native test environment; do not inject a fake Tauri bridge into a browser.
- Existing evidence proves sidecar processes and browser IndexedDB, not the
  complete desktop path. Add a repeatable personal native acceptance harness.

Use disposable local content. External model authorization covers disposable
test content only, with no paid fallback. Leave Tim and existing personal stores
untouched. The canonical detailed designs remain the September 28 plans linked
from `docs/briefs/WABI_AI_IMPLEMENTATION_HANDOFF_2026-09-28.md`.
