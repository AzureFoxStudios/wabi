# Wabi Media Gateway (Phase 2 MVP)

This service is the SRT gateway control-plane daemon for Wabi Phase 2.

Current MVP responsibilities:
- Pull desired gateway sessions from origin (`GET /api/media/gateway/control/sessions`)
- Send health + active stream heartbeats to origin (`POST /api/media/gateway-heartbeat`)
- Expose local health/session visibility endpoints (`/health`, `/sessions`)

It does not yet run a full media-plane transcoder/bridge. It is the deployable control-plane foundation.

## Required environment

- `WABI_ORIGIN_URL` (example: `https://chat.example.com` or `http://backend:8080`)
- `MEDIA_GATEWAY_KEY` (must match backend `MEDIA_GATEWAY_KEY`)

Optional:
- `GATEWAY_HOST` (default `0.0.0.0`)
- `GATEWAY_PORT` (default `8095`)
- `MEDIA_GATEWAY_REGION` (default `unknown`)
- `MEDIA_GATEWAY_HEARTBEAT_INTERVAL_MS` (default `15000`)
- `MEDIA_GATEWAY_SESSION_SYNC_INTERVAL_MS` (default `10000`)

## Run (local)

```bash
cd media-gateway
WABI_ORIGIN_URL=http://localhost:8080 \
MEDIA_GATEWAY_KEY=replace_me \
node src/server.mjs
```

## Run (docker)

```bash
docker compose --profile srt-gateway up -d --build media-gateway
```
