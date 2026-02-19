# Relay Phase 1 Server Runbook (Codex/Claude)

This runbook is for deploying and validating volunteer relay nodes (file delivery only).

Phase split:
- Phase 1: file relay network (this runbook)
- Phase 2: SRT media gateway transport (MVP control-plane now available; full media-plane still pending)

## 1. Origin Server Checklist

1. Deploy latest `wabi` backend with relay APIs.
2. Ensure origin is reachable over HTTPS.
3. Verify endpoints:
```bash
curl -i https://YOUR_ORIGIN/api/relays
curl -i https://YOUR_ORIGIN/health
```
4. Set `VITE_ENABLE_RELAYS=true` in frontend build env when ready.

## 2. Relay Node Setup (on volunteer server)

1. Clone repo and enter relay folder:
```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi/relay-node
```

2. Configure env:
```bash
cp relay-node.env.example .env
```

Required variables:
- `RELAY_ORIGIN_URL=https://your-origin-domain`
- `RELAY_PUBLIC_URL=https://relay-volunteer-domain`
- `RELAY_NAME=...`
- `RELAY_REGION=...`

3. Start relay:
```bash
node --env-file=.env src/server.mjs
```

Or with Docker:
```bash
docker compose -f relay-node/docker-compose.yml up -d --build
```

4. Verify relay health:
```bash
curl -i https://relay-volunteer-domain/health
```

## 3. Approve Relay on Origin

Relay stays pending until approved.

Admin workflow:
1. List relays via `GET /api/relays/admin` (admin auth required).
2. Approve relay via `POST /api/relay/approve` with `{ "relay_id": <id> }`.

Convenience script (from origin repo):

```bash
export WABI_ORIGIN_URL=https://YOUR_ORIGIN
export WABI_ADMIN_TOKEN=YOUR_ADMIN_BEARER_TOKEN
./scripts/relay-admin.sh list
./scripts/relay-admin.sh approve 3
./scripts/relay-admin.sh list-pending
./scripts/relay-admin.sh delete 3
```

After approval, relay appears in public `GET /api/relays`.

## 4. Functional Validation

1. Confirm relay list includes active relay:
```bash
curl -s https://YOUR_ORIGIN/api/relays
```

2. Confirm relay serves file path:
```bash
curl -I https://relay-volunteer-domain/uploads/<known-file>
```

3. Frontend behavior checks:
- Relay enabled: downloads resolve to relay URL.
- Relay unavailable: fallback to origin URL.

4. Run validation helper:
```bash
WABI_ORIGIN_URL=https://YOUR_ORIGIN \
WABI_ADMIN_TOKEN=YOUR_ADMIN_BEARER_TOKEN \
RELAY_EXPECTED_PUBLIC_URL=https://relay-volunteer-domain \
node scripts/relay-phase1-check.mjs
```

## 5. Caddy Example (relay server)

```caddyfile
relay-volunteer-domain {
  reverse_proxy 127.0.0.1:8090
}
```

## 6. Rollback

1. Disable frontend relay usage: `VITE_ENABLE_RELAYS=false`
2. Rebuild/redeploy frontend.
3. Stop relay nodes.
4. Existing clients will fall back to origin file URLs.

## 7. Production Readiness Checklist

### Required for Production Deployment

**Backend Requirements:**
- ✅ Use Node 20-slim or later for better-sqlite3 compatibility
  - See backend/Dockerfile commit bc35ffe: "Fix backend Docker build: use Node 20-slim and rebuild native modules"
  - Ensures native module compilation (better-sqlite3) works correctly
  - Build tools (build-essential, python3) required in Dockerfile

**Relay Configuration:**
- ✅ RELAY_ORIGIN_URL must use HTTPS (e.g., `https://wabi.example.com`)
- ✅ RELAY_PUBLIC_URL must use HTTPS (e.g., `https://relay-us-west.example.com`)
- ✅ Both URLs must be publicly reachable over HTTPS

**Admin Approval Workflow:**
- ✅ MUST use API admin flow via `scripts/relay-admin.sh` — NOT direct database updates
  - Set environment: `export WABI_ORIGIN_URL=https://origin` and `export WABI_ADMIN_TOKEN=<token>`
  - List pending: `./scripts/relay-admin.sh list-pending`
  - Approve: `./scripts/relay-admin.sh approve <relay_id>`
  - Verify: `./scripts/relay-admin.sh list-active`
- ❌ DO NOT use direct SQLite updates (`UPDATE relays SET approved=1`) — testing only
  - This bypasses admin authentication; production requires proper auth flow

**Frontend Deployment:**
- ✅ Set `VITE_ENABLE_RELAYS=true` in build environment
- ✅ Rebuild/redeploy frontend after enabling
- ✅ Verify active relay list: `curl -s https://YOUR_ORIGIN/api/relays`

### Creating First Admin User

The first account created (user ID 1) automatically becomes admin. To create an admin account:

```bash
# 1. Visit web UI and create account — first user is admin
# 2. Log in and copy JWT token from browser localStorage ('token' key)
# 3. Use token in admin scripts:
export WABI_ADMIN_TOKEN=<token>
export WABI_ORIGIN_URL=https://your-origin
./scripts/relay-admin.sh list-pending
```

## 8. Phase 2 Hand-off (SRT)

Phase 2 status:
- Implemented now:
  - gateway service deployment track (`media-gateway/`)
  - authenticated control-plane integration (`MEDIA_GATEWAY_KEY`)
  - gateway session lifecycle in backend (`/api/media/gateway/session*`)
  - frontend transport selection now attempts gateway session establishment for channel calls
- Remaining:
  - full SRT media-plane bridge/transcoding path behind those control-plane hooks

Quick validation (Phase 2 MVP control-plane):

```bash
export WABI_ORIGIN_URL=https://YOUR_ORIGIN
export WABI_AUTH_TOKEN=YOUR_USER_OR_ADMIN_TOKEN
export WABI_MEDIA_GATEWAY_KEY=YOUR_MEDIA_GATEWAY_KEY
node scripts/srt-phase2-check.mjs
```
