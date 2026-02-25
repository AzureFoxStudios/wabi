# Wabi Chat - Deployment Guide

## Overview

Wabi Chat is designed to be self-deployable on bare-metal Linux. This guide covers setup with Docker Compose and Caddy reverse proxy.

## Prerequisites

- Docker & Docker Compose (v2)
- A Linux server (VPS recommended) with a public IP
- A domain name pointed at your server (recommended for HTTPS)
- Caddy (reverse proxy — the setup wizard can install it for you)

## Quick Start (Setup Wizard)

The fastest way to get running. The wizard asks a few questions, generates your config, and tells you exactly what to do.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
./scripts/setup.sh
```

The wizard will:
- Check that Docker is installed
- Ask for your domain (or fall back to IP-only)
- Detect your public IP
- Generate secure secrets automatically
- Write your `.env` and `Caddyfile`
- Offer to install Caddy if it's missing
- Print step-by-step instructions to start everything

After the wizard finishes, follow its instructions (typically: start Caddy, then `docker compose up -d --build`).

Operator-config flow (small config + generated env):

```bash
cp wabi.config.example wabi.config
./scripts/launch.sh --reconfigure
```

`launch.sh` reads `wabi.config` first, then writes `.env` / `frontend/.env`. It also writes `.wabi-profile` to prevent silent mode/runtime swaps on later runs.

## Normal vs Community

| Mode | Database | Compose files | Typical use |
|---|---|---|---|
| `normal` | SQLite (`DB_MODE=sqlite`) | `docker-compose.yml` | Single-host default deployment, simplest operations |
| `community` | Postgres (`DB_MODE=postgres`) | `docker-compose.yml` + `docker-compose.community.yml` | Multi-node/community deployments needing Postgres durability |

`scripts/setup.sh` remains the first-run entry point and generates a default `.env` for `normal` mode on Node + SQLite.

## Runtime Matrix

Runtime is independent from deployment mode:

| Combination | Compose invocation |
|---|---|
| `normal + node` | `docker compose -f docker-compose.yml up -d --build` |
| `normal + bun` | `docker compose -f docker-compose.yml -f docker-compose.bun.yml up -d --build` |
| `community + node` | `docker compose -f docker-compose.yml -f docker-compose.community.yml up -d --build` |
| `community + bun` | `docker compose -f docker-compose.yml -f docker-compose.community.yml -f docker-compose.bun.yml up -d --build` |

If you use the deploy helper, overlays are selected automatically from environment:

```bash
WABI_MODE=community WABI_RUNTIME=bun ./scripts/deploy-clean.sh
```

## Manual Setup

If you prefer to configure things by hand:

### 1. Clone & Configure

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cp .env.example .env
```

### 2. Edit `.env` for Your Domain

At minimum, update these values:

```bash
FRONTEND_URL=https://your-domain.com
PUBLIC_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com,https://tauri.localhost,tauri://localhost

TURN_EXTERNAL_IP=<your server's public IP>
TURN_REALM=your-domain.com
TURN_SHARED_SECRET=<generate with: openssl rand -base64 32>

JWT_SECRET=<generate with: openssl rand -base64 32>

VITE_TURN_SERVER=<your server's public IP>
```

The `VITE_*` variables are used by Docker Compose as build arguments for the frontend container.

### 3. Set Up Caddy Reverse Proxy

Copy the example and replace the domain:

