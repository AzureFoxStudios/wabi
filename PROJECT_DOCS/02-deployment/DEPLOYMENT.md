# Wabi Chat - Deployment Guide

> **Note on STDB state plane (2026-04-23):** The STDB migration's P1–P6 phases completed
> 2026-04-22. The 6 state stores (message, channel, channel_member, user, session, rbac)
> all run in `stdb_primary` mode as the sole source of truth. The `STATE_BACKEND_MODE`,
> `STATE_STDB_READ_ENABLED`, `STATE_STDB_WRITE_ENABLED`, `STATE_BACKEND_STRICT`, and all
> `STATE_SHADOW_*` env flags described later in this document are **no longer read by
> the backend** — setup.sh / launch.sh no longer emit them. Operators only need
> `WABI_STDB_BRIDGE_*` + `WABI_STDB_AUTH_TOKEN` to point the backend at a SpacetimeDB
> instance. Verify with `curl $ORIGIN/state-plane/healthz`. See
> `STDB_MIGRATION_P7_P8_GUIDE.md` for the remaining cleanup scope and multi-server plans.

## Overview

Wabi Chat is designed to be self-deployable on bare-metal Linux. This guide covers setup with Docker Compose or Podman Compose and Caddy reverse proxy.

## Prerequisites

- Docker & Docker Compose (v2), or Podman with Compose support
- A Linux server or other always-on machine
- A domain name pointed at your server (recommended for HTTPS)
- Caddy (reverse proxy — the setup wizard can install it for you)

Notes:
- A VPS is not required. A community member can run the origin and/or booster relay on their own machine.
- Public inbound ports are only required when you self-host TURN/SFU media directly. Site/API/signaling can still sit behind Cloudflare Tunnel.

## Zero-Config Quick Start (Any OS)

The fastest way to get running. No `.env` file, no shell scripts, no WSL. Works on **Windows, Mac, and Linux**.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
docker compose up -d --build
```

Open `http://localhost:3000`, create the owner account, and you're in.

Secrets (`JWT_SECRET`, `TURN_SHARED_SECRET`) are auto-generated on first boot and persisted to the data volume across restarts.

If your host uses Podman instead of Docker, replace `docker compose` with `podman compose`. The helper scripts also auto-detect either runtime; set `WABI_CONTAINER_RUNTIME=podman` to force Podman when both are installed.

Use the CLI setup scripts when you want a real public domain, reverse proxy, TURN exposure, mesh config, or other non-local deployment settings. Configure login-page branding separately via `data/launch-page.json`.

## Setup Wizard (CLI)

For first-time server provisioning on Linux, the CLI wizard provides guided domain/Caddy setup:

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
./scripts/setup.sh
```

The wizard will:
- Check that Docker or Podman is installed
- Ask for your domain (or fall back to IP-only)
- Detect your public IP
- Generate secure secrets automatically
- Write your `.env` and `Caddyfile`
- Offer to install Caddy if it's missing
- Print step-by-step instructions to start everything

After the wizard finishes, follow its instructions (typically: start Caddy, then `docker compose up -d --build` or `podman compose up -d --build`).

For Windows hosts without WSL, use the native setup script instead:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-forWindows.ps1
```

That script generates `.env`, `frontend/.env`, and `Caddyfile` for a Docker- or Podman-based Windows host without routing the user through the WSL deploy helper.

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
| `community` | SQLite + STDB state-plane | `docker-compose.yml` | Community-style deployments using the same base stack with STDB-enabled state routing |

`scripts/setup.sh` remains the first-run entry point and generates a default `.env` for `normal` mode on Node + SQLite.

## Runtime Matrix

Runtime is independent from deployment mode:

| Combination | Compose invocation |
|---|---|
| `normal + node` | `docker compose -f docker-compose.yml up -d --build` |
| `normal + bun` | `docker compose -f docker-compose.yml -f docker-compose.bun.yml up -d --build` |
| `community + node` | `docker compose -f docker-compose.yml up -d --build` |
| `community + bun` | `docker compose -f docker-compose.yml -f docker-compose.bun.yml up -d --build` |

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

