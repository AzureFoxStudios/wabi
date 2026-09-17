# Production-finish campaign — hard browser QA results 2026-09-17 (final)

## Summary

Real-browser QA completed on `union/production-finish-20260917`.

- Gallery: 15/15 PASS (fixture `frontend/scripts/gallery-workspace-browser-smoke.mjs`)
- Files GF07: 23/23 PASS (fixture `frontend/scripts/files-workspace-browser-smoke.mjs`)
- All pre-existing static gates stay green: `bun run check` 0 errors / 167 pre-existing warnings, `files-workspace-regression.mjs` OK, `filesWorkspaceSession.test.ts` 1/1, `gallery-feedback-regression` 0 fail.

## Bugs found by testing, then fixed (6 product fixes)

Gallery:
1. **Filter empty-state lie** — "No works match these filters" appeared when matches existed in the Recently Uploaded section. `GalleryChannel.svelte`: gallery-section condition now `filteredItems.length > 0` instead of `mainItems.length > 0`.
2. **Creator banner collapse** — banner with no image (offline creator) collapsed to 0 height; "Show all" button overlapped by the header search input. `gallery-channel.css`: `.creator-banner { min-height: 140px; }`.
3. **Marker overlay click-blocking** — `.lightbox-markers` (full-bleed overlay) and the pending-marker preview intercepted clicks meant to place new markers. `gallery-feedback.css`: both now `pointer-events: none`; saved-marker dots keep `pointer-events: auto`.

Files GF07:
4. **GF07-F1 blank space picker** — `<select value={selectedChannelId ?? ''}>` passed a NUMBER while options are strings; Svelte 5's `select_option` uses strict equality (`"102" === 102` fails) and deselects all options. Confirmed with a minimal isolated Svelte 5.56.8 repro (vanilla DOM coerces fine — Svelte-runtime-specific). `FilesWorkspace.svelte`: value now `selectedChannelId === null ? '' : String(selectedChannelId)`.
5. **GF07-F2 two-click context recovery** — component retained `selectedChannelId` across scope retirement, so `reloadSpaces()` never re-triggered the listing. `FilesWorkspace.svelte`: subscribes to `session.onRetired` and resets `selectedChannelId = null`; the auto-pick + listing effects re-resolve on one Retry.
6. **GF07-F3 retried upload never refreshed listing** — `retryUpload` re-ran the job but skipped the post-success listing refresh that the batch path does. `filesWorkspaceSession.ts`: retryUpload now calls `loadFiles` when the retried job lands as `done`.

## Verified passing coverage

- Gallery: render/split counts, search-before-split, no-match + clear, media filters, offline creator filter + Show all, partial/total album 503 with honest warnings and Retry, feedback draft survival across navigation/reopen, failed-save retry persistence, marker placement with existing saved markers, two independent mounted surfaces, zero page errors, zero off-origin requests.
- Files: rendered listing, nested encoded paths, Markdown/SVG previews, object-URL revocation, real binary download byte-equality, listing/preview/search error+retry, cross-space search and space-picker sync, delayed stale-preview isolation, context retirement + single-Retry recovery, optional dependency unavailable/absent-repository states, upload success/failure/retry with listing refresh, 390px viewport bounds, zero uncaught exceptions.

## Reports

- `docs/reviews/gallery-browser-2026-09-17.md`
- `docs/reviews/files-browser-2026-09-17.md`
- Evidence dirs: `/tmp/wabi-gallery-browser-7GNQdX/` (15/0), `/tmp/wabi-files-gf07-BAdplE/` (23/0)

## Campaign status

- Hard real-browser QA: DONE, both suites green.
- 5 product bugs fixed and re-verified; no product behavior weakened.
- Push/merge/deploy: awaiting user word.
