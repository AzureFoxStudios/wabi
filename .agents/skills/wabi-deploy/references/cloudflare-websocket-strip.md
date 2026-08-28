# Cloudflare / cloudflared strips the WebSocket Upgrade — diagnosis + fix

Verified incident 2026-07-19: after a fresh-DB redeploy, the Wabi app loaded but the
socket.io connection never established. Browser console: `Firefox can't establish a
connection to wss://wabi.chat/socket.io/?EIO=4&transport=websocket`.

## Symptom

- `wss://wabi.chat/socket.io/...` fails ("connection interrupted while page was loading").
- The `static.cloudflareinsights.com` CSP error in the same console is a **red herring**
  (blocked analytics, harmless).
- API calls work; only the realtime socket dies.

## Diagnosis (do this before touching the binary)

The WS upgrade is stripped somewhere in Cloudflare → cloudflared → caddy. Isolate it with
a raw `Upgrade` handshake at each hop:

```bash
# 1. Direct to caddy on Tim (bypasses Cloudflare/tunnel) — should return 101
ssh tim@100.96.11.45 'curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://127.0.0.1:8088/socket.io/?EIO=4&transport=websocket" | head -12'
# Expect: HTTP/1.1 101 Switching Protocols  +  Upgrade: websocket

# 2. Through the public edge (Cloudflare + tunnel) — if it returns 200 (no 101), the
#    upgrade was stripped upstream of caddy.
curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://wabi.chat/socket.io/?EIO=4&transport=websocket" | head -12
# If you see HTTP/2 200 + content-length:0 (no 101) → upgrade stripped by edge/tunnel.
```

Also check `docker logs wabi-cloudflared-named` for the `/socket.io/` request: if the
origin (caddy) returns `200 OK content-length=0` for the WS path, caddy never saw the
`Upgrade` header (cloudflared dropped it).

## Root cause

1. **socket.io client is WebSocket-only** — `frontend/src/lib/socketConnectionCore.ts` had
   `transports: ['websocket']`. With no polling fallback, a failed WS upgrade = no
   connection at all.
2. **The Cloudflare→cloudflared→caddy hop strips `Upgrade: websocket`** in this stack
   (reproduced: caddy direct = 101, public edge = 200). cloudflared `--protocol quic`
   tunnels are especially prone to this (see pitfall 28 / SKILL.md).

## Fix (frontend, not server)

Set the socket.io client to negotiate polling first, then upgrade to WS when available:

```ts
// frontend/src/lib/socketConnectionCore.ts  (inside io(serverUrl, { ... }))
transports: ['websocket', 'polling'],
```

Then rebuild + redeploy:
```bash
cd frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build && cd ..
cargo build --release -p wabi-server
# ship binary, lock-clear, up (see tim-update-runbook.md)
```

## Verify end-to-end (no browser needed)

Polling works through Cloudflare, so prove the full session:

```bash
# handshake → expect {"sid":...,"upgrades":["websocket"],...}
curl -s "https://wabi.chat/socket.io/?EIO=4&transport=polling" | head -c 200

# login to get a token
TOK=$(curl -s -X POST https://wabi.chat/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"wabi","password":"Please1"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")

SID=$(curl -s "https://wabi.chat/socket.io/?EIO=4&transport=polling" | sed 's/^0//' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('sid',''))")

# connect with token → expect "ok"
curl -s -X POST "https://wabi.chat/socket.io/?EIO=4&transport=polling&sid=$SID" \
  -H "Content-Type: text/plain;charset=UTF-8" --data-binary "40{\"token\":\"$TOK\"}"

# poll for server ack → expect 2<0x1e>40{"sid":"..."}
curl -s "https://wabi.chat/socket.io/?EIO=4&transport=polling&sid=$SID"
```

A headless-browser confirmation (Playwright, `npx playwright install chromium`) is the
strongest proof: load `https://wabi.chat/login`, log in, assert a `/socket.io/` polling
`200` appears in network and `pageerror` count is 0.

## Do NOT

- Chase the Rust binary for WS — it's a client-transport + edge-strip issue.
- Add `cloudflared --protocol quic` connectors to "fix" WS — quic tunnels strip the
  upgrade too (pitfall 28). Prefer http2 connectors for socket.io-heavy apps.
- Treat the `beacon.min.js` CSP error as the connection failure — it is not.