Booster relay profiles (same machine as origin):

```bash
# TURN only
docker compose --profile booster-turn up -d --build

# TURN + LiveKit SFU
docker compose --profile booster-sfu up -d --build

# TURN + LiveKit SFU + SRT media gateway
docker compose --profile booster-full up -d --build
```

Mode mapping:

| `BOOSTER_RELAY_MODE` | Compose profile |
|---|---|
| `off` | none |
| `turn-only` | `booster-turn` |
| `turn-sfu` | `booster-sfu` |
| `turn-sfu-gateway` | `booster-full` |

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

## Cloudflare Tunnel (No Port Forwarding)

For MVP/self-hosted setups where you do not want router port forwarding, use the built-in tunnel profiles.

### Option A: Domainless Quick Tunnel

Creates a temporary `trycloudflare.com` URL (no domain required):

```bash
docker compose --profile tunnel --profile tunnel-quick up -d --build
docker logs -f wabi-cloudflared-quick
```

### Option B: Named Tunnel (Your Domain)

For stable domain routing (`wabi.chat`, `www.wabi.chat`, etc):

1. Create a named tunnel in Cloudflare Zero Trust and copy its token.
2. Set `.env`:

```bash
CLOUDFLARE_TUNNEL_TOKEN=<your-token>
```

3. Start:

```bash
docker compose --profile tunnel --profile tunnel-named up -d --build
```

Both modes use `Caddyfile.tunnel` to route:
- `/api`, `/socket.io`, `/uploads`, `/health` -> backend
- everything else -> frontend

Important limitation:
- Cloudflare Tunnel is suitable for the web app, API, and WebSocket signaling.
- Cloudflare Tunnel is **not** the public media path for self-hosted TURN, LiveKit SFU, or SRT gateway traffic.
- If you want reliable browser media with self-hosted booster relays, those relay endpoints still need a real reachable media path.

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
| `DB_MODE` | Backend DB engine selector (`sqlite` only) | `sqlite` |
| `DATABASE_PATH` | SQLite DB path override | `/app/data/chat.db` |
| `FRONTEND_URL` | Frontend domain (CORS origin) | `https://wabi.chat` |
| `PUBLIC_URL` | File upload base URL | `https://wabi.chat` |
| `ALLOWED_ORIGINS` | CORS whitelist (comma-separated) | `https://wabi.chat,https://tauri.localhost` |
| `JWT_SECRET` | Auth token signing key | `<random base64>` |
| `PLUGINS_ENABLED` | Enable backend plugin loading at boot | `false` |
| `PLUGINS_ALLOW_INSTALL` | Allow plugin install API uploads | `false` |
| `PLUGIN_SIGNATURE_POLICY` | Plugin trust policy (`warn-allow`, `signed-only`, `curated-only`) | `signed-only` |
| `WABI_PUBLIC_BASE_URL` | Absolute backend public URL used by payment/link plugins | `https://wabi.chat` |
| `TH_PAYMENTS_PROMPTPAY_PROXY_ID` | PromptPay proxy ID (mobile or Thai ID) for `th-payments` QR generation | `0812345678` |
| `TH_PAYMENTS_WEBHOOK_SECRET` | HMAC secret for `th-payments` webhook verification | `<random secret>` |
| `TH_PAYMENTS_ADAPTER_BASE_URL` | Contracted PSP adapter API base URL for `th-payments` checkout/refund/status | `https://payments-adapter.example.com` |
| `TH_PAYMENTS_ADAPTER_TOKEN` | Bearer token for adapter API auth | `<random secret>` |
| `TH_PAYMENTS_ADAPTER_SIGNING_SECRET` | Optional HMAC secret to sign requests from plugin to adapter | `<random secret>` |
| `TH_PAYMENTS_ADAPTER_TIMEOUT_MS` | Adapter request timeout for checkout/refund/status polling | `10000` |
| `WEST_PAYMENTS_WEBHOOK_SECRET` | HMAC secret for `western-payments` webhook verification | `<random secret>` |
| `WEST_PAYMENTS_ADAPTER_BASE_URL` | Contracted PSP adapter API base URL for western checkout/refund/status | `https://west-payments-adapter.example.com` |
| `WEST_PAYMENTS_ADAPTER_TOKEN` | Bearer token for western adapter API auth | `<random secret>` |
| `WEST_PAYMENTS_ADAPTER_SIGNING_SECRET` | Optional HMAC secret to sign western adapter requests | `<random secret>` |
| `WEST_PAYMENTS_ADAPTER_TIMEOUT_MS` | Western adapter request timeout for checkout/refund/status polling | `10000` |
| `NODE_ENV` | Node environment | `production` |
| `PORT` | Backend listen port | `8080` |
| `TURN_EXTERNAL_IP` | Public IP for TURN relay | `203.0.113.10` |
| `TURN_REALM` | TURN server realm | `your-domain.com` |
| `TURN_SHARED_SECRET` | TURN auth secret (must match coturn) | `<random base64>` |
| `VITE_TURN_SERVER` | TURN IP for frontend (build arg) | `203.0.113.10` |
| `VITE_GIPHY_API_KEY` | Optional Giphy key for GIFs | `<your key>` |

