# Production-finish campaign — Gallery continuation checkpoint

**Date:** 2026-09-16

**Verified starting main:** `d5eba19a7de64c60c6828be3f3447d58570fb330`

**Scope:** resume the existing limited-production-pilot campaign, not start a feature expansion.

## Provenance and current truth

The [original September 15 campaign](2026-09-15-production-finish-campaign.md) remains the detailed card/acceptance ledger. It already contains September 16 implementation entries. The handoff's `2026-09-16-production-finish-campaign.md` was not present on the default branch when this work resumed. This separately named checkpoint does not overwrite or claim to recover an unpublished local copy; reconcile that copy when available.

Main contains the campaign work and the wiki follow-up `d5eba19a`. The operator reports that this was deployed; this session has not independently verified the live binary/assets or exercised the deployed wiki. Preserve those fixes. Historical ledger statements such as “no merge/deploy” describe their original batches, not necessarily the present server state.

The finish line is unchanged: a new person can join/install, communicate, use the exposed workspaces and return without losing work; an operator can update and recover the instance. “Implemented”, “checked”, “accepted”, “merged” and “deployed” are separate states. No whole-wave acceptance is added by this checkpoint.

## This implementation batch

| Change | Implementation and evidence | Acceptance still required |
| --- | --- | --- |
| GF01 — Filters | Search, media type and durable uploader ID filter before splitting Recent/More Works. Offline creators are not excluded just because their presence entry is missing. No-match and clear-filter controls are distinct from a truly empty gallery. | Rendered search/type/creator combinations with fewer and more than six results, in desktop/dock/phone layouts. |
| GF02 — Load failures | Successful albums remain visible with an explicit partial-load warning and retry. Total failure is an error, not “No works yet”. Loading limits are disclosed rather than presented as a complete listing. | Real API partial failures, denial, retry and loading-limit behavior; pagination remains unchanged. |
| GF03 — Request ownership | A factory gives each mounted gallery its own stores and lifecycle, following the existing Wiki/Forum approach. Request order, channel, token, server, session generation, logout/context/revocation and disposal fence stale completions. A retired request cannot start album-item requests against a different server. | Real account/server switches, group removal, simultaneous surfaces and pop-outs. These client guards do not replace backend authorization. |
| GF04 — Upload continuation | Check ownership between album lookup/creation, raw upload and album publication; use the captured server for byte upload. Stop subsequent steps after context changes and do not reload an old gallery over the new view. Retain acknowledged upload counts, show file errors and preserve MIME when a picker omits it. | Real large/interrupted uploads, quota/permission failures, multi-file partial success and recovery. An already dispatched request can complete; this is not transactional upload cancellation or automatic cleanup. |
| GF05 — Component lifecycle | Remove duplicate initial load, reset cached lightbox/upload/filter state on context retirement, dispose subscriptions, and bind lightbox index/visibility so the parent's selected work follows navigation. Preserve channels, center stage, additive stubs and optional panels. | Browser rendering, interaction and feedback target checks. Existing visual styling is retained, not certified as the broad design pass. |
| Status documentation | Correct the obsolete “not yet merged” description of the integrated baseline in PROJECT_STATUS. Do not infer live deployment or pilot readiness. | Final release identity and live acceptance remain separate. |

### Checks actually executed in this session

`frontend/scripts/gallery-regression.mjs` passed **36 cases, zero failures**, using Node **22.16.0** and TypeScript **5.8.3** available in the isolated environment. The script transpiles the actual Gallery store and filtering modules and runs them in separate VM contexts with explicit store/auth/network fixtures. It checks filtering, partial/total failures, retries, late success/rejection, latest-request ordering, A→B→A, session/context invalidation, disposal, independent workspace instances and each upload continuation boundary. The final case is a source-wiring guard, not a rendered UI test.

`frontend/src/lib/galleryStore.test.ts` runs that script in a child Node process under the normal Bun suite. It deliberately avoids global `mock.module` state leaking into other tests.

The local environment could not obtain the repository's locked dependencies and did not provide Bun/Rust. Therefore **the pinned full frontend suite, Svelte check, static build, backend suite, container install, actual browser interaction and device tests were not run here**. TypeScript transpilation is not semantic typechecking. Do not replace the repository's pinned dependencies with these local versions. The existing PR CI must pass before this batch is accepted for integration. The GitHub connector blocked the attempted repository write before commit creation, so no branch, commit, PR or remote CI run was created by this session. The implementation is delivered as an unapplied patch bundle.

After the normal locked install, run from `frontend/`:

```sh
node scripts/gallery-regression.mjs
bun test src/lib
bun run check
STATIC_BUILD=1 npm run build
```

The existing CI also builds the source-only container, exercises a fresh Compose install/restart, runs Rust tests and runs disposable backup/restore and retention drills. The existence of those jobs is not evidence that this candidate passed them. No deployment was performed by this session, and no live data, keys, policies or services were changed.

## Remaining code blockers — next bounded batch

