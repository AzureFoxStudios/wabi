# P1 Wave-3 — hardening follow-through (implementation report)

**Date:** 2026-08-21
**Commits:** `6f21bb4` (all four cards, single commit — small, related changes)

## What changed

### [X2] Revocation-store pruning — `state.rs`, `auth_extractor.rs`, `api/auth.rs`, `api/admin.rs`
- `RevocationStore.jtis: HashSet<String>` → `HashMap<String /*jti*/, u64 /*exp*/>`.
- New `prune_expired_jtis(now)`: drops entries past `exp + 1h` grace; called from
  `save_revocations`, which now takes the write lock to mutate safely.
- Safety argument: JWT validation rejects expired tokens before the revocation
  lookup (`decode_token` → validate_exp), so a pruned expired jti can never be
  the reason a live request fails.
- Legacy compat: old `revocations.json` with bare-array `jtis` loads via
  `load_legacy_revocations_str` shim; entries get `u64::MAX` expiry (kept until
  explicitly cleared or epoch-revoked). Upgrade never un-revokes anything.
- Call sites: logout and refresh-burn pass the real token exp; admin
  `/admin/revoke/token` accepts optional `exp` (omitted = kept indefinitely);
  bot/lore credentials use `i64::MAX`.

### [X3] Latency histogram — `metrics.rs`, `main.rs`
- `wabi_http_request_duration_seconds` Prometheus histogram: cumulative buckets
  at 5/10/25/50/100/250/500ms, 1/2.5/5/10/30s, +Inf, plus `_sum`/`_count`.
- Recorded in the existing `metrics_middleware` around `next.run()` — no new
  layers, no new dependencies (atomic u64s only).

### [X1] Socket token freshness — `frontend/src/lib/socketConnectionCore.ts`
- `scheduleReconnect` re-reads the live access token via `getAuthToken()` before
  reconnecting instead of reusing the boot-time capture (15-minute access tokens
  made stale capture a guaranteed handshake failure for long-lived tabs).
- New `auth-failed` / `auth-revoked` listeners (backend emits both since B1):
  disconnect the socket, attempt one silent refresh via the stampede-guarded
  `tryRefresh()`, reconnect with the rotated token on success; on failure with
  no stored token surface `session_expired` so the app routes to login rather
  than retry-looping.

### [X4] Frontend accessToken migration — `Login.svelte`, `shared/userContracts.ts`
- All six `result.token` reads in Login.svelte now use `result.accessToken`
  (setAuthToken ×2, setPersistentAuthToken, pendingOwnerLogin,
  pendingRegisteredLogin, login dispatch).
- Shared contract: `accessToken` is now required; `token` demoted to optional
  legacy alias; added `authAccessToken()` helper for either-spelling consumers
  (authRefresh.ts already tolerated both).
- Backend alias serialization unchanged — older cached clients keep working.

## Deliberately skipped (from wave-3 scouting)
- Rate-limit tightening on `/api/auth/refresh`: 30-day-JWT brute force is not
  practical; login already has lockout. Revisit if abuse observed.
- Guest sessionId socket flow removal: harmless legacy path.

## Verification
- `cargo test -p wabi-server --lib` → 108 passed (incl. updated legacy-load +
  prune test)
- `cargo check -p wabi-server --release` → clean
- `npm run check` → 0 errors (172 warnings, +1 pre-existing-class warning in
  touched file)
- Peer WIP (business components, workspacePanels) untouched — scoped commit of
  exactly the nine wave-3 files.
