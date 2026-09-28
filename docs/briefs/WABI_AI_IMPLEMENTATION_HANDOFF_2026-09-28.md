# Wabi AI workspace and personal Planner — implementation handoff

Prepared 28 September 2026. Audience: the next AI working with Ronin on Wabi.

## Start here

Continue implementation from this working tree, preserving all existing work. Ronin explicitly authorized building the features; do not turn a green light into another documentation-only pass. Work autonomously on safe, reversible implementation and verification. Ask only for genuinely missing information or a consequential action requiring approval.

Repository: `/home/ironin/wabi`.

Observed branch: `codex/friends-dm-rebuild-20260925`.
Observed HEAD: `cf00e3cbe37920d6b1da76dff3e9171ab4aac7a5`.

These identify the checkout when this handoff was written, **not a commit containing this work**. The working tree contains extensive earlier/concurrent changes, including untracked source directories. The personal Planner files listed below are untracked. Nothing in this session was committed, merged or deployed. Do not reset, clean, blanket-stash, switch branches, or discard files to get a clean build. Some older docs name another candidate branch; inspect the actual checkout before acting.

Read `AGENTS.md`, `docs/PROJECT_STATUS.md` and `docs/architecture/overview.md`. Apply relevant Planner/frontend/deployment skills. Treat this handoff as a map; current source and durable acceptance records remain authoritative.

## What Ronin is trying to achieve

Wabi should be a useful shared organizing workspace around the AI tools a team already uses: tasks, ownership, context, wiki, evidence, review, handoff and eventually execution across computers. Ronin wants to show this to **PokeeAI's developers as people building PokeeAI**, not propose that their customers use Wabi or require PokeeAI to become Wabi's model provider. Ronin does not want to develop a new AI model or force a repository migration.

Priority personal tools: OpenCode, Codex and Hermes. OpenRouter/free models are useful for disposable proof. Nous Portal, Claude Code and GLM/Zcode are secondary experiments, not established integrations. Never silently fall back to a paid model. Authorization for prior external model tests covers **disposable test content only**, not private project files, diary data or credentials. No outreach to PokeeAI or anyone else is authorized.

Preserve the original human use case: an artist organizes convention season, conventions, poster collections, individual posters, print deadlines and decisions. Calendar, journal and nested projects matter independently of AI.

The latest implementation request was an **independent personal Planner using the Tauri sidecar**. Ronin said “let's add that,” meaning build it. An earlier reply incorrectly updated only the plan; implementation followed and is now in the candidate.

## Implemented: independent personal workspace

Entry: `/personal`, **Open personal Planner** on login, and **Personal workspace** from community-bound My Planner. Navigation to this separate entry uses a full reload. It reuses the existing Calendar, Board, Journal and Projects UI rather than duplicating the Planner implementation.

- Personal ownership does not require a community account, guest session or channel. Local attribution is “Me,” not a previously selected community user.
- In browsers, personal records use a separate IndexedDB identity. Existing server/account records remain untouched. The browser does not have access to native app-folder storage.
- In desktop Tauri, `personal_planner_request` is authorized through the existing local-main-window origin check. The frontend supplies an allowlisted operation and fixed personal scope, never an executable, directory or network URL.
- The bridge invokes the bundled `wabi-server --personal-planner --data-dir <app data>/personal-planner` with private stdin/stdout pipes, bounded input/output, isolated environment and a timeout. It exits after one storage operation. It does **not** start a community, network listener, account bootstrap, helpers, providers or Authority WabiDB.
- Native persistence uses versioned JSON snapshot commits. It reuses the existing nine-collection Planner snapshot contract; these are **not WabiDB community projections**. An OS lock serializes operations, expected revisions reject stale writes, conflict drafts are retained, and synchronized immutable commits retain the preceding complete version. Interrupted temporary files are ignored. Corrupt/unsupported committed storage produces an error instead of being overwritten or silently replaced by browser fallback.
- Limits: snapshot 20 MiB / 10,000 records; IPC input 24 MiB; recovery state 64 MiB / 32 drafts. Limit failures keep the current unsaved draft in memory. Storage is not encrypted at rest.
- Personal entry skips known community boot-brand lookup, relay probing and queue replay. Its people picker does not fetch the community directory; a late in-flight directory response is fenced out. The Project channel-reference picker is hidden.
- Existing validated additive export/import is the explicit content backup and migration path. Account records are not automatically moved or merged. Backups with channel/Lore references cannot be rebound silently into another scope.
- No personal device sync, community publication or personal AI grants were implemented.

### Personal-workspace source map

