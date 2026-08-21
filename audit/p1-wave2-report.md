# P1/Wave-2 (W1+W2+W3+W4) — small-gaps bundle (implementation report)

**Date:** 2026-08-21
**Kanban:** prod-readiness board, cards W1 `t_9790ac6c`, W2 `t_4a3db615`, W3 `t_148a9226`, W4 `t_2234c0c2`

## What changed

### [W1] Body-size docs
- `INSTALL.md` — new "Public instance hardening" section: table of env vars to review before going public (`WABI_MAX_BODY_SIZE`, `WABI_HTTP_TIMEOUT_SECS`, rate-limit + trusted-proxy pair, `WABI_METRICS_PUBLIC`).
- `.env.example` — comment above `WABI_MAX_BODY_SIZE` points public operators at 200–500MB and the INSTALL.md section.

### [W2] Job queue DLQ — `core/crates/wabi-server/src/jobs/mod.rs` + `api/admin.rs`
- New `JobStatus::DeadLettered` variant (serde snake_case, backward-compatible with persisted `job_queue.json`).
- **Retry cap now enforced in BOTH failure paths** (fixes the whole bug class):
  - `report_result` failure: cap exceeded → `DeadLettered` instead of terminal `Failed`.
  - `reap_stale_jobs`: previously requeued a vanished-node job **infinitely** with no cap check — poison job + dead node = requeue every 300s forever. Now increments the same cap and dead-letters when exhausted.
- New `JobQueue::requeue_job()` — admin recovery: only DeadLettered jobs eligible (else `NotClaimable`), resets `retry_count` so the cap applies fresh.
- Admin endpoints under existing `admin_auth` gate:
  - `GET /api/admin/jobs/dead-lettered` — quarantined jobs incl. payload + error for inspection.
  - `POST /api/admin/jobs/{id}/requeue` — reset to Pending; 404 unknown id, 409 not-dead-lettered.
- Tests updated/extended in `report_failure_retries_then_fails_after_max`: dead-letter status, non-claimability, requeue → claimable with fresh cap, requeue-of-non-DLQ rejected.

### [W3] Webhooks catalog flip — `core/crates/wabi-server/src/api/addons.rs`
- `enabled: true` → `enabled: false` on the `webhooks` AddonCapability, with rationale comment. WebhookService is unwired (no registration API, zero trigger call sites); catalog was advertising capability that doesn't exist. Latent SSRF surface closed at zero cost.

### [W4] Audit doc correction + archive
- `audit/PRODUCTION_READINESS_AUDIT_2026-08-21.md` — copied from Downloads (original untouched).
- Appended dated CORRECTION block for gap #1: per-request revocation shipped 2026-07-23 era (`auth_extractor.rs:196-202`, `state.rs:494-535`, `admin.rs:638-640`); residual gap was rotation-only. History preserved, not rewritten.
- Appended Resolution log table mapping all nine gaps → cards/commits/status (#9 tracing export deferred by design).

## Verification
- `cargo check -p wabi-server --release` — clean, 0 errors
- `cargo test -p wabi-server --lib` — 108 passed, 0 failed (incl. extended DLQ tests)
