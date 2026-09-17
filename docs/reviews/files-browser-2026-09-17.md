# Files GF07 rendered browser QA — 2026-09-17

## Result

**21 PASS / 0 FAIL across 21 unique assertion groups.** The two product failures found in the first run (GF07-F1, GF07-F2 below) were fixed in product code and re-verified with this fixture; the fixture's second-Retry check was replaced by a single-Retry recovery assertion that matches the corrected behavior.

- Source baseline supplied at dispatch: `3a888add`.
- Fixture: `frontend/scripts/files-workspace-browser-smoke.mjs`.
- Run: `cd frontend && node scripts/files-workspace-browser-smoke.mjs`.
- Browser: real headful `/usr/bin/chromium-browser`, Playwright disposable browser profile/context.
- Final run origin: `http://127.0.0.1:42821/__files_gf07` (now closed).
- Evidence directory: `/tmp/wabi-files-gf07-BxqCxT`.
- Machine results: `/tmp/wabi-files-gf07-BxqCxT/results.json`.
- Request ledger: `/tmp/wabi-files-gf07-BxqCxT/requests.jsonl`.
- Execution log: `/tmp/files-gf07-run-2.log`.
- `node --check scripts/files-workspace-browser-smoke.mjs`: exit 0.
- Final aggregate re-read from JSON: 21 unique groups, 19 pass, 2 fail; 24 repository, 26 listing, 10 blob requests. Owned Vite port verified closed after cleanup; browser and Vite closed in `finally`.

## What this proves (and does not)

This is **controlled synthetic Lore HTTP fixture evidence, not external Lore integration evidence**. It mounts the unmodified current `FilesWorkspace.svelte` using Vite and Svelte, including real `filesWorkspaceSession.ts`, `api/lore.ts`, `api/utils.ts`, `apiRequest.ts`, Lore tree nodes, Markdown renderer, and file viewer. The actual API helper URLs are fulfilled with synthetic repository/list/blob data. Binary download is a real browser download with exact filename and saved-byte comparison. SVG preview is checked for successful browser decode and subsequent object-URL revocation.

Only shell boundaries are virtual fixtures: channel stores, session/account/server identity, membership callbacks, socket lookup, and toast sink. Context transitions increment a synthetic generation and call the actual session's context listener. Identity strings have no authentication authority; there is no account registration or password entry. No Authority or external Lore process is launched. Requests are restricted to the owned origin. Random Vite port, disposable browser state, and isolated Vite cache are used; neither live `:3001` nor production/user data is touched.

The fixture provides basic theme variables, not the complete production shell/global CSS. Desktop/mobile images are component-harness evidence, not full-shell visual acceptance. Uploads, mirror writes, permissions enforced by a real backend, server persistence, real login/logout wiring, cross-instance mounting, and external dependency installation are **NOT RUN**. Optional service absence is simulated using HTTP 503; absent repositories use HTTP 404. This distinction is retained in visible UI assertions.

## Exact assertion groups

| ID | Assertion | Result |
|---|---|---|
| 01 | Rendered root listing (4 entries), two synthetic spaces | PASS |
| 02 | Expand docs/deep, open `guide & notes.md`, exact encoded nested request and rendered Markdown | PASS |
| 03 | Local filter narrows to bundle, clearing restores rows | PASS |
| 04 | SVG preview decodes to 160px width; closing revokes blob URL | PASS |
| 05 | Unsupported-file preview, actual binary download filename and byte equality | PASS |
| 06 | Preview failure displayed; rendered Retry restores Markdown | PASS |
| 07 | Listing failure displayed rather than empty success; Retry restores Beta | PASS |
| 08 | Cross-space `.md` search renders all 3 matching paths | PASS |
| 09 | Search-result navigation updates rendered space picker | **PASS** (was FAIL in first run — fixed, see GF07-F1) |
| 10 | Partial search retains 2 Alpha matches with warning; Retry restores 3 | PASS |
| 11 | All-space failures render error, not no-match success; Retry restores 3 | PASS |
| 12 | No-match query renders explicit no-match message | PASS |
| 13 | Delayed Alpha preview completes after switching to Beta without replacing Beta | PASS |
| 14 | Synthetic server/account context retirement clears old file rows and preview | PASS |
| 15 | First context Retry reloads same-channel listing in new scope | **PASS** (was FAIL in first run — fixed, see GF07-F2) |
| 15b | Single Retry fully recovers listing — no residual retirement error, no second Retry needed | PASS |
| 16 | Optional Lore HTTP 503 shows “Could not load spaces,” not empty connected-space success | PASS |
| 17 | Optional service recovery through visible Retry | PASS |
| 18 | Repository HTTP 404 shows “No connected spaces yet” and Code-view guidance | PASS |
| 19 | 390px viewport picker fits and document has no horizontal overflow | PASS (bounded geometry check only) |
| 20 | No uncaught browser exceptions | PASS |

