# Wabi Self-Hosting — From Your Laptop to a Rack

A complete deployment guide for running Wabi on hardware YOU control.
The network adapts to you, not the other way around.

---

## Philosophy: Self-Host First

Wabi is built to be run by the people who use it. You do NOT need:
- A domain name
- A VPS subscription
- Cloudflare (or any CDN)
- Port forwarding (if using Tailscale)
- SSL certificates (for private/LAN use)

You DO need:
- A computer that stays on while people want to chat
- Docker (recommended) or the ability to compile Rust
- (Optional) A friend who can read an IP address

---

## Quick Decision: Which Tier Are You?

| Your Situation | Use This Tier | What You Do |
|----------------|---------------|-------------|
| Same WiFi / LAN | Tier 1 | Type the LAN IP. Done. |
| You + friends, anywhere | Tier 2 | Install Tailscale. All peers get real IPs. Done. |
| CGNAT (most of world), no Tailscale | Tier 3 | Cloudflare Tunnel (outbound only). Done. |
| US / real public IP, no VPN | Tier 4 | Port forward router. Done. |
| Old laptop died, need always-on | Tier 5 | $3/mo VPS. Done. |
| Rack server / community of 500+ | Tier 6 | Compose profiles, monitoring. |

---

## Tier 0: Just You (Localhost)

**Goal:** Run Wabi on your own machine. Only you can access it.

**Hardware:** Your current computer.
**Network:** None needed. Completely offline-capable after first build.

### Docker (Recommended)

```bash
cd /path/to/wabi
docker-compose up -d
```

Then open `http://localhost:3000` in your browser.

### Native (No Docker)

```bash
cd /path/to/wabi
./wabi-serve.sh --port 3000
```

Or run the Rust binary directly:

```bash
cd core/crates/wabi-server
cargo run --release -- --port 3000
```

**What works:**
- Full chat, channels, DMs
- File uploads (stored locally in `./data/uploads`)
- WebSocket real-time
- Embedded frontend (no separate web server needed)

**What doesn't:**
- Anyone else can't connect (it's localhost)
- Voice/video calls need another peer to test against

---

## Tier 1: LAN Party / Friends on Same WiFi

**Goal:** Everyone on your local network connects directly to your machine.

**Hardware:** Your current computer.
**Network:** Same WiFi/Ethernet. No internet required.

### Step 1: Find your LAN IP

```bash
# Linux/macOS:
ip addr show | grep "inet " | head -5

# Or simply:
hostname -I | awk '{print $1}'
```

You'll get something like `192.168.1.42`.

### Step 2: Make sure Wabi binds to all interfaces

Your `wabi-server` already defaults to `0.0.0.0` (all interfaces), but verify in `docker-compose.yml`:

```yaml
services:
  wabi-server:
    ports:
      - "0.0.0.0:3000:3000"   # ← binds to ALL interfaces, not just localhost
```

If running native, pass `--host 0.0.0.0`:

```bash
./wabi-serve.sh --host 0.0.0.0 --port 3000
```

### Step 3: Friends connect via raw IP

Tell your friends to open their browser and type:

```
http://192.168.1.42:3000
```

Or better: they download the **Wabi Desktop/Mobile app**, and when prompted for a server URL, they type:

```
http://192.168.1.42:3000
```

The app stores this in localStorage. Next launch it auto-connects.

### For Voice/Video Calls

If everyone is on the same LAN, WebRTC connects directly peer-to-peer. No TURN server needed.

If you want calls to work across routers (e.g. friend on guest WiFi), enable the TURN server in docker-compose:

```bash
docker-compose --profile turn up -d
```

This starts `coturn` on UDP 3478. The frontend auto-discovers it.

### No Domain, No SSL, No Problem

On a LAN, HTTP is fine. Your traffic never leaves the building. The browser "Not Secure" warning is expected and harmless.

---

## Tier 2: Friends Across the Internet (Tailscale — Recommended Default)

**Goal:** Run Wabi on your home computer. Friends anywhere in the world connect securely.
**No port forwarding. No public IP. No domain. Works through CGNAT.**

**Hardware:** Your current computer (can sleep when not in use, or use an always-on machine).
**Network:** Internet connection. Tailscale handles NAT traversal.

### Why Tailscale Is The Default

