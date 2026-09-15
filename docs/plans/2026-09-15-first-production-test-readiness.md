# First production test readiness

**Date:** 2026-09-15

**Audience:** invited users on the hosted instance **and** people cloning/self-hosting Wabi

**Status:** audit and proposed release gates; implementation and deployment are not completed by this document.

Unless specified otherwise, source findings and local checks below refer to `bbcb5b28`. GitHub advanced during the audit; the final upstream snapshot is recorded separately.

**Follow-up:** the [production finishing campaign](2026-09-15-production-finish-campaign.md) supersedes this baseline for current implementation status. Its newer-source review also found separate node/standby administrator decoders; the statement below about shared admin helpers did not cover those routes. The campaign repairs them and records the additional tests.

## Recommendation

Prepare a limited production pilot with an identifiable release candidate. Wabi has enough product breadth for that milestone. The work now is to make its existing workflows dependable, give a new operator a reproducible setup, and finish the most visible interactions.

Do not label the current state production-certified. There are concrete local-data defects, a remaining authentication inconsistency, and acceptance evidence still to collect. Conversely, do not carry old failures forward when current tests or source show they have changed.

Suggested initial scope: one Authority per community, browser clients, chat/DMs/groups, uploads, small calls, and the existing workspace shell. Include Notes as a finished local notebook. Exercise other exposed workspaces enough to make their capabilities, dependencies, and failure states clear. Offer native installers only for platforms actually installed and tested.

## What this audit established

### Source and PR boundary

