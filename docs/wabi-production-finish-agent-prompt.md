# Continue Wabi's production-finish campaign

You are taking over implementation of AzureFoxStudios/wabi. Continue the existing production-finish campaign. This is an execution task: inspect, repair, test, and leave reviewable commits. Do not stop after an audit or replace the existing campaign with another ambitious plan.

## Objective

Bring Wabi toward a dependable limited production pilot: a newcomer can join or install it, communicate, use its exposed workspaces, and return without losing work. An operator can update and recover the instance using the documented procedure.

Finish existing behavior before adding features. Do not call the product production-ready while its required acceptance gates remain open.

## Establish the real starting point

Read AGENTS.md, docs/PROJECT_STATUS.md, docs/architecture/overview.md, the applicable nested agent instructions, and:

- docs/plans/2026-09-15-production-finish-campaign.md
- docs/plans/2026-09-16-production-finish-campaign.md, if present
- The attached wabi-production-finish-continuation.md
- The README and checkpoint inside wabi-production-finish-gallery-bundle.zip
- Relevant existing tests, CI/toolchain files, operator runbooks, and docs/testing/PILOT_DEVICE_CHECKLIST.md

The September 16 campaign filename was not retrievable from main at the last check; it may exist locally or on another branch. Check without overwriting anything. If absent, use the original campaign and continuation, record the absence, and proceed.

Historical handoff snapshot, not permission to reset newer work:

- On September 17, 2026, remote main was d5eba19a7de64c60c6828be3f3447d58570fb330. That includes the wiki follow-up fixes. Preserve them and all subsequent work.
- The operator reported deployment of those wiki fixes. Live source/build identity was not independently verified in the preceding chat.
- Substantial Notes/Reader/Planner/Wiki/Forum, authentication, retention, first-boot, entry/mobile-shell, and release-tooling work already exists. Read the ledger instead of repeating it.
- The Gallery bundle was prepared against that commit but was not applied, committed, pushed, merged, or deployed by the preceding chat.
- Its 36 isolated regression cases reportedly passed. The pinned full suite, semantic Svelte check, static build, real-browser acceptance, and backend/container checks were NOT run for that patch. Treat it as proposed code, not an approved solution.

Inspect branch, HEAD, working-tree changes, relevant recent commits, and the available runtime/test environment. Use a separate branch/worktree when needed. Preserve dirty files and other agents' work; never reset, clean, or overwrite them to obtain a convenient baseline. Do not assume local changes are yours.

Give a short initial baseline and execution order, then start implementation in the same run. Keep discovery targeted; do not spend the entire session indexing the repository.

## First batch: integrate and verify Gallery

Inspect the bundle and compare it with current source. Do not blindly apply it. Where its implementation is wrong, stale, incomplete, or unnecessarily complex, repair or replace it while preserving the intended fixes.

Close these behaviors:

1. Search, media type, and creator filters govern every displayed list. Partition Recent/More Works after filtering. Distinguish no matches from no content; offline creators remain filterable by stable uploader identity.
2. Partial album failures remain visible as partial results with an actionable warning/retry. Total failure is not an empty-success state. Do not imply a capped listing is complete.
3. Late success, rejection, and cleanup cannot overwrite a newer view, clear its loading state, or expose another server/account/channel's content. Independently mounted surfaces must not share mutable request ownership.
4. Upload continuation stays with its captured server/account/channel. After navigation, logout, revocation, or disposal, it must not send subsequent requests using old credentials against a new server or refresh the wrong view. Preserve truthful partial-success/error reporting. Already-dispatched requests may complete; do not pretend cancellation is atomic or delete uploaded files automatically.
5. Lightbox navigation, work identity, close/reopen, subscriptions, and stale component state remain consistent.

Reproduce the reported defects where feasible. Add regression tests that fail for the relevant original behavior and pass after the fix. Run the supplied tests, but evaluate their assertions independently: source-text checks, transpilation, and mocked stores are not browser or semantic-type acceptance.

## Next batch: feedback ownership and the separate Files journey

Gallery feedback is a separate unresolved finding. Inspect frontend/src/lib/galleryFeedbackStore.ts, GalleryLightbox.svelte, their callers, and the backend API.

The reviewed baseline had a module-global feedback cache keyed only by workId and unguarded follow-up reloads. Fix the full lifecycle, not just the cache key:

- Scope content and operations to server/account/channel/work and the owning surface/session.
- Fence late loads and mutation continuations; preserve independent drafts and display real load/save failures.
- Verify album-derived item IDs actually map to the feedback API's expected resource. Do not assume two similarly named resources are interchangeable.
- Exercise identical IDs on two servers, A→B→A navigation, two simultaneous lightboxes, remounts, account switches, logout/re-login, revocation, and navigation during a save.
- Test legitimate token refresh as well as session changes, so defensive guards do not needlessly discard recoverable work.

Client guards are not backend authorization. Verify the server denies unauthorized reads/writes for the resources being exercised.

Then test the actual Files workspace separately: listing, search/filter, nested navigation, upload/download/preview, persistence, denied access, retry, unavailable optional dependencies, account/server switching, and concurrent surfaces. Preserve explicit local pull/upload/overwrite and conflict decisions. Do not introduce automatic synchronization to make the checklist pass.

## Continue the remaining campaign, not just these two batches

Use the original card IDs and acceptance criteria. Reconcile already completed work with current source and evidence. Do not create a competing backlog.

### Reliability, privacy, and all exposed workspaces

Carry forward the unresolved permission/credential, encrypted-attachment, retention/deletion, first-boot, historical-exposure, and recovery cards. Test the supported transports and account roles relevant to each change. Distinguish logical deletion, expired visibility, retained events, uploaded bytes, caches, and backups.

