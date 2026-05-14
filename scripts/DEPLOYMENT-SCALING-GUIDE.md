# Wabi Server Deployment — From Zero to Edge

A practical guide for deploying Wabi at every scale, from a laptop to a global edge network.

---

## Scale 0: Localhost (No Website)

**What:** Run everything on your own machine. No domain, no SSL, no public access.

**Stack:**
- `wabi-server` + `spacetimedb` running locally
- Frontend served from `npm run dev` (port 5173) or the static build
- Direct IP: `http://127.0.0.1:3000` or `http://localhost:3000`

**When:** Development, LAN parties, testing.

**Command:**

```bash
cd /path/to/wabi
docker-compose up -d
# or native:
./wabi-serve --port 3000
```

**Limitations:**
- Only accessible from your machine
- No SSL/TLS
- WebRTC calls won't traverse NAT (no TURN/ICE)
- No persistence beyond your local disk

---

## Scale 1: LAN Access (No Domain, Just IP)

**What:** Expose your machine to your local network so phones/tablets on the same WiFi can connect.

**Stack:**
- Bind `wabi-server` to `0.0.0.0` instead of `127.0.0.1`
- Use your LAN IP: `http://192.168.1.xxx:3000`

**Command:**

```bash
# In docker-compose.yml or .env:
WABI_HOST=0.0.0.0

# On the client device:
# Open browser to http://192.168.1.xxx:3000
```

**When:** Home use, small teams on the same network, demos.

**Limitations:**
- Still no SSL — browsers will warn about insecure connection
- No access outside the LAN
- IP can change when your router reboots

---

## Scale 2: Tailscale/ZeroTier (Private Mesh, No Domain)

**What:** Create a private mesh network so devices anywhere connect as if on the same LAN.

**Stack:**
- Tailscale or ZeroTier on all devices
- Magic DNS gives you stable hostnames like `iyoku-laptop.tailnet-name.ts.net`

**Command:**

```bash
# Install tailscale on server and clients:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Wabi server binds to tailscale IP:
WABI_HOST=100.x.x.x  # your tailscale IP
```

**When:** Friends/family across the internet, remote teams, avoiding public exposure entirely.

**Advantages over Scale 1:**
- Works across the internet (not just LAN)
- Encrypted WireGuard tunnel
- No port forwarding needed
- Stable hostnames
- Still zero cost

**Limitations:**
- Everyone needs Tailscale installed
- No public domain means no public invites
- Tailscale free plan has device limits (100)

---

## Scale 3: Named Tunnel (Domain, No Server)

**What:** Give your localhost/LAN setup a real domain name without hosting on a server.

**Stack:**
- Cloudflare Tunnel (`cloudflared`) — free
- OR: ngrok free tier
- Your own domain (Cloudflare) or a generated subdomain

**Command (Cloudflare):**

```bash
# Already exists in your docker-compose.yml under profiles:
docker compose --profile tunnel --profile tunnel-quick up -d --build

# Or manually:
cloudflared tunnel --no-autoupdate --url http://localhost:3000
```

**When:** You want a real URL to share, but still run on your machine.

**Advantages:**
- Real domain name (e.g. `wabi.yourdomain.com`)
- Cloudflare provides SSL automatically
- No server rental cost
- DDoS protection from Cloudflare edge

**Limitations:**
- Your machine must stay on
- Cloudflare free tunnel gets a random subdomain unless you configure a named one
- Bandwidth limits on free plan (100GB/mo — generous for chat)
- Not "production" — if your machine sleeps, Wabi goes down

---

## Scale 4: VPS/Bare Metal (Own the Server)

**What:** Rent a cheap VPS ($3-10/mo) or use an old computer at home. This is the "standard" self-hosted approach.

**Stack:**
- Any VPS: Hetzner, DigitalOcean, Linode, Vultr, or a Raspberry Pi at home
- Docker + docker-compose
- Caddy or Traefik for reverse proxy + SSL
- systemd or docker-compose for process supervision

**Setup:**

```bash
# On the VPS (Debian/Ubuntu):
apt update && apt install -y docker.io docker-compose
# Or: use the docker-compose.yml in this repo
git clone https://github.com/your-org/wabi.git
cd wabi
docker-compose up -d
```

**For your existing machines (Iyoku, Tim):**

