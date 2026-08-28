# Networking: CGNAT, calling, Cloudflare

Updated 2026-07-17 (post Tim WabiDB cutover + dual-connector 502 fix).

## Layer stack

```
1. LAN / router
2. Tailscale / mesh   — primary CGNAT path; no port-forward
3. Domain + HTTPS     — Caddy/LE or Tailscale certs (secure context for mic)
4. Port-forward       — only if ISP allows; IP becomes public
```

Cloudflare (or any edge tunnel) is an **optional public front door**, not a core layer.

## Calling and ports

**Default transport is WabiDB / Socket.IO media relay** over the same TCP/WebSocket as the app. It does **not** require open UDP, STUN/TURN, or CF for default voice.

| Need | CF required? |
|------|----------------|
| LAN / Tailscale / port-forward reachability | No |
| Default voice/DM (wabidb) on CGNAT | No — only reach the server |
| Optional P2P / LiveKit SFU | May need TURN/UDP — not default |
| Mic/camera in browser | **Secure context**: `https://` or `http://127.0.0.1` / `localhost` |

`navigator.mediaDevices is undefined` on plain `http://192.168.x` / `http://100.x` is a **browser rule**, not a Wabi bug.

## CF-less IP protection

| Mode | Home IP public? |
|------|-----------------|
| LAN / Tailscale only | No |
| VPS reverse proxy + WG/TS to home | No (public sees VPS) |
| Port-forward home | Yes |
| CF tunnel | No (public sees CF) |

There is no “public internet + zero intermediary + CGNAT + hide home IP” free lunch. Prefer Tailscale-first; optional small VPS jumphost if public without CF.

## Origin vs edge health

Proven: Tim origin (`:3001` / Caddy `:8088`) can be fully healthy while **https://wabi.chat** 502s for some clients.

Always report separately:

1. Origin on Tim
2. Public from Tim egress
3. Public from Ronin / user egress

Do not redeploy the binary to fix CF-only 502. Client-IP split and dual-connector fix: **`references/wabichat-502-diagnosis.md`**.

Production tunnel shape (Tim compose, tunnel profiles):

- `caddy-tunnel` → `wabi-tunnel-caddy`, `127.0.0.1:8088`, `Caddyfile.tunnel`
- `cloudflared-named` + `cloudflared-named-2` — same token, **quic**, both registered

## Unbind CF to test CF-less

1. Stop cloudflared containers (+ tunnel caddy if only for CF).
2. Dashboard: pause tunnel / DNS if needed.
3. Prove `curl http://127.0.0.1:3001/health` on the host.
4. Access via Tailscale `http://100.96.11.45:3001` until CF rewired or permanently dropped.

## Agent rule

Do not treat Cloudflare as load-bearing for WabiDB calling or install success. Treat CF as optional ingress.
