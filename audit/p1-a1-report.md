# P1/A1 — JWT Refresh Rotation (implementation report)

**Date:** 2026-08-21
**Worker:** opencode/nemotron-3-ultra-free (initial implementation) + Hermes (verification, test-fixture fixes, contract-compat fix)
**Kanban:** prod-readiness board, card [A1] `t_e8b1f1e8`

## What changed

### core/crates/wabi-server/src/api/auth.rs
- `generate_access_jwt` — access tokens now 15 minutes (`Duration::minutes(15)`), carry `token_type: "access"`.
- `generate_refresh_jwt` (NEW) — refresh tokens 30 days, own jti, `token_type: "refresh"`.
- `JwtClaims` gains `token_type: String` with `#[serde(default)]` → legacy tokens without the claim decode as access tokens (no forced logout of live sessions).
- `POST /api/auth/refresh` (`handle_refresh`, route registered at auth.rs:40):
  - validates signature/expiry, requires `token_type == "refresh"`
  - reuse detection: presented refresh jti already in revocation set ⇒ `revoke_user(sub)` (family kill) + 401 "token reuse detected; all sessions revoked"
  - blacklist check so banned users cannot refresh
  - burns the used refresh jti, mints a fresh access+refresh pair
- Login / register / guest all return `{ accessToken, refreshToken }`.
- **Hermes fix — wire-contract compat:** worker renamed the response field `token` → `accessToken`, but the frontend reads `result.token` (`Login.svelte:104`) and the shared TS contract declares `token: string` (`shared/userContracts.ts:13`). Deployed as-is this would have broken every login. `AuthResponse` now serializes BOTH `token` (alias of access_token) and `accessToken`/`refreshToken`. A2 migrates the frontend, then the alias can be dropped.

### core/crates/wabi-server/src/auth_extractor.rs
- `AuthUser` extractor rejects `token_type == "refresh"` (auth_extractor.rs:200) — a refresh token can never authenticate API calls.
- Same rejection in `OptionalAuthUser` (:265).

### core/crates/wabi-server/src/state.rs (Hermes fix)
- **Re-discovered latent bug (2026-07-23 login-bounce):** the planned code hardening (`user_epochs` iat floor + login-time legacy-ban clear) was documented in `docs/architecture/overview.md` but NEVER committed — only the data-only live fix (clearing `revocations.json` on Tim) ever shipped. Current main still had permanent-ban semantics in `revoke_user`.
- `revoke_user` now writes a per-user iat floor into `user_iat_revoked` and REMOVES any legacy permanent-ban entry — force-logout/theft-response no longer permanently locks an account.
- NEW `clear_legacy_user_revocation(user_id)` — called on successful password login so a stale on-disk `users: [id]` cannot trap the user in a login→401 bounce loop.

## Tests (all green)

| Test | Verifies |
|---|---|
| `refresh_happy_path` | register → refresh returns new distinct pair |
| `refresh_reuse_detects_theft_and_revokes_family` | reuse of burned refresh ⇒ 401 + family kill; old access token now revoked; fresh login still works (floor, not ban) |
| `refresh_expired_token_rejected` | expired refresh rejected |
| `refresh_token_rejected_as_access_token` | token_type round-trips; extractor would reject |
| `legacy_token_without_token_type_still_works` | backward compat |

Plus Hermes fixes to the worker's fixtures:
- `make_test_state` returned `Arc<AppState>` while dropping the `TempDir` — data dir deleted mid-test ⇒ `Wdb(Io NotFound)` panics. Now returns `(TempDir, Arc<AppState>)`; all 5 call sites bind `_dir`.

## Verification

- `cargo test -p wabi-server --lib` → **108 passed, 0 failed**
- `cargo check -p wabi-server --release` → clean
- `cargo test -p wabi-server --test first_boot_onboarding` → 2 passed (login/register integration path intact)

## Known follow-ups
- A2 (frontend silent-refresh) must consume `refreshToken`, store it, and migrate `.token` readers before the compat alias is removed.
- Socket.io handshake (B1) decodes tokens with its own claims struct that ignores `token_type` — acceptable: refresh tokens are single-use, short-lived in practice, and never delivered to the socket client as its auth token; A2 will keep sending the ACCESS token.
