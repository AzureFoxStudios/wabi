# Iyoku Staging Rebuild Runbook

Use this when Ronin asks to tear down and rebuild Wabi on Iyoku (`Iyoku@100.104.166.42`) rather than continue a painful local/ironin restore.

## Principles

- Iyoku is staging, not Ronin's protected local worktree.
- Still inspect and back up before destructive rebuilds.
- Prefer a fresh `~/Desktop/Wabi` tree from Ronin `/var/home/Ronin/wabi`.
- Preserve runtime state from the old tree: `.env`, `wabi.config`, `data/`, `uploads/`.
- For weak/slow remotes, consider low-impact transfer: `rsync --whole-file --partial --timeout=60 --rsync-path='nice -n 15 rsync'`; use `parsyncfp` only if installed on both sides and not paired with `--delete`.

## Known Iyoku Shape

- SSH: `Iyoku@100.104.166.42`
- Preferred staging path: `~/Desktop/Wabi`
- Historical standalone runtime path: `~/wabi/bin/wabi-server`
- Old live-ish process pattern:
  - `~/wabi/bin/wabi-server --port 8080`
  - `socat TCP-LISTEN:3100,reuseaddr,fork TCP:100.96.11.45:3100`
- Old container may exist:
  - `wabi-frontend` rootless podman container

## Rebuild Steps

```bash
# 1. Inspect
ssh -o BatchMode=yes Iyoku@100.104.166.42 '
  hostname; whoami; uptime; free -h; df -h ~;
  for d in ~/Desktop/Wabi ~/Documents/wabi ~/wabi; do [ -e "$d" ] && { echo FOUND "$d"; du -sh "$d"; }; done;
  podman ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null || true;
  ss -tulpn | grep -E ":(3000|3001|5173|8080|3100)" || true
'
```

```bash
# 2. Stop stale frontend/runtime and back up Desktop tree
ssh -o BatchMode=yes Iyoku@100.104.166.42 '
  set -euo pipefail
  podman stop wabi-frontend >/dev/null 2>&1 || true
  pkill -x wabi-server >/dev/null 2>&1 || true
  pkill -f "socat TCP-LISTEN:3100" >/dev/null 2>&1 || true
  stamp=$(date +%Y%m%d-%H%M%S)
  [ -e ~/Desktop/Wabi ] && mv ~/Desktop/Wabi ~/Desktop/Wabi.pre-rebuild-$stamp
  mkdir -p ~/Desktop/Wabi
  echo backup=~/Desktop/Wabi.pre-rebuild-$stamp
'
```

```bash
# 3. Sync source from Ronin. This is safe for Iyoku staging; do not use this against protected "wabi from ronin" trees.
rsync -az --delete --info=stats2 \
  --exclude='node_modules/' \
  --exclude='frontend/node_modules/' \
  --exclude='target/' \
  --exclude='frontend/.svelte-kit/' \
  --exclude='frontend/build/' \
  --exclude='data/' \
  --exclude='uploads/' \
  --exclude='logs/' \
  --exclude='*.log' \
  --exclude='.env' \
  /var/home/Ronin/wabi/ Iyoku@100.104.166.42:/home/Iyoku/Desktop/Wabi/
```

```bash
# 4. Restore runtime state from latest backup
ssh -o BatchMode=yes Iyoku@100.104.166.42 '
  set -euo pipefail
  old=$(ls -dt ~/Desktop/Wabi.pre-rebuild-* | head -1)
  cd ~/Desktop/Wabi
  for item in .env wabi.config data uploads; do
    [ -e "$old/$item" ] && [ ! -e "$item" ] && cp -a "$old/$item" "$item"
  done
  git rev-parse --short HEAD || true
  grep -n "__WABI_SW_VERSION__" frontend/vite.config.ts || true
'
```

```bash
# 5. Build frontend and Rust binary on Iyoku
ssh -o BatchMode=yes Iyoku@100.104.166.42 '
  set -euo pipefail
  cd ~/Desktop/Wabi
  npm install
  cd frontend
  npm install
  STATIC_BUILD=1 npm run build
  cd ..
  ls frontend/build | sed -n "1,20p"
  cargo build --release -p wabi-server
  mkdir -p ~/wabi/bin
  cp -f target/release/wabi-server ~/wabi/bin/wabi-server
  chmod +x ~/wabi/bin/wabi-server
'
```

```bash
# 6. Start staging server on 8080 with STDB bridge on 3100
ssh -o BatchMode=yes Iyoku@100.104.166.42 '
  set -euo pipefail
  cd ~/Desktop/Wabi
  mkdir -p ~/wabi/bin data uploads
  nohup socat TCP-LISTEN:3100,reuseaddr,fork TCP:100.96.11.45:3100 >~/wabi/bin/socat.log 2>&1 &
  sleep 1
  nohup bash -lc '\''cd "$HOME/Desktop/Wabi" && set -a && [ -f .env ] && source .env; set +a; export WABI_STDB_SERVER=http://localhost:3100; export WABI_STDB_DATABASE=${WABI_STDB_BRIDGE_DATABASE:-wabi-state-benchmark-v2}; export WABI_STDB_TOKEN=${WABI_STDB_AUTH_TOKEN:-${WABI_STDB_TOKEN:-}}; export DATA_DIR="$HOME/Desktop/Wabi/data"; export UPLOADS_DIR="$HOME/Desktop/Wabi/uploads"; export FRONTEND_URL=http://100.104.166.42:8080; export PUBLIC_URL=http://100.104.166.42:8080; "$HOME/wabi/bin/wabi-server" --port 8080 --data-dir "$HOME/Desktop/Wabi/data"'\'' >~/wabi/bin/wabi-server.log 2>&1 &
  sleep 5
  ss -tulpn | grep -E ":(8080|3100)"
'
```

## Verification

```bash
ssh -o BatchMode=yes Iyoku@100.104.166.42 '
  curl -fsS --max-time 10 http://127.0.0.1:8080/health; echo
  curl -fsS -I --max-time 10 http://127.0.0.1:8080/ | sed -n "1,12p"
  tail -40 ~/wabi/bin/wabi-server.log
'

curl -fsS --max-time 15 http://100.104.166.42:8080/health
curl -fsS -I --max-time 15 http://100.104.166.42:8080/
```

Expected:
- `/health` returns JSON with `status: ok`, `service: wabi-server`, `role: authority`.
- `/` returns HTTP 200 and `cache-control: no-cache, no-store, must-revalidate`.
- `ss` shows `wabi-server` listening on 8080 and `socat` on 3100.

## Browser-Harness Verification

If browser-harness is installed, open:

```python
tid = new_tab('http://100.104.166.42:8080/')
wait_for_load(timeout=20)
switch_tab(tid)
print(page_info())
print(js('document.body.innerText.slice(0,500)'))
print(js('Array.from(document.querySelectorAll("script[src],link[href]")).map(e=>e.src||e.href).filter(Boolean).slice(0,20)'))
```

Confirm the login screen says `Server: http://100.104.166.42:8080` and asset hashes match the new build.
