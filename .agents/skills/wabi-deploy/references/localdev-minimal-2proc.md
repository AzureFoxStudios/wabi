# Wabi localdev — 2-process minimal stack (STDB + host wabi-server binary)

Use when you need a real Wabi backend running on a Bazzite/Ronin box for
**frontend dev work** or **bot testing** and you do NOT need the full
`local-dev.sh` 7-service stack (no call/media STDB cluster, no caddy
proxies, no cloudflared tunnel, no helper nodes, no mesh).

This is the path you take when:
- You have a dirty frontend tree and want to see it talk to a real backend
- You want to test a bot against a real STDB + real wabi-server
- `local-dev.sh` would take 3-4 minutes of cargo build + start 7 services
  you do not need
- The `localhost/wabi_wabi-server:latest` container image is broken or
  missing its `/wabi-server` binary (it is, on Ronin's box as of 2026-06-15)

This is NOT a substitute for `local-dev.sh` when the user needs call/media
STDB, caddy, the cloudflared tunnel, or the mesh stack.

## What you actually run

Three things on the host:

1. **STDB** — single podman container, port 3000, with a host bind-mount
   for the data dir. The `docker.io/clockworklabs/spacetime:latest` image
   is already pulled on most Wabi dev machines.
2. **wabi-server** — host process (NOT a container), the binary built
   locally via `cargo build --release -p wabi-server`. The binary lands at
   `<workspace-root>/target/release/wabi-server` because Cargo uses the
   workspace target dir even when you run `cargo build` from inside
   `core/`. Do not look for it in `core/target/`.
3. **vite dev** — already running on 5173 with `VITE_SOCKET_URL`
   pointing at the local wabi-server on 3001.

## Order of operations (this is the part that matters)

If you skip a step the symptoms look like the wabi-server is broken when
it is not. Do these in order:

1. **Make the data dirs first.** Podman bind-mounts require the host dir
   to exist. `local-dev.sh` had this as a bug — `data/spacetimedb-local`
   did not exist on the first run.

   ```bash
   mkdir -p /var/home/Ronin/wabi/data/spacetimedb-local
   mkdir -p /var/home/Ronin/wabi/data/spacetimedb-local-config
   mkdir -p /var/home/Ronin/wabi/data/wabi-server-local
   ```

2. **Start STDB.** Use `--network=host` so the container can bind 3000
   directly on the host. Without `--network=host` you'd have to publish
   the port and then the wabi-server in the next step would need to know
   the host-side mapped port, which is annoying.

   ```bash
   podman run -d --rm \
     --name wabi-stdb-local \
     --network=host \
     -v /var/home/Ronin/wabi/data/spacetimedb-local:/var/lib/spacetimedb:Z,U \
     -v /var/home/Ronin/wabi/data/spacetimedb-local-config:/home/spacetime/.config/spacetime:Z,U \
     docker.io/clockworklabs/spacetime:latest \
     start --listen-addr 0.0.0.0:3000 --data-dir /var/lib/spacetimedb --non-interactive --page_pool_max_size 268435456
   ```

3. **Wait for STDB ping** before doing anything else. STDB takes 1-2s
   on a warm start; don't race the next step.

   ```bash
   for i in {1..60}; do
     curl -fsS http://127.0.0.1:3000/v1/ping >/dev/null 2>&1 && break
     sleep 1
   done
   ```

4. **Build the wabi-server binary.** First time this is 20-30s on a
   warm `target/` cache; 3-4 minutes if Cargo has to fetch and compile
   the entire dep tree from scratch. Subsequent rebuilds are seconds.
   **CRITICAL**: Cargo uses the workspace target dir. From inside
   `core/`, the binary lands at the repo root, not `core/target/`.

   ```bash
   cd /var/home/Ronin/wabi/core
   cargo build --release -p wabi-server
   # binary is at: /var/home/Ronin/wabi/target/release/wabi-server
   ```

5. **Start wabi-server as a host process.** NOT in a container. The
   `localhost/wabi_wabi-server:latest` image on Ronin's box is broken
   (entrypoint is `/wabi-server` but the image is missing the binary at
   that path). Don't waste time debugging the image; use the host
   binary.

   Required env:
   - `WABI_STDB_SERVER=http://127.0.0.1:3000`
   - `WABI_STDB_DATABASE=wabi-state-local`
   - `JWT_SECRET=*** non-empty>`
   - `RUST_LOG=info`

   ```bash
   WABI_STDB_SERVER=http://127.0.0.1:3000 \
   WABI_STDB_DATABASE=wabi-state-local \
   JWT_SECRET=*** \
   RUST_LOG=info \
   /var/home/Ronin/wabi/target/release/wabi-server \
     --port 3001 --host 0.0.0.0
   ```

6. **Wait for `/health`.** This confirms the server can talk to STDB.
   First start will fail to seed the default `general` and `voice`
   channels with `wabi-state-local not found` until step 7.

   ```bash
   for i in {1..60}; do
     curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1 && break
     sleep 1
   done
   ```

7. **Publish the `wabi_state_bridge` module to STDB.** This creates the
   `wabi-state-local` database in STDB with the schema the wabi-server
   needs. The database does not exist by default — STDB starts empty.

   This requires the `spacetime` / `spacetimedb-cli` binary. **It is not
   preinstalled on Bazzite/Fedora atomic.** Install it by downloading
   the v2.5+ release from GitHub (the binary is named `spacetimedb-cli`,
   not `spacetime`, in v2.5+; older docs are wrong on this):

   ```bash
   curl --tlsv1.2 -sSL -o /tmp/stdb-install/spacetime.tar.gz \
     https://github.com/clockworklabs/SpacetimeDB/releases/download/v2.5.0/spacetime-x86_64-unknown-linux-gnu.tar.gz
   tar -xzf /tmp/stdb-install/spacetime.tar.gz -C /tmp/stdb-install/
   CLI=/tmp/stdb-install/spacetimedb-cli

   $CLI server set-default local   # or: server add --url http://127.0.0.1:3000 wabi-local --default yes
   $CLI publish --module-path /var/home/Ronin/wabi/spacetimedb/wabi_state_bridge wabi-state-local --yes
   ```

   The `publish` step compiles the Rust module to WASM (~12s cold) and
   uploads it to STDB. The first publish creates the database; subsequent
   publishes update the schema. After this step the wabi-server log will
   stop showing `wabi-state-local not found`.

8. **Restart vite with `VITE_SOCKET_URL=http://127.0.0.1:3001`.** The
   default `serverUrl.ts` falls back to `http://localhost:8080` (Tim's
   production port) for unknown env. You must tell vite where the local
   backend is, or the login form will hit a 404 and the user will think
   the backend is broken when it isn't.

   ```bash
   pkill -f 'bun x vite'   # kill current vite
   cd /var/home/Ronin/wabi/frontend
   VITE_SOCKET_URL=http://127.0.0.1:3001 bun x vite dev --host 0.0.0.0 --port 5173
   ```

## Why the image is broken (don't try to fix it in-session)

The `localhost/wabi_wabi-server:latest` image on Ronin's box has entrypoint
`/wabi-server` but no binary at that path. The compose file's
`wabi-server` service relies on a **host bind-mount**
(`./target/release/wabi-server:/wabi-server:ro`) to supply the binary
from outside the image, which is why the compose workflow works but the
standalone image does not. The image is only useful in the context of the
compose stack, not as a self-contained container.

If you need a self-contained wabi-server image, fix the
`core/crates/wabi-server/Dockerfile` to use a multi-stage build that
copies the binary in. That's a separate change; do not detour into it
during a local-dev pass.

## Verification

End-to-end check after step 8:

```bash
# 1. STDB responds to ping
curl -fsS http://127.0.0.1:3000/v1/ping
# expect: 200

# 2. wabi-server health
curl -fsS http://127.0.0.1:3001/health
# expect: 200

# 3. Setup status (frontend will hit this on first load)
curl -fsS http://127.0.0.1:3001/api/setup/status
# expect: 200, body like {"setupRequired":false,...}

# 4. Real registration (validates the full stack)
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"username":"ronin","password":"testpass","handle":"ronin"}' \
  http://127.0.0.1:3001/api/auth/register
# expect: 200 with real JWT in body
```

If step 4 returns `400` "Password must be at least 6 characters", the
stack is working end-to-end and the validation is from the real backend.

## Bot testing

With the stack up, a bot can hit:

- `POST http://127.0.0.1:3001/api/auth/register` — register a bot user
- `POST http://127.0.0.1:3001/api/auth/login` — log in
- `GET  http://127.0.0.1:3001/api/channels` — list channels
- `POST http://127.0.0.1:3001/api/channels` — create a channel
- `POST http://127.0.0.1:3001/socket.io/` — real-time events

The bot gets a real JWT, a real row in STDB, and a real socket connection.
No mocking, no fake users. This is what "test bots" means in the Wabi
context: a Python or Node script that drives the same API a human
browser would.

## Shutdown

```bash
pkill -f 'bun x vite'                        # vite
kill <wabi-server pid>                       # host process; pid in /tmp/wabi-server.log if you used the script
podman stop wabi-stdb-local                  # STDB
```

The data dirs persist on the host under `data/`, so subsequent runs
pick up the same database. If you want a clean state, delete the data
dirs before re-running.

## What NOT to do

- **Do not build a Vite plugin that mocks `/api/auth/login` etc.** to
  let the user "skip the login wall" in mock mode. The wabi-deploy
  skill's `localdev-container-runtime-detection.md` already documents
  this anti-pattern. The real fix is always: get STDB up, build
  wabi-server, point vite at it. The frontend talking to a fake auth
  endpoint is not a real backend; it cannot exercise the reducer, real
  channels, real socket events, or any bot-style automation.
- **Do not use `cargo install spacetime`** to get the CLI. It is not on
  crates.io. Download the binary from the SpacetimeDB GitHub releases
  page; the v2.5+ asset is named `spacetime-x86_64-unknown-linux-gnu.tar.gz`
  and extracts to `spacetimedb-cli` and `spacetimedb-standalone`.
- **Do not look for the wabi-server binary in `core/target/`.** Cargo
  uses the workspace target dir, which is the repo root. The binary is
  at `<repo-root>/target/release/wabi-server`.
- **Do not start vite without `VITE_SOCKET_URL`.** Without it, the
  frontend's `serverUrl.ts` falls back to `http://localhost:8080`
  (production port), the login form will hit a 404, and the user will
  think the backend is broken when it isn't.
- **Do not try to fix the broken `localhost/wabi_wabi-server:latest`
  image in this session.** It is broken by design — the compose file
  supplies the binary via bind-mount. Use the host binary instead.
