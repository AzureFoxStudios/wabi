# Wabi Frontend-Only Local Mock Dev Handoff

**Status:** in progress, local changes only, not pushed.

**Goal:** make it possible to work on Wabi frontend screens without a real backend / SpacetimeDB stack. The intended command is `bun run dev:mock` from repo root.

**Current branch:** `main`

**User preference:** push useful Wabi work directly to `main` when access exists. Do not create PRs unless explicitly requested.

---

## What is already in `main`

These were completed and pushed directly before this task:

- `35746ce feat: polish DM surfaces and fix dev runtime`
  - DM visual polish.
  - fixed `opus-recorder` default import/runtime crash.
  - cleaned malformed CSS var fallbacks.
- `33e2b4f chore: repair local dev stack launcher`
  - `bun run dev:local` now starts real Rust backend + frontend.
  - backend `/health` was verified HTTP 200.
  - frontend was verified HTTP 200.

Known issue still present in real-backend local dev:

- backend can log `Reducer call failed: Failed to call reducer` while seeding the default `general` channel.
- Server still stays healthy; this is a follow-up STDB/default-channel seeding issue, not the frontend-only mock task.

---

## Current uncommitted work

`git status` currently shows:

```text
## main
 M frontend/src/lib/socketConnection.ts
 M package.json
?? frontend/src/lib/localMockSocket.ts
?? docs/local-mock-dev-handoff.md
```

A dev mock server is still running from the last attempt:

```text
bun run dev:mock
node .../vite dev --host 127.0.0.1
```

Kill it before continuing if needed:

```bash
pkill -f 'bun run dev:mock' || true
pkill -f 'vite dev --host 127.0.0.1' || true
```

---

## Files changed for this task

### 1. `frontend/src/lib/localMockSocket.ts`

New file.

Purpose:

- enable mock socket mode when `VITE_WABI_LOCAL_MOCK=1`.
- avoid connecting to backend / Socket.IO / STDB.
- seed enough frontend stores to inspect and work on the app shell.

Implemented so far:

- `isLocalMockMode()` reads `import.meta.env.VITE_WABI_LOCAL_MOCK`.
- `LocalMockSocket` class implements a small Socket.IO-like shape:
  - `id`
  - `connected`
  - `on(event, listener)`
  - `off(event, listener?)`
  - `emit(event, ...args)`
  - `removeAllListeners(event?)`
  - `disconnect()`
  - `connect()`
  - internal `dispatch(event, ...args)`
- `createLocalMockSocket(username)`:
  - sets `socket`, `connected`, and `connectionState` stores.
  - asynchronously seeds local frontend state.
- `disconnectLocalMockSocket(mock)`:
  - disconnects mock socket and resets connection stores.
- seeds:
  - current user
  - mock users `Mira` and `Taro`
  - `general` text channel
  - `voice-lounge` voice channel
  - fake DM `dm-local-mira`
  - role definitions
  - one voice participant in `voice-lounge`
  - starter messages in `general` and `dm-local-mira`
- local message handling:
  - intercepts `emit('message', payload)`
  - clears optimistic `deliveryState`
  - dispatches `message-accepted`
  - persists message map to `localStorage` key `wabi:local-mock:messages:v1`

Important caveat:

- `sendMessage()` in `messageStore.ts` already appends an optimistic message before calling `sock.emit('message')`.
- The mock therefore only needs to accept/confirm the optimistic message, not append a duplicate.

### 2. `frontend/src/lib/socketConnection.ts`

Modified to branch into mock mode:

- imports:
  - `createLocalMockSocket`
  - `disconnectLocalMockSocket`
  - `isLocalMockMode`
  - `type LocalMockSocket`
- adds `let localMockSocket: LocalMockSocket | null = null;`
- `getSocket()` returns mock socket in mock mode.
- `initSocket(username, authToken?)` creates mock socket in mock mode.
- `disconnect()` disconnects mock socket in mock mode.
- `getConnectionState()` returns connected/disconnected based on mock socket.