Complete the remaining Notes/Reader/Planner/Wiki/Forum and other exposed-workspace journeys. Include create/open/edit/save/reload, failed-save recovery, competing editors, interrupted operations, account/server changes, logout, permission loss, and pop-outs wherever supported. Preserve writing and old recoverable bytes.

Historical secret exposure requires a recorded, value-free assessment and authorized remediation, not a claim that ignoring files fixes Git history. Do not print secrets, rotate root keys, or rewrite history on your own.

### Design and usability

Perform the remaining broad design pass after the relevant behavior is dependable. Build on existing work rather than resetting the visual direction. Check desktop, constrained dock, phone, keyboard, 200% zoom, contrasting themes, reduced motion, and actual rendered loading/empty/denied/error/saved states. Measure performance before optimizing.

Preserve the layout contract: channels anchor location; center stage owns the primary task; stubs are additive; right panels are optional multitasking. Shared data does not justify deleting simultaneous views or independent drafts. No broad shell rewrite merely to make one screen easier.

### Physical clients and calling

Use the hardware inventory and checklist already in the repository; do not ask me to repeat them. Prepare and run available browser/synthetic tests, but keep physical acceptance separate.

Real devices/participants must establish two-network calling, microphone/output, camera, screenshare, mute/deafen, denial/cancellation, reconnect/network change, leave/kick/logout, and capture cleanup. Test the declared room size before advertising it. Mobile web/PWA is not native-mobile certification; building an installer is not installation/upgrade acceptance.

Do not activate a person's microphone/camera or disrupt an in-use host without appropriate consent. When hardware or participants are unavailable, leave those results untested, provide exact steps, and continue other unblocked work.

### Operator readiness, release, and pilot

Run the existing clean-install, backup/restore, retention, and release-identity drills in disposable environments. Prove first-owner/member setup, representative content/upload, restart, and recovery. Verify advertised alternative install paths separately.

A hosted-data rehearsal needs an authorized preserved copy, compatible keys/state/uploads/config, and a stopped writer or a genuinely supported consistent backup procedure. Test restore, upgrade, and rollback without mutating live data. A binary downgrade alone is not proof of data compatibility or recovery.

Prepare one identifiable candidate with matching source/build identity, artifacts, checksums, supported-client scope, accurate instructions, known limits, and rollback evidence. Keep final candidate validation separate from earlier batch checks.

Prepare the invitation/tasks/feedback kit for the proposed small hosted and independent-self-hosted pilot. Do not count simulated users as independent operators or claim pilot results before people complete the tasks.

## Working rules

- Use bounded, reviewable batches: reproduce → implement → targeted tests → diff review → real interaction where applicable → commit/checkpoint. Continue to the next unblocked batch without asking me to approve every routine fix.
- Follow committed toolchains, lockfiles, and CI commands. Do not upgrade dependencies or replace the testing stack merely to fit your environment. Never weaken assertions, suppress new warnings, or skip failing tests to obtain green results.
- Run focused checks while iterating, then the required broad checks on the final candidate. If you call a failure pre-existing, demonstrate it on an appropriate preserved baseline. Do not repeatedly rerun expensive unchanged suites without a reason.
- Preserve durable record compatibility, generated-protocol workflows, authentication, and the existing architectural boundaries. No speculative database, transport, navigation, or state-management rewrite.
- Wabi is one Authority per community with independent servers selectable by a client. Do not introduce federation, claim certified E2EE/HA, or present trusted backend plugins as safely sandboxed code.
- Do not remove existing capabilities or convert working core features into “unavailable” placeholders just to reduce the acceptance workload. Propose substantial scope changes explicitly.
- If helpers are available, assign bounded, non-overlapping files/tasks and review their actual diffs. You own integration and verification; helper summaries are not evidence.
- Routine source edits, local tests, and reviewable local commits are authorized. Prepare a review branch; push it only when repository authorization permits, and report the actual result. Do not force-push, bypass protections, merge to main, tag/publish a release, change live configuration, purchase resources, or deploy without my explicit approval.
- Keep brief progress updates about concrete findings, fixes, and blockers. Do not repeatedly narrate tool operations or promise asynchronous work.

## Evidence and final handoff for independent review

Maintain one dated checkpoint linked to the original campaign. Use explicit states: implemented, checked, accepted for a named scope, merged, deployed. Never substitute one for another.

For each meaningful change record the card/defect, files, behavior before/after, tested source SHA (or base SHA plus exact diff identity), command/user steps, environment, result, and remaining limits. Evidence from earlier bytes does not automatically certify later edits.

Before stopping, provide a portable, sanitized review packet containing:

1. Base/head SHAs, branch, commits, diff summary, working-tree status, and whether anything was actually pushed, merged, or deployed.
2. What was fixed, what was deliberately left alone, and which original acceptance cards remain open.
3. Exact test/build/browser commands, versions, exit statuses, pass/fail/skip counts, and any reproducible baseline failures. Clearly list every check not run and why.
4. Accessible sanitized logs/reports and screenshots for visual claims, plus reproducible steps. Do not cite an inaccessible old /tmp path as the only evidence. Keep credentials, private addresses, and real user content out of Git and public artifacts.
5. Regression coverage, known risks, dependency/schema/auth changes, and unresolved decisions for an independent reviewer to challenge.
6. The exact next action and any narrowly specified user/device/access requirement. Do not summarize the state as merely “almost done.”

If execution or context limits interrupt the work, preserve a safe checkpoint with precise resume instructions. Do not claim completion. If a tool operation is blocked, report it and use an authorized alternative where available; do not claim a local patch reached GitHub.

Begin with repository-state verification and Gallery patch review, then execute the campaign in this order. Work through everything genuinely unblocked, while keeping physical acceptance, live changes, and release claims honest.
