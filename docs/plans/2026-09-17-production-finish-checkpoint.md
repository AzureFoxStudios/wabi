# Production-finish continuation — September 17

Source of truth: [original campaign](2026-09-15-production-finish-campaign.md), supplemented by [handoff](../wabi-production-finish-continuation.md) and [execution prompt](../wabi-production-finish-agent-prompt.md). This checkpoint does not replace the original cards.

## Baseline and scope

- Base: `d5eba19a7de64c60c6828be3f3447d58570fb330`.
- Review branch: `union/production-finish-20260917`; isolated worktree preserves all original untracked handoffs/presentation/native artifacts. No stash/reset/cleanup.
- September 16 ledger exists locally and was copied without rewriting its historical claims. Its blanket no-deployment statements conflict with later operator reports; live source/build identity is not accepted here.
- Gallery ZIP not found in repository, Downloads or Desktop searches. GF01–GF06 are being reconstructed against current source from the explicit acceptance requirements; no claim to have run the absent bundle's 36 cases.
- Locked `npm ci` succeeded. Node 22.22.2 and Rust 1.93.1 available; system Bun 1.3.12 differs from CI. `npm exec --package=bun@1.3.14 -- bun --version` verified CI's 1.3.14 without changing dependencies.

## Active batches

| Cards | State | Scope / required evidence |
|---|---|---|
| GF01–GF05 / W03 / T02 / U04 | Verified | Gallery filters before partition, partial/total failure states, per-surface lifetime, upload continuation, component reset/disposal. Real-browser synthetic-API fixture `frontend/scripts/gallery-workspace-browser-smoke.mjs` (headful Chromium, 15 assertions) green; 2 product bugs found and fixed (filter empty-state lie, creator-banner collapse blocking Show all). Evidence: `/tmp/wabi-gallery-browser-*/results.json`, `docs/reviews/gallery-browser-2026-09-17.md`. |
| GF06 / W03 / T02 | Verified | Owned feedback lifecycle, draft/save fencing and actual album-derived resource identity. Covered by the same Gallery fixture (draft survival, failed-save retry, marker placement with saved markers, independent center/panel drafts); 1 product bug found and fixed (marker overlay click-blocking). |
| GF07 / W04 | Verified | Files listing/search/nesting/upload/download/preview/retry/context journeys. Real-browser synthetic-Lore fixture `frontend/scripts/files-workspace-browser-smoke.mjs` (headful Chromium, 23 assertions incl. upload success/failure/retry) green; 2 product bugs found and fixed (blank space picker — Svelte 5 strict select_option; two-click context recovery — now one Retry via `onRetired` reset). Evidence: `/tmp/wabi-files-gf07-*/results.json`, `docs/reviews/files-browser-2026-09-17.md`. |
| U01 / T02 guest entry | Observed, not diagnosed | Pre-campaign public-browser guest entry reached shell with zero channels; Notes/Planner still requested sign-in; Chromium reload returned to login. Seen in Chromium and Firefox. Source/build identity and root cause unverified. Shell navigation does not accept authentication or workspace data access. |

## Verification rules

Use exact commands and source/diff identity for each batch. Preserve tests and warnings; distinguish baseline, unit, rendered, embedded, operational, deployed and physical evidence. Named workspace-title changes alone do not certify content rendering. DOM-only clicks cannot certify normal pointer hit targets.

Physical calls/room capacity/native installations, an independently run operator walkthrough, authorized hosted-copy recovery, final live deployment, and real pilot participation remain external acceptance gates. No deployment, push, merge, tag, key rotation or history rewrite is authorized by this checkpoint.
