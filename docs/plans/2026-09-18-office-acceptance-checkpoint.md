# Office workspace acceptance checkpoint — 2026-09-18

Scope: PR #236, shared Documents and independently optional Sheets / Present. Existing owner-reported hosting/calling acceptance is unchanged; Music remains paused. No merge or deployment is authorized by this checkpoint.

## Current verification

The source-writing diagnostic pass has committed fixes through `c456a4b6965acfe624d4229deebfa4043bb3fc90`. This checkpoint deliberately triggers the ordinary read-only PR acceptance workflow against the integrated source. Its results are pending, not passed.

The preceding integrated checkpoint `d4393ed6d210bd569b7e0739bcc479c48fdb8aa1` built the expanded frontend and ran 55 focused tests: 54 passed, one failed. The failing export test mistakenly counted an empty `ppt/embeddings/` directory as embedded data; the corrected assertion still rejects every actual embedded file. It also exposed a table-cell TypeScript mismatch and Rust protected-range visibility errors; those were fixed rather than suppressed.

Current work includes private/snapshot/live artifacts, durable drafts and recovery, document collaboration/reviews, protected and conflict-preserving sheets, literal-safe file round trips, native slide objects and pinned charts, explicit revision approval, stable slide/object references, link-only chat drafts, private Planner task handoffs, and optional consent-gated PPTX/ODP static conversion. See `docs/operations/office-workspaces.md` for installation, privacy boundaries, and limits.

Native crop preview is not redaction: crops must be finalized into new pixel data before audience publication. The audience DTO excludes unused legacy canvas text/image fields, hidden slides, removed objects, and device-private speaker notes. A frozen presentation preview is rechecked after synchronization so later changes are not silently approved.

## Gates still requiring actual evidence

- Ordinary read-only acceptance at the latest head: typecheck, focused tests, expanded build, real Authority/storage contracts, converter fixtures, Chromium and Firefox browser acceptance, and all four addon build profiles.
- Existing Reader regression suite at the same integrated head.
- Native installer/device and manual owner acceptance of these new workspaces. Automated Chromium/Firefox tests are not native-device acceptance.
- Minimum-system startup/memory/performance targets. Bundle evidence now includes raw and gzip byte counts, but those sizes are not startup or memory measurements.
- Dependency audit triage. The preceding npm install reported eleven vulnerabilities; no clean dependency-audit claim is made.

The temporary `.github/workflows/office-finish-repair.yml` must be removed before PR readiness. All feature changes remain on the draft branch until the actual evidence supports release review.
