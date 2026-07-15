# Calling Frontend: Offline/LAN Resilience + Wabidb Identity

Workdir: `/var/home/Ronin/wabi`. Date: 2026-07-15.

Scope: frontend-only offline-safe calling and wabidb identity fix. No backend
edits, no Settings/logout changes, no commits, no CSS redesign.

## Summary

| Task | File(s) | Status |
|------|---------|--------|
| A. Soft-fail TURN prefetches | `calling_impl_core.ts` | Done |
| B. Transport resolve offline-resilient | `mediaRuntime.ts`, `callingTransport.ts` | Done |
| C. Socket connected gate | `calling_impl_core.ts` | Done |
| D. Offline/call error notice | `callingStateStores.ts`, `CallView.svelte`, `calling.ts` | Done |
| E. Fix wabidb random userId | `callingWabidb.ts` | Done |
| F. Logout (Task 5) | — | Skipped (already done) |

`bun run check`: **0 errors**, 75 pre-existing warnings.

## A. Soft-fail TURN prefetches

All 6 `await prefetchTurnCredentials()` calls in `calling_impl_core.ts` (join,
start call, start group call, answer, create offer, handle offer) now degrade
to a `console.warn` instead of throwing and aborting the call flow:

```ts
await prefetchTurnCredentials().catch((err) => {
  console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
});
```

## B. Transport resolve offline-resilient

- `mediaRuntime.ts`: `resolveCallTransportPlan()` now wraps
  `syncMediaRuntimeFromServer()` in a try/catch so a failed fetch can never
  hard-error transport resolution. When the runtime is unreachable AND there is
  no cached snapshot, it defaults to `wabidb` with
  `reason: 'runtime_unreachable_default_wabidb'`, `fallbackApplied: true`, and
  `gatewayHealthy` softened to `isLocalConnection()` (so a local/LAN server is
  treated as healthy for calling even without external TURN/LiveKit).
- Added `isLocalConnection(serverUrl?)` helper (hint only) in `mediaRuntime.ts`.
- `callingTransport.ts`: `syncMediaRuntimeFromServer()` was already `.catch(() =>
  null)`, so external checks are soft-failed; the wabidb branch already resolves
  to `wabidb` for the default `auto`/unreachable case.

The default transport remains `wabidb` (not stdb), per verified facts.

## C. Socket connected gate on call entry points

`startCall`, `startGroupCall`, and `joinVoiceChannel` now guard at the top
(after the in-call guards) with:

```ts
if (!socket.connected) {
  throw new Error('No connection to server. Calls require an active connection to the Wabi server.');
}
```

The gate sets `callOfflineNotice` before throwing (see D).

## D. Offline/call error notice

- Added `callOfflineNotice: writable<string | null>` to `callingStateStores.ts`
  and re-exported it from `calling.ts`.
- Set on:
  - socket-not-connected gate (start/join/group) — connection message
  - catch blocks of `startCall` / `startGroupCall` / `answerCall` — generic retry
    message
- Cleared (`set(null)`) on successful join/start/answer.
- Rendered in `CallView.svelte` as a small absolutely-positioned banner at the
  top of the media overlay (with a dismiss button). Minimal inline `<style>`
  added only for the new banner element — no existing styling touched.

## E. Fix wabidb identity

`callingWabidb.ts`:
- Imports `getStoredDbUserId` and `getAuthToken` from `authSession.ts`.
- Replaces `const userId = Math.floor(Math.random() * 1e9)` with the real
  authenticated user id:
  ```ts
  const dbUserId = getStoredDbUserId();
  const userId: number = dbUserId ?? 0;
  currentUserId = userId;
  const token = getAuthToken();
  ```
- Passes `token` into `new WabiDbCallState({ serverUrl, token })`.
- `joinSession` now uses `stable_user_id: 'user-${userId}'` (was `String(userId)`
  of the random id).
- The media relay path (`WabidbMediaRelay`) is unchanged and still uses the
  resolved `currentUserId`.

## Verification

```bash
cd frontend && bun run check
# svelte-check found 0 errors and 75 warnings in 32 files
```

## Files touched

- `frontend/src/lib/calling_impl_core.ts`
- `frontend/src/lib/mediaRuntime.ts`
- `frontend/src/lib/callingWabidb.ts`
- `frontend/src/lib/callingStateStores.ts`
- `frontend/src/lib/calling.ts` (re-export only)
- `frontend/src/lib/components/CallView.svelte` (banner only)

`callingTransport.ts` required no change (already soft-failed). No logout /
Settings / backend / CSS-redesign changes were made.
