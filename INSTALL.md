# Wabi install / deploy

**Updated:** 2026-07-17

## Mental model

| Piece | Role |
|-------|------|
| `wabi-server` | Only app process. Axum + WabiDB in-process + embedded SPA |
| `.env` | Secrets + config |
| Caddy (optional) | HTTPS / reverse proxy / tunnel front |
| Docker | Optional packaging of the same binary |
| Compose | Optional multi-service glue; **not** the architecture |

No SpacetimeDB. No separate frontend/backend services. Default calling is same TCP/WS as the app (see `docs/NETWORKING.md`).

---

## Preferred: Rust / cargo path

```bash
# 1) Frontend for rust_embed (must be static SPA)
cd frontend && STATIC_BUILD=1 npm run build && cd ..

# 2) Binary
cargo build --release -p wabi-server

# 3) Secrets + data
mkdir -p data/wabi-server uploads plugins
export WABI_JWT_KEY="$(openssl rand -base64 48)"
export WABIDB_ROOT_KEY="$(openssl rand -hex 32)"
# binary also accepts JWT_SECRET (legacy alias)

# 4) Run
./target/release/wabi-server --data-dir ./data/wabi-server --host 0.0.0.0 --port 3000
```

**Check:**
```bash
curl -s http://127.0.0.1:3000/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # expect 200 + HTML
```

If `/` is 404, rebuild frontend with `STATIC_BUILD=1` then rebuild the binary (embed is compile-time).

**Prod front:** point Caddy (or cloudflared) at `127.0.0.1:3000`. Edit Caddyfile + `.env` only — no STDB, no node backend.

---

## Docker (same binary, containerized)

```bash
# .env (required for compose)
# WABI_JWT_KEY=...
# WABIDB_ROOT_KEY=...  # 64 hex chars

docker compose up -d          # only wabi-server by default
# optional profiles: tunnel, tunnel-named, turn, sfu, ...
```

Compose bind-mounts `./target/release/wabi-server` (read-only) in the current layout — rebuild the binary on the host, then restart the container. Default publish: host `3001` → container `3000`.

Bare docker without compose is fine:
```bash
docker run --rm -p 3001:3000 --env-file .env \
  -v "$PWD/data/wabi-server:/data" \
  -v "$PWD/target/release/wabi-server:/wabi-server:ro" \
  --user 1000:1000 --entrypoint /wabi-server \
  wabi-wabi-server --data-dir /data --host 0.0.0.0 --port 3000
```
(Image name/tags may vary; the contract is: one process, one data dir, two secrets.)

---

## Tim / production shape

Live Tim is already this stack:
- `wabi-server` (healthy)
- Caddy tunnel container (optional edge)
- cloudflared connectors (optional public)

Update flow: rebuild binary (and static frontend if UI changed) → restart `wabi-server` → leave Caddy/tunnel unless edge config changed.

---

## Optional extras

| Profile / tool | When |
|----------------|------|
| Caddy / cloudflared | Public domain or HTTPS edge |
| coturn / LiveKit | Only if you enable P2P TURN or SFU |
| Mesh env vars | Multi-node authority/anchor |

Default voice does **not** need open UDP or Cloudflare.

---

## Stale docs

- `DEPLOYMENT_READY.md`, much of `PROJECT_DOCS/02-deployment/DEPLOYMENT.md` — STDB-era; prefer this file + `docker-compose.yml` header + `docs/NETWORKING.md`.
