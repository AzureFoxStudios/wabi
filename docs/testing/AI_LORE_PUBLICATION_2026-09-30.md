# AI and Lore publication batch — 30 September 2026

Publication branch: `codex/ai-workspace-publication-20260930`.
This is a review candidate. Publishing does not merge main, deploy wabi.chat,
or update the existing Lore mirror of main.

The branch retains the saved workspace baseline `138abe39e0`, then adds separate
operator-file cleanup and Lore-fix commits, followed by the Codex Project
connector, optional Connections addon and bounded worker recovery. Existing
workspace/personal Planner changes in that baseline are part of this broad
backlog publication; focused checks below are not full acceptance of every
baseline feature. Current peer security/geographic implementation edits remain
in the original shared checkout and are excluded from this batch. Integrate
those changes through their own release checks before deploying.

## Fresh publication checks

The isolated source was copied to the stronger Ronin without live data or keys.
Rust used pinned 1.93.1, `--locked`, two build jobs and no incremental compilation.
Frontend dependencies used CI's `frontend/package-lock.json` through `npm ci`.
Check passed with 0 errors and 90 existing warnings; static build passed.

- Project Assistant server contracts: 11 passed; physical fixture excluded from
  the ordinary test run and driven separately by its harness.
- Lore library: 35 passed; Lore API integration: 16 passed; Lore API unit: 14 passed.
- Addon inventory/switch checks: 6 passed.
- Real worker admission/replay: 4 passed; event catalog/payload checks: 4 passed;
  old-run JSON compatibility: 1 passed.
- API runner: 11 passed; Codex MCP connector: 11 passed.
- Runtime-file guard and 3 guard tests passed. New source/evidence files matched
  no selected provider-token/private-key patterns; this is not a complete audit.
- The exact isolated publication passed the two-physical-computer recovery
  harness again: primary process interrupted, real expiry, one saved card,
  continuation on the backup and stale returning write rejected with 409. The
  provider was a deterministic stub, not a model or native coding harness.
- Both actual headful desktop/phone browser harnesses passed using the locked
  frontend dependencies. Account/HTTP boundaries remain fixtures.

See [Connections proof](PROJECT_WORKER_RECOVERY_2026-09-30.md) and
[Codex/Lore evidence](CODEX_AND_PERSONAL_ACCEPTANCE_2026-09-30.md). The latter
retains the failed live mirror-head check honestly; source fixes are not live
release acceptance. New worker steps cannot execute shell or repository code.
Native Codex/OpenCode/Hermes session recovery and verified code/artifact
checkpoints remain open. No paid model, external model or credential rotation
was used for publication validation.
