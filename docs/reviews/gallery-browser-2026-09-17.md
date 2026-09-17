# Gallery rendered browser QA — 2026-09-17

## Result

**15 PASS / 0 FAIL across 15 unique assertion groups.** Three product bugs were found across iterations and all were fixed in product code, re-verified with this fixture until green.

- Fixture: `frontend/scripts/gallery-workspace-browser-smoke.mjs`.
- Run: `cd frontend && WABI_SMOKE_CHROMIUM_PATH=/usr/bin/chromium-browser node scripts/gallery-workspace-browser-smoke.mjs`.
- Browser: real headful `/usr/bin/chromium-browser`, Playwright, 1440x900.
- Synthetic network/auth: all `/api/*` requests fulfilled by the fixture (albums, items, feedback). No Authority, registration, accounts, or passwords. `SYNTHETIC API / AUTH` label is rendered on the page itself.
- Final run evidence: `/tmp/wabi-gallery-browser-7GNQdX/results.json` (15/0). Earlier iterations: `-mA5kGO` (13/2), `-wEeHhB` (14/1), `-UcHkQB`/`-s9XSkp` (11/3).
- Final run: zero uncaught page errors; zero unconfigured/off-origin requests.

## Assertion groups (final state, all PASS)

01 Initial render: nine works, six recent and three older
02 Search filters FULL collection before recent split: older caption match is reachable
03 Nonempty matching results must not simultaneously claim no works match
04 No-match state and Clear filters restore all nine works
05 Media filters: Images = eight; Video = one; All = nine
06 Offline creator stable-id filter yields four works and Show all restores nine
07 Partial album 503 keeps seven works, explicit warning; Retry restores nine
08 Total album 503 shows error not empty; Retry restores nine
09 Feedback unsent marker/text survives work navigation and close/reopen
10 Feedback failed save retains draft; Send retry persists to synthetic API and clears submitted draft
11 Existing saved marker must not block placing a second marker
12 Two mounted Gallery surfaces maintain independent filters and survive panel disposal
13 Panel feedback draft does not replace center feedback draft on same work
14 No uncaught browser page errors
15 No unconfigured API or off-origin requests escaped the synthetic boundary

## Product bugs found and fixed

### G-F1 — “No works match these filters” shown while matching results exist

When a search matched only works in the “Recently Uploaded” section, `mainItems` (= `olderItems` when no creator filter) was empty, so the gallery-section `{#if}` fell to the no-match empty state even though `filteredItems.length > 0`.

Fix: `GalleryChannel.svelte` — condition changed from `{#if mainItems.length > 0}` to `{#if filteredItems.length > 0}`.

### G-F2 — Creator banner “Show all” button unreachable without a banner image

For creators with no `bannerUrl` (e.g. offline creators), the banner image is conditionally skipped, leaving `.creator-banner` with zero height; its absolutely-positioned content overflowed upward and the header search input intercepted the button.

Fix: `styles/components/gallery-channel.css` — `.creator-banner` now has `min-height: 140px`.

### G-F3 — Marker overlay blocked placing new feedback markers

`.lightbox-markers` (absolute `inset: 0`) had `pointer-events: auto` with no click handler, so once any marker existed the full overlay swallowed clicks meant to place new markers; the pending-marker preview (a visual-only div) also intercepted.

Fix: `styles/components/gallery-feedback.css` — `.lightbox-markers` and `.lightbox-marker-pending` now use `pointer-events: none`; the interactive saved-marker dots keep `pointer-events: auto`.

## Boundaries

This is controlled synthetic API/auth evidence for the rendered GalleryChannel + GalleryLightbox + stores + API clients. It is NOT backend/runtime acceptance: no real Authority, no album persistence, no authenticated uploads, no cross-user visibility. Uploads are not exercised in this fixture.