## Product findings

### GF07-F1 — Space picker is blank after programmatic selection — FIXED

**Severity: Medium / functional orientation.** Found in the first run; fixed and re-verified green.

1. Open Files with Alpha (`101`) and Beta (`102`) synthetic repositories.
2. Enable Search all spaces, search `.md`, click Beta's `beta.md` result.
3. Beta's tree and Markdown preview rendered correctly, but the space picker was blank (`value: ""`, neither option `selected`).

Root cause: the picker bound a NUMBER (`selectedChannelId ?? ''`) to the `<select value>` while the options use string values (`String(opt.id)`). Svelte 5's runtime selects options with strict equality between the option `__value` (string) and the select value (number) — `"102" === 102` fails, so every option is deselected. Confirmed in a minimal isolated Svelte 5.56.8 repro (value stays `""` for numeric state; vanilla DOM coerces fine, so this is Svelte-runtime-specific).

Fix: `value={selectedChannelId === null ? '' : String(selectedChannelId)}` in `FilesWorkspace.svelte` (select, line ~317). Re-verified with this fixture: assertion 09 now passes.

Screenshot of the original failure: `/tmp/wabi-files-gf07-BxqCxT/failure-9.png`.

### GF07-F2 — Context recovery requires two different Retry clicks — FIXED

**Severity: Medium / recovery.** Found in the first run; fixed and re-verified green.

1. Load Alpha and open README.
2. Trigger the synthetic account/server context callback (new generation and `/B` API scope).
3. Old rows and preview clear; “Your context changed. Reload files.” appears.
4. Click Retry once.

Before the fix: repositories reloaded but the tree still displayed the retirement error (a second Retry inside the file tree was needed). Root cause: `FilesWorkspace.svelte` retained `selectedChannelId` across the retirement while `filesWorkspaceSession.retireAll` emptied the space map; the listing effect depends on that unchanged ID, so no `loadFiles` re-fired after `reloadSpaces()`.

Fix: the component now subscribes to `session.onRetired` and resets `selectedChannelId = null`; the existing auto-pick effect then re-resolves the channel once spaces reload, which re-triggers the listing effect. One Retry now recovers both repositories and the listing. Assertions 15 and 15b (updated to assert the single-click recovery) pass.

Screenshot of the original failure: `/tmp/wabi-files-gf07-BxqCxT/failure-15.png`.

### Additional observations, not failing acceptance groups

- Svelte compiler reports two accessibility warnings: `LoreTreeNode.svelte:36` and `:61`, `treeitem` missing required `aria-selected`.
- At 1440px, the harness text-preview header is cramped (filename effectively hidden while actions consume the narrow pane). At 390px the tree is narrow/truncates filenames. These are screenshot observations, not complete production-shell regressions because global shell styles are not mounted. The mobile PASS is only the stated picker/document bounds assertion.
- Ten browser console errors were collected: five injected HTTP 500s, two injected 503s, two injected 404s, and one intentional revoked-blob fetch `ERR_FILE_NOT_FOUND`. Zero uncaught page exceptions. Do not call this a clean console without explaining the expected fault injections.

## Screenshots

All below are from the final run and remain in `/tmp/wabi-files-gf07-BxqCxT/`:

- `01-listing.png`
- `02-nested-preview.png` — visually inspected; nested Markdown rendered, cramped viewer header noted
- `04-image.png`
- `05-download.png`
- `06-preview-error.png`
- `07-list-error.png`
- `08-search.png`
- `failure-9.png` — blank picker while Beta preview is visible
- `10-partial-search.png`
- `13-channel-scope.png`
- `14-context-retired.png`
- `failure-15.png` — lingering context error after first Retry
- `15b-second-retry.png`
- `16-unavailable.png` — visually inspected, honest optional-dependency error
- `18-absent.png`
- `19-mobile.png`

## Harness iteration notes

The initial run (`/tmp/wabi-files-gf07-CSurlv`, `/tmp/files-gf07-run.log`) reported 17/20 pass. One failure was a harness race: it checked whether the gated network request arrived immediately after the loading indicator appeared. The fixture now waits for gate arrival and waits for actual response completion before checking stale-preview suppression; that check passes. Added UTF-8 response charset, isolated Vite cache (parallel tester safety), richer failure DOM/picker evidence, and a separate second-Retry recovery check. The two remaining failures were not weakened or hidden. Product code was not edited.

Only the browser fixture script and this review were added for this task. No commit, push, deployment, registration, or production integration was performed.
