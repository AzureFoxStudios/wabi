# Wabi Relay Node (Phase 1)

This service is a volunteer-hosted relay node for Wabi file delivery.

Current capabilities:
- `/health` endpoint for latency checks
- auto-registration with origin via `/api/relay/register`
- periodic health pings via `/api/relay/health`
- cached proxy for file paths (default: `/uploads/`, `/emotes/`)
- cache budget enforcement (max items + max bytes + TTL pruning)
- graceful shutdown on `SIGINT` / `SIGTERM`

This is Phase 1 (file relay network). SRT media gateway is Phase 2.

## Quick Start

Linux/macOS wizard:
```bash
chmod +x setup.sh
./setup.sh
docker compose up -d --build
```

Windows wizard:
```powershell
powershell -ExecutionPolicy Bypass -File .\setup-forWindows.ps1
docker compose up -d --build
```

1. Copy environment template:
```bash
cp relay-node.env.example .env
```

2. Edit required values in `.env`:
- `RELAY_ORIGIN_URL`
- `RELAY_PUBLIC_URL`
- `RELAY_NAME`
- `RELAY_REGION`

3. Run:
```bash
node --env-file=.env src/server.mjs
```

Or:
```bash
npm start
```

Docker Compose:
```bash
cp relay-node.env.example .env
docker compose up -d --build
```

## First Registration Flow

On first startup, relay node calls origin `POST /api/relay/register`.
If successful, credentials are saved to `state/registration.json`.

If origin returns `409` duplicate URL:
- this usually means the relay URL already exists in origin DB
- remove old row (or add admin tooling), then restart relay to register again

## Runtime Notes

- Health endpoint: `GET /health`
- Heartbeat interval default: 60s
- Cache is local disk-based and path-prefix scoped
- Cache prune runs periodically and keeps data under configured budgets
- CORS headers are added (`Access-Control-Allow-Origin: *`) for browser file fetches

Useful env controls:
- `RELAY_MAX_CACHE_TOTAL_BYTES`
- `RELAY_MAX_CACHE_ITEMS`
- `RELAY_CACHE_CLEAN_INTERVAL_MS`
- `RELAY_ORIGIN_FETCH_TIMEOUT_MS`
- `RELAY_CORS_ALLOW_ORIGIN`

## Recommended Reverse Proxy

Expose this relay through Caddy/Nginx and forward to local `RELAY_PORT` (default `8090`).
Use TLS and public DNS so clients can measure relay latency.

## Standalone / Relay-Only Download

Yes, this relay can be operated without using the full Wabi tree as your day-to-day working set.

### Option A: Sparse checkout (recommended)

Download only `relay-node/` from the repo:

```bash
git clone --filter=blob:none --no-checkout https://github.com/AzureFoxStudios/wabi.git wabi-relay
cd wabi-relay
git sparse-checkout init --cone
git sparse-checkout set relay-node
git checkout main
cd relay-node
```

Then run normal relay setup:

```bash
./setup.sh
docker compose up -d --build
```

### Option B: Folder copy

Copy just `relay-node/` to a new location/server and run from there.
The relay node service itself does not require the full monorepo at runtime.

### Future direction

If you want this fully detached for non-technical operators, the next step is publishing a dedicated `wabi-relay-node` repo (or release artifact) with its own versioning and release cadence.
