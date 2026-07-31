# Wabi — Networking & Ports

**Status:** living doc  
**Updated:** 2026-07-28  

Wabi is a self-hosted **tool**, not a SaaS. Networking should match that: private by default, public only when you choose, and **not** dependent on a single edge vendor for core chat or default calling.

---

## Layer stack (mental model)

```
1. LAN / router          — same network; fastest; no internet path
2. Tailscale / mesh      — "intranet for people I trust" across CGNAT
3. Domain + HTTPS        — real name + TLS (Caddy / LE or Tailscale certs)
4. Port-forward / public — open internet to home (IP visible) OR skip
```

**Cloudflare (or any tunnel CDN)** is an **optional public front door**, not a required layer.  
Default calling does **not** need CF or open UDP ports.

---

## How calls work

Wabi's calling path is designed to work with minimal network configuration.

### Default calling (no extra ports needed)

```
User A ──WebSocket──→ wabi-server ──WebSocket──→ User B
                        │
                     Wabidb
                 (session state)
```

1. Both users connect to `wabi-server` via the same WebSocket/Socket.IO path used for chat
2. When User A calls User B, `wabi-server` negotiates the call via WebSocket signaling
3. Media flows directly between browsers via WebRTC (peer-to-peer), **not** through the server
4. The server only manages signaling and session state — it doesn't relay media

**No separate media server is needed for 1-on-1 calls.** The WebSocket connection you already have for chat handles call signaling.

### TURN (for problematic networks)

Some networks (CGNAT, corporate firewalls, certain mobile carriers) block direct WebRTC peer connections. In those cases, Wabi can use a TURN server to relay media:

```
User A ──WebRTC──→ TURN Server (coturn) ──WebRTC──→ User B
```

TURN is **optional** and only needed when P2P fails. Enable it with the `turn` Docker profile:

```bash
docker compose --profile turn up -d --build
```

### LiveKit SFU (for >2 participants)

For calls with 3+ participants, Wabi can use a LiveKit SFU (Selective Forwarding Unit) to mix media:

```
User A ──WebRTC──→ LiveKit SFU ──WebRTC──→ User B
                   ──WebRTC──→ User C
                   ──WebRTC──→ User D
```

LiveKit is **optional**. Enable it with the `sfu` Docker profile:

```bash
docker compose --profile sfu up -d --build
```

### Calling summary

| Scenario | Server needed | Extra ports? |
|----------|--------------|-------------|
| 1-on-1 call on same LAN | None (P2P) | No |
| 1-on-1 call over internet | TURN only if P2P fails | UDP 3478 + TLS 5349 |
| 3+ person call | LiveKit SFU (optional) | LiveKit ports (see below) |
| Screen sharing | None (P2P over WebRTC) | No |

---

## Data flow diagram (message delivery)

```
┌─────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────────┐   ┌─────────┐
│  User A  │──▶│  WebSocket   │──▶│ wabi-    │──▶│   Wabidb     │──▶│  Disk   │
│ (browser)│   │  (Socket.IO) │   │ server   │   │  (in-process) │   │ (data/) │
└──────────┘   └──────────────┘   └────┬─────┘   └──────────────┘   └─────────┘
                                       │
                                       │ broadcast
                                       ▼
                                ┌──────────────┐
                                │  WebSocket   │
                                │  (Socket.IO) │
                                └──────┬───────┘
                            ┌──────────┼──────────┐
                            ▼          ▼          ▼
                        ┌────────┐ ┌────────┐ ┌────────┐
                        │ User B │ │ User C │ │ User D │
                        └────────┘ └────────┘ └────────┘
```

1. User A sends a message via WebSocket (Socket.IO)
2. `wabi-server` receives it and writes it to Wabidb for persistence
3. Wabidb persists the event to disk (data/wabi-server/)
4. `wabi-server` broadcasts the event to all connected clients in the same channel
5. Users B, C, D receive the message in real time

---

## What ports do I need open?

### Default (core Wabi only)

| Port | Protocol | Service | Notes |
|------|----------|---------|-------|
| 3000 | TCP | wabi-server (frontend) | Main web UI |
| 3001 | TCP | wabi-server (backend) | HTTP API + WebSocket |
| 8080 | TCP | wabi-server (internal) | Health check / internal API |

**No UDP ports are required for default calling** — media signaling goes over WebSocket, and P2P WebRTC uses ephemeral ports via ICE negotiation. If P2P fails, calls fall back to server-relayed audio over WebSocket.

### With TURN (optional profile)