- **WireGuard encrypted tunnel.** All traffic is encrypted end-to-end.
- **NAT punching built-in.** Works through ANY router, including CGNAT.
- **No router config.** You don't log into your router. Ever.
- **Stable hostname.** `your-machine.tailnet-name.ts.net` doesn't change when your ISP rotates your IP.
- **Free for personal use.** Up to 100 devices.
- **Works with raw IP too.** Even if you don't use Magic DNS, Tailscale assigns stable IPs like `100.x.x.x`.

### Step 1: Install Tailscale

On the server (your computer):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

On every friend's device:
- Install Tailscale app (Windows, macOS, Linux, iOS, Android)
- Log in with the same Tailscale account (or accept your invite)
- Join your tailnet

### Step 2: Start Wabi bound to Tailscale IP

Find your Tailscale IP:

```bash
tailscale ip -4
# → 100.104.166.42
```

Start Wabi:

```bash
# Docker — bind to tailscale interface:
docker run -p 100.104.166.42:3000:3000 ...

# Or just bind all interfaces (Tailscale IS an interface):
docker-compose up -d
# It already binds 0.0.0.0:3000, which includes Tailscale
```

Native:

```bash
./wabi-serve.sh --host 0.0.0.0 --port 3000
```

### Step 3: Connect

Friends enter in their Wabi app:

```
http://100.104.166.42:3000
```

Or if you enabled Magic DNS:

```
http://iyoku-laptop.your-tailnet.ts.net:3000
```

### For Voice/Video Calls Over Tailscale

WebRTC over Tailscale works great. The Tailscale IPs are fully routable between peers, so peer-to-peer connections establish directly. No TURN needed for most setups.

If someone is behind a restrictive corporate firewall, enable the coturn profile:

```bash
docker-compose --profile turn up -d
```

### SSL with Tailscale

Tailscale offers free TLS certificates for your `.ts.net` domain:

```bash
sudo tailscale cert iyoku-laptop.your-tailnet.ts.net
```

This gives you a real certificate. Combine with a local reverse proxy (Caddy or nginx) if you want HTTPS. But for Tailscale, HTTP inside the WireGuard tunnel is already encrypted.

### Cost

$0. Uses your existing home internet and electricity.

---

## Tier 3: CGNAT Rescue (Cloudflare Tunnel — Outbound Only)

**Goal:** You're behind CGNAT and cannot (or refuse to) use Tailscale. Still need friends to reach your server.

**Hardware:** Your current computer.
**Network:** Internet connection. CGNAT blocks inbound connections.

### Why This Exists

Most of the world's ISPs use CGNAT. Your "public IP" is shared by hundreds of households. Your router never gets a real public IP, so port forwarding literally cannot work.

Tailscale is the clean answer. But if you refuse VPNs or need to invite strangers, Cloudflare Tunnel is the zero-config alternative.

### Why Cloudflare Tunnel Works Through CGNAT

- Your machine makes an **outbound** connection to Cloudflare's edge
- No inbound port is opened on your router
- Friends connect to a `*.trycloudflare.com` URL (or your domain)
- Traffic flows through the existing outbound tunnel

### Step 1: Start the tunnel profile

```bash
docker-compose --profile tunnel up -d
```

This starts:
- `caddy-tunnel` — local reverse proxy
- `cloudflared-quick` — outbound tunnel to Cloudflare

### Step 2: Read the generated URL

```bash
docker logs wabi-cloudflared-quick
# → https://wabi-some-random-string.trycloudflare.com
```

Share that URL with friends.

### Important Caveat

Cloudflare Tunnel gives you a random subdomain that changes on restart. If you want a stable URL, you need the `tunnel-named` profile with a Cloudflare account + tunnel token.

**Trade-offs:**
- ✅ Works through CGNAT without port forwarding
- ✅ Zero router config
- ⚠️ Traffic goes through Cloudflare's network (you don't control it)
- ⚠️ URL changes randomly unless you register a named tunnel
- ⚠️ Adds latency compared to direct/Tailscale connections
- ⚠️ Free plan limits (not an issue for chat, but it exists)

### This Is A Rescue Tool, Not The Default

We recommend Tailscale first. Use Cloudflare Tunnel only if:
- Tailscale is blocked/banned in your region
- You need to invite people who can't install apps
- You're testing quickly and don't care about the random URL
- You already have a Cloudflare account and named tunnel

