---
name: wabidb-troubleshooting
description: "Troubleshooting guide for WabiChat deployment and runtime issues, including 502 errors, service health checks, and deployment verification."
version: 1.0.1
author: Hermes
platforms: [linux, macos, windows, web]
metadata:
  hermes:
    tags: [WabiDB, Troubleshooting, Deployment, HealthCheck, 502Error]
---

# WabiChat Troubleshooting Guide

This skill provides procedures for diagnosing and resolving common issues with WabiChat deployment and runtime, particularly HTTP 502 errors and service health problems.

## When to Use

- Users report HTTP 502 Bad Gateway errors on wabi.chat
- Need to verify service health after deployment
- Investigating connectivity or performance issues
- Checking deployed version or configuration
- Validating that recent changes have been properly deployed

## Initial Diagnosis Steps

When encountering a 502 error on wabi.chat:

1. **Check from multiple locations/networks** to rule out geographic/Cloudflare edge issues
2. **Verify basic connectivity**:
   ```bash
   dig wabi.chat A
   curl -v https://wabi.chat/
   curl -s https://wabi.chat/health
   ```
3. **Inspect response headers** for Cloudflare indicators:
   ```bash
   curl -sI https://wabi.chat/
   ```
4. **Check local service status** (if accessing a self-hosted instance):
   ```bash
   ps aux | grep wabi
   ss -tlnp | grep :300
   ```
5. **Verify repository state** (if you have access to the codebase):
   ```bash
   git status --short
   git log --oneline -10
   ```

## Common Causes of 502 Errors

### Calling / media relay: socketioxide `Data<serde_json::Value>` drops binary (2026-08-10)

Symptom: wabidb media relay calls appear connected (transport badge shows WABIDB, sessions join) but NO audio flows in either direction. Root cause: the client emitted `socket.emit('wabidb-media', {sessionId, userId, payload: ArrayBuffer})` — socket.io-client turns the ArrayBuffer into a `{"_placeholder":true,"num":0}` placeholder + binary attachment, and socketioxide's `Data<Value>` (serde_json::Value) extractor does NOT substitute the placeholder: the handler is never called (silent deserialization skip). Proven empirically: a relay test with socketioxide 0.16 + socket.io-client showed string payloads relay intact while ArrayBuffer payloads never reached the handler. Fix (cdf9d53): payload is base64 string end-to-end (`arrayBufferToBase64` send / `base64ToUint8Array` receive in `wabidbMediaRelay.ts`), mirroring `callingStorefwd.ts` `audioBase64`. The opus decoder worker also requires a `Uint8Array` (it calls `new DataView(pages.buffer)`; a raw ArrayBuffer has no `.buffer`). Diagnostic: "connected but silent" calls + no server-side `on_wabidb_media` log lines = binary-drop; if you ever see the server receive a wabidb-media payload that is an ARRAY of numbers, the client sent binary and serde_json converted it. Do not reintroduce raw ArrayBuffer payloads on this path.

### Calling dies ~15 min in with `createSession failed: 401` while presence stays alive (2026-09-04)

Symptom: calls work, then go silent — console shows `POST /api/calls/sessions → 401` (and usually `layout`/`theme`/`turn-credentials` 401s alongside), `wabidb swap reconnect failed`, yet `voice-channel-state` keeps flowing and rosters look alive. Root cause: access tokens live 15 min (`api/auth.rs` `Duration::minutes(15)`), refresh tokens 30 days — and the call HTTP layer (`wabidbCallConnection.ts`) used raw `fetch` with NO refresh path (the shared `fetchWithTimeout` wrapper in `api/utils.ts` has one; the call path bypassed it). So the first expiry after join killed every relay (re)connect while the socket.io connection — authenticated once at handshake — sailed on. Presence alive + media dead is the signature. Fix (86b7e94): all `WabiDbCallState` HTTP goes through `authedFetch` — 401 → `tryRefresh()` once (stampede-guarded, shared with the socket layer) → retry with the live token. Diagnostic: if 401s self-heal after one refresh in the log, recovery worked; if they repeat with no recovery, the tab holds no valid refresh token (predates refresh issuance, or rotation rejected it) — re-login fresh on that tab is the only fix, no code will save it. Test tabs should always re-login fresh before a calling session so each holds a fresh refresh-token pair.

### Cloudflare-Related Issues
<!-- (existing content unchanged) -->

### Backend Service Issues
<!-- (existing content unchanged) -->

### Offline roster empty / registered users invisible (People panel + admin registry)