```bash
# SSH to Iyoku (your staging)
ssh user@100.104.166.42
git pull origin main
docker-compose up -d --build
```

**When:** You want Wabi online 24/7 with a stable IP.

**Advantages:**
- Full control
- Custom domain + SSL via Caddy (auto-HTTPS)
- Can run TURN server for WebRTC (coturn in compose)
- Can add backup cron jobs
- Cost: $3-10/mo VPS, or $0 if using home hardware + electricity

**Limitations:**
- Single point of failure (one server)
- If server is far from users, latency is higher
- You manage uptime, backups, SSL renewal

---

## Scale 5: Reverse Proxy + SSL (The "Real Website")

**What:** Put Caddy, Nginx, or Traefik in front of Wabi. This gives you HTTPS, subdomain routing, and load balancing hooks.

**Stack:**
- Caddy (already in your docker-compose.yml as `caddy-tunnel`)
- OR: Nginx + certbot for Let's Encrypt
- Domain pointed at your server IP

**Caddyfile example:**

```caddy
wabi.yourdomain.com {
    reverse_proxy wabi-server:3000
    encode gzip zstd
    tls {
        dns cloudflare YOUR_API_TOKEN
    }
}
```

**Already in your repo:**
- `Caddyfile.tunnel` — for Cloudflare tunnel
- `Caddyfile.stdb` — for SpacetimeDB proxy
- `Caddyfile.example` — general reference

**When:** You want HTTPS, custom headers, rate limiting, or multiple services on one server.

**Advantages:**
- Auto SSL certificates (Caddy handles renewal)
- Can add basic auth at the edge
- Path rewriting if you run multiple apps
- WebSocket proxying already configured in Caddy

---

## Scale 6: CDN-Backed Static Frontend (Edge for Assets)

**What:** The Wabi frontend is a static SvelteKit build. You can serve it from a CDN while keeping the API on your server.

**Stack:**
- Build frontend: `cd frontend && npm run build`
- Upload `frontend/build/` to Cloudflare Pages / Vercel / Netlify / AWS S3 + CloudFront
- API calls point to your VPS: `https://api.wabi.yourdomain.com`

**Config:**

```javascript
// frontend/.env.production
PUBLIC_API_URL=https://api.wabi.yourdomain.com
PUBLIC_WS_URL=wss://api.wabi.yourdomain.com
```

**When:** You have users worldwide and want the UI to load fast everywhere.

**Advantages:**
- Frontend loads from 300+ Cloudflare edge locations
- API/WebSocket still goes to your origin server
- Costs: Cloudflare Pages is free for most usage
- Offloads static asset bandwidth from your VPS

**Limitations:**
- The websocket + API still need a central origin
- The CORS/config dance between CDN frontend and API server
- Real-time features (calling, screen share) still go through your single server

---

## Scale 7: Edge-First / "Chocolate Coated Cloudflare"

**What:** Push as much as possible to the edge: auth, routing, workers, Durable Objects, R2 storage.

**Stack:**
- **Cloudflare Pages** — static frontend
- **Cloudflare Workers** — auth, API routing, rate limiting at edge
- **Cloudflare Durable Objects** — real-time pub/sub (alternative to WebSocket server)
- **Cloudflare R2** — file uploads (much cheaper than S3)
- **Cloudflare TURN** — managed WebRTC relay (or keep coturn)
- **Cloudflare Access** — zero-trust authentication layer

**Architecture:**

```
User Browser
     |
[Cloudflare Edge]
     |-- Pages: static frontend (build/)
     |-- Worker: auth check + API routing
     |-- Durable Object: real-time room state
     |-- R2: file attachments
     |
     ↓ (only for stateful backend)
[Your Origin Server]
     |-- wabi-server (axum) — but much lighter now
     |-- spacetimedb
```

**When:** You want global low latency, DDoS resistance, and minimal origin load.

**Advantages:**
- Edge workers run in 300+ cities, <50ms response globally
- Durable Objects give you distributed state without managing servers
- R2 is 1/4 the cost of AWS S3
- Cloudflare Access gives you Google/GitHub SSO for free
- Origin server can be a tiny VPS because edge handles most traffic

**Limitations:**
- Requires rearchitecting parts of Wabi (Workers have CPU/memory limits)
- Durable Objects are NOT a drop-in replacement for SpacetimeDB
- WebRTC signaling still needs a central coordinator
- Some Wabi features (file upload processing, plugin sandboxing) need compute that Workers can't provide

