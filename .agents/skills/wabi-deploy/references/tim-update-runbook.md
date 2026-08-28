# Tim update runbook — WabiDB single binary

Commands-only. **Audit live Tim first** (`pre-deploy-live-stack-audit.md`).

If Tim still shows STDB containers / no healthy `wabi-server` / wabi.chat 502 → **cutover**, not this binary-only path.

## Hosts

- Tim: `tim@100.96.11.45` · project `~/Desktop/Wabi`
- Build machine: Ronin `/var/home/Ronin/wabi` or ironin `~/Documents/wabi`
- Branch: **`main`**

## 0. Live audit (mandatory)

```bash
ssh tim@100.96.11.45 'hostname; docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"; head -25 ~/Desktop/Wabi/docker-compose.yml; ls -lh ~/Desktop/Wabi/target/release/wabi-server; curl -fsS -m 3 http://127.0.0.1:3001/health; curl -fsS -m 3 http://127.0.0.1:3000/health; test -f ~/Desktop/Wabi/.env && grep -E "^WABI_JWT_KEY=" ~/Desktop/Wabi/.env | sed "s/=.*/=***set***/"'
```

Stop if STDB-era compose without healthy wabi-server — need full cutover plan.

## 1. Build on source machine

```bash
cd /var/home/Ronin/wabi   # or ironin clean tree
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

ABI: current Dockerfile is **fedora:44**. Prefer build on Bazzite/Fedora. Only use bookworm builder if live container is Debian and binary crash-loops on GLIBC. Live Tim host may be Linux Mint (glibc 2.39); image `wabi-wabi-server` is what matters for the bind-mounted binary.

## 2. Ship binary (WabiDB host already on current compose)

**Always clear the WabiDB lock on stop.** After SIGTERM the container can exit cleanly while `data/wabi-server/wabidb/.lock` remains; the next start then crash-loops with `Error: engine already running` (2026-07-17 Tim UI deploy). Make lock removal part of the swap, not a post-failure improvisation:

```bash
scp target/release/wabi-server tim@100.96.11.45:~/Desktop/Wabi/target/release/wabi-server.new
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && \
  docker compose stop wabi-server && \
  rm -f data/wabi-server/wabidb/.lock && \
  mv -f target/release/wabi-server.new target/release/wabi-server && \
  chmod +x target/release/wabi-server && \
  docker compose up -d wabi-server'
```

Do **not** `docker compose up --build` for Rust compile. Do **not** `docker cp` into container.
Do **not** delete STDB-era `data/spacetimedb/**/db.lock` unless the user is explicitly cleaning orphans — only the WabiDB path above.

## 3. Verify

```bash
ssh tim@100.96.11.45 'docker ps --filter name=wabi-server; curl -fsS http://127.0.0.1:3001/health; curl -fsS -o /dev/null -w "root:%{http_code}\n" http://127.0.0.1:3001/; curl -fsS http://127.0.0.1:3001/api/setup/status'
curl -fsS -I --max-time 20 https://wabi.chat/ || true
```

Host health is authoritative. CF 502 with healthy local origin means tunnel/DNS problem, not binary.
UI deploys: confirm `/` returns HTML and hashed CSS (e.g. `assets/0.*.css`) changed vs prior deploy; hard refresh / private window for SW cache.

## 4. Optional: CF-less first (cutover / proof)

```bash
# On Tim: core only — no tunnel profiles
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose stop wabi-cloudflared-named wabi-cloudflared-quick wabi-tunnel-caddy 2>/dev/null; docker compose up -d wabi-server'
# Prove:
ssh tim@100.96.11.45 'curl -fsS http://127.0.0.1:3001/health'
```

User unbinds CF DNS/tunnel in dashboard if testing public CF-less. Default calling needs no open UDP ports — only HTTP(S) reachability to the server.

## 5. Full-tree code sync (when compose/source changed)

```bash
rsync -az --delete \
  --exclude='data/' --exclude='uploads/' --exclude='.git/' \
  --exclude='target/' --exclude='node_modules/' --exclude='frontend/node_modules/' \
  --exclude='frontend/.svelte-kit/' --exclude='frontend/build/' \
  --exclude='logs/' --exclude='*.log' --exclude='.env' \
  /var/home/Ronin/wabi/ tim@100.96.11.45:~/Desktop/Wabi/
```

Then rebuild binary, ship, restart. **Never** overwrite remote `.env` or `data/` by accident.

## Env on Tim (WabiDB compose)

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
