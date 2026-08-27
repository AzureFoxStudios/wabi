# Tim restart-loop + login UX hardening

## Observed failure mode (2026-08-10)

Tim's `wabi-server` container was in a ~1-minute restart loop:

```
🚀 Wabi Node v0.1.0
📡 Starting server on 0.0.0.0:3000
Error: engine already running
```

Public endpoints:
- `GET https://wabi.chat/api/public/backend-endpoints` → HTTP 502
- `GET https://wabi.chat/socket.io/?EIO=4&transport=polling` → HTTP 502
- Firefox: `Firefox can't establish a connection to the server at wss://wabi.chat/socket.io/...`

Frontend console included `places_502`, repeated `ServerUrl` resolution spam, and
`WebGL context was lost` noise. The **Cloudflare beacon hash mismatch** warning
is unrelated CF instrumentation noise; ignore it.

## Root cause

Stale WabiDB lock at `data/wabi-server/wabidb/.lock`. There are two lock files;
removing only `data/wabi-server/.lock` is insufficient.

## Recovery command sequence

Run on Tim (`tim@100.96.11.45`):

```bash
cd ~/Desktop/Wabi
docker compose stop wabi-server
docker rm wabi-server
find data/wabi-server -name '*.lock' -print   # confirm before delete
find data/wabi-server -name '*.lock' -delete
docker compose up -d wabi-server
```

Verify:

```bash
curl -sS -o /dev/null -w '%{http_code}' https://wabi.chat/api/public/backend-endpoints
# expect 200
curl -sS -o /dev/null -w '%{http_code}' "https://wabi.chat/socket.io/?EIO=4&transport=polling"
# expect 200
docker logs --tail 40 wabi-server
# expect no more "engine already running"
```

## Why registered login appears "stuck signed in"

Login succeeds at the credential layer, then post-login paths hit 502:
- `/api/user/settings`, `/api/public/backend-endpoints`, places registry, socket.io
- The socket retries, the app stays in `loggedIn=true` but never completes boot
- Guest bypasses some of those fetches, so it *appears* to work

This is not an auth state bug — it is a backend outage leaking into the UI.

## Login/boot UX hardening

When the backend is unreachable, do **not** silently retry forever or
hard-cache user data to fake connectivity. Instead:

- **Boot shell:** show an explicit “Not connected to server — cannot log in or switch users” overlay with a manual retry button, after a bounded retry count.
- **Logout:** keep current semantics (`disconnect()` + `clearAuthSession()` + remove `wabi_has_logged_in`).
- **ConnectionBadge:** already maps `failed` → `Server unreachable`; ensure the
  badged state is visible once a real connection attempt has occurred, not during
  pre-auth idle.
- **Returning-user reconnect loop:** the `/api/auth/validate` retry in
  `frontend/src/routes/+page.svelte` should also surface a user-visible
  disconnect notice after `maxReconnectAttempts` instead of going silent.

This keeps the offline UX honest without baking in fake-user hacks.
