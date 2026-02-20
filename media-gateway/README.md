# Wabi Media Gateway

Current MVP responsibilities:
- Pull desired gateway sessions from origin (`GET /api/media/gateway/control/sessions`)
- Send health + active stream heartbeats to origin (`POST /api/media/gateway-heartbeat`)
- Expose local health/session visibility endpoints (`/health`, `/sessions`)
- Optionally orchestrate per-session media workers (spawn/stop child processes per active gateway session)

The built-in service is still control-plane first. Media-plane work is delegated to worker processes you configure.

## Required environment

- `WABI_ORIGIN_URL` (example: `https://chat.example.com` or `http://backend:8080`)
- `MEDIA_GATEWAY_KEY` (must match backend `MEDIA_GATEWAY_KEY`)

Optional:
- `GATEWAY_HOST` (default `0.0.0.0`)
- `GATEWAY_PORT` (default `8095`)
- `MEDIA_GATEWAY_REGION` (default `unknown`)
- `MEDIA_GATEWAY_HEARTBEAT_INTERVAL_MS` (default `15000`)
- `MEDIA_GATEWAY_SESSION_SYNC_INTERVAL_MS` (default `10000`)

Worker orchestration (optional):
- `MEDIA_GATEWAY_WORKER_ENABLED` (`true|false`, default `false`)
- `MEDIA_GATEWAY_WORKER_CMD` (binary/script path when enabled)
- `MEDIA_GATEWAY_WORKER_ARGS_JSON` (JSON array; template tokens allowed)
- `MEDIA_GATEWAY_WORKER_ENV_PASSTHROUGH` (comma-separated env keys to pass through)
- `MEDIA_GATEWAY_WORKER_SHUTDOWN_TIMEOUT_MS` (default `8000`)

Template tokens for `MEDIA_GATEWAY_WORKER_ARGS_JSON`:
- `{{sessionId}}`
- `{{channelId}}`
- `{{kind}}`
- `{{publishUrl}}`
- `{{playbackUrl}}`
- `{{expiresAt}}`

Example worker args:

```json
["--session-id","{{sessionId}}","--publish-url","{{publishUrl}}","--playback-url","{{playbackUrl}}"]
```

## Run (local)

```bash
cd media-gateway
WABI_ORIGIN_URL=http://localhost:8080 \
MEDIA_GATEWAY_KEY=replace_me \
node src/server.mjs
```

With worker orchestration:

```bash
cd media-gateway
WABI_ORIGIN_URL=http://localhost:8080 \
MEDIA_GATEWAY_KEY=replace_me \
MEDIA_GATEWAY_WORKER_ENABLED=true \
MEDIA_GATEWAY_WORKER_CMD=node \
MEDIA_GATEWAY_WORKER_ARGS_JSON='["workers/ffmpeg-srt-bridge.mjs","--session-id","{{sessionId}}","--publish-url","{{publishUrl}}","--playback-url","{{playbackUrl}}"]' \
node src/server.mjs
```

Direct custom worker example:

```bash
cd media-gateway
WABI_ORIGIN_URL=http://localhost:8080 \
MEDIA_GATEWAY_KEY=replace_me \
MEDIA_GATEWAY_WORKER_ENABLED=true \
MEDIA_GATEWAY_WORKER_CMD=/usr/local/bin/your-srt-worker \
MEDIA_GATEWAY_WORKER_ARGS_JSON='["--session-id","{{sessionId}}","--publish-url","{{publishUrl}}","--playback-url","{{playbackUrl}}"]' \
node src/server.mjs
```

## Run (docker)

```bash
docker compose --profile srt-gateway up -d --build media-gateway
```