## Payments Quickstart (`th-payments`)

Use this for production-safe non-custodial Thailand payments (PromptPay QR + contracted PSP checkout adapter).

1. Enable plugins and enforce signed-only policy:
   - `PLUGINS_ENABLED=true`
   - `PLUGIN_SIGNATURE_POLICY=signed-only`
2. Configure payment plugin env:
   - `WABI_PUBLIC_BASE_URL` (must match externally reachable backend URL)
   - `TH_PAYMENTS_PROMPTPAY_PROXY_ID`
   - `TH_PAYMENTS_WEBHOOK_SECRET`
   - `TH_PAYMENTS_ADAPTER_BASE_URL`
   - `TH_PAYMENTS_ADAPTER_TOKEN`
   - optional: `TH_PAYMENTS_ADAPTER_SIGNING_SECRET`
3. Verify plugin signature and trust signer:
   - `npm run plugin:verify -- --plugin plugins/th-payments --strict`
   - `node scripts/payments-signed-only-rollout.mjs --plugin plugins/th-payments --server https://<wabi-host> --token <admin-token>`
4. Run deterministic payment smoke checks:
   - `npm --prefix backend run payments:smoke`
   - `npm --prefix backend run payments:provider-sandbox-smoke`
5. Restart backend and verify provider methods:
   - `GET /api/payments/providers` must include `promptpay_qr` and `psp_checkout`.
6. Open chat composer payment sheet:
   - link provider account once via `Linked account` panel (optional but recommended)
   - create payment intent and verify status progression + webhook convergence.
7. Operator runbook:
   - `PROJECT_DOCS/PAYMENTS_PROVIDER_RUNBOOK.md`

## Western Payments Quickstart (`western-payments`)

Use this for US/EU/CAN style non-custodial rails via contracted adapter.

1. Ensure plugins are enabled and signed-only:
   - `PLUGINS_ENABLED=true`
   - `PLUGIN_SIGNATURE_POLICY=signed-only`
2. Configure env:
   - `WEST_PAYMENTS_WEBHOOK_SECRET`
   - `WEST_PAYMENTS_ADAPTER_BASE_URL`
   - `WEST_PAYMENTS_ADAPTER_TOKEN`
   - optional: `WEST_PAYMENTS_ADAPTER_SIGNING_SECRET`
3. Verify plugin signature and trust signer:
   - `npm run plugin:verify -- --plugin plugins/western-payments --strict`
   - `node scripts/payments-signed-only-rollout.mjs --plugin plugins/western-payments --server https://<wabi-host> --token <admin-token>`
4. Run deterministic sandbox smoke:
   - `npm --prefix backend run payments:western-provider-sandbox-smoke`
5. Restart backend and verify provider appears:
   - `GET /api/payments/providers` with `country=US` or `country=CA` or `country=DE`.

## Mode Switch And Migration

