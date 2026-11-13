# Wabi install / deploy

**Updated:** 2026-11-13

For a first install, [FRESH_INSTALL.md](FRESH_INSTALL.md) is the shorter step-by-step page; this page covers both paths in more detail. What following these pages from a blank machine actually takes, step by step, is measured in [docs/testing/INSTALL_FROM_NOTHING.md](../testing/INSTALL_FROM_NOTHING.md), and `core/crates/wabi-server/tests/install_from_nothing_contract.rs` checks the same journey in CI.

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

Before you start you need Git, Node.js 22 with npm, Rust through [rustup](https://rustup.rs) (the repository selects its pinned toolchain itself) and a C compiler/linker for your platform (on Debian/Ubuntu, `build-essential` and `pkg-config`). This page does not list exact packages for every platform.

```bash
# 0) Source
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi

# 1) Frontend for rust_embed (must be static SPA)
cd frontend
npm ci --no-audit --no-fund
STATIC_BUILD=1 npm run build
cd ../

# 2) Binary
cargo build --locked --release -p wabi-server

# 3) Run. The server creates ./data/wabi-server itself; nothing to create first.
./target/release/wabi-server --data-dir ./data/wabi-server --host 0.0.0.0 --port 3000
```

The server keeps running in that terminal. When it is ready to accept connections it prints a short block like this (your paths, date and address will differ):

```text
Wabi server is ready.
  Open in a browser:  http://localhost:3000
                      http://192.168.1.20:3000  (from other devices)
  Data directory:     /home/you/wabi/data/wabi-server
  Log file:           /home/you/wabi/logs/wabi-server.log.2026-11-13
  No owner yet: the first account created becomes the owner.
```

The second address is this machine's address on your network; when the server cannot work it out, that line says `or this machine's address, port 3000` instead. The `No owner yet` line appears only until the first account exists. A `Web app: not included in this build` line means the frontend was not built (pitfall 1). Nothing secret is ever printed.

Everything else goes to the log file named in the block, `./logs/wabi-server.log.<date>` relative to where you started the server (set `WABI_LOG_DIR` to move it). If the server cannot start (port already in use, another server using the same data directory, a data directory it cannot read), it says what happened and what to do on the terminal, then exits. Stop it with Ctrl+C. Keeping it running after you log out (a systemd unit or similar) is not covered here yet.

The block is left out when the server is started with `--print-bound-address`: that flag is for a supervising program (the desktop app, test harnesses) that reads stdout as one JSON record per line.

Secrets: first boot generates `<data_dir>/jwt_secret` and `<data_dir>/wabidb/root_key` (mode 0600) if no env var provides them. To manage secrets externally instead, export `WABI_JWT_KEY` (JWT_SECRET is a legacy alias) and `WABIDB_ROOT_KEY` (64 hex chars) — env always wins over the files. **Back the data dir up**: the root key is not recoverable, and losing it loses the data.

**Check** (from a second terminal):
```bash
curl -fsS http://127.0.0.1:3000/readyz
curl -fsS -o /dev/null http://127.0.0.1:3000/ && echo "web app OK"
```

`/readyz` should answer `{"engine":"ready","status":"ok"}`. The second check fails (`curl: (22) ... 503`) when the binary was built without the web app: the server then answers every page with `503` and a page saying so, while the API and health checks keep working. Fix: rebuild the frontend with `STATIC_BUILD=1`, then rebuild the binary (pitfall 1).

**Create the owner:** open `http://localhost:3000` (or `http://<this machine's address>:3000` from another computer on your network) in a browser. The first account created becomes the server owner; the setup screens then ask for starter rooms and whether anyone may register (**Open**) or nobody (**Closed**). See [Inviting someone](#inviting-someone) for what that choice means.

**Prod front:** point Caddy (or cloudflared) at `127.0.0.1:3000`. Edit Caddyfile + `.env` only — no STDB, no node backend.

---

## Docker (same binary, containerized)

```bash
docker compose up -d --build   # first build compiles frontend + server (~10+ min, cached after)
# optional profiles: tunnel, tunnel-named, turn, sfu, ...
```

Compose prepares fresh bind-mount directory ownership with a short initializer, then runs the Authority as UID/GID 1000. Existing files are not recursively changed.

The image is a multi-stage build (frontend → cargo → runtime), so a fresh clone needs no host toolchain. No `.env` is required: secrets auto-generate into the bind-mounted `./data/wabi-server` on first boot. Set `WABI_JWT_KEY` / `WABIDB_ROOT_KEY` in `.env` only if you manage secrets externally. Default publish: host `3001` → container `3000`.

`docker compose logs wabi-server` shows the same ready block as the binary path. Inside a container the server cannot see which host port Docker published, so the block says `the host port mapped to 3000 in this container` (with the provided `docker-compose.yml`, `http://localhost:3001`) and marks its data directory and log file as paths inside the container (`/data` is `./data/wabi-server` on the host).

Dev override: to run a host-built binary instead of the image's, mount it over the baked-in one and restart:

```yaml
volumes:
  - ./target/release/wabi-server:/wabi-server:ro
```

Bare docker without compose is fine:
```bash
docker run --rm -p 3001:3000 \
  -v "$PWD/data/wabi-server:/data" \
  --user 1000:1000 \
  $(docker build -q -f core/crates/wabi-server/Dockerfile .) \
  --data-dir /data --host 0.0.0.0 --port 3000
```
(The contract is: one process, one data dir, zero required secrets.)

---

## Inviting someone

What exists today, plainly:

- **The default is open registration.** With no admission policy saved (or **Open** chosen on the setup screen), anyone who can reach the server's address can create an account without an invitation. Send them the address; they choose **Create account**.
- **Invitation links are created only in the desktop app's hosting screen** (`/host`, Tauri builds). The browser app served by this server has no button for creating an invitation.
- **Invite-only admission** (`auth_policy` mode `invite`) is not offered on the browser setup screen. **Closed** refuses every registration, invitations included.
- **An invitation link only opens over HTTPS**, or over plain HTTP on `localhost` or a private LAN address (`10.x`, `172.16–31.x`, `192.168.x`). A friend on the internet therefore needs the server behind HTTPS (see *Prod front* above and [NETWORKING.md](../NETWORKING.md)).

To make a one-use invitation without the desktop app, from a terminal on the server (the password ends up in your shell history; clear it afterwards):

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"OWNER_NAME","password":"OWNER_PASSWORD"}' | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s -X POST http://127.0.0.1:3000/api/invites \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"expiresInHours":24}'
```

The answer contains `"token":"<64 hex characters>"`. The link to send is `https://<your server>/join#invite=<token>` (or `http://<LAN address>:3000/join#invite=<token>` on a LAN). It works once and expires after the hours you chose (1–168).

