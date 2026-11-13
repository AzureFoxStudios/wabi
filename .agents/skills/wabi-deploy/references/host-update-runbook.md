# <host> update runbook — WabiDB single binary

Commands-only. **Audit live <host> first** (`pre-deploy-live-stack-audit.md`).

If <host> still shows STDB containers / no healthy `wabi-server` / wabi.chat 502 → **cutover**, not this binary-only path.

## Hosts

- <host>: `<user>@<host>` · project `<wabi-root>`
- Build machine: Ronin `<wabi-root>` or <dev-host> `<wabi-root>`
- Branch: **`main`**

## 0. Live audit (mandatory)

```bash
ssh <user>@<host> 'hostname; docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"; head -25 <wabi-root>/docker-compose.yml; ls -lh <wabi-root>/target/release/wabi-server; curl -fsS -m 3 http://127.0.0.1:3001/health; curl -fsS -m 3 http://127.0.0.1:3000/health; test -f <wabi-root>/.env && grep -E "^WABI_JWT_KEY=" <wabi-root>/.env | sed "s/=.*/=***set***/"'
```

Stop if STDB-era compose without healthy wabi-server — need full cutover plan.

## 1. Build on source machine

```bash
cd <wabi-root>   # or <dev-host> clean tree
git checkout main && git status -sb

cd frontend
rm -rf build .svelte-kit
STATIC_BUILD=1 bun run build
cd ..
# MUST be static:
ls frontend/build/ | head
# want: index.html _app — NOT handler.js server/

cargo build --release -p wabi-server
ls -lh target/release/wabi-server
```

ABI: current Dockerfile is **fedora:44**. Prefer build on Bazzite/Fedora. Only use bookworm builder if live container is Debian and binary crash-loops on GLIBC. Live <host> host may be Linux Mint (glibc 2.39); image `wabi-wabi-server` is what matters for the bind-mounted binary.

## 2. Ship binary (WabiDB host already on current compose)

**Do NOT delete `data/wabi-server/wabidb/.lock`.** Older versions of this runbook removed it on every swap. Current WabiDB holds an OS advisory lock on that persistent file; PID text is diagnostic only. Deleting it can admit a second writer, and pre-advisory and advisory binaries must never share one data tree (`AGENTS.md` rule 9, `docs/deployment/BACKUP_AND_RECOVERY.md`). Stop the container, confirm the process exited, swap the binary, start. A legacy root `data/wabi-server/.lock` may be removed only after confirming every old Wabi process is stopped. If a start fails with `Error: engine already running`, find the process that holds the lock; do not unlink the file.

Stopping `wabi-server` on <host> is a **live outage** (<host> serves wabi.chat). Get explicit operator go-ahead first.

```bash
scp target/release/wabi-server <user>@<host>:<wabi-root>/target/release/wabi-server.new
ssh <user>@<host> 'cd <wabi-root> && \
  docker compose stop wabi-server && \
  mv -f target/release/wabi-server.new target/release/wabi-server && \
  chmod +x target/release/wabi-server && \
  docker compose up -d wabi-server'
```

Do **not** `docker compose up --build` for Rust compile. Do **not** `docker cp` into container.
Do **not** delete STDB-era `data/spacetimedb/**/db.lock` unless the user is explicitly cleaning orphans — only the WabiDB path above.

## 3. Verify

```bash
ssh <user>@<host> 'docker ps --filter name=wabi-server; curl -fsS http://127.0.0.1:3001/health; curl -fsS -o /dev/null -w "root:%{http_code}\n" http://127.0.0.1:3001/; curl -fsS http://127.0.0.1:3001/api/setup/status'
curl -fsS -I --max-time 20 https://wabi.chat/ || true
```

Host health is authoritative. CF 502 with healthy local origin means tunnel/DNS problem, not binary.
UI deploys: confirm `/` returns HTML and hashed CSS (e.g. `assets/0.*.css`) changed vs prior deploy; hard refresh / private window for SW cache.
Calls deploys: hard-refresh ALL test devices and confirm the entry-chunk hash in console sources matches live (`curl -s https://wabi.chat/ | grep -oE 'entry/start\.[A-Za-z0-9_-]+\.js'`) BEFORE testing. A stale page's mid-call lazy `import()` 404s against the new binary (`error loading dynamically imported module: .../chunks/<old-hash>.js`) and kills the fallback/heal chain — a stale client cannot judge new calling code. See `wabi-deploy-debug` `references/cf-stale-js-chunk-and-diagnostic-runtime.md`.

## 4. Optional: CF-less first (cutover / proof)

```bash
# On <host>: core only — no tunnel profiles
ssh <user>@<host> 'cd <wabi-root> && docker compose stop wabi-cloudflared-named wabi-cloudflared-quick wabi-tunnel-caddy 2>/dev/null; docker compose up -d wabi-server'
# Prove:
ssh <user>@<host> 'curl -fsS http://127.0.0.1:3001/health'
```

User unbinds CF DNS/tunnel in dashboard if testing public CF-less. Default calling needs no open UDP ports — only HTTP(S) reachability to the server.

## 5. Full-tree code sync (when compose/source changed)

```bash
rsync -az --delete \
  --exclude='data/' --exclude='uploads/' --exclude='.git/' \
  --exclude='target/' --exclude='node_modules/' --exclude='frontend/node_modules/' \
  --exclude='frontend/.svelte-kit/' --exclude='frontend/build/' \
  --exclude='logs/' --exclude='*.log' --exclude='.env' \
  <wabi-root>/ <user>@<host>:<wabi-root>/
```

Then rebuild binary, ship, restart. **Never** overwrite remote `.env` or `data/` by accident.

## Env on <host> (WabiDB compose)

```
WABI_JWT_KEY=<64+ random chars>
WABIDB_ROOT_KEY=<64 hex chars = openssl rand -hex 32>
WABI_PORT_OUT=3001
TURN_HMAC_KEY=<any base64>   # compose interpolates even if turn profile unused
```

Without `WABIDB_ROOT_KEY` the server crash-loops: `validation failed for load_bootstrap_key`.

Not `JWT_SECRET` / `JWT_SIGNING_KEY` unless compose still maps them (current compose uses `WABI_JWT_KEY`).

## Never

- Wipe `data/` or `uploads/` without explicit ask
- Binary-only deploy onto STDB-era compose
- Claim wabi.chat updated without host `/health` + (if using CF) public check
- Ship CSS-only without re-embedding via `STATIC_BUILD` + release binary