Postgres mode has been removed from the runtime. Current migrations are:

1. SQLite remains the local compatibility store.
2. STDB state-plane rollout is controlled with `STATE_*` and `WABI_STDB_*` settings.
3. Community mode no longer implies a second SQL engine.

### Rollback and export paths

Snapshot SQLite:

```bash
mkdir -p backups
cp data/chat.db "backups/chat-$(date -u +%Y%m%d-%H%M%S).db"
```

Revert to previous normal mode safely:

1. Stop current stack: `docker compose -f docker-compose.yml down`
2. Restore SQLite backup to `data/chat.db` if needed.
3. Set `.env`: `WABI_MODE=normal`, `DB_MODE=sqlite`.
4. Start again with `docker compose -f docker-compose.yml up -d --build`.

## Firewall Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 80 | TCP | HTTP — Caddy uses this for certificate validation |
| 443 | TCP | HTTPS — all public traffic |
| 3478 | TCP+UDP | TURN signaling (voice/video), if TURN/booster TURN is enabled |
| 49152-65535 | UDP | TURN media relay range, if TURN/booster TURN is enabled |
| 7880 | TCP | LiveKit SFU signaling/API, if `booster-sfu` / `booster-full` is enabled |
| 7881 | UDP | LiveKit SFU media, if `booster-sfu` / `booster-full` is enabled |

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
- [ ] Firewall allows ports required by the profiles you actually run
- [ ] `.env` configured with production domain
- [ ] `JWT_SECRET` is a unique random value
- [ ] `TURN_SHARED_SECRET` is a unique random value
- [ ] Caddy running and serving HTTPS
- [ ] Backups configured for `data/` directory
- [ ] Docker set to start on boot (`sudo systemctl enable docker`)
- [ ] If `BOOSTER_RELAY_MODE` includes SFU, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are set consistently across SFU-capable nodes

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

## State Backend Migration Flags

Wabi includes production state-plane controls for SpacetimeDB migration and primary-mode cutover.
Use these in `.env` (or set via `wabi.config` + `scripts/launch.sh`):

```bash
STATE_BACKEND_MODE=legacy            # legacy | dual_write | stdb_primary
STATE_STDB_READ_ENABLED=false
STATE_STDB_MESSAGE_READ_CANARY_PERCENT=10
STATE_STDB_CHANNEL_READ_CANARY_PERCENT=10
STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=10
STATE_STDB_USER_READ_CANARY_PERCENT=10
STATE_STDB_SESSION_READ_CANARY_PERCENT=10
STATE_STDB_RBAC_READ_CANARY_PERCENT=10
STATE_SHADOW_WARMUP_ENABLED=true
STATE_SHADOW_WARMUP_LIMIT=25000
STATE_STDB_WRITE_ENABLED=false
STATE_STDB_SUBSCRIPTIONS_ENABLED=false
STATE_STDB_ENFORCE_RBAC=true
STATE_BACKEND_STRICT=false
STATE_OUTBOX_PATH=                 # optional override (default: ${DATA_DIR}/state-plane-outbox.ndjson)
STATE_OUTBOX_REDACT_SENSITIVE=true # redact token/secret-like fields in outbox payloads
STATE_OUTBOX_MAX_BYTES=67108864    # max shadow-writer backlog before check fails/warns
STATE_OUTBOX_TRUNCATE_MIN_BYTES=16777216
STATE_SHADOW_WRITER_ENABLED=false  # auto-enabled by launch.sh when dual_write + STATE_STDB_WRITE_ENABLED=true
STATE_SHADOW_SINK=mirror           # mirror | http | command
STATE_SHADOW_ENDPOINT=
STATE_SHADOW_TOKEN=
STATE_SHADOW_SIGNING_SECRET=       # optional HMAC secret for signed HTTP envelopes
STATE_SHADOW_SIGNING_KEY_ID=       # optional key id header
STATE_SHADOW_COMMAND=              # required when STATE_SHADOW_SINK=command
STATE_SHADOW_COMMAND_TIMEOUT_MS=10000
WABI_STDB_BRIDGE_MODE=spacetime-call
WABI_STDB_BRIDGE_SERVER=local
WABI_STDB_BRIDGE_DATABASE=
WABI_STDB_BRIDGE_REDUCER=ingest_wabi_event
WABI_STDB_BRIDGE_MAP_FILE=
WABI_STDB_BRIDGE_TIMEOUT_MS=10000
WABI_STDB_AUTH_TOKEN=
WABI_STDB_ANONYMOUS=false
WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=false
STATE_PLANE_SCHEMA_VERSION=1
STATE_PLANE_SCHEMA_AUTO_APPLY=true
STATE_REDUCER_INGRESS_ENABLED=false
STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true
STATE_REDUCER_INGRESS_MAX_SKEW_MS=300000
STATE_REDUCER_INGRESS_MAX_BODY_BYTES=1048576
STATE_SHADOW_POLL_INTERVAL_MS=1000
STATE_SHADOW_BATCH_SIZE=250
WEBHOOK_MAX_BODY_BYTES=65536
WEBHOOK_ALLOW_PRIVATE_TARGETS=false
WEBHOOK_ALLOWED_HOSTS=
WEBHOOK_MAX_DNS_RECORDS=16
WEBHOOK_MAX_CONCURRENT_DELIVERIES=20
WEBHOOK_MAX_EVENT_FANOUT=250
```