| Port | Protocol | Service | Notes |
|------|----------|---------|-------|
| 3478 | UDP | coturn (TURN) | Main TURN traffic |
| 5349 | TCP | coturn (TURN TLS) | TURN over TLS |

### With LiveKit SFU (optional profile)

| Port | Protocol | Service | Notes |
|------|----------|---------|-------|
| 7880 | TCP | LiveKit | WebRTC signaling |
| 7881 | UDP | LiveKit | Media traffic |
| 7882 | TCP | LiveKit (TURN) | TURN fallback |

### With tunnel profiles

| Port | Protocol | Service | Notes |
|------|----------|---------|-------|
| 80 | TCP | Caddy | HTTP redirect to HTTPS |
| 443 | TCP | Caddy | HTTPS with auto TLS |

---

## Port opening guidelines

| Scenario | Ports to open |
|----------|--------------|
| LAN-only testing | None needed (localhost:3000) |
| Tailscale/ mesh | None needed (Tailscale handles routing) |
| Public domain (direct) | 80 + 443 (Caddy) → forward to 3000/3001 |
| Public + TURN | 80 + 443 + UDP 3478 + TCP 5349 |
| Public + LiveKit | 80 + 443 + UDP/TCP 7880-7882 |
| Public + TURN + LiveKit | All of the above |
| Cloudflare tunnel | None (outbound-only connection to CF edge) |

---

## Calling and ports

**Default transport:** Wabidb / Socket.IO media relay on the **same TCP/WebSocket** path as the app.

| Need | Required? |
|------|-----------|
| Reach server (LAN / Tailscale / HTTPS proxy) | Yes |
| Open UDP ports for default voice | **No** |
| Cloudflare for default voice | **No** |
| STUN/TURN | Only for optional P2P |
| LiveKit SFU ports | Only if admin enables SFU |

**Browser secure context:** mic/camera need `https://` or `http://127.0.0.1` / `localhost`.  
Plain `http://192.168.x.x` or `http://100.x.x.x` often yields `navigator.mediaDevices is undefined`.

---

## Hiding home IP (CF-less)

You cannot have "anyone on the public internet can connect" **and** "no intermediary and no public address" on residential CGNAT. Choices:

| Mode | Home IP public? | Good for |
|------|-----------------|----------|
| LAN only | No | House |
| Tailscale / Headscale only | No | Friends / team |
| VPS reverse proxy + WireGuard/Tailscale to home | No (public sees VPS) | Public site without CF |
| Port-forward home | **Yes** | Simple public host |
| Cloudflare tunnel | No (public sees CF) | Convenience |

### Recommended CF-less public pattern

```
Internet → small VPS (Caddy + domain + HTTPS)
        → WireGuard or Tailscale
        → home wabi-server
```

- DNS points at **VPS only**
- You control Caddy and the tunnel
- Smaller blast radius than "all traffic opinionated through one edge monopoly"
- Still a middle hop — honest about that

### Private-first (often enough)

No public hostname: invite people onto Tailscale, open `http://100.x:3001` or serve HTTPS with Tailscale certs. Matches "tool not SaaS."

---

## Caddy's role

Caddy is the boring way to get **HTTPS** (certs + reverse proxy to `wabi-server`).

- With a domain + public 80/443 (home or VPS): Let's Encrypt works.
- Without a domain: HTTP-only is fine for LAN testing; mic may not work off-localhost.
- Behind CF tunnel: TLS often at the edge; origin Caddy may be HTTP-only (see `Caddyfile.tunnel`).

---

## Install vs ingress

| Concern | Path |
|---------|------|
| Core product | `wabi-server` + Wabidb (`docker compose up -d`) |
| Ingress | LAN → Tailscale → Caddy/domain → optional CF or VPS jumphost |

Update Tim / a host = update the **core binary + compose era**.  
Re-attaching CF is a separate step after origin health is proven.

---

## Operator checklist

1. Prove origin: `curl http://127.0.0.1:3001/health` on the host  
2. Prove mesh/LAN for trusted users  
3. Add Caddy HTTPS if you need mic for non-localhost clients  
4. Optional: public CF or VPS jumphost  
5. Never treat CF outage as "Wabi is down" if origin is up — that's ingress, not the app  

---

## Related

- Deploy skill: `~/.hermes/skills/devops/wabi-deploy/` (v3+)  
- `references/network-cgnat-and-cloudflare.md` in that skill  
- `Caddyfile.example` / `Caddyfile.tunnel` in repo  
- Compose profiles: tunnels optional; default is `wabi-server` only  