Symptom: the People panel's collapsible "Offline — N" section never shows anyone, and registered-but-offline accounts (e.g. a user who can't log in) don't appear in the admin Users registry or Settings→Admin. Cause: the socket `init` payload sends `users` = **online-only** (presence map), and `serverMembers` was **hardcoded `Vec::new()`** in `core/crates/wabi-server/src/socketio/presence.rs` (WDB-compat stub). The frontend renders `offlineUsers = serverMembers − online`, so an empty serverMembers = no offline section, ever. Fix (shipped): populate `serverMembers` from `state.app.wdb.list_users()` → WdbAdapter → **UsersProjection** with `UsersFilter::default()` — returns EVERY user row (registered, guests, bots), each with profile fields. Guest discriminator = empty `password_hash` (same test `auth.rs` handle_login uses), exposed as `isRegistered` on the wire. Admin UI must merge `$serverMembers` + `$users` (online wins, keyed `dbUserId ?? id`) — `AdminWorkspace.svelte` + `settings/AdminSettingsTab.svelte` do this; the People panel already does. Corollary: avatars of offline users only appear once that user's session joins (user-joined) — with the fix they render immediately from the roster.

### Message/UI Runtime Bugs (keyed-list collapse)

When users report messages being deleted/overwritten by new messages ("new message eats old"), the cause is a keyed `{#each}` identity failure across backend id generation + frontend merge — never just one layer. Full audit recipe, fix shape, and verification probes: `references/message-identity-new-eats-old.md`. Key rules: backend must stamp a UUID message id BEFORE commit (never rely on `commit_seq` alone); frontend merge must preserve `clientMessageId` against null wire fields; list dedupe keeps the LAST row of a key; never remove a shared helper (e.g. `dedupeByIdKey`) without grepping all callers first.

### CSS/UI Bugs (Runtime, Not Backend)
When the frontend renders but UI elements are broken (overlays hiding content, panels not scaling, drag handles invisible), the issue is CSS, not backend. Common patterns:

1. **Opaque overlay blocking content**: A CSS `::before`/`::after` pseudo-element using fully opaque hex tokens (`#1a1a2e`) instead of intended translucent rgba values covers content. Fix: replace hex with rgba, reduce alpha, add `pointer-events: none`.
2. **Flex children not scaling**: `.panel-stack-content` is `display:flex`. Children without `flex:1` size to `max-content`. Fix: add `.panel-stack-content > * { flex: 1; min-width: 0; min-height: 0; }`.
3. **Resize handle invisible**: Handle is 6-8px wide, transparent, visible only on hover. Test with `localStorage.setItem('wabi:obvious-grab-rails','1'); location.reload()`.
4. **Sidebar row split into two lines / "only the word is clickable"** (verified 2026-08-06, `UnifiedChannelList.svelte`): a `display:flex` row whose children got wrapped in a classless `<div>` stacks them vertically — the wrapper is a plain block, so the label lands on line 1 and the star/pin/gear actions on line 2, and the row doubles in height. Fix: give the wrapper a single-line grid mirroring the styled sibling branch: `display:grid; grid-template-columns: minmax(0,1fr) auto; align-items:center; flex:1; min-width:0;` — the `minmax(0,1fr)` label column makes the button span the full row, restoring whole-line clicks. Diagnostic shortcut: a "2-line row" or "must click only the word" report usually means a classless wrapper div, not a button-style problem.

When the user says "the right panel Notes/Admin tab doesn't properly scale horizontally" or "the server banner is just a solid box", check CSS first, not the Rust backend.

## User Registry & Login Triage

When a user "can't log in" or "isn't in the admin/people list":

1. **Probe login directly** — the 401 body disambiguates the failure mode:
   - `"Invalid username or password"` → row missing **OR** bcrypt verify failed (generic; disambiguate via step 2)
   - `"This account is guest-only. Use 'Join as Guest'..."` → row exists with EMPTY password hash (guest account)
   - `"Account banned: ..."` → user is in `data/wabi-server/blacklist.txt`