```bash
cp Caddyfile.example Caddyfile
# Edit Caddyfile — replace YOUR_DOMAIN with your actual domain
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The Caddyfile routes requests to the correct Docker container:

```caddyfile
your-domain.com {
    # API, WebSocket, uploads, health checks -> backend
    @backend {
        path /socket.io/* /api/* /uploads/* /health /health/*
    }
    reverse_proxy @backend localhost:8080

    # Everything else -> frontend
    reverse_proxy localhost:3000
}
```

Caddy will automatically obtain an SSL certificate via Let's Encrypt.

**Without a domain** (IP-only, no SSL):

```caddyfile
:80 {
    @backend {
        path /socket.io/* /api/* /uploads/* /health /health/*
    }
    reverse_proxy @backend localhost:8080
    reverse_proxy localhost:3000
}
```

### 4. Start Services

```bash
# With voice/video calling (TURN server):
docker compose --profile turn up -d --build

# Without TURN:
docker compose up -d --build
```

Or use the deploy script for zero-downtime rebuilds:

```bash
./scripts/deploy-clean.sh
```

### 5. Verify Connection

Visit your domain (e.g. `https://your-domain.com`). The first account you create will be the admin.

Check diagnostics:
```bash
curl https://your-domain.com/health/cors
```

Expected output:
```json
{
  "allowedOrigins": ["https://your-domain.com"],
  "isAllowed": true,
  "requestOrigin": "https://your-domain.com",
  "nodeEnv": "production"
}
```

## Domain vs IP-Only

| | Domain | IP-Only |
|---|---|---|
| HTTPS | Automatic (Caddy + Let's Encrypt) | Not available |
| Voice/video calls | Works | Requires HTTPS — won't work without a domain |
| Screen sharing | Works | Requires HTTPS — won't work without a domain |
| Setup | Need DNS A record pointing to server | Just use the IP |

**Recommendation**: Use a domain. Even a cheap one works. HTTPS is required for WebRTC features (voice, video, screen sharing).

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `WABI_MODE` | Deployment profile selector (`normal` or `community`) | `normal` |
| `WABI_RUNTIME` | Runtime selector (`node` or `bun`) | `node` |
| `DB_MODE` | Backend DB engine selector (`sqlite` or `postgres`) | `sqlite` |
| `DATABASE_PATH` | SQLite DB path override | `/app/data/chat.db` |
| `POSTGRES_HOST` | Postgres host (community mode) | `postgres` |
| `POSTGRES_PORT` | Postgres port | `5432` |
| `POSTGRES_USER` | Postgres user | `wabi` |
| `POSTGRES_PASSWORD` | Postgres password | `<secret>` |
| `POSTGRES_DB` | Postgres database | `wabi` |
| `DATABASE_URL` | Optional full Postgres DSN override | `postgresql://wabi:secret@postgres:5432/wabi` |
| `FRONTEND_URL` | Frontend domain (CORS origin) | `https://wabi.chat` |
| `PUBLIC_URL` | File upload base URL | `https://wabi.chat` |
| `ALLOWED_ORIGINS` | CORS whitelist (comma-separated) | `https://wabi.chat,https://tauri.localhost` |
| `JWT_SECRET` | Auth token signing key | `<random base64>` |
| `PLUGINS_ENABLED` | Enable backend plugin loading at boot | `false` |
| `PLUGINS_ALLOW_INSTALL` | Allow plugin install API uploads | `false` |
| `NODE_ENV` | Node environment | `production` |
| `PORT` | Backend listen port | `8080` |
| `TURN_EXTERNAL_IP` | Public IP for TURN relay | `203.0.113.10` |
| `TURN_REALM` | TURN server realm | `your-domain.com` |
| `TURN_SHARED_SECRET` | TURN auth secret (must match coturn) | `<random base64>` |
| `VITE_TURN_SERVER` | TURN IP for frontend (build arg) | `203.0.113.10` |
| `VITE_GIPHY_API_KEY` | Optional Giphy key for GIFs | `<your key>` |

## Mode Switch And Migration

### One-shot SQLite to Postgres migration

Run from `backend/` with the target Postgres values exported in your shell:

```bash
cd backend
node scripts/migrate-sqlite-to-postgres.mjs \
  --sqlite ../data/chat.db \
  --database-url "postgresql://wabi:<password>@127.0.0.1:5432/wabi"
```

Dry-run mode:

```bash
cd backend
node scripts/migrate-sqlite-to-postgres.mjs --sqlite ../data/chat.db --dry-run
```

The tool bootstraps `schema.postgres.sql`, then copies core auth/chat/role/channel/message/file-metadata tables.

### Safe switch to community mode (Postgres)

1. Snapshot current SQLite file.
2. Start Postgres stack (`docker-compose.community.yml`) and run migration.
3. Set `.env`: `WABI_MODE=community`, `DB_MODE=postgres` (runtime stays `node` or `bun`).
4. Restart with community compose files.

### Rollback and export paths

Snapshot SQLite:

```bash
mkdir -p backups
cp data/chat.db "backups/chat-$(date -u +%Y%m%d-%H%M%S).db"
```

Dump Postgres:

```bash
mkdir -p backups
docker compose -f docker-compose.yml -f docker-compose.community.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-wabi}" "${POSTGRES_DB:-wabi}" \
  > "backups/postgres-$(date -u +%Y%m%d-%H%M%S).sql"
```

Revert to previous normal mode safely:

1. Stop current stack: `docker compose -f docker-compose.yml -f docker-compose.community.yml down`
2. Restore SQLite backup to `data/chat.db` if needed.
3. Set `.env`: `WABI_MODE=normal`, `DB_MODE=sqlite`.
4. Start again with `docker compose -f docker-compose.yml up -d --build`.

## Firewall Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 80 | TCP | HTTP — Caddy uses this for certificate validation |
| 443 | TCP | HTTPS — all public traffic |
| 3478 | TCP+UDP | TURN signaling (voice/video) |
| 49152-65535 | UDP | TURN media relay range |

Ports 3000 (frontend) and 8080 (backend) only need to be reachable from localhost (Caddy proxies to them).

## Troubleshooting

### WebSocket Connection Fails

**Symptom**: Client shows `connect_error` in console

**Check**:
1. Verify `FRONTEND_URL` matches your domain:
   ```bash
   docker compose exec backend curl http://localhost:8080/health/cors
   ```

2. Check Caddy is forwarding WebSocket headers:
   ```bash
   curl -i -N \
     -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Origin: https://your-domain.com" \
     "https://your-domain.com/socket.io/?EIO=4&transport=websocket"
   # Should return: HTTP/1.1 101 Switching Protocols
   ```

3. Check browser console for specific error messages

### CORS Rejected

**Symptom**: Logs show `[CORS] Rejected origin: ...`

**Fix**: Ensure `.env` has correct domain:
```bash
FRONTEND_URL=https://your-domain.com
PUBLIC_URL=https://your-domain.com
```

Restart backend:
```bash
docker compose restart backend
```

### Caddy SSL Issues

**Issue**: Caddy can't obtain certificate

**Cause**:
- Domain DNS not pointing to server
- Port 80/443 blocked by firewall
- Another process using port 80 or 443

**Fix**:
```bash
# Check DNS
dig +short your-domain.com

# Make sure ports are open
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Check Caddy logs
sudo journalctl -u caddy --no-pager -n 50
```

## Production Checklist

- [ ] Domain DNS A record pointing to server IP
- [ ] Firewall allows ports 80, 443, 3478, 49152-65535
- [ ] `.env` configured with production domain
- [ ] `JWT_SECRET` is a unique random value
- [ ] `TURN_SHARED_SECRET` is a unique random value
- [ ] Caddy running and serving HTTPS
- [ ] Backups configured for `data/` directory
- [ ] Docker set to start on boot (`sudo systemctl enable docker`)

## Systemd Service (Optional)

Create `/etc/systemd/system/wabi.service`:

```ini
[Unit]
Description=Wabi Chat Docker Services
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/root/wabi
ExecStart=/usr/bin/docker compose --profile turn up -d
ExecStop=/usr/bin/docker compose stop
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable wabi
sudo systemctl start wabi
```

## Support

- Docker logs: `docker compose logs -f backend`
- Frontend logs: `docker compose logs -f frontend`
- TURN logs: `docker compose logs -f coturn`
- Health check: `curl http://localhost:8080/health`
- CORS check: `curl http://localhost:8080/health/cors`

## Relay Network (Phase 1)

Relay nodes for file delivery are implemented in-repo and can be rolled out separately from core app deploys.

- Relay node code: `relay-node/`
- Relay runbook: `PROJECT_DOCS/RELAY_PHASE1_SERVER_RUNBOOK.md`
- Relay admin helper: `scripts/relay-admin.sh`
- Relay validation helper: `scripts/relay-phase1-check.mjs`
- Frontend toggle: `VITE_ENABLE_RELAYS=true`

SRT media gateway is deployable with control-plane + worker orchestration (`media-gateway/` + `/api/media/gateway/session*`).

Operational requirements for SRT gateway mode:

```bash
# backend/.env
MEDIA_SRT_GATEWAY_ENABLED=true
MEDIA_SRT_GATEWAY_URL=https://gateway.your-domain.com
MEDIA_GATEWAY_KEY=<shared_secret>
MEDIA_SRT_SESSION_TTL_SECONDS=900
MEDIA_SRT_BASE_PORT=7000
```

```bash
# media-gateway service env
MEDIA_GATEWAY_WORKER_ENABLED=true
MEDIA_GATEWAY_WORKER_CMD=node
MEDIA_GATEWAY_WORKER_ARGS_JSON=["workers/ffmpeg-srt-bridge.mjs","--session-id","{{sessionId}}","--publish-url","{{publishUrl}}","--playback-url","{{playbackUrl}}"]
```

To deploy gateway with launch script:

```bash
# enable in .env:
# MEDIA_SRT_GATEWAY_ENABLED=true
# MEDIA_SRT_GATEWAY_URL=https://your-gateway-domain
# MEDIA_GATEWAY_KEY=shared_secret

./scripts/launch.sh --srt-gateway
```

To validate gateway readiness and session lifecycle:

```bash
WABI_ORIGIN_URL=https://your-domain.com \
WABI_AUTH_TOKEN=<bearer_token> \
WABI_MEDIA_GATEWAY_KEY=<shared_secret> \
node scripts/srt-phase2-check.mjs
```

---

**Last updated**: 2026-02-18
**Tested on**: Ubuntu 22.04 LTS with Docker Compose 2.x and Caddy 2.7+