**GF06 — Gallery feedback ownership (source-review finding, not browser-reproduced here).** `frontend/src/lib/galleryFeedbackStore.ts` still has a module-global cache keyed only by `workId`, no explicit session/context invalidation, and unguarded post-mutation reloads. Give each lightbox/workspace an owned feedback lifecycle or an equivalently scoped cache. Capture channel/work/server/account at action start, prevent old completions and follow-up requests from reaching a new context, show load/save errors, and preserve independent drafts. Validate the complete album-derived work → feedback API path rather than assuming the identifier mapping is correct. Regression cases must include identical work IDs on two servers, logout/re-login, navigation during a save and two simultaneous lightboxes. Do not mark all Gallery privacy/interaction acceptance complete until this is resolved.

**GF07 — Complete Files and media journey acceptance.** The separate Files workspace has not been accepted by this Gallery patch. Exercise listing, search/filter, nested navigation, upload/download/preview, denied access, unavailable optional integrations, retries and account/server switching in the actual exposed UI. Preserve explicit user-controlled local pull/upload/overwrite and conflict resolution. Do not introduce automatic synchronization to make the checklist green.

**T/W continuation.** Carry forward the original open permission/encrypted-attachment checks, report/upload/client-cache/backup deletion boundaries, historical-secret exposure resolution and remaining Notes/Reader/Planner/Wiki/Forum recovery cases. Earlier passing helper tests and the wiki patch are not blanket workspace acceptance. Reuse the original card IDs instead of duplicating a second backlog.

## Seven-step completion sequence

| Order | State at this checkpoint | Concrete exit evidence | Execution responsibility |
| --- | --- | --- | --- |
| 1. Reliability and privacy | Significant auth, retention and first-boot repairs exist; unresolved boundaries remain. | Relevant permission matrix and failure tests on the candidate; GF06 resolved; observed retention/deletion matches wording; explicit historical-exposure decision; no known data-loss or unauthorized-access defect in supported scope. | Implementation/review plus operator participation for private exposure and hosted-data evidence. |
| 2. Complete workspace journeys | Notes/Reader/Planner/Wiki/Forum have substantial scoped evidence; Gallery patch is locally checked only; Files and full workspace acceptance remain open. | For every exposed workspace: create/open/edit/save/reload, failure/retry, concurrent surface, account/server switch/logout and permission loss. Record scope and result, or a clear unavailable boundary. | Automated fixtures plus real-browser reviewer. |
| 3. Design and usability | Entry/mobile-shell improvements exist; this is not a completely unstarted effort, but the broad pass is unfinished. | Desktop, constrained dock and phone; keyboard, 200% zoom, contrasting themes, reduced motion; truthful empty/loading/denied/failed/saved states; no high-severity task obstruction. Measure before performance changes. | Browser/visual review with focused implementation fixes. |
| 4. Devices and calling | Physical acceptance remains unproven; synthetic media and SSH access do not substitute. | Two real network paths, Linux/Windows/mobile-web pairings, mic/output/camera/screenshare, mute/deafen, denial/cancel, reconnect/change-network, leave/kick/logout with no lingering capture. Test the declared room size, initially six, before claiming it. Install/upgrade each advertised native package. | User/participants with real hardware, using the existing device checklist. |
| 5. Operator readiness | Build identity/release tooling and disposable rehearsal work exist; final clean-host and hosted-copy proof remain open. | Locked clean install without private prerequisites; first owner/member, content/upload, restart; stopped-copy backup including keys/state/uploads/config; restore/upgrade/rollback on isolated copies; a second operator follows the docs unaided. Test Podman separately if advertised. | CI/disposable hosts plus authorized operator. |
| 6. Verified release and deployment | Current deployment is operator-reported; no final candidate certificate from this batch. | Freeze one source SHA, run final checks, record artifacts/checksums/manifest; preserve compatible backup and prior artifact; deploy deliberately; match server/client/build identity; verify origin/public auth, assets/cache, uploads and a real user journey. | Release coordinator and authorized operator. |
| 7. Invited pilot and decision | Not accepted. | Proposed 5–10 hosted testers and 1–2 independent self-hosters, task checklist and one feedback destination; version/device/network context on reports; fix/retest serious defects; documented expansion decision. | Pilot coordinator, testers and independent hosts. |

Steps 1–3 may progress in bounded parallel batches. Step 4 can be prepared alongside them but must exercise the selected candidate. Step 6 requires the preceding applicable gates; a source patch alone is not permission to skip backups or cut over a live host.

Use [PILOT_DEVICE_CHECKLIST](../testing/PILOT_DEVICE_CHECKLIST.md) rather than asking for the already recorded hardware inventory again. A real second network/participant and actual results are still needed. Treat mobile web/PWA separately from native Android/iOS certification.

## Evidence record and stop conditions

For each accepted card, record: card ID, source/build SHA, platform/browser/runtime, data/network setup, exact command or user steps, expected result, actual result, sanitized log/screenshot location, remaining limits, and reviewer. Keep private host addresses, credentials, recovered keys and real user content out of Git.

Release expansion stops for confirmed data loss, credential/permission leakage, unrecoverable upgrade/restore, or an unauthorized call audience. Preserve evidence and the prior working artifact. Never overwrite damaged persisted state, rotate root keys, erase local drafts or rewrite repository history simply to obtain a passing check.

**Verdict:** continue implementation from the integrated baseline. This batch closes the three reported Gallery-listing defects at the implementation/isolated-test level and hardens upload continuation. It does not accept all Gallery/Files, broad design, hardware calls, clean installation, hosted recovery, deployment or the pilot.