Current behavior:
- `legacy`: existing SQL-backed message persistence path.
- `dual_write` + `STATE_STDB_WRITE_ENABLED=true`: legacy primary plus in-memory shadow mirrors, parity sampling, and durable outbox file (`${DATA_DIR}/state-plane-outbox.ndjson`).
  - startup warmup can preload shadow state using `STATE_SHADOW_WARMUP_ENABLED` + `STATE_SHADOW_WARMUP_LIMIT` (per-store row cap).
  - outbox payload redaction defaults on via `STATE_OUTBOX_REDACT_SENSITIVE=true` to avoid leaking sensitive values into shadow transport.
- `dual_write` + `STATE_STDB_WRITE_ENABLED=true` + `STATE_STDB_READ_ENABLED=true`: sampled core state reads (messages/channels/members/users/sessions/rbac) run shadow canary comparison and only serve shadow results on exact parity; mismatches/errors hard-fallback to legacy read path.
  - `STATE_STDB_MESSAGE_READ_CANARY_PERCENT` sets the default read canary percent.
  - `STATE_STDB_CHANNEL_READ_CANARY_PERCENT`, `STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT`, `STATE_STDB_USER_READ_CANARY_PERCENT`, `STATE_STDB_SESSION_READ_CANARY_PERCENT`, `STATE_STDB_RBAC_READ_CANARY_PERCENT` override by entity.
- `dual_write` + `STATE_STDB_WRITE_ENABLED=false`: legacy-only writes (shadow and outbox writes are disabled as a kill switch).
- `dual_write` + `STATE_BACKEND_STRICT=true`: shadow write failures are treated as hard errors (fail-fast behavior).
- `dual_write` can optionally run a shadow writer:
  - `mirror` sink appends applied events to `${DATA_DIR}/state-plane-shadow-applied.ndjson`
  - `http` sink POSTs events to `STATE_SHADOW_ENDPOINT` with optional `Authorization: Bearer <STATE_SHADOW_TOKEN>`
  - `command` sink executes `STATE_SHADOW_COMMAND` and pipes one JSON record to stdin per event
    - intended for local reducer bridge workers (for example a SpacetimeDB adapter process)
    - `STATE_SHADOW_COMMAND_TIMEOUT_MS` bounds each command execution
    - when `STATE_SHADOW_COMMAND` is empty and `WABI_STDB_BRIDGE_DATABASE` is set, `scripts/launch.sh` auto-generates a bridge command from `WABI_STDB_BRIDGE_*` keys
  - when `STATE_SHADOW_SIGNING_SECRET` is set, HTTP sink adds signed envelope headers:
    - `X-Wabi-State-Timestamp`
    - `X-Wabi-State-Nonce`
    - `X-Wabi-State-Signature` (`sha256=<hmac>`)
    - optional `X-Wabi-State-Key-Id`
  - schema contract controls:
    - required schema version is `STATE_PLANE_SCHEMA_VERSION` (recorded at `${DATA_DIR}/state-plane-schema-version.json`)
    - `STATE_PLANE_SCHEMA_AUTO_APPLY=true` bootstraps/upgrades forward on startup
    - when auto-apply is `false`, mismatches are surfaced in runtime stats and fail startup only if `STATE_BACKEND_STRICT=true`
  - optional reducer ingress endpoint:
    - `POST /api/internal/state-plane/reducer`
    - gated by `STATE_REDUCER_INGRESS_ENABLED=true`
    - can require signed envelopes with replay/skew checks via `STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true`
  - outbox guardrails:
    - `STATE_OUTBOX_MAX_BYTES` marks backlog-over-limit in runtime/checks
    - when fully caught up (`offset == file_size`) and file is large enough, writer truncates outbox at `STATE_OUTBOX_TRUNCATE_MIN_BYTES`
  - idempotency:
    - outbox records get generated `eventId` values when missing
    - shadow writer skips duplicate events using recent-id cache (`duplicatesSkipped` metric)
