# P1 Wave-1 audit — independent re-verification of worker commits (2026-08-21)

Scope: line-level re-read of A1 (`b755498`), B1 (`73aedd3`), A2 (`5ff08da`) —
all three authored by free-model workers (longcat/nemotron/mimo lineage), not
by Hermes. Ronin asked for a double-check after wave 2 landed.

## Verdict

Core designs are sound and the test suites are honest. Four real gaps found;
all fixed in commit `787af2c`.

## Findings

### F1 (security, B1) — refresh tokens could open sockets
`validate_token_sync` validated signature+expiry but never checked
`token_type`. REST rejects refresh tokens as credentials (A1's AuthUser
guard) but the socket layer accepted them: a leaked 30-day refresh token —
exactly the artifact rotation exists to contain — could open a live,
handshake-authenticated socket.
**Fix:** `token_type == "refresh"` → handshake reject, mirroring the REST
extractor. (`socketio/shared.rs`)

### F2 (semantics drift, A1) — guests got 30-day refresh tokens
`generate_refresh_jwt(is_guest)` ignored its `is_guest` flag. Pre-rotation
guest tokens expired in 24h; post-rotation they silently became 30-day.
**Fix:** guest refresh TTL capped at 24h. (`api/auth.rs`)

### F3 (security, A2) — logout left the refresh token alive
`clearAuthSession()` cleared access token + guest session but not the new
refresh token. Every logout path in the app routes through it, so "logout"
left a live 30-day credential in sessionStorage.
**Fix:** `clearAuthSession` now also calls `clearRefreshToken`. Note this
makes authSession depend on api/authRefresh (storage-only module, no cycle).

### F4 (dead wiring, A2, Hermes-owned miss) — silent refresh never fired
`fetchWithAuth` was exported with zero callers; all 12 API modules still call
`fetchWithTimeout`, so an expired 15-minute access token would 401 straight
to login instead of refreshing. The stampede-guarded refresh logic existed
but nothing invoked it.
**Fix:** folded into `fetchWithTimeout` itself via `refreshAndRetry`:
fires only when the original request carried an Authorization header, skips
/auth/refresh + /auth/login, single retry, returns original 401 on failure.
Dead `fetchWithAuth` removed.

## Verified-good aspects (no action)

- Reuse detection → family revocation ordering is correct: revoked-jti check
  fires BEFORE burn, ban check before minting, burn after all validations.
- Revocation floor semantics: `revoke_user` uses per-user iat floor +
  removes legacy permanent-ban entry; login clears stale bans. The old
  access-token-rejected-after-family-kill assertion is in the test suite.
- Handshake failure path emits `auth-failed` then disconnects before any
  handler registration; empty token still allowed for guest sessionId flow
  (frontend sends `sessionId` when no token — verified compatible).
- `resolve_identity` keeps revocation+ban checks per-event (async checks
  can't run in the sync connect closure) — defence in depth intact.
- Sentinel sweep: remaining `unwrap_or(-1)` sites are fallback paths behind
  SioIdentity checks that guard with `<= 0` — no unguarded sentinels remain.
- Frontend handshake sends `auth.token`; reconnect path reuses stored token
  (15m expiry means long-idle tabs will need socket re-init on 401-class
  failures — acceptable now that silent refresh restores the access token;
  noted as follow-up polish, not a gap).

## Verification at close

- `cargo test -p wabi-server --lib` → 108 passed, 0 failed
- `cargo check -p wabi-server --release` → clean
- `npm run check` (frontend) → 0 errors, 171 warnings (pre-existing baseline)
