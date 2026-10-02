# Production finish — September 19 resume

Continues the [original campaign](2026-09-15-production-finish-campaign.md), not a new backlog.

## Reconciled source state

Fetched origin before resuming. Review branch `codex/production-finish-20260919` starts at main `c723198416270c2ed40919107e2b4101eec99c6b` in a new isolated worktree. The earlier finish worktree and its uncommitted Gallery experiment are preserved.

Main includes 22 commits after the previous `e3c2f282` checkpoint: Wiki ownership follow-up, Gallery GF01–GF06, Files GF07 and rendered-fixture fixes, native folder-picker/Android-script changes, the deliberate restoration of overlapping closed stubs, compaction-padding repair, and add-on settings UI. Their presence is source evidence; prior test reports retain their original scope.

Additional work exists outside main and must not be described as integrated:

- `origin/crash-harness-hardening` at `b181672a`: additional compaction/crash-harness hardening and runtime add-on attachment/switches.
- `origin/codex/desktop-host-mode-20260916` at `49f582bd`: managed desktop hosting, admission, recovery and installer work.
- `origin/codex/docs-sheets-present-20260917` at `1e1c6bc1`: office workspaces and consent-gated desktop exports.

No local branch was reset or cleaned. Do not replay the older Gallery frontend experiment over the newer implementation. Preserve the closed-stub overlap decision in `00a702bd`. Live deployment identity remains unverified here; historical “nothing deployed” statements do not establish today's server state.

## Continued implementation: W03/W04 album metadata

The current REST add-item path still discarded submitted size/MIME before the durable adapter write. Pass those values into the existing record fields. The postcard shape and event type remain unchanged; no migration or rewriting of old records. MIME is client-supplied display metadata, not byte validation. Regression test exercises REST response, writer teardown/reopen and retained metadata.

Only this still-missing backend change was carried from the paused worktree. Current Gallery/Files frontend changes were retained intact. Corrected PROJECT_STATUS's obsolete unmerged heading and the Files report's contradictory old aggregate.

## Evidence and limitations

- Locked `npm ci`: exit 0; dependency audit notices remain, no automatic dependency upgrades.
- `npm exec --yes --package=bun@1.3.14 -- bun run build:static`: exit 0 on this source. Node 22.22.2. Build warnings remain visible in the local log.
- Files fixture: 23 pass / 0 fail / no uncaught page errors. Real headful Chromium with synthetic Lore HTTP; no real Lore integration or physical-client acceptance. [Portable assertions](../reviews/evidence/2026-09-19-resume/files-results.json).
- Backend command: `CARGO_BUILD_JOBS=1 CARGO_TARGET_DIR=/var/home/Ronin/wabi/target cargo +1.93 test -p wabi-server --test channel_access_contract` (Rust 1.93.1). Result recorded below when terminal.
- Browser command from frontend: `DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 WABI_SMOKE_CHROMIUM_PATH=/home/Ronin/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome node scripts/files-workspace-browser-smoke.mjs`; Gallery uses `scripts/gallery-workspace-browser-smoke.mjs` with the same environment.

Not run in this batch: full Rust workspace/frontend unit suites, native installers, real Lore, physical calls, hosted-copy restore, final release identity/deployment, actual pilot. This batch changes backend metadata and documentation; synthetic browser checks reconcile prior frontend evidence but do not prove backend integration. No push, merge, tag, deploy, keys or live-data changes.

Next: complete real Authority Gallery upload/reload/feedback acceptance on the integrated implementation; review outstanding branch integration separately; then continue the original remaining workspace/trust/operator/device gates.

Gallery fixture recheck: **15 pass / 0 fail / no blocker**, headful Chromium with synthetic API/auth. [Portable assertions](../reviews/evidence/2026-09-19-resume/gallery-results.json). This confirms the integrated frontend fixture scope; actual Authority upload metadata is covered separately by the backend contract, not by this synthetic fixture.

Backend channel contracts: **31 pass / 0 fail**, including `album_item_media_metadata_survives_rest_write_and_restart`; exit 0. [Portable result summary](../reviews/evidence/2026-09-19-resume/album-contract.txt). The newly integrated Gallery feedback fixture also calls `add_item`; its signature was updated to pass image metadata and its separate contract suite is run before committing.

Gallery feedback contracts: **4 pass / 0 fail**, exit 0. [Portable summary](../reviews/evidence/2026-09-19-resume/gallery-contract.txt). All required checks for this bounded metadata patch passed. The complete production-pilot goal remains open.