- `stdb_primary`:
  - core state reads/writes (messages/channels/members/users/sessions/rbac) run against STDB projections/reducers; backend API and Socket.IO contracts stay unchanged.
  - startup prerequisites: `STATE_STDB_WRITE_ENABLED=true`, `STATE_STDB_READ_ENABLED=true`, and STDB client configured (`WABI_STDB_BRIDGE_SERVER`, `WABI_STDB_BRIDGE_DATABASE`, helper script present).
  - production auth guard: if STDB is active and `NODE_ENV=production`, anonymous STDB auth is blocked unless `WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=true`.
  - with `STATE_BACKEND_STRICT=true`: startup fails fast if prerequisites are not met.
  - with `STATE_BACKEND_STRICT=false` + `STATE_STDB_WRITE_ENABLED=true`: falls back to `dual_write` preflight (requested=`stdb_primary`, effective=`dual_write`).
  - with `STATE_BACKEND_STRICT=false` + `STATE_STDB_WRITE_ENABLED=false`: falls back to `legacy`.
  - `STATE_STDB_SUBSCRIPTIONS_ENABLED=true`: enables STDB subscription-bridge mode log/intent, but backend remains the realtime Socket.IO fanout source (no direct STDB -> socket push path).
  - keep STDB endpoint private to backend/network perimeter; do not expose STDB SQL/call endpoints directly to untrusted internet clients.
- webhook delivery hardening:
  - target URLs are validated with DNS/IP guardrails (private/reserved ranges blocked by default).
  - redirect chains are revalidated per hop.
  - fanout and concurrency are bounded via `WEBHOOK_MAX_EVENT_FANOUT` and `WEBHOOK_MAX_CONCURRENT_DELIVERIES`.
  - use `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` only for controlled private-network receivers.

STDB primary deployment (practical sequence):
1. Set STDB connection values in `wabi.config`:
   - `WABI_STDB_BRIDGE_SERVER`
   - `WABI_STDB_BRIDGE_DATABASE`
   - `WABI_STDB_AUTH_TOKEN` (required for production hardening)
   - keep `WABI_STDB_ANONYMOUS=false` for production
2. Validate bridge module toolchain:
   - `cd spacetimedb/wabi_state_bridge && cargo check`
3. Publish reducer module:
   - `spacetime publish --module-path spacetimedb/wabi_state_bridge --server <server> <database> --yes --no-config`
4. Run deterministic cutover smoke test:
   - `node scripts/state-plane-stdb-primary-smoke.mjs --server <server> --database <database> --json`
5. Preflight in dual-write:
   - `STATE_BACKEND_MODE=dual_write`
   - `STATE_STDB_WRITE_ENABLED=true`
   - `STATE_STDB_READ_ENABLED=true`
   - apply with `./scripts/launch.sh --reconfigure`