---

## Tim / production shape

Live Tim is already this stack:
- `wabi-server` (healthy)
- Caddy tunnel container (optional edge)
- cloudflared connectors (optional public)

Update flow: `docker compose up -d --build wabi-server` (image rebuilds frontend + binary; host-built binary override also works — see Docker section) → leave Caddy/tunnel unless edge config changed.

---

## Optional extras

| Profile / tool | When |
|----------------|------|
| Caddy / cloudflared | Public domain or HTTPS edge |
| coturn / LiveKit | Only if you enable P2P TURN or SFU |
| Mesh env vars | Multi-node authority/anchor |

Default voice does **not** need open UDP or Cloudflare.

---

## Public instance hardening

Defaults in this repo are tuned for **trusted / LAN self-hosting**. If you expose
Wabi to the public internet, review these env vars first (all optional, see
`.env.example`):

| Env var | Default | Public-instance guidance |
|---|---|---|
| `WABI_MAX_BODY_SIZE` | 50 GiB | File/transport ceiling in bytes. Ordinary API JSON, auth POST and whiteboard document PUT have a separate 2 MiB ceiling; a smaller operator limit still wins. Lower the file ceiling for public instances; 50 GiB suits trusted LAN media backups. |
| `WABI_HTTP_TIMEOUT_SECS` | 30 | API request timeout. Uploads/static are exempt. 30s is fine publicly; raise only if long API operations matter to you. |
| `WABI_RATE_LIMIT_RPS` / `WABI_RATE_LIMIT_BURST` | see `.env.example` | Keep enabled behind a trusted proxy; set `WABI_TRUSTED_PROXIES` so rate limiting sees real client IPs. |
| `WABI_METRICS_PUBLIC` | false (admin-gated) | Leave false on public instances. When false, `/metrics` answers only a server admin's bearer token or `WABI_METRICS_TOKEN`; anyone else gets 401/403. `1`/`true`/`yes` serves it to anyone without auth and logs a warning at startup. |
| `WABI_METRICS_TOKEN` | unset | Scrape secret for Prometheus: send it as `Authorization: Bearer <token>` (in Prometheus, `authorization: { credentials: <token> }` on the scrape job). It opens `/metrics` only, no other route. Use a long random value, e.g. `openssl rand -hex 32`. |

