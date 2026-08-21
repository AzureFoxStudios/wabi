# P1/A2 — Frontend Silent-Refresh Wiring (implementation report)

**Date:** 2026-08-21
**Worker:** opencode/x-preview-f-free (stalled after reading backend files — free-model fatigue; Hermes completed the implementation)
**Kanban:** prod-readiness board, card [A2] `t_60c8ad7e`

## What changed

### frontend/src/lib/api/authRefresh.ts (NEW)
Server-scoped session storage for the refresh token, mirroring authSession.ts conventions:
- `getRefreshToken(serverUrl)` / `setRefreshToken(token, serverUrl)` / `clearRefreshToken(serverUrl)`
- storage key: `wabi_refresh_token:<encoded serverUrl>` (sessionStorage, session-scoped)
- `tryRefresh(serverUrl)`: POST /api/auth/refresh with stored refresh token; on success updates access+refresh tokens; on failure clears tokens and returns false (caller routes to login)
- **Stampede guard**: module-level `inFlight: Promise<boolean> | null` — concurrent 401s share one refresh promise instead of burning the single-use refresh token N times

### frontend/src/lib/api/utils.ts
- `fetchWithAuth(url, options)`: drop-in wrapper around fetchWithTimeout. Intercepts clean 401s from JSON API responses. Calls `tryRefresh()` once; on success retries original request with fresh Authorization header; on failure returns the original 401 for caller to classify as auth-fatal.
- Skips refresh for /auth/refresh and /auth/login themselves.

### shared/userContracts.ts
- `AuthResponse` extended with optional `accessToken?: string` and `refreshToken?: string`. Existing `token` field unchanged (backend still serializes the compat alias from A1).

### frontend/src/lib/components/Login.svelte
- `handleLogin`: `setRefreshToken(result.refreshToken)` after `setAuthToken(result.token)`.
- `handleRegister`: `setRefreshToken(result.refreshToken)` after `setAuthToken(result.token)`.

## Verification

- `npm run check` → **0 errors**, 171 warnings (pre-existing baseline)
- Manual read-through:
  - refresh token stored server-scoped, session-scoped (cleared on tab close)
  - stampede guard is module-level promise shared across 401s
  - failure path clears both tokens
  - refresh endpoint path is excluded from refresh-retry (no infinite loop)
  - retry updates Authorization header with the new access token

## Deviations

- x-preview-f-free stalled after reading backend files (presence.rs, shared.rs, auth.rs, authStore.ts, serverUrl.ts) — classic free-model step budget. Hermes took over with the full prompt context already loaded and completed the implementation.
- No automated tests added (none existed for the auth fetch path in the frontend). The logic is simple enough to unit-test the stampede guard if desired later.
