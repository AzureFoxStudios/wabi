# Cloudflared WS + WabiDB lock recipes

## WebSockets through Cloudflare (socket.io)

socket.io client: `frontend/src/lib/socketConnectionCore.ts`. It had `transports: ['websocket']` (WS-only, no fallback). Cloudflared **`quic`** tunnels (and sometimes the edge) strip the `Upgrade: websocket` header, so the WS handshake returns HTTP 200 instead of `101 Switching Protocols` → connection fails, no fallback.

### Verification commands (proves WHERE the break is)
```bash
# 1. WS upgrade DIRECT to caddy (:8088) — expect 101
curl -s -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8088/socket.io/?EIO=4&transport=websocket

# 2. SAME through wabi.chat (Cloudflare + tunnel) — 200 (no 101) = upgrade stripped upstream
curl -s -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
  https://wabi.chat/socket.io/?EIO=4&transport=websocket

# 3. Polling handshake (should work end-to-end both ways)
curl -s "https://wabi.chat/socket.io/?EIO=4&transport=polling"   # returns {"sid":...}
```

If (1)=101 and (2)=200 → the tunnel/edge strips WS. Fix: `transports: ['websocket', 'polling']` so socket.io prefers WS but falls back to long-polling (polling works through Cloudflare). Also remove any `--protocol quic` cloudflared connectors in favor of `http2` if native WS is required. Polling fallback makes it non-blocking regardless.

Note: a single http2 cloudflared connector can 502 intermittently after restarts (the prior "502 holy moly" symptom). Multiple http2 connectors keep resilience without the WS-stripping quic mode.

## Dead QUIC edge → public 502 with healthy origin (2026-07-23)

This is distinct from "WS upgrade stripped" (site loads, socket fails). Here the **whole site** is Cloudflare 502.

| Probe | Healthy-origin dead-tunnel result |
|---|---|
| `https://wabi.chat/health` | Cloudflare body `error code: 502` |
| Tim `127.0.0.1:3001/health` | 200 JSON ok |
| Tim `127.0.0.1:8088/health` | 200 (Via: Caddy) |
| `docker logs --since 2m wabi-cloudflared-named` during public curls | **empty** — edge never handed traffic to connector |
| cloudflared historical ERR | `failed to dial to edge with quic: timeout: no recent network activity` |

Running compose on Tim had been `tunnel --no-autoupdate --protocol quic ...` even when the repo's intended posture is http2. Container "Up 6 days" is not proof the edge path is live.

### Fix (Tim `/home/tim/Desktop/Wabi`, no wipe)
```bash
cd /home/tim/Desktop/Wabi
cp -a docker-compose.yml "docker-compose.yml.bak-quic-$(date +%Y%m%d%H%M%S)"
sed -i 's/--protocol quic/--protocol http2/g' docker-compose.yml
docker compose --profile tunnel --profile tunnel-named up -d --force-recreate \
  caddy-tunnel cloudflared-named cloudflared-named-2 cloudflared-named-3
# boot log must show: Initial protocol http2 + Registered tunnel connection ... location=bkk/sin
```
Token stays in `.env` as `CLOUDFLARE_TUNNEL_TOKEN` — never echo it. After fix, public probes must appear in `docker logs --since 1m wabi-cloudflared-named`.

### Auth API smoke (no password needed)
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://wabi.chat/login          # 200
curl -s https://wabi.chat/api/setup/status                                   # {"setupRequired":false} if owner exists
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://wabi.chat/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"wabi","password":"x"}'  # 401 = auth path live
curl -s "https://wabi.chat/socket.io/?EIO=4&transport=polling"               # {"sid":...}
```
Real login still needs Ronin's browser + real credentials.

## WabiDB two-level lock (restart-loop trap)

`wabi-server` owns a data dir (e.g. `data/wabi-server/`). Two lock files exist:
- `data/wabi-server/.lock` (top-level)
- `data/wabi-server/wabidb/.lock` (DEEPER — the engine lock)

A stale DEEPER lock causes `Error: engine already running` and the container restart-loops even after `docker stop` + `docker rm` + `up`. Clearing only the top lock leaves the engine lock and loops the new container.

### Deploy script MUST remove BOTH:
```bash
rm -f "${DEST}/data/wabi-server/.lock" "${DEST}/data/wabi-server/wabidb/.lock" || true
```

### Full DB wipe + fresh owner (dev server, user-authorized "relax"):
```bash
docker stop wabi-server
docker rm -f wabi-server
rm -rf data/wabi-server
docker compose up -d
# then register the owner through the NORMAL flow (or curl register) so id 1 lands in the
# DURABLE commit log, not only snapshot.json. Otherwise every restart drops the owner -> 401.
curl -s -X POST http://127.0.0.1:8088/api/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"wabi","password":"<pass>"}'
curl -s -X POST http://127.0.0.1:8088/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"wabi","password":"<pass>"}'   # expect 200 + token
```

### Health check after deploy:
```bash
curl -s -o /dev/null -w "health: %{http_code}\n" --max-time 8 http://127.0.0.1:8088/health
```

### Owner-kill symptom (pre-fix, now avoided by full wipe+register):
If `setupRequired` is true but the UI shows guest-loading / 8080 spam, it's stale frontend localStorage (`wabi.savedServers.v1`, `wabi_has_logged_in`, wabi.* auth keys) — clear them, hard refresh. The backend `getSetupStatus` drives the wizard; the frontend boot short-circuits to reconnect if `hasLoggedInBefore` is set.