**Migration path for Wabi:**
1. Phase 1: Static frontend on Pages (easy)
2. Phase 2: Replace nginx/Caddy with Workers for API proxy (medium)
3. Phase 3: Move real-time presence to Durable Objects (hard — replaces socket.io)
4. Phase 4: Move file storage to R2 (medium)
5. Phase 5: Keep SpacetimeDB + axum backend only for stateful operations (e.g. business logic, plugin runtime)

---

## Scale 8: Multi-Region / Kubernetes (The "Web Dev" Way)

**What:** Cloud-native deployment with auto-scaling, health checks, rolling updates.

**Stack:**
- **Kubernetes** (k3s for small, EKS/GKE/AKS for enterprise)
- **Helm** charts for Wabi services
- **Traefik/Nginx Ingress** + cert-manager
- **Prometheus + Grafana** for monitoring
- **PostgreSQL or Redis** for cache + session store
- **Object storage** (S3/R2/MinIO) for uploads

**Not recommended for Wabi unless:**
- You have 1000+ concurrent users
- You need auto-scaling (K8s HPA)
- You have an ops team or ops interest

**Complexity jump:** Scale 4 → Scale 8 is a 10x increase in complexity for marginal benefit on a self-hosted chat app.

---

## Recommended Path for Wabi

Given that Wabi is:
- Self-hosted (you want control)
- Chat + calling (needs low-latency WebSocket + TURN)
- Has a Rust backend (single binary, easy to deploy)
- Targets small-to-medium communities

**The sweet spot is Scale 4 + Scale 5 + optionally Scale 6:**

1. **VPS on Hetzner** ($3.79/mo CX11) or **home server**
2. **Caddy reverse proxy** for auto-SSL (already in your compose)
3. **Custom domain** pointed at VPS
4. **Cloudflare DNS + proxy** for the domain (free plan — gives you DDoS + caching + SSL even before Caddy)
5. **Tailscale** as a backup/admin access layer
6. **Optional:** static frontend on Cloudflare Pages if you have global users

This gives you:
- Real domain + HTTPS
- $0-5/mo cost
- Full control of data
- WebRTC works with coturn in docker-compose
- No K8s complexity
- Can scale up VPS size if needed

---

## Your Current Setup

Looking at your repo, you already have most of Scale 4-5 built in:

| Component | Status | File |
|-----------|--------|------|
| SpacetimeDB | ✅ Dockerized | `docker-compose.yml` |
| wabi-server | ✅ Dockerized | `docker-compose.yml` |
| STDB proxy (Caddy) | ✅ Dockerized | `docker-compose.yml` + `Caddyfile.stdb` |
| Tunnel (Cloudflare) | ✅ Optional profile | `docker-compose.yml` (tunnel profile) |
| TURN server | ✅ Optional profile | `docker-compose.yml` (turn profile) |
| Media gateway | ✅ Optional profile | `docker-compose.yml` (srt-gateway profile) |
| LiveKit SFU | ✅ Optional profile | `docker-compose.yml` (sfu profile) |

**You are already at Scale 4.** To go to Scale 5:

1. Buy a domain (Namecheap, Cloudflare Registrar, Porkbun)
2. Point it at your server IP
3. Add `Caddyfile` entry for your domain
4. Enable `tunnel-named` profile with your Cloudflare token

To go to Scale 6:

1. Set `PUBLIC_API_URL` in frontend build env
2. Build frontend: `npm run build`
3. Upload `build/` folder to Cloudflare Pages
4. Point your domain's `www` to Pages, `api` subdomain to your VPS

---

## Cost Comparison

| Scale | Monthly Cost | Effort |
|-------|-------------|--------|
| 0 (localhost) | $0 | Zero |
| 1 (LAN) | $0 | Minimal |
| 2 (Tailscale) | $0 | Low |
| 3 (CF Tunnel) | $0 | Low |
| 4 (VPS) | $3-10 | Low |
| 5 (Reverse proxy) | $3-10 + domain (~$10/yr) | Low |
| 6 (CDN frontend) | $3-10 + domain | Medium |
| 7 (Edge-first) | $5-20 + domain | High |
| 8 (K8s) | $50-500+ | Very High |

---

*This guide was written for the Wabi project but applies to any self-hosted web application.*
