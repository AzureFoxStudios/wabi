# Wabi Relay Node (Phase 1)

This service is a volunteer-hosted relay node for Wabi file delivery.

Current capabilities:
- `/health` endpoint for latency checks
- auto-registration with origin via `/api/relay/register`
- periodic health pings via `/api/relay/health`
- cached proxy for file paths (default: `/uploads/`, `/emotes/`)

This is Phase 1 (file relay network). SRT media gateway is Phase 2.

## Quick Start

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
- CORS headers are added (`Access-Control-Allow-Origin: *`) for browser file fetches

## Recommended Reverse Proxy

Expose this relay through Caddy/Nginx and forward to local `RELAY_PORT` (default `8090`).
Use TLS and public DNS so clients can measure relay latency.