| File | Responsibility |
|---|---|
| `core/crates/wabi-server/src/personal_planner.rs` | Native snapshot protocol, locking, durable commits, recovery, bounds and five tests |
| `core/crates/wabi-server/src/main.rs` | Private CLI mode before normal server initialization |
| `src-tauri/src/personal_planner.rs` | Authorized/bounded sidecar IPC command |
| `src-tauri/src/lib.rs` | Command registration/module |
| `src-tauri/src/hosting/mod.rs` | Existing origin/binary resolution helpers made crate-visible |
| `frontend/src/routes/personal/+page.svelte` | Independent personal shell and community return action |
| `frontend/src/lib/business/personalWorkspace.ts` | Personal identity/context and local actor |
| `frontend/src/lib/business/deviceStorage.ts` | Ownership switching, retained drafts and storage sessions |
| `frontend/src/lib/business/persistence.ts` | Browser/native persistence dispatch, no silent fallback |
| `frontend/src/lib/business/plannerUsers.ts` | Suppress personal directory traffic and fence late responses |
| `frontend/src/lib/business/personalDirectory.test.ts` | Regression for no personal fetch / stale community response |
| `frontend/src/lib/business/plannerScopes.ts` | Empty personal channel choices |
| `frontend/src/lib/components/business/PlannerWorkspace.svelte` | Personal save label and independent-workspace link |
| `frontend/src/lib/components/business/ProjectModal.svelte` | Hide personal channel reference |
| `frontend/src/lib/components/business/{DiaryView,CalendarImpl,TaskPanel,KanbanBoardImpl,ProjectsView,SignatureRow}.svelte` | Local actor attribution |
| `frontend/src/lib/components/Login.svelte` | Personal entry |
| `frontend/src/routes/+layout.svelte`, `frontend/src/app.html` | Avoid community initialization/branding on personal entry |
| `scripts/tests/personal-planner-sidecar-smoke.py` | Reproducible real-binary process/recovery/restore smoke |

### Personal-workspace verification

See `docs/testing/PERSONAL_PLANNER_ACCEPTANCE_2026-09-28.md` for evidence and limitations.

- Five scoped Rust tests passed: restart/conflict/recovery, damaged/incomplete storage, wrong scope/partial snapshot, locking/duplicates and Unix symlink rejection.
- Real newly built sidecar process smoke passed: separate-process save/readback of disposable project, event and journal payloads, code/image bytes, conflict draft retention, isolated copied-store restoration and invalid-write rejection. Image payload retention is not image decoding; these are not physical power-loss tests.
- 35 focused frontend tests passed across five files. The directory regression was subsequently rerun after fixing its TypeScript fetch mock and passed.
- Final frontend check: **0 errors, 90 existing warnings**. Final static build fingerprint: **`68e25e04a4222f19`**.
- Desktop bridge `cargo check` passed with pinned Rust 1.93. A **build-only** `TAURI_CONFIG` override removed externalBin entries because the checkout lacks the target-suffixed Tailcat resource. That is not packaging proof and must not become release config.
- Real browser preview `/personal`: separate empty inventory, project creation/reload, local sign-off, journal with fenced TypeScript save/reload, and event save/reload. No community login required. Browser proof uses actual IndexedDB, not simulated native IPC.
- Scoped whitespace checks passed. Whole-tree checks still report unrelated login-helper/generated protocol whitespace issues; do not rewrite unrelated work.

**Still unverified:** packaged native WebView-to-sidecar flow, matching installer resources, Windows/macOS runtime durability, fresh-profile offline/network tracing including inherited media/theme preferences, and physical power-loss/IO-fault behavior.

## Earlier completed work: shared Project / AI foundation

Development candidate, not deployed to Tim/public wabi.chat:

- Shared channel-scoped Kanban cards and wiki, bot membership grant/revoke, attributed edits, claims and expected revisions. Human estimates support burndown and are excluded/refused by bot API paths.
- Project center stage groups Board, Wiki, Assistant and Discussion, with optional Lore Files. The broken Project/Chat toggle was removed.
- Native Project Assistant supports reply-only and bounded card/wiki work, explicit provider handoff, saved run/step records and human pause/resume/cancel/takeover controls. Worker limit is twelve tools; it has **no shell, repository execution or Lore tools**.
- Competing card/wiki writes, admission changes, stale worker attempts, replay, restart and revocation have scoped tests. This is not a parallel multi-agent execution system.
- Real external one-shot bridge trials: Hermes v0.20.0, OpenCode 1.18.32 and separately installed OpenCode 2.0.18 each read disposable context and created an attributed card using OpenRouter's free router. These were not separately enrolled durable workers or OS sandboxes.
- Native free-model run with `cohere/north-mini-code:free` completed card/wiki tool steps; reply-only produced a greeting without tools. Free router trials also failed. No paid fallback was used; permanent free quota or independently verified billing is not claimed.
- Iyoku hosted a disposable Authority and Ronin connected remotely. Two humans and a bot exercised shared reads, edits, stale conflict, an orchestrated bot ping/reply, restart readback, revoke and regrant. This is **remote shared-state proof, not automatic recovery or HA**. Iyoku test services/tunnels were stopped afterward.
- Tim was audited read-only and left unchanged.
- A tiny real in-app task deduplicated four synthetic events. The model listed three correctly but reported the wrong count, then corrected it after feedback. Later malformed calls failed. All three runs remain failed. Codex operating a human test account independently checked results and closed the card. Do not describe this as an unattended success or a repository bugfix.
- Worker failure text was corrected to explain that earlier successful steps can remain applied when a later response fails.

Primary evidence: `PROJECT_AI_WORKSPACE_ACCEPTANCE_2026-09-28.md`, `PROJECT_ASSISTANT_ACCEPTANCE_2026-09-28.md`, `PROJECT_IN_APP_PROOF_2026-09-28.md`, all under `docs/testing/`.

Useful code entry points: `frontend/src/lib/components/business/SharedProjectBoard.svelte`, `frontend/src/lib/components/ProjectAssistant.svelte`, `scripts/wabi-project-agent.mjs`, `scripts/wabi-project-worker.mjs`, `scripts/tests/wabi-project-worker.test.mjs`. Read the current API source before changing protocols.

## Earlier completed work: human Planner redesign

See `docs/testing/PLANNER_REDESIGN_2026-09-28.md` and screenshots in `docs/testing/screenshots/2026-09-28-project-proof/`.

- Projects uses a searchable inventory, full-width selected Overview, optional tree, reachable sub-projects, unique descendant active-task rollups and deadlines/work in progress. Charts/sprints remain optional Reports. Insights navigation was retired, with legacy navigation redirected to Projects.
- Journal has a stream/reader/editor instead of an empty permanent sidebar. Sanitized Markdown supports tables and fenced code, preview, inert text/code imports up to 1 MiB, images up to 5 MiB, clipboard image paste and images-only entries. Async imports cannot attach to a different entry. Saved code/image readback and canceled pasted-image drafts were checked in a real browser. Generic binary attachments are still missing.
- Shared-card links became a searchable entity picker with owner/status/context previews. They remain **related-card links**, not typed blockers, task parents, reverse links or comments.
- “Sign off” never published content. It is now **Add my name** with an explicit explanation. Local privacy markers and channel references are metadata, not server access controls.
- A leaked create intent between Board and Projects was fixed; cycle-safe project hierarchy helpers and safe code-fence formatting have tests.

These local Planner views are not the shared server calendar/journal/project hierarchy. A wiki page named “journal” is not the dated Journal feature.

## Agreed direction still to implement

Read the detailed plans rather than inventing another competing architecture:

1. **Finish personal desktop acceptance** first: real native IPC, matching resources, quit/reopen and export/import, unavailable-sidecar recovery, no community setup. Preserve old data and the browser path. Sync is optional and separate.
2. **AI discovery/onboarding and bounded Project brief:** published/versioned tools, effective grants, exact-source context, clear available/configured/connected/healthy states. Keep maintained instructions distinct from untrusted retrieved content.
3. **Card comments/help/review and resumable delivery:** owner, helpers and reviewers have separate roles. Card-specific coordination belongs on the card; cross-card overlap gets one canonical thread. No mandatory “AI dispute channel.”
4. **Shared planning parity:** server-owned calendar/milestones, dated journal, project/sub-project hierarchy and useful entity links, preserving the artist/convention workflow.
5. **Explicit private → shared publication:** choose destination, show effective audience/storage/retention/AI access and exact content preview, publish a copy by explicit action, keep personal original. Updates/removal are separate actions. Name endorsement must never publish.
6. **Visibility layers:** only me / selected people or roles / Project members / everyone on server. First sharing slice inherits a destination's proven membership policy. Do not offer narrower item-level audiences until every server read, download, search, export and tool path enforces them. Admin management is not intended to imply reading all private content; audit actual backend behavior before promising that separation. Server-readable operator access is a separate boundary.
7. **Lore tools and evidence:** scoped exact-revision reads, checked change proposals, review/acceptance, artifact bundles and actual second-client transfer. Human Lore UI exists, but these AI tool integrations were not trialed. Lore is an optional external dependency, not bundled magic.
8. **Worker execution and recovery:** isolated repository workspaces, verified base revisions/checkpoints/tests, atomic task/resource reservations, stale-attempt fencing, uncertainty reconciliation and explicit takeover. Checking In progress before editing is useful, but prompt instructions alone cannot arbitrate races. An offline human is not grounds to steal work.
9. **Opt-in event launches and bounded helpers:** off by default; notify-only / ask-before-run / automatic within explicit grants and budgets. Deterministic event rules, deduplication, recursion protection, inherited revocation, shared budget reservations, bounded depth/count and cancellation acknowledgement. Current one-active-run-per-Project behavior is not a helper tree.
10. **Wiki/assets/Jev:** compact approved playbooks and selective retrieval; measure token cost/quality instead of claiming savings. Albums/inbox can route originals and link provenance, with storage/indexing/model disclosure as separate permissions. Jev-assisted choices are an untested optional idea; choice probabilities are not measured workflow success or permission grants.