---

## Tier 4: Public Access from Home (Port Forward — US / Open NAT)

**Goal:** Anyone on the internet connects to your home server. You have a real public IP.

**Hardware:** A computer that stays on 24/7 (old laptop, NUC, Raspberry Pi, your gaming PC).
**Network:** Home internet. Requires port forwarding on your router.

> **Note:** This only works in regions where ISPs give you a real public IP. In most of Europe, much of Asia, and many developing countries, CGNAT blocks this entirely. If you don't have a public IP, use Tier 2 (Tailscale) or Tier 3 (Tunnel).

### When to use this instead of Tailscale

- You want to invite strangers (Tailscale requires account)
- You want a public URL to share
- You're running a community (e.g. a Discord replacement) where people don't want to install VPN software
- You have a real public IP and prefer direct connections

### Step 1: Get a dynamic DNS hostname (Optional but recommended)

Your ISP probably gives you a dynamic IP that changes. Use a free DDNS service so you have a stable hostname:

- **DuckDNS** (`yourname.duckdns.org`) — free, dead simple
- **No-IP** — free tier
- **Cloudflare API** — if you already have a domain
- **Or just skip this** and tell friends your current IP (check `whatsmyip.org`)

### Step 2: Port forward on your router

Forward these ports to your Wabi machine's LAN IP:

| Port | Protocol | Purpose |
|------|----------|---------|
| 3000 | TCP | Wabi web/API server |
| 3478 | UDP | TURN server (for WebRTC calls) |
| 5349 | UDP | TURNS (TLS TURN) — optional |

How:
1. Log into your router (usually `192.168.1.1`)
2. Find "Port Forwarding" or "Virtual Servers"
3. Add rules for the above ports pointing to your machine's LAN IP (e.g. `192.168.1.42`)

### Step 3: Start Wabi

Same as before:

```bash
docker-compose up -d --profile turn
```

Or native:

```bash
./wabi-serve.sh --host 0.0.0.0 --port 3000
```

### Step 4: Share the address

**Option A — Raw IP:**

```
http://203.0.113.42:3000
```

**Option B — DDNS hostname:**

```
http://yourname.duckdns.org:3000
```

### Security Considerations

- Your IP is now public. Use Wabi's built-in auth (registration, invite codes).
- Keep your router firmware updated.
- If using a domain, you can get free SSL via Let's Encrypt + Caddy.

### Cost

- Hardware: $0 (use what you have) to $200 (NUC)
- Electricity: ~$5-15/month depending on hardware
- Domain: $0-10/year (optional)
- No VPS cost

---

## Tier 5: Always-On Home Server (NUC / Old Laptop / Pi)

**Goal:** Dedicated hardware that runs Wabi 24/7. The classic "homelab" approach.

**Hardware recommendations:**

| Scale | Users | Hardware | RAM | Storage | Power Draw |
|-------|-------|----------|-----|---------|------------|
| Family | 2-10 | Raspberry Pi 4/5 | 4GB | 128GB SD | 7W |
| Friend group | 10-50 | Old laptop / mini PC | 8GB | 256GB SSD | 15-65W |
| Community | 50-500 | Intel NUC / Dell OptiPlex micro | 16GB | 512GB SSD+ | 35W |
| Serious | 500+ | Used 1U server / custom build | 32GB+ | 1TB+ NVMe | 100W+ |

### Setup

Same as Tier 4, but on dedicated hardware:

1. Install Linux (Debian, Ubuntu, or your favorite)
2. Clone Wabi repo
3. `docker-compose up -d --profile turn`
4. Set a static LAN IP on the server (or DHCP reservation in router)
5. If you have a public IP: port forward from router to this static IP
6. If CGNAT: use Tailscale (Tier 2) or Tunnel (Tier 3)
7. (Optional) Dynamic DNS

### systemd Auto-Start (Native)

If running natively instead of Docker:

```bash
sudo tee /etc/systemd/system/wabi.service << 'EOF'
[Unit]
Description=Wabi Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wabi
WorkingDirectory=/opt/wabi
ExecStart=/opt/wabi/wabi-serve.sh --host 0.0.0.0 --port 3000
Restart=always
RestartSec=5
Environment="RUST_LOG=info"

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now wabi
```

