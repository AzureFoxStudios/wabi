# Wabi networking model

**Status:** living doc  
**Updated:** 2026-07-15  

Wabi is a self-hosted **tool**, not a SaaS. Networking should match that: private by default, public only when you choose, and **not** dependent on a single edge vendor for core chat or default calling.

---

## Layer stack (mental model)

```
1. LAN / router          — same network; fastest; no internet path
2. Tailscale / mesh      — “intranet for people I trust” across CGNAT
3. Domain + HTTPS        — real name + TLS (Caddy / LE or Tailscale certs)
4. Port-forward / public — open internet to home (IP visible) OR skip
```

**Cloudflare (or any tunnel CDN)** is an **optional public front door**, not a required layer.  
Default calling does **not** need CF or open UDP ports.

---

## Calling and ports

**Default transport:** WabiDB / Socket.IO media relay on the **same TCP/WebSocket** path as the app.

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

You cannot have “anyone on the public internet can connect” **and** “no intermediary and no public address” on residential CGNAT. Choices:

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
- Smaller blast radius than “all traffic opinionated through one edge monopoly”
- Still a middle hop — honest about that

### Private-first (often enough)

No public hostname: invite people onto Tailscale, open `http://100.x:3001` or serve HTTPS with Tailscale certs. Matches “tool not SaaS.”

---

## Caddy’s role

Caddy is the boring way to get **HTTPS** (certs + reverse proxy to `wabi-server`).

- With a domain + public 80/443 (home or VPS): Let’s Encrypt works.
- Without a domain: HTTP-only is fine for LAN testing; mic may not work off-localhost.
- Behind CF tunnel: TLS often at the edge; origin Caddy may be HTTP-only (see `Caddyfile.tunnel`).

---

## Install vs ingress

| Concern | Path |
|---------|------|
| Core product | `wabi-server` + WabiDB (`docker compose up -d`) |
| Ingress | LAN → Tailscale → Caddy/domain → optional CF or VPS jumphost |

Update Tim / a host = update the **core binary + compose era**.  
Re-attaching CF is a separate step after origin health is proven.

---

## Operator checklist

1. Prove origin: `curl http://127.0.0.1:3001/health` on the host  
2. Prove mesh/LAN for trusted users  
3. Add Caddy HTTPS if you need mic for non-localhost clients  
4. Optional: public CF or VPS jumphost  
5. Never treat CF outage as “Wabi is down” if origin is up — that’s ingress, not the app  

---

## Related

- Deploy skill: `~/.hermes/skills/devops/wabi-deploy/` (v3+)  
- `references/network-cgnat-and-cloudflare.md` in that skill  
- `Caddyfile.example` / `Caddyfile.tunnel` in repo  
- Compose profiles: tunnels optional; default is `wabi-server` only  
