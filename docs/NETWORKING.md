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

## Private access via Tailcat (built-in, optional)

**New (2026-09-01):** Wabi ships a private-access transport addon (`core/addons/tailcat`) built on
[tailcat](https://github.com/tailscale/tailcat) — Tailscale's userspace WireGuard data plane without
the control plane. For family/friend instances this replaces "layer 2 + layer 3" of the stack above
with **one paste-able `tc…` code**: no port-forward, no domain, no cloud tunnel, and the home box
gets *darker* (zero inbound ports; magicsock punches outbound).

- **Transport only.** The pipe grants reachability, never membership — Wabi auth always gates.
- **Per-member keys.** Each member's desktop client registers its own key against their account;
  an admin revokes per member. No shared bearer tokens.
- **Off by default.** Enable from Admin → Runtime → "Private access" (explicit confirm to turn on;
  instant kill-switch to turn off). Disabled = no subprocess, zero footprint.
- **Requirements:** the `tailcat` binary v0.4.0+ on PATH (or `WABI_TAILCAT_BINARY`), desktop/Tauri
  clients for members (browser users keep using the normal address).
- **Rate limits:** pipe clients are keyed per-connection (not collapsed into one `127.0.0.1`
  bucket), so a family creating accounts the same evening doesn't trip the 5/hour guest cap.
- **Public DERP caveat:** bootstrap/relay uses Tailscale's free DERP fleet (rate-limited, no SLA);
  self-host [`derper`](https://github.com/tailscale/tailscale/tree/main/cmd/derper) for reliability.
- Design + spike/E2E evidence: `docs/plans/2026-09-01-tailcat-private-access.md` (incl. measured
  cross-NAT relay floor ~390 KB/s, 1/10 immediate direct). Operator walkthrough:
  `PROJECT_DOCS/03-features/PRIVATE_ACCESS_GUIDE.md`.

## Related

- Deploy skill: `~/.hermes/skills/devops/wabi-deploy/` (v3+)  
- `references/network-cgnat-and-cloudflare.md` in that skill  
- `Caddyfile.example` / `Caddyfile.tunnel` in repo  
- Compose profiles: tunnels optional; default is `wabi-server` only  
