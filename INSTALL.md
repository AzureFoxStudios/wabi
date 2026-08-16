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

## Common pitfalls

1. **`STATIC_BUILD=1` is required for the frontend build.** If you run `npm run build` without it, SvelteKit uses `adapter-node` and emits `handler.js`/`server/` — **no `index.html`**. The Rust binary embeds the frontend via `rust_embed` at compile time, so it needs the static `index.html`. `/health` will return 200 but every page route 404. Fix: `cd frontend && STATIC_BUILD=1 npm run build`, then rebuild the binary.

2. **First account is the owner.** The first user registered becomes the server admin/owner. Use a strong password. Don't create throwaway accounts first.

3. **WabiDB engine lock can survive a stop/restart.** If the server won't start with "engine already running", clear both lock files: `rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock`.

4. **Auth token bounce (login page flash → bounce to /login).** This is a stale JWT in the browser's `localStorage`, not a server bug. Hard refresh does NOT clear it — clear site data for the domain.

5. **`TURN_HMAC_KEY` is required in `.env` even if you don't use TURN.** Compose interpolates `${TURN_HMAC_KEY:?...}` unconditionally. Generate one: `openssl rand -base64 32`.

6. **Cloudflare tunnel strips WebSocket upgrade.** If your app disconnects immediately behind CF, set `transports: ['websocket', 'polling']` in the socket.io client. See `docs/NETWORKING.md`.

7. **`docker compose up -d --build` does NOT rebuild the Rust binary.** The Dockerfile is runtime-only. The binary is bind-mounted from `./target/release/wabi-server`. To ship a new binary: rebuild on host, then `docker compose restart wabi-server`.

8. **Stale scripts in this repo are removed.** `scripts/setup.sh` and `docker-compose.bun.yml` are gone. The canonical paths are `docker-compose.yml` + `.env` (Docker) or bare cargo.

## Stale docs

- `DEPLOYMENT_READY.md`, much of `PROJECT_DOCS/02-deployment/DEPLOYMENT.md` — STDB-era; prefer this file + `docker-compose.yml` header + `docs/NETWORKING.md`.