6. Cut over to STDB primary:
   - set `STATE_BACKEND_MODE=stdb_primary`
   - keep `STATE_STDB_WRITE_ENABLED=true` and `STATE_STDB_READ_ENABLED=true`
   - set `STATE_BACKEND_STRICT=true` once environment validation is complete
   - apply with `./scripts/launch.sh`

Failure handling:
1. STDB unavailable or elevated read/write errors in primary mode:
   - switch to `STATE_BACKEND_MODE=dual_write` and keep `STATE_STDB_WRITE_ENABLED=true` for shadow continuity.
2. Need complete backend-only rollback:
   - `STATE_BACKEND_MODE=legacy`
   - `STATE_STDB_WRITE_ENABLED=false`
   - `STATE_STDB_READ_ENABLED=false`
3. Apply config with `./scripts/launch.sh` (or `--reconfigure` when regenerating env) and verify via `GET /api/admin/state-plane`.

Operational check:
- `GET /api/admin/state-plane` (admin auth required) shows state-plane mode plus dual-write/outbox/parity counters (messages/channels/members/users/sessions/rbac), shadow-writer, watchdog, reducer-ingress, and warmup status.
  - includes requested mode, effective mode, and fallback reason when applicable.

Drift check helper:
```bash
WABI_ORIGIN_URL=https://your-domain.com \
WABI_AUTH_TOKEN=<admin_bearer_token> \
WABI_STATE_PLANE_REQUIRE_SIGNED_HTTP=true \
node scripts/state-plane-check.mjs
```

- Exit code `0`: no drift/failure counters detected.
- Exit code `1`: parity mismatch, read-canary mismatch/error, warmup failure, outbox/shadow-write failures, or shadow-writer backlog over-limit detected.
- Exit code `2`: request/auth/runtime error.
- Optional: set `WABI_STATE_PLANE_REQUIRE_SIGNED_HTTP=true` to fail drift check when shadow writer uses `sink=http` without signing.

Reducer ingress check helper:
```bash
WABI_ORIGIN_URL=https://your-domain.com \
WABI_SHADOW_TOKEN=<shadow_token> \
WABI_SHADOW_SIGNING_SECRET=<shadow_signing_secret> \
WABI_SHADOW_SIGNING_KEY_ID=<optional_key_id> \
node scripts/state-plane-ingress-check.mjs
```

Backup/restore drill helpers:
```bash
# Create snapshot + checksums + NDJSON integrity report.
node scripts/state-plane-backup.mjs

# Restore specific snapshot back into DATA_DIR.
node scripts/state-plane-restore.mjs --backup-dir backups/state-plane-YYYYMMDD-HHMMSS
```

Schema contract helpers:
```bash
# Show current/required schema contract status.
node scripts/state-plane-schema.mjs status

# Reconcile schema file to required version (uses env defaults unless overridden).
node scripts/state-plane-schema.mjs reconcile

# Explicitly set schema version (blocks downgrade unless --allow-downgrade is passed).
node scripts/state-plane-schema.mjs set --version 2 --reason "manual migration milestone"
```

Replay/backfill helper:
```bash
# Replay outbox records into reducer ingress with resume offset tracking.
WABI_ORIGIN_URL=https://your-domain.com \
WABI_SHADOW_TOKEN=<shadow_token> \
WABI_SHADOW_SIGNING_SECRET=<shadow_signing_secret> \
node scripts/state-plane-replay.mjs

# Re-run from beginning with strict failure behavior.
node scripts/state-plane-replay.mjs --from-start --strict

# Replay directly into command sink target (for example SpacetimeDB bridge command).
STATE_SHADOW_COMMAND="node scripts/state-plane-stdb-bridge.mjs --mode spacetime-call --server local --database <stdb_db_name> --reducer ingest_wabi_event --no-config --anonymous --yes" \
node scripts/state-plane-replay.mjs --mode command --strict
```