2. **Check existence via `GET /api/users`** (any valid token; it's an authed public directory from `wdb.list_users()`). If the user is listed, a generic 401 means **wrong password**, not a broken account. A registered user with a profilePicture has logged in before — it's not a ghost row.
3. **Server-side ban/revocation state** in `data/wabi-server/`: `blacklist.txt`, `revocations.json` (`users: []` = clean; non-empty = token-revoked login-bounce — login mints JWT but AuthUser endpoints 401 "token revoked").
4. **The roster gap ("not in the registry")**: socket `init` payload `users` = **online-only** presence map; `serverMembers` (the intended full directory) was hardcoded `Vec::new()` in `socketio/presence.rs` until 2026-08-06. Surfaces rendering `$users` only (AdminWorkspace registry, AdminSettingsTab) can never show offline registered users. The People panel's greyed "Offline — N" section = `$serverMembers` minus online `$users` — it existed in the UI but was always empty. Fix shape: server populates `serverMembers` from `wdb.list_users()` via `build_user_view`; admin surfaces merge `serverMembers` + `users` (online wins, key = `dbUserId ?? id`). **Same root cause explains "can't see other users' profile pictures until they come online"** — avatars only ever traveled with online presence (`user-joined` broadcasts); once `serverMembers` carries the full directory (with `profilePicture` from the User row), offline users render with avatars immediately. Verify what a client ACTUALLY receives with `scripts/probe-init-payload.mjs` (socket.io guest join → dumps init `users`/`serverMembers`).
5. **Guest accounts are covered too**: `wdb.list_users()` → UsersProjection with `UsersFilter::default()` returns EVERY row — registered, guests (empty `password_hash`), bots; no filtering. Guest discriminator on the wire is `isRegistered: !password_hash.is_empty()` (same test auth.rs uses for the guest-only 401 — the stored `is_registered` flag is unreliable, `User::new` defaults it true). Added end-to-end 2026-08-06: wabi-core `UserView.is_registered` → ts-rs regen → both view builders (`build_user_view`, `connected_user_to_view`) → `socket-types.ts` → admin Guest badge (`!user.dbUserId || user.isRegistered === false`) + guest count.
5. **Password recovery**: the frontend called `POST /api/admin/users/reset-password` + `/clear-login-lockout` long before the backend implemented them (dead API until 2026-08-06 — that's why there was no way to recover a password). General pitfall: grep backend `routes.rs`/handler files before concluding a frontend admin feature is broken — the frontend may anticipate endpoints the backend never shipped. Also: **no step-up flow exists anywhere in the frontend** — UI-called admin endpoints must be gated with `admin_auth` (bearer only), not `admin_auth_stepup` (stepup-gated endpoints like `revoke_user` are API-only).

Full probe commands, code locations, and the fix diff summary: `references/user-registry-login-triage.md`.

## Investigation Procedure

### Step 1: Confirm the Error
```bash
# Replace with your domain if different
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" https://wabi.chat/
```

### Step 2: Check Service Health
```bash
# If you have server access:
ssh tim@100.104.166.42
# Then on the server:
systemctl --user status wabi-server
journalctl --user -u wabi-server -n 50
docker ps | grep wabi
docker logs $(docker ps -q -f name=wabi) 2>/dev/null | tail -20
```

### Step 3: Verify Deployed Version
```bash
# On server:
cd /home/tim/wabi
git log --oneline -5
./target/release/wabi-server --version
```

### Step 4: Check Configuration
```bash
# On server:
cat /home/tim/wabi/.env
cat /home/tim/wabi/config.yaml
```

### Step 5: Test Endpoints Directly (if server accessible)
```bash
# On server or via SSH tunnel:
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/auth/login -X POST -H "Content-Type: application/json" -d '{"username":"test","password":"test"}'
```

## Resolution Steps

### If Service is Down
```bash
# On server:
systemctl --user start wabi-server
# or
docker compose up -d
```

### If Configuration Issue
```bash
# On server:
cd /home/tim/wabi
# Fix .env or config.yaml
systemctl --user restart wabi-server
```

### If Code Needs Deployment
```bash
# On server:
cd /home/tim/wabi
git pull origin main
cd frontend && STATIC_BUILD=1 npm run build && cd ..
cargo build --release -p wabi-server
systemctl --user restart wabi-server
```

## Verification After Fix
```bash
# Should return HTTP 200
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" https://wabi.chat/

# Should return healthy status
curl -s https://wabi.chat/health | jq .

# Should show current version
curl -s https://wabi.chat/ | grep -o 'version":"[^"]*"' | cut -d'"' -f4
```

## Related Skills

- `wabidb-client-offline` - Client-side WabiDB offline persistence layer
- `wabidb-core-capabilities` - Server-side WabiDB engine reference
- `wabi-deploy-debug` - Wabi production deployment and runtime debugging
- `hermes-agent` - Hermes agent configuration and troubleshooting

## Verification Commands (for automation)

```bash
# Confirm service health
curl -s https://wabi.chat/health | jq .

# Confirm basic access
curl -s -o /dev/null -w "%{http_code}\\n" https://wabi.chat/

# Check version
curl -s https://wabi.chat/ | grep -o 'version":"[^"]*"' | cut -d'"' -f4
```