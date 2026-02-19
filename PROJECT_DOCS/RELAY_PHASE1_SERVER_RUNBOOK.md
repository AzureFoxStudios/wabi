# Relay Phase 1 Server Runbook (Codex/Claude)

This runbook is for deploying and validating volunteer relay nodes (file delivery only).

Phase split:
- Phase 1: file relay network (this runbook)
- Phase 2: SRT media gateway transport (not included here)

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

## 7. Phase 2 Hand-off (SRT)

Phase 2 requires a separate server-side media gateway track:
- gateway service deployment
- authenticated control plane integration
- gateway session lifecycle in backend
- frontend transport selection tied to real gateway sessions