`/health`, `/livez` and `/readyz` stay public for load balancers and the compose
health check. They return only status, service name, role, version and a
timestamp (`/health`), or a status and engine-ready flag (`/livez`, `/readyz`;
a 503 from `/readyz` also carries the engine's error text). No user, channel or
message data. `/metrics` itself carries only server-wide
counters (request count, request latency histogram, socket gauge, uptime),
labelled by `service` and `le`, with nothing per user or per conversation.

Also standard: run behind HTTPS (Caddy/cloudflared profile), keep
`PLUGINS_ENABLED=false` unless you need plugins, and back up `data/`
(see pitfalls #7).

---

## Common pitfalls

1. **`STATIC_BUILD=1` is required for the frontend build.** If you run `npm run build` without it, SvelteKit uses `adapter-node` and emits `handler.js`/`server/` — **no `index.html`**. The Rust binary embeds the frontend via `rust_embed` at compile time, so it needs the static `index.html`. Without it the startup block says `Web app: not included in this build`, and `/` (and every other page) answers `503` with a page explaining this; `/health`, `/readyz` and the API still answer normally. Fix: `cd frontend && STATIC_BUILD=1 npm run build`, then rebuild the binary.

2. **First account is the owner.** The first user registered becomes the server admin/owner. Use a strong password. Don't create throwaway accounts first.

3. **Investigate an engine-lock error before touching locks.** Stop the service and confirm that no other Wabi process or container is using the same data directory. **Never delete `data/wabi-server/wabidb/.lock`**: the engine holds an OS lock on that file, so a leftover file is not a stale lock and the next start reacquires it; deleting it can let a second writer in. Only a legacy root `data/wabi-server/.lock` may be removed, and only after confirming every old Wabi process is stopped. Follow [Backup and Recovery](BACKUP_AND_RECOVERY.md#restore-onto-a-clean-authority).

4. **Investigate repeated login/session-expired redirects.** Stale credentials are one possible cause; verify server readiness and the sign-in response before assuming the cause. Use the app's sign-out/re-authentication path when available. Avoid clearing all site data as a first step: browser-local notes and other local documents may have no server backup. Preserve/export local work before any browser-storage reset.

5. **`TURN_HMAC_KEY` is required when the turn profile runs.** The coturn entrypoint refuses to start without it (compose no longer fails interpolation for everyone else). Generate one: `openssl rand -base64 32`.

6. **Cloudflare tunnel strips WebSocket upgrade.** If your app disconnects immediately behind CF, set `transports: ['websocket', 'polling']` in the socket.io client. See `docs/NETWORKING.md`.

7. **Back up the data dir — it holds the root key.** `data/wabi-server/wabidb/root_key` (auto-generated on first boot) encrypts the engine's stream keys. Losing it loses the data; it is not derivable from anywhere else. The whole `data/` directory is the backup unit.

8. **Stale scripts in this repo are removed.** `scripts/setup.sh` and `docker-compose.bun.yml` are gone. The canonical paths are `docker-compose.yml` + optional `.env` (Docker) or bare cargo.

## Stale docs

- `DEPLOYMENT_READY.md`, much of `docs/deployment/DEPLOYMENT.md` — STDB-era; prefer this file + `docker-compose.yml` header + `docs/NETWORKING.md`.