Normal mode still uses the real `SocketManager` path.

### 3. `package.json`

Added script:

```json
"dev:mock": "cd frontend && VITE_WABI_LOCAL_MOCK=1 bun run dev -- --host 127.0.0.1"
```

Usage:

```bash
bun run dev:mock
```

Expected:

- only frontend/Vite starts.
- no Rust backend.
- no STDB.
- app should guest-login into seeded mock app state.

---

## Verification already completed

From `frontend/`:

```bash
bun run check
```

Result:

```text
svelte-check found 0 errors and 53 warnings in 23 files
```

This means the current mock-mode code type-checks.

Started mock dev server:

```bash
bun run dev:mock
```

Frontend readiness check:

```bash
curl -fsS http://127.0.0.1:5173/ >/tmp/wabi-mock-root.html
```

Result:

```text
ready
```

So Vite serves HTTP 200 in mock mode.

---

## Blocked / not completed

I attempted a headless Chromium/CDP smoke to verify:

1. login page loads
2. click “Continue as guest”
3. enter guest name
4. enter app shell
5. seeded mock channels/users/messages appear
6. no “Connection Lost” banner

The CDP command was denied by the command approval system. I stopped and did not route around it.

Therefore runtime UI smoke is still incomplete.

---

## What to do next

### Step 1: Clean up old running mock server

```bash
pkill -f 'bun run dev:mock' || true
pkill -f 'vite dev --host 127.0.0.1' || true
```

Or use Hermes `process` if the session id is still known.

### Step 2: Re-run static checks

```bash
cd /var/home/Ronin/wabi/frontend
bun run check
```

Expected:

```text
svelte-check found 0 errors and 53 warnings in 23 files
```

### Step 3: Start mock dev mode

```bash
cd /var/home/Ronin/wabi
bun run dev:mock
```

Expected:

- Vite starts on `http://127.0.0.1:5173/`.
- No backend process starts.
- No `wabi-server` process is needed.

### Step 4: Manually smoke in browser, or rerun browser automation if approved

Manual smoke:

1. Open `http://127.0.0.1:5173/`.
2. Click “Continue as guest”.
3. Enter a guest name, e.g. `RoninLocal`.
4. Join.
5. Confirm the app shell appears.
6. Confirm there is no “Connection Lost” banner.
7. Confirm mock state is visible:
   - `general`
   - `Voice Lounge`
   - fake DM with `Mira`
   - seeded welcome/mock messages
8. Send a message in `general`.
9. Confirm message does not stay stuck as “sending”.
10. Refresh page.
11. Confirm local mock messages persist from localStorage.

### Step 5: Patch issues found by smoke

Likely things to watch for:

- Login might still clear auth/session state in a way that reloads or loses mock state.
- Stores may be seeded before shell components subscribe; should be OK because stores persist, but verify.
- Some components may call APIs directly instead of using socket stores; mock mode may need lightweight guards later.
- `Connection Lost` banner might subscribe to `connected` or `connectionState`; current mock sets both connected.
- DM list may depend on exact `Channel.type` value and/or `otherUser` shape.
- Message accepted behavior might need to update `deliveryState` in the right order if Svelte store batching causes timing oddities.

### Step 6: Production/static build check

```bash
cd /var/home/Ronin/wabi/frontend
STATIC_BUILD=1 bun run build
```

Expected:

- build completes.
- no new CSS syntax warnings.

### Step 7: Commit and push directly to main

Only after smoke passes:

```bash
cd /var/home/Ronin/wabi
git status --short
git add package.json frontend/src/lib/socketConnection.ts frontend/src/lib/localMockSocket.ts docs/local-mock-dev-handoff.md
git commit -m "feat: add frontend-only local mock dev mode"
git push origin main
```

---

## Verification update — 2026-06-06