Canonical plans:

- `docs/plans/2026-09-28-project-planning-and-opt-in-ai.md`
- `docs/plans/2026-09-28-ai-connection-readiness.md`
- `docs/plans/2026-09-28-lore-ai-workspace-direction.md`
- `docs/plans/2026-09-28-pokee-developer-workflow.md`
- `docs/proposals/multi-computer-ai-workers-and-kanban.md`

## Proof to pursue next

Use an actual disposable Wabi Project and a tiny reproducible bug or documentation task. Save the brief, source revision, proposed result, real check evidence, corrections and review in Wabi. A fresh session should be able to understand and continue from that record. Extend to isolated repository work, then independent review and interrupted-worker recovery as those capabilities are implemented.

The earlier standalone HTML demonstration was only a sketch and is superseded by in-app proof. Do not replace product acceptance with a polished presentation. Do not fake model calls, reviews, passing tests, Lore transfers or failover for a demo.

## Safe continuation commands

Run from repository root unless noted. These check the implementation, not release/deployment:

```bash
cargo test -p wabi-server --bin wabi-server personal_planner::tests --locked
cargo build -p wabi-server --bin wabi-server --locked
python3 scripts/tests/personal-planner-sidecar-smoke.py
```

From `frontend/`:

```bash
bun test src/lib/business/session.test.ts src/lib/business/backup.test.ts src/lib/business/projectHierarchy.test.ts src/lib/business/journalFormatting.test.ts src/lib/business/personalDirectory.test.ts
bun run check
STATIC_BUILD=1 bun run build
```

Desktop compile-only check used here:

```bash
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Do not use that override to claim a working installer or ship missing resources. Follow actual desktop packaging/hosting instructions to stage matching binaries. Do not overwrite a running sidecar or touch real native personal data during tests; use an isolated profile.

The latest localhost preview was `http://127.0.0.1:47332/personal`. A temporary static preview script `/tmp/wabi-planner-preview.mjs` served `frontend/build` and proxied community API paths to disposable port 47311. Its process/session may not survive this handoff. `/personal` browser storage does not require that backend. Port 47332 is preview hosting, **not the personal native storage protocol**. Temporary logs/build scripts under `/tmp` are conveniences, not required durable evidence.

## Non-negotiable boundaries

- Preserve Wabi's channel/center-stage/stub/right-panel layout contract; optional right panels are not required primary destinations.
- Keep credentials, offline data and community state server/account scoped. Personal identity is deliberately separate, not an account merge.
- Generated protocol files are generated. Cargo tests may regenerate them; do not casually hand-edit or discard pre-existing changes.
- Persistent Postcard records need compatibility planning. This slice added separate versioned JSON personal files; it did not change those records.
- Anchor is an experimental proxy role, not an AI worker; WabiDB replication/standby is experimental, not production HA or guaranteed restore.
- Real browser/native acceptance matters. Compile or HTTP success is not UI proof.
- Distinguish implemented, build-checked, runtime-tested, packaged, merged and deployed. Tim was not deployed in this work.
- Private/experimental encryption must not be sold as verified operator-blind E2EE. Local retention and visibility markers are not encryption.
- Do not contact others, expose a host publicly, send private content to a model, provision paid compute or deploy merely because a card suggests doing so.

## Shareable document already delivered

`docs/briefs/WABI_AI_COLLABORATION_OVERVIEW_2026-09-28.md` is the editable overview for PokeeAI developers. `output/pdf/Wabi-AI-Collaboration-Overview.pdf` is the visually checked 11-page handout. Its personal-workspace page now describes the implementation and explicitly lists native release gates. Keep these honest when subsequent work changes maturity.