### Backups

Wabi stores everything in `./data/`:

```bash
# Cron job for nightly backups to external drive
0 3 * * * tar czf /mnt/backup/wabi-$(date +\%Y\%m\%d).tar.gz /opt/wabi/data/
```

SpacetimeDB data is in Docker volumes:

```bash
docker run --rm -v wabi_spacetimedb_data:/data -v /mnt/backup:/backup alpine tar czf /backup/stdb-$(date +%Y%m%d).tar.gz -C /data .
```

---

## Tier 6: Multi-Server / Federation (Mesh Mode)

**Goal:** Multiple Wabi instances that talk to each other. No single point of failure.

**Hardware:** 2+ servers (can be a mix of home, VPS, and friend's homes).

### Why Federation?

- Your friend has their own server, you have yours, but you share a channel
- If your internet goes down, your local chat still works
- Distribute load across households
- Each community owns their data

### How Wabi Mesh Works

Wabi has a built-in mesh layer. Set `WABI_MESH_ENABLED=true` and configure peers:

```yaml
# docker-compose.yml override or .env
services:
  wabi-server:
    environment:
      - WABI_MESH_ENABLED=true
      - WABI_MESH_PEERS=100.96.11.45:3000,100.104.166.42:3000
      - WABI_NODE_ID=iyoku-home
```

When a message is sent, your node propagates it to peer nodes via WebSocket. Each node stores it in its local SpacetimeDB.

### Tailscale is Perfect for Mesh

Because Tailscale gives every node a stable IP, mesh configuration never changes even when ISPs rotate IPs:

```
WABI_MESH_PEERS=iyoku-laptop.ts.net:3000,tim-desktop.ts.net:3000
```

### Use Cases

- **Family + friends:** Your house runs a node, your parents' house runs a node. Both see the same `#general` channel.
- **Community clusters:** 5 friends each run a node for their local group, but `#announcements` is federated across all of them.
- **Offline-first:** Your LAN party works without internet. When someone gets back online, messages sync.

---

## Tier 7: Rack Server / Discord-Level Scale

**Goal:** Run Wabi for hundreds or thousands of users from a serious machine.

**Hardware:** Rack-mounted server or beefy workstation.
**Network:** Business internet with static IP (or keep using Tailscale for admin).

### Hardware Example

```
Used Dell R720 / HP ProLiant DL380e (eBay: $150-400)
- 2x Intel Xeon E5-2680v2 (20 cores total)
- 64GB DDR3 ECC
- 4x 1TB SSD in RAID 10
- Dual PSU
- Power draw: ~150W idle
```

Total cost: ~$400 hardware, ~$25/month electricity, $0 software.

### Configuration

Use all Docker compose profiles:

```bash
docker-compose up -d \
  --profile turn \
  --profile sfu \
  --profile booster-full
```

This starts:
- `wabi-server` — your API and frontend
- `spacetimedb` — the state database
- `coturn` — TURN for WebRTC
- `livekit` or `srt-gateway` — SFU for large voice channels (50+ people calls)
- `stdb-publisher` — replication, backup, federation

### Scaling Individual Services

If SpacetimeDB becomes the bottleneck:

```bash
# Run multiple SpacetimeDB read replicas
docker-compose up -d --scale spacetimedb-read=2
```

If file uploads get heavy:

```bash
# Mount a large storage array
volumes:
  - /mnt/big-array/wabi-uploads:/app/uploads
```

### Monitoring

Add Prometheus + Grafana to docker-compose:

```yaml
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "127.0.0.1:9090:9090"

  grafana:
    image: grafana/grafana
    ports:
      - "127.0.0.1:3001:3000"
```

View at `http://localhost:9090` and `http://localhost:3001`.

### Still Self-Hosted

Even at this scale:
- No Cloudflare required
- No AWS/GCP required
- No domain required (but you probably want one at this scale)
- You own all the data
- Your users' messages never touch a third-party API

---

## Cloudflare as a Fallback (Not a Default)

If you want extra resilience or a cleaner URL, Cloudflare is an option. This is NOT required for any tier.

### What Cloudflare Actually Does for Wabi

| Feature | What it means for Wabi | Trade-off |
|---------|------------------------|-----------|
| **DNS** | Point `wabi.yourdomain.com` to your IP | Free. No downside. |
| **DDoS** | Absorbs attack traffic | Good for public servers. Adds a man-in-the-middle you don't control. |
| **Cache** | Static assets served from edge | Nice for global users. Dynamic WebSocket bypasses cache anyway. |
| **SSL** | Free certs for your domain | If you have a domain, Caddy gets certs free too. CF is easier. |
| **Tunnel** | No port forwarding needed | Your traffic goes through CF's network. Adds latency. |

### When to Use It

- You're being DDoSed
- You have users in another continent and they complain about load times
- You want a domain but don't want to manage SSL yourself
- You already use Cloudflare for other stuff
- CGNAT and no Tailscale is your only option

### How to Use It Without Locking In

1. Keep your raw IP/Tailscale working: `http://YOUR_IP:3000`
2. Add DNS record in Cloudflare pointing `chat.yourdomain.com` → your IP
3. If using Cloudflare proxy (orange cloud), make sure WebSocket is enabled:
   - Network → WebSockets: ON
4. If NOT using proxy (gray cloud): Cloudflare is just DNS. Zero impact.

**You can turn Cloudflare off anytime and your users keep using the IP directly.**

---

## SSL / TLS Guide

### Do You Actually Need SSL?

| Scenario | Need SSL? | Why |
|----------|-----------|-----|
| Localhost | No | Traffic never leaves your machine |
| LAN | No | Your network, your trust |
| Tailscale | No | WireGuard encrypts everything |
| Public IP, no domain | Hard | Let's Encrypt won't issue for bare IPs. Self-signed possible but browsers hate it. |
| Public IP + domain | Yes | Browsers block camera/mic on HTTP sites. Let's Encrypt + Caddy is free and automatic. |

### Get Free SSL with a Domain

If you bought a domain ($10/year):

```bash
# Install Caddy
sudo apt install caddy

# Caddyfile
cat > /etc/caddy/Caddyfile << 'EOF'
chat.yourdomain.com {
    reverse_proxy localhost:3000
}
EOF

sudo systemctl reload caddy
```

Caddy auto-obtains and renews Let's Encrypt certificates. You do nothing else.

### Self-Signed for Raw IP

If you refuse to get a domain but want the padlock:

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=203.0.113.42"
```

Then configure your reverse proxy to use these. Every client will get a scary warning they have to click through. Not recommended unless you enjoy troubleshooting browser security warnings.

---

## Hardware Reference Table

| Tier | Users | Machine | Power | Monthly Cost |
|------|-------|---------|-------|-------------|
| 0 | 1 | Your laptop | N/A | $0 |
| 1 | 2-10 | Your laptop | 20W | $0 |
| 2 | 2-20 | Your laptop/NUC | 20W | $0 |
| 3 | 5-50 | Rescue tunnel | — | $0 |
| 4 | 5-50 | Old desktop | 65W | $5-10 power |
| 5 | 10-100 | Raspberry Pi 5 / NUC | 7-35W | $2-5 power |
| 6 | 50-500 | Intel NUC / mini PC | 35W | $5-10 power |
| 7 | 500+ | Rack server / Tower | 100-300W | $15-40 power |

Compare to Discord: $0/month for full control.

---

## Troubleshooting

### "Connection refused" from another machine

- Server bound to `127.0.0.1` instead of `0.0.0.0`?
- Firewall blocking port 3000? `sudo ufw allow 3000/tcp`
- Docker port binding is `127.0.0.1:3000:3000`? Change to `0.0.0.0:3000:3000`.

### "Not Secure" in browser

- Expected on raw IP. Harmless on LAN/Tailscale.
- Get a domain + Caddy for the green padlock.

### WebRTC calls don't connect

- Start the TURN server: `docker-compose --profile turn up -d`
- If behind double NAT (CGNAT), use Tailscale instead of port forwarding.
- Check `about:webrtc` in Firefox or `chrome://webrtc-internals` for ICE status.

### SpacetimeDB won't start

- Check port 3030 isn't already bound: `lsof -i :3030`
- Data volume permissions: `sudo chown -R 1000:1000 ./data/`

---

*Wabi is designed to be owned by the people who use it. You don't need permission from a cloud provider, a domain registrar, or a CDN to talk to your friends. Just an IP address and an open port — or Tailscale, which gives you both without asking your ISP.*