Phases 1 and 2 from `.hermes/plans/2026-06-06_110247-local-dev-foundation-before-frontend-polish.md` were completed/verified.

### OpenCode notes

- OpenCode CLI was refreshed with `opencode models --refresh`.
- Requested model became available as `opencode/nemotron-3-ultra-free`.
- Smoke test passed:

```bash
opencode run 'Respond with exactly: OPENCODE_SMOKE_OK' --model opencode/nemotron-3-ultra-free
```

Output included `OPENCODE_SMOKE_OK`.

- A larger Nemotron run was started but exited before making edits.
- MiniMax fallback `opencode/minimax-m2.7` failed because the Zen account requires billing.
- MiniMax free fallback `opencode/minimax-m3-free` smoke-passed and inspected the repo, but did not make code edits beyond checks.

### Static verification

```bash
cd /var/home/Ronin/wabi/frontend
bun run check
STATIC_BUILD=1 bun run build
```

Results:

- `bun run check`: passed, 0 errors / 53 existing warnings.
- `STATIC_BUILD=1 bun run build`: passed; static adapter wrote `build`.

### `dev:mock` verification

Command:

```bash
cd /var/home/Ronin/wabi
bun run dev:mock
```

Readiness:

```bash
curl -fsS http://127.0.0.1:5173/ >/tmp/wabi-devmock-root.html
```

Result: HTTP 200.

Headless Chromium/CDP smoke verified:

- login page loaded.
- “Continue as guest” expanded guest login.
- guest name `RoninLocal` entered.
- guest login reached app shell.
- no “Connection Lost” banner.
- seeded mock state appeared:
  - `general` text channel
  - `Voice Lounge` voice channel
  - fake DM/user `Mira`
  - user `Taro`
  - `RoninLocal` current user
  - seeded welcome messages
- sending `mock smoke hello` in `general` worked.
- sent message did not remain stuck in “sending”.
- mock messages persisted to localStorage key `wabi:local-mock:messages:v1`.

### `dev:local` verification

Command:

```bash
cd /var/home/Ronin/wabi
bun run dev:local
```

Readiness checks:

```bash
curl -sS -o /tmp/wabi-devlocal-frontend.html -w '%{http_code}\n' http://127.0.0.1:5173/
curl -sS -o /tmp/wabi-devlocal-health.txt -w '%{http_code}\n' http://127.0.0.1:3000/health
```

Results:

- frontend: HTTP 200
- backend `/health`: HTTP 200
- health body: `{"role":"authority","service":"wabi-server","status":"ok",...}`

Known follow-up still reproduced:

```text
wabi_server::db: Reducer call failed: Failed to call reducer
```

This happens around startup/default `general` channel seeding. It does not block frontend HTTP 200 or backend health HTTP 200. Treat it as a separate backend/STDB seed investigation.

### Process cleanup

The `dev:mock`, Chromium smoke, and `dev:local` processes used for verification were killed after checks.

---

## Optional follow-up after this task

After frontend-only mock mode lands, the next useful follow-ups are:

1. Add a tiny visible “Local mock mode” pill/banner in dev mode so nobody mistakes it for real backend state.
2. Add mock controls/dev panel:
   - add fake user
   - toggle connection state
   - add unread DM
   - populate voice channel
3. Investigate real backend local-dev reducer failure:
   - reproduce with `bun run dev:local`
   - inspect exact server log around `ingest_wabi_event`
   - trace default channel seed path
   - fix SpacetimeDB reducer/schema mismatch
4. Add a Playwright/browser smoke later if the project accepts browser automation dependencies.

---

## Safety notes

- There is still an old stash from before the main update:

```text
stash@{0}: On feat/login-auth-polish-and-theme-plan: pre-main-update dirty tree 2026-06-02 before merging PR99
```

- Backup archive still exists:

```text
/var/home/Ronin/wabi-backups/pre-main-update-20260602-140424.tar.gz
```

Do not delete stash or backup unless Ronin explicitly says to.