- Local source: `bbcb5b28d55d8d0a66b30ccb903f64e2681ba808` on `main`.
- GitHub `main` at inspection: [`1bd9479255515334b558bd2bcf2f6bc339d3c763`](https://github.com/AzureFoxStudios/wabi/commit/1bd9479255515334b558bd2bcf2f6bc339d3c763). It is one commit ahead and changes only the Translator Assist settings test.
- The recent integration includes public-site changes, emote work, Reader documents, mobile-shell work, Translator Assist, and other substantial changes. Earlier passing builds do not certify this combined state.
- Initial upstream [CI](https://github.com/AzureFoxStudios/wabi/actions/runs/34926580926) and [Build and Release](https://github.com/AzureFoxStudios/wabi/actions/runs/34926581005) were queued when inspected. Earlier same-day [CI](https://github.com/AzureFoxStudios/wabi/actions/runs/34917698238) and [builds](https://github.com/AzureFoxStudios/wabi/actions/runs/34917698344) passed at `0790aedc`, including macOS universal packaging. The old macOS failure is not evidence of a current failure.
- Open PRs at inspection: [#184 DM/code UX, draft](https://github.com/AzureFoxStudios/wabi/pull/184), [#205 shared media control](https://github.com/AzureFoxStudios/wabi/pull/205), [#207 voice policy](https://github.com/AzureFoxStudios/wabi/pull/207), and [#209 media integration, draft](https://github.com/AzureFoxStudios/wabi/pull/209). These are not included merely because their PRs exist.
- The live hosted executable and frontend were not matched to either SHA during this audit. Local, merged, built, and deployed remain separate statuses.

**Final upstream snapshot, 04:22 UTC:** main moved to [`6d345f49bc6425b8430f822ebf48850f62a9e04e`](https://github.com/AzureFoxStudios/wabi/commit/6d345f49bc6425b8430f822ebf48850f62a9e04e). The [additional changes](https://github.com/AzureFoxStudios/wabi/compare/1bd9479255515334b558bd2bcf2f6bc339d3c763...6d345f49bc6425b8430f822ebf48850f62a9e04e) touch media control, token brokering, helper jobs, Compose, CI, and setup/controller files. Its [CI](https://github.com/AzureFoxStudios/wabi/actions/runs/34928510281) and [build](https://github.com/AzureFoxStudios/wabi/actions/runs/34928510270) were queued. Those changes were outside the local source/test audit. The PR API still showed the four PRs above open: in particular, open #205 does **not** mean its shared-media code is absent from this newer main tree. Reconcile actual commits and retest the chosen candidate rather than relying on PR labels.

### Verification

| Check | Observed result / limit |
| --- | --- |
| WabiDB, pinned Rust and committed lockfile | `cargo test --locked -p wabidb --features test-harness --lib`: **915 passed, 0 failed, 5 ignored**. |
| Focused durability checks | **14 passed**, including subprocess crashes at five write boundaries and restart/replay; a separate replay selection passed 3 tests. These are included in the broader evidence, not additive independent coverage. |
| Existing frontend environment | Check: 0 errors, 165 warnings. Unit tests: 752 passed, 12 skipped, 1 failed. Installed packages and Bun differed from the committed/CI versions, so this is diagnostic evidence only. |
| Known frontend failure | The Translator Assist test expects detection-gated visibility, while current code deliberately keeps its settings discoverable. The newer GitHub commit corrects precisely this stale test. |
| Clean frontend dependencies and build | A temporary **full tracked-source snapshot** installed successfully with `npm ci --no-audit --no-fund`: 241 packages. Check: **0 errors, 166 warnings**. Static build: **passed**. |
| Clean frontend unit tests, CI-pinned Bun 1.3.14 | **759 passed, 3 skipped, 3 failed** on local HEAD. One is the upstream-fixed Translator test. The other two are a confirmed process-wide mock isolation defect in `messageStore.e2ee-boundary.test.ts`: an ordered four-file reproduction gives the same two failures; the affected message-delivery/composer suites together pass **14/14** without that fixture. Isolate the fixture in a subprocess, following existing test patterns; preserve the production assertions. These failures alone do not demonstrate broken user message delivery or logout behavior. |
| Notes persistence demonstrations | Isolated fixture storage reproduced swallowed write failures, authority-ambiguous keys, stale-array overwrite, and a wrong-shape JSON read throwing `TypeError`. These demonstrate defects; they are not passing acceptance tests. |
| Compose syntax | `docker compose --env-file /dev/null config --quiet` passed. The image was not built or booted. |
| Current UI, native devices, deployed calls, restore | Not verified in this audit. Historical screenshots and synthetic tests are not current visual or physical-device acceptance. |

The old “current persistence/recovery regression” language in PROJECT_STATUS and ROADMAP was **not reproduced**. Tie it to a failing example or reconcile the wording with current evidence. A successful engine suite still does not prove a complete operator backup/restore.

## Work to finish, in priority order

**Candidate prerequisite:** record one commit and make its full checks reproducible with committed dependencies. The existing working copy had 17 dependency-version mismatches. The clean snapshot compiles/builds, but the combined unit suite still needs the test-isolation repair above plus the already available upstream test correction. Do not certify a candidate using old installed packages or pre-merge CI.

### 1. Make local notes safe — blocks relying on Notes in the pilot

**Confirmed problems:**

- `notesStore.ts:39` swallows storage failures. Scratchpad save feedback can still say “Saved.”
- `NotesWorkspace.svelte:26,30,78` keeps a separate whole-array snapshot per mounted editor and writes the whole array back. A stale dock/window can erase a note created elsewhere.
- `notesStore.ts:62` keys Notes and scratchpads by user ID without server identity. Authority-local IDs repeat. This affects clients switching servers within one browser origin or native app; separate browser origins already separate browser storage.
- `userNotes.ts:3,54` stores private notes about people in a global map keyed by the subject, without the owning account/server.
- Valid JSON of the wrong shape can crash note loading; deletion is immediate and has no recovery path.

**Done when:**

- [ ] Notes use one consistent collection with explicit account/server ownership and reliable shared state across center, dock, and windows.
- [ ] Failed saves preserve the draft and show an actionable error; a saved indicator follows actual successful persistence.
- [ ] Concurrent changes to different notes survive; same-note conflicts cannot silently discard work.
- [ ] Old local content is preserved during migration. Ambiguous old keys are not silently assigned to multiple accounts.
- [ ] Malformed storage has a recoverable error path rather than looking empty or crashing.
- [ ] Export/import and undo/trash survive reload. Label populated notebooks “On this device.” Explain that server backups do not include browser-local notes.

Implementation references: [Notes store](../../frontend/src/lib/notesStore.ts), [Notes workspace](../../frontend/src/lib/components/NotesWorkspace.svelte), [profile notes](../../frontend/src/lib/userNotes.ts). Existing [Reader document storage](../../frontend/src/lib/readerDocuments.ts) has scope/save/conflict patterns worth assessing for reuse.

### 2. Close the remaining trust and repository-hygiene gaps — before inviting users or encouraging clones

**Authentication:** HTTP's `authenticate_access_token` rejects step-up and non-account credential types. Socket.IO's `validate_token_sync` only rejects refresh tokens, and the later identity path does not restore the missing check. Real step-up tokens use `token_type: "access"` with `stepup: true`.

This is a source-confirmed inconsistency requiring a valid signed credential; no anonymous-access claim or live exploit test was made. Current admin helpers already use the shared account authenticator, so older documentation about independent admin decoding needs reconciliation.

**Repository:** no `data/` contents are tracked in the audited local checkout, but `.gitignore` omits the current default `data/wabi-server/` directory. Generated root keys, JWT secrets, and locks under that directory are not ignored. SECURITY-MODEL also records previously tracked instance secrets remaining in Git history.

**Done when:**

- [ ] Account authentication rules agree across HTTP, Socket.IO, and raw WebSocket; tests reject refresh, step-up, scoped-tool, invalid, revoked, and banned credentials as appropriate.
- [ ] Guest/member/moderator/owner and removed-member tests cover private content, uploads under their actual policy, and privileged actions.
- [ ] The actual default runtime paths are ignored; a repository hygiene check covers generated secrets/state.
- [ ] Historical-secret exposure has an explicit operator resolution. Preserve database key/data compatibility; do not blindly rotate the WabiDB root key.
- [ ] Pilot registration, owner bootstrap, upload/body limits, retention, and optional services have deliberate settings.
- [ ] Public-facing wording matches PROJECT_STATUS: server-readable DMs, no HA guarantee, trusted opt-in backend plugins. Disclose the existing capability-link upload boundary; possession of a generic upload URL can grant access.

Evidence: [Socket.IO authentication](../../core/crates/wabi-server/src/socketio/shared.rs), [HTTP authentication](../../core/crates/wabi-server/src/auth_extractor.rs), [secret history warning](../SECURITY-MODEL.md), [.gitignore](../../.gitignore), [accepted upload policy](../audits/FILE_SECURITY_AUDIT_DECISION_2026-07-31.md).

### 3. Prove installation, recovery, and upgrade — required for both audiences

Use one candidate and the same documented procedure a new operator receives. Start with Docker on a clean machine; test Podman separately if advertising it as supported.

- [ ] Clone the named candidate and run the documented setup with no prior caches, secrets, operator-specific mounts, or manual fixes.
- [ ] Create the owner and another account; send messages/DMs, upload a file, and create representative shared workspace data.
- [ ] Restart and verify logins, permissions, old content, attachments, and new writes.
- [ ] Take a stopped-server backup including required keys, state, uploads, and operator configuration.
- [ ] Restore to a clean location/host, verify old data and permissions, create new data, then restart again.
- [ ] Rehearse the upgrade on an isolated copy of the hosted data. Record rollback compatibility; preserve the prior binary **and** compatible pre-upgrade backup.
- [ ] Record candidate SHA, image/binary checksum, commands, expected results, restore duration, and any compatibility limit.
- [ ] Monitor `/readyz`, disk space, backup freshness/failures, and restart loops. Compose currently probes `/livez`, which only proves process liveness.

The current CI does not boot the advertised Compose image and complete owner registration/persistence/restore. Add a focused clean-install acceptance job. A process returning healthy or serving HTML is insufficient.

References: [Fresh Install](../deployment/FRESH_INSTALL.md), [Backup and Recovery](../deployment/BACKUP_AND_RECOVERY.md), [Compose](../../docker-compose.yml).

### 4. Finish a small, useful linked-notes experience — requested product work

Current Notes supports create/edit/delete, pin/color, compact layouts, and handing a Markdown snapshot to Reader. It has no named-note model, search, internal link resolver, backlinks, or notebook import/export.

**First release scope:**

- [ ] Titles and search.
- [ ] `[[Note title]]` completion and link insertion; keyboard/click navigation and a clear return path.
- [ ] Stable identity through renames, explicit duplicate-title handling, and a clear missing/deleted target state.
- [ ] Backlinks showing which notes refer to the current note.
- [ ] Markdown export/import preserving useful links and a metadata-preserving backup format where needed.
- [ ] One coherent Notes destination. The bottom scratchpad's current “Full” action opens a different collection; either preserve its content through the transition or label it separately and provide “Save as note.”
- [ ] Make Reader handoff understandable: it currently opens a snapshot/working copy, not a live write-back editor for the original note.

Graph view, plugins, folder-vault watching, Obsidian compatibility beyond the agreed link/import subset, cloud sync, collaborative editing, and E2EE are later scope. Local note linking should not require any server federation or identity changes.

### 5. Polish complete user journeys — before the invitation wave

Use the existing Svelte/CSS theme system. Review the default presentation and one contrasting theme. Confirm ordinary laptop width, narrow dock width, phone width, keyboard navigation, text scaling, reduced motion, and an effects-light configuration.

| Journey | Acceptance |
| --- | --- |
| Arrive → join | Clear hosted-instance identity, login/register/guest choices consistent with policy, useful unavailable/closed errors, no unexplained setup decisions. |
| Person → conversation | Recognizable recipient, one obvious DM path, honest unavailable/deleted-person fallback, correct conversation after switching surfaces. |
| Compose → accepted message | Draft survives normal navigation; send/pending/retry/error states are truthful; accepted message appears once; reload and reconnect preserve it. |
| Open → dock → return | Predictable navigation and selection; no lost draft or hidden controls at narrow widths. Existing pop-out paths need actual authentication, targeting, and lifecycle acceptance before being offered as reliable. |
| Create → link → revisit note | Safe persistence, searchable titles, working links/backlinks, local-only label, recovery/export, usable compact editor. |
| Join → share → leave call | Clear device and connection state; reachable mute/deafen/share/leave; permission denial and reconnect are recoverable; exit releases capture. |
| Open a workspace | Notes, Planner, Reader, Files, whiteboard, CAD, Lore, and Admin each have meaningful loading/empty/error states; missing optional services explain what is needed. |
| Return tomorrow | Authentication/session expiry, saved layout, service-worker update/cache behavior, and offline recovery work without reset rituals. |

Treat older polish ledgers as a source of scenarios, not a current bug list. Some September 7 findings were fixed later. Avoid restarting a blanket theme rewrite based on July findings.

### 6. Verify real calls within the pilot's declared limits

- [ ] Two real clients on different networks, including a public internet path and the TURN fallback actually offered to users.
- [ ] Then the intended pilot room size; an initial target such as 6 participants is a proposal to test, not a proven capacity claim.
- [ ] Microphone/output selection, mute/deafen, camera, screenshare and supported sound capture, reconnect/network change, leave/rejoin, and permission cancellation.
- [ ] Kick/removal and logout stop access and capture; no stuck microphone/camera after exit.
- [ ] Record browser/OS/device/network/backend and results. Include native clients only if offered in this pilot.

Existing synthetic browser tests are useful regression coverage. Historical TURN acceptance covered tailnet UDP/TCP, not public TURN/TLS certification. Larger-room and advanced media architecture targets can follow a successful limited pilot.

### 7. Make the repository handoff self-contained

- [ ] Choose a pilot version/tag and supported artifact set. Include commit/build identity and checksums. The latest public release observed was January's [v0.2.2](https://github.com/AzureFoxStudios/wabi/releases/tag/v0.2.2), not the current product snapshot.
- [ ] Fix release automation before promising tag-triggered downloads: `tauri-build.yml` has a tag-only publishing job but no tag trigger; `build.yml` uploads CI artifacts without a release-publishing step.
- [ ] Repair README's bare-Cargo path: install locked frontend dependencies before building. State prerequisites and keep one canonical install route.
- [ ] Remove unsafe lock-removal advice from the older INSTALL page; link to the recovery runbook's process checks.
- [ ] Add contributor instructions, a private security-reporting contact/process, and a bug-report template including build version, platform, reproduction, expected/actual behavior, and safe diagnostic guidance.
- [ ] Publish pilot scope, known limitations, support/feedback destination, backup responsibility, and the hosted instance's actual retention/local-data policy.
- [ ] Refresh screenshots/product claims and the existing [pilot issue #182](https://github.com/AzureFoxStudios/wabi/issues/182) against the candidate. Do not call unresolved PRs shipped.
- [ ] Triage open issues against reachable pilot flows, including [encrypted attachment downloads #214](https://github.com/AzureFoxStudios/wabi/issues/214) if that path is exposed. This does not change Wabi's stated E2EE maturity boundary.

### 8. Run a short pilot and use explicit exit criteria

Suggested first wave: 5–10 invited hosted users plus 1–2 independent self-hosters for about a week, with a named person watching feedback. This is a proposed test shape, not a capacity promise.

**Ready to invite when:** candidate checks are green; identified data/authentication defects are closed; installation and restore pass; core journeys and the declared call matrix pass; Notes meets its agreed scope; known limits and feedback instructions are published.

**Ready to broaden when:** no unresolved data-loss or unauthorized-access issue; self-hosters complete setup without undocumented intervention; tested restarts/updates preserve data; ordinary users complete the core journeys; remaining issues are classified and communicated. Pause expansion for any newly confirmed data-loss/access-boundary failure.

Do not make HA, federation, native-phone certification, every optional integration, or all outstanding PRs prerequisites for this limited release.

## Suggested execution order and ownership

| Batch | Owner | Deliverable |
| --- | --- | --- |
| A: trust and candidate | Frontend + backend/release | Notes integrity/isolation fixes, credential parity tests, runtime ignore rules, secret-exposure resolution, named candidate. |
| B: linked Notes and focused UX | Frontend/design | Safe linked local notebook and accepted high-traffic journeys. Operational rehearsal can run alongside this work. |
| C: operator and device proof | Operator + independent tester | Clean install/restore/upgrade record and real call matrix, followed by a rerun on the final candidate where changes affect those paths. |
| D: handoff and pilot | Release + pilot coordinator | Current artifacts, concise docs/reporting kit, hosted deployment verified against the candidate, then limited invitations. |

## Interface-review scope and limits

Full-mode source review was bounded to Notes, scratchpads, mounts, and Reader handoff. The framework is Svelte 5 with existing plain CSS and semantic tokens. A historical September 8 Notes screenshot informed scenarios; current rendering was not certified.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | Notes timestamp/preview styles | Hierarchy/text-scaling check proposed; current visual appearance unverified. |
| Surfaces | Compact layout, buttons, toolbar, scratchpad transitions | Data-feedback and navigation findings below; current dimensions need rendering. |
| Animations | Specific card transitions and reduced-motion styles | No source-level blocker found; motion replay at 10% speed not performed. |
| Icons | SVG/currentColor Notes controls | No blanket icon replacement justified; current visual alignment unverified. |
| Performance | Whole-array serialization on each edit | Realistic note-library typing measurement required; no measured latency claim. |

### Feedback and predictable controls

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `notesStore.ts:39`; `QuickScratchpad.svelte:36` | Rejected storage writes are swallowed and save feedback can report success. | Persistent save result, retained draft, explicit failure and export recovery. | A visible state must represent the action's real outcome. |
| HIGH | `NotesWorkspace.svelte:26,78`; `notesStore.ts:62`; `userNotes.ts:54` | Separate snapshots and incomplete ownership can lose or mix personal content. | Shared collection, explicit ownership, conflict handling and lossless migration. | Users must be able to trust the content displayed and saved. |
| MEDIUM | `QuickResourcesPanel.svelte:41,105,243` | “Full” opens a different note collection from the scratchpad being viewed. | Preserve content/context or label the scratchpad separately with explicit transfer. | Navigation should preserve the user's intended task. |
| MEDIUM | `NotesWorkspace.svelte:59`; `KeepNotesView.svelte:31,41` | Immediate deletion; local-storage disclosure is primarily an empty-state message. | Recovery/export and a persistent local-only indicator. | Data location and destructive actions need understandable feedback. |

Considered and rejected: a parallel Notes navigation/store architecture, and blanket theme-token cleanup based on old audit findings. Both would increase scope without resolving the verified release risks. A current mobile toolbar taste pass is warranted only after rendering confirms crowding.

**Verdict:** Block reliance on Notes until the HIGH findings are fixed. Whole-product visual acceptance, real devices, performance measurements, and the final deployed candidate remain unverified.