SpacetimeDB bridge helper (`STATE_SHADOW_SINK=command`):
```bash
# 1) Basic bridge: each event -> spacetime call <db> ingest_wabi_event "<json>"
STATE_SHADOW_SINK=command
STATE_SHADOW_COMMAND=node scripts/state-plane-stdb-bridge.mjs --mode spacetime-call --server local --database <stdb_db_name> --reducer ingest_wabi_event --no-config --anonymous --yes
STATE_SHADOW_COMMAND_TIMEOUT_MS=10000

# 2) Optional per-entity operation routing with templates.
STATE_SHADOW_COMMAND=node scripts/state-plane-stdb-bridge.mjs --mode spacetime-call --server local --database <stdb_db_name> --map-file scripts/state-plane-stdb-bridge-map.example.json --no-config --anonymous --yes

# 3) Preflight test the configured command bridge before enabling dual-write traffic.
node scripts/state-plane-bridge-check.mjs --json
```

Bridge module source:
- `spacetimedb/wabi_state_bridge/`
- Reducer entrypoint: `ingest_wabi_event(event_json: String)`
- Build prerequisite: Rust `1.93.0+` for `spacetimedb = 2.0.2`

Rollback quick path (config-first):
```bash
# 1) fast rollback from stdb_primary to legacy-read primary + STDB shadow writes
STATE_BACKEND_MODE=dual_write
STATE_STDB_WRITE_ENABLED=true

# 2) full rollback to legacy-only (disable STDB read/write path)
STATE_BACKEND_MODE=legacy
STATE_STDB_WRITE_ENABLED=false
STATE_STDB_READ_ENABLED=false

# 3) apply with launch script and verify /api/admin/state-plane
./scripts/launch.sh
```

## Support

- Docker logs: `docker compose logs -f backend`
- Frontend logs: `docker compose logs -f frontend`
- TURN logs: `docker compose logs -f coturn`
- Health check: `curl http://localhost:8080/health`
- CORS check: `curl http://localhost:8080/health/cors`

## Relay Network (Phase 1)

Relay nodes for file delivery are implemented in-repo and can be rolled out separately from core app deploys.
Core deploy scripts (`scripts/setup.sh`, `scripts/launch.sh`) intentionally do not start relay-node services.

- Relay node code: `relay-node/`
- Relay runbook: `PROJECT_DOCS/RELAY_PHASE1_SERVER_RUNBOOK.md`
- Relay admin helper: `scripts/relay-admin.sh`
- Relay validation helper: `scripts/relay-phase1-check.mjs`
- Frontend toggle (manual): `VITE_ENABLE_RELAYS=true` in `frontend/.env` before rebuild.
- Dedicated relay launcher:
  - `./scripts/relay-launch.sh configure`
  - `./scripts/relay-launch.sh up`
  - Windows (WSL): `scripts/relay-launch-forWindows.ps1`

## Origin-Only Account Recovery

Base Wabi recovery is intentionally simple:

- normal users recover through guest mode plus owner/admin help
- owner/admin can issue a temporary password reset through the app
- emergency operator recovery is local to the trusted origin/backend host

Do not treat relay/media/community nodes as auth authorities. Mesh/relay helpers are not the place to run emergency password recovery.

Emergency recovery command:

```bash
cd backend
npm run auth:operator-reset -- --user your-username --generate
```

That command:

- resets the target account password
- defaults to a temporary-password flow
- revokes existing registered sessions
- prints the generated password once

If you want to set a specific password instead:

```bash
cd backend
npm run auth:operator-reset -- --user your-username --password "replace-me-now" --temporary
```

If you need a permanent reset instead of a forced-change temporary reset:

```bash
cd backend
npm run auth:operator-reset -- --user your-username --password "replace-me-now" --permanent
```

Operator notes:

- Run this on the real backend/origin machine, not on a relay node.
- The command uses the same backend auth store that normal login uses.
- If the backend is already running, restart it after the reset if you need in-memory login cooldown timers cleared immediately.
- In a meshed deployment, recovery authority stays with the trusted origin/backend cluster, not volunteer relay/media/community nodes.

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

**Last updated**: 2026-03-12
**Tested on**: Ubuntu 22.04 LTS with Docker Compose 2.x and Caddy 2.7+
