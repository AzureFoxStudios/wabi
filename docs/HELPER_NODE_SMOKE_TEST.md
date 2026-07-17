# Helper node smoke test (Ronin → Tim)

**Status:** ready to run once Tim has an owner/admin session  
**Updated:** 2026-07-15  
**Authority:** Tim `http://100.96.11.45:3001` / `https://wabi.chat` (when CF path is healthy)  
**Do not call this “mesh product” yet** — this is Phase 1 **helper registry** only.

## Mental model

```
Tim  = authority (WabiDB + user auth + pairing tokens)
Ronin = helper (outbound client; --helper-mode)
```

- Helper does **not** own permissions or user state.
- Not multi-master. Not equal peers sharing one DB.
- Success = pair once → heartbeats → appears in `GET /api/nodes` → can revoke.

## Prerequisites

- [x] Tim `wabi-server` healthy (`/health` ok, setup done / can login)
- [x] First-time owner registration works (confirmed 2026-07-15)
- [ ] Admin JWT from browser login (owner or admin)
- [ ] Ronin can reach Tim over Tailscale (`100.96.11.45:3001`)
- [ ] Matching `wabi-server` binary on Ronin (`target/release/wabi-server`)

## API surface (authority)

| Method | Path | Who |
|--------|------|-----|
| GET | `/api/nodes` | admin Bearer |
| POST | `/api/nodes/pairing-tokens` | admin Bearer |
| GET | `/api/nodes/pairing-tokens` | admin Bearer |
| POST | `/api/nodes/join` | helper (pairing token body) |
| POST | `/api/nodes/{node_id}/heartbeat` | helper (`x-wabi-node-secret`) |
| POST | `/api/nodes/{node_id}/revoke` | admin Bearer |

## Smoke steps

### 1. Get admin token

Login on Tim in browser → DevTools → network/storage → copy Bearer JWT as `ADMIN_JWT`.

### 2. Create pairing token (Tim or from Ronin via Tailscale)

```bash
export TIM=http://100.96.11.45:3001
export ADMIN_JWT='…'

curl -sS -X POST "$TIM/api/nodes/pairing-tokens" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "ronin-dev-helper",
    "capabilities": [
      "cpuWorker",
      "thumbnailWorker",
      "transcodeWorker",
      "searchIndexer",
      "mediaRelay"
    ],
    "ttlSeconds": 900
  }'
```

Save the one-shot token string from the response.

### 3. Start helper on Ronin

```bash
mkdir -p /var/home/Ronin/wabi-helper-data

/var/home/Ronin/wabi/target/release/wabi-server \
  --helper-mode \
  --primary-url http://100.96.11.45:3001 \
  --pairing-token 'PASTE_TOKEN' \
  --data-dir /var/home/Ronin/wabi-helper-data
```

Optional same-LAN face:

```bash
  --lan-reachable-at 192.168.1.85:9999
```

Expect logs:
- `[helper] Connected to primary … node_id=…`
- heartbeat loop continues  
Identity file: `wabi-helper-data/helper_identity.json` (restarts reuse it).

### 4. Verify on Tim

```bash
curl -sS "$TIM/api/nodes" -H "Authorization: Bearer $ADMIN_JWT"
# expect online helper + capabilities + recent heartbeat
```

### 5. Revoke

```bash
curl -sS -X POST "$TIM/api/nodes/<node_id>/revoke" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

## Pass / fail

| Check | Pass |
|-------|------|
| Pair with token | join succeeds, identity saved |
| Heartbeat | node stays online ~30s interval |
| List | admin sees node |
| Revoke | node no longer trusted / stopped |

## Explicitly out of scope for this smoke

- Multi-master WabiDB sync  
- `WABI_MESH_ENABLED` peer mesh  
- Job execution (thumbnails/transcode) end-to-end  
- LAN signed route tokens for blob offload (helper_api is mostly verify gate)  
- Cloudflare-dependent testing (use Tailscale URL if CF breaks scripts)

## After this works (order)

1. Document real curl responses / node_id in a short session note  
2. Optional `--lan-reachable-at` + helper `/health`  
3. One real job type if job queue is wired  
4. Admin UI for “Helpers” (list / create token / revoke)  
5. Only then multi-anchor / heavier mesh futuresight  

## Related

- `docs/implementation-checkpoint-helper-nodes-phase1.md`  
- `docs/NETWORKING.md`  
- Code: `helper_client.rs`, `api/nodes.rs`, `--helper-mode` in `main.rs`  
