---
name: wabi-deploy
description: Deploy wabi-server (WabiDB-embedded Rust binary) to Tim or other hosts. Build static frontend + release binary, bind-mount swap, health checks. Cloudflare is optional. Always audit live stack before deploy.
version: 3.3.1
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [deploy, docker, wabi, rust, self-hosted, wabidb, bazzite, cgnat, minimal-compose]
    status: post-wabidb-cutover-2026-07-17
---

# Wabi Deploy — WabiDB Single Binary

## Hard rule: do not trust this skill blindly

Skills lag the tree. **Before any Tim / wabi.chat / remote deploy:**

1. Read **local** `docker-compose.yml`, `core/crates/wabi-server/Dockerfile`, and `main.rs` rust-embed path.
2. **Probe the live host** — mandatory: `references/pre-deploy-live-stack-audit.md`.
3. If live Tim still has STDB containers and **no** healthy `wabi-server`, that is a **stack cutover**, not a binary swap. Stop and plan with the user.
4. If `wabi-server` is already healthy and public `https://wabi.chat` is 502, that is **not** cutover and **not** a binary-swap problem — run `references/wabichat-502-diagnosis.md` (CF tunnel / client-path routing). Do not “fix CF” by redeploying the origin.
5. Never wipe `data/` or `uploads/` without explicit user consent.
6. **Public health must be proven from the user path**, not only from the agent’s current egress. Ronin and Tim can disagree (2026-07-17: Tim public 200, Ronin public 502 Host Error while origin stayed green).

## Stack simplification (Ronin confirmed 2026-07-17)

With SpacetimeDB fully replaced by WabiDB, the canonical runtime is just `wabi-server` plus env/proxy. Compose is optional.

Minimal options, in preference order:
1. Minimal `docker-compose.yml` containing **only** `wabi-server` + optional tunnel profiles
2. Direct `docker run` of the `wabi-server` image
3. Run the local `target/release/wabi-server` binary directly on the host

Pick the simplest unless the user explicitly requests a specific path. Do not leave orphan STDB-era compose sections on Tim.

## Rust-only validation protocol

When the user says **“test the crate,”** validate the full embedded-asset path, not just the API:

1. `cargo build --release -p wabi-server --features addons` succeeds
2. Run locally:
   ```bash
   mkdir -p /tmp/wabi-rust-test/data
   WABI_JWT_KEY=... WABIDB_ROOT_KEY=... ./target/release/wabi-server \
     --data-dir /tmp/wabi-rust-test/data --host 127.0.0.1 --port 3001
   ```
3. Prove UI serve, not just API:
   ```bash
   curl -sS http://127.0.0.1:3001/ | head
   ```
   Expect `<!doctype html>` from `index.html`, **not** `404`. If it 404s, the embedded SPA is broken.
4. `/health` and `/api/setup/status` returning 200 is necessary but not sufficient.

**Pre-fix for `/` returning 404:** confirm `frontend/build/` contains a proper SvelteKit static output (`index.html` + `_app/`), not just adapter-node outputs. Build command must produce static assets for `rust_embed` to bundle:
```bash
cd frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build
# Verify: ls frontend/build/index.html frontend/build/_app/immutable/assets/
```

## When to use

- Ship a new `wabi-server` binary / embedded UI to Tim (or another named host)
- Fresh install path (Minecraft-jar style) on a new box
- Decide CF vs CF-less / CGNAT networking
- Diagnose what is actually running vs what the checkout says

## Target architecture (Ronin `main` / current compose)

Canonical stack is **WabiDB only**:

| Layer | Tech | Notes |
|-------|------|-------|
| Frontend | SvelteKit static | `STATIC_BUILD=1 bun run build` → `frontend/build/` |
| Backend | Rust Axum `wabi-server` | bind-mounted `./target/release/wabi-server:/wabi-server:ro` |
| Engine | **WabiDB in-process** | no SpacetimeDB sidecar in current compose |
| Runtime image | **`FROM fedora:44`** | not Debian; verify live image before ABI tricks |
| Data | `./data/wabi-server` → `/data` | never rsync/wipe casually |
| Uploads | `./uploads` → `/app/uploads` | user content |
| Env | **`WABI_JWT_KEY`** + **`WABIDB_ROOT_KEY`** (64 hex chars) | compose refuses empty JWT; engine needs root key |
| Host port | **3001 → container 3000** | healthcheck is `:3000` *inside* container |
| Tunnels / CF / LiveKit / coturn | compose **profiles** | optional; not required for core |

Default: `docker compose up -d` starts **only** `wabi-server`.

There is **no** `wabi-backend` / `wabi-frontend` Node stack. STDB containers on a host mean **stale checkout**.

## Networking: CGNAT, calling, Cloudflare

**Default calling is WabiDB / Socket.IO relay over the same TCP path as the app** (WebSocket). It does **not** require open UDP ports, STUN/TURN, or a public CF edge to work between clients that can already reach the server.

| Need | CF required? |
|------|----------------|
| Users reach server on LAN / Tailscale / port-forward | **No** |
| Default voice/DM calls (wabidb transport) behind CGNAT | **No** — only reachability to host:3001 (or HTTPS reverse proxy) |
| Optional P2P / LiveKit SFU | May need TURN/UDP/open ports — **not** default |
| Pretty public hostname + hide home IP | CF optional |
| Mic/camera in browser on non-localhost | Need **secure context**: `https://` or `http://127.0.0.1` / `localhost` — LAN plain HTTP fails (`mediaDevices` undefined) |

**CF-less is a first-class install path:** run `wabi-server` (optionally Caddy + Let's Encrypt for real HTTPS). Unbind CF when testing that path (stop cloudflared / pause tunnel / DNS). Do not treat CF as the product.

## Install path (fresh host)

```bash
# 1. Clone current main
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi

# 2. Env (name must match compose)
openssl rand -base64 48   # use as WABI_JWT_KEY
cat > .env <<'EOF'
WABI_JWT_KEY=<paste openssl rand -base64 48>
WABIDB_ROOT_KEY=<paste openssl rand -hex 32>
WABI_PORT_OUT=3001
TURN_HMAC_KEY=<paste openssl rand -base64 32>
EOF

# 3. Build on a machine with bun + rust (or ship a prebuilt binary)
cd frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build && cd ..
# Verify static output: must see index.html + _app/, NOT handler.js/server/
ls frontend/build/
cargo build --release -p wabi-server --features addons

# 4. Runtime dirs
mkdir -p data/wabi-server uploads plugins

# 5. Start core only (no CF)
docker compose up -d wabi-server
# or: docker compose up -d

# 6. Verify
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3001/api/setup/status
```

Access: `http://127.0.0.1:3001` (calls work).  
Public/LAN IP over **http://** works for chat but **not** browser mic until HTTPS.

## Update path (existing WabiDB host)

See `references/tim-update-runbook.md` (commands-only).

Summary:

1. Live audit (containers, compose era, health)
2. `STATIC_BUILD=1` frontend build + verify static `frontend/build/`
3. `cargo build --release -p wabi-server --features addons` (**addons REQUIRED** — without it lore/webhooks routes are silently absent from the binary; if the previous binary also had addons, `touch core/addons/lore/backend/src/lib.rs` first so the feature-gated crate actually recompiles and the SHA changes)
4. `scp` binary to host bind-mount path
5. `docker compose stop wabi-server` → **`rm -f data/wabi-server/.lock`** → replace binary → `docker compose up -d wabi-server` (stale lock survives clean SIGTERM; see pitfall 6)
6. `curl` host `:3001/health`, `/` HTML 200, `/api/setup/status`, and optional public URL
7. **Auth smoke** (required): no postcard/`user_registered` corrupt logs; re-register known owner → **400 taken** not 200; wrong-password login → **401**. See `references/user-record-postcard-compat-and-owner-recovery.md`.

**Do not** `docker compose up --build` expecting a Rust compile — Dockerfile is runtime-only.

**Do not** use `docker cp` into the container — binary is host bind-mount.

**Do not** probe usernames with live `register` on production (creates junk accounts).

## Tim cutover note (historical; live as of 2026-07-17)

WabiDB cutover on Tim is **done** when live probe shows healthy `wabi-server` + WabiDB compose. Orphan STDB containers may still appear in `docker ps` — do not assume STDB-era solely from orphans; read compose header + health.

If Tim were still STDB-era (**no** healthy wabi-server): backup → sync tree → WabiDB compose first without tunnel → then Caddy/CF. Binary-swap alone onto STDB-era compose is still wrong. See `references/tim-wabidb-cutover-checklist.md`.

**Tunnel profile (post-cutover CF):** dual connectors `cloudflared-named` + `cloudflared-named-2` with `--protocol quic` (`references/wabichat-502-diagnosis.md`). Caddy service `caddy-tunnel` / container `wabi-tunnel-caddy` on `127.0.0.1:8088`; host file `Caddyfile.tunnel`. **WS caveat (pitfall 28):** quic tunnels strip the socket.io WS `Upgrade` header — if the app needs realtime WebSocket, prefer http2 connectors or ship the `transports:['websocket','polling']` fallback (pitfall 27); do not add quic connectors to "fix" WS.

## Remote hosts (scope exactly what user names)

| Host | SSH | Notes |
|------|-----|--------|
| Tim | `root@100.96.11.45` | production WabiDB; public via CF tunnel profiles. **Hostname `tim` does NOT resolve** — use the raw IP. |
| Ironin | `ironin@100.80.172.12` | `~/Documents/wabi` preferred clean tree |
| Iyoku | often unplugged / `100.104.166.42` | staging; skip if user says unplugged |
| Ronin | local | `/var/home/Ronin/wabi` |

Obey named scope. No drive-by Iyoku.

## Build gates and rust-embed UI verification

```bash
cd frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build
# static check: index.html + _app present; no handler.js/server outputs
ls frontend/build/index.html frontend/build/_app/immutable/assets/
```bash
cd frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build
# static check: index.html + _app present; no handler.js/server outputs
ls frontend/build/index.html frontend/build/_app/immutable/assets/
cargo check -p wabi-server
# REQUIRED: --features addons or ALL addon routes (lore, webhooks, payments) are absent
cargo build --release -p wabi-server --features addons
# Optional: prove embedded assets load
mkdir -p /tmp/wabi-rust-test/data
WABI_JWT_KEY=... WABIDB_ROOT_KEY=... ./target/release/wabi-server \
  --data-dir /tmp/wabi-rust-test/data --host 127.0.0.1 --port 3001 &
sleep 6
curl -sS http://127.0.0.1:3001/ | head
curl -sS http://127.0.0.1:3001/health
curl -sS http://127.0.0.1:3001/api/setup/status
kill %1 2>/dev/null || true
```
If `/` returns 404, `STATIC_BUILD=1` output is wrong/absent — `/health` alone is NOT proof of embedded assets.

## Full-tree sync (code only)

If live container is Fedora 44, prefer building on Fedora/Bazzite. Only use Debian bookworm builder if **live** image is Debian and Fedora binary crash-loops — see `references/tim-glibc-compatible-build.md` (historical note).

## Full-tree sync (code only)

Never sync `data/`, `uploads/`, `.env`, `target/` tree (except shipping the one binary), `node_modules/`.

```bash
rsync -az --delete \
  --exclude='data/' --exclude='uploads/' --exclude='.git/' \
  --exclude='target/' --exclude='node_modules/' --exclude='frontend/node_modules/' \
  --exclude='frontend/.svelte-kit/' --exclude='frontend/build/' \
  --exclude='logs/' --exclude='*.log' --exclude='.env' \
  ./ tim@100.96.11.45:~/Desktop/Wabi/
```

Then ship binary separately and restart.

## Tailscale SSH

Commands (`ssh`/`scp`/`rsync`) to Tim/Iyoku/ironin over Tailscale may hit the web-auth checkpoint and print `https://login.tailscale.com/a/<hash>`. The agent MUST proactively extract and hand over that raw URL — never just report "blocked"/"denied" and stop (2026-07-18 correction: I reported "blocked" and the user had to ask "supposed to send me the web auth"). Deterministic extraction technique + per-user URL behavior: `references/tailscale-ssh-auth.md`. After the user authorizes, retry the original command. Even after web-auth clears, `scp` to a raw `100.x` IP triggers a SEPARATE client-side command-approval prompt — a "BLOCKED" there is the consent guard, not Tailscale; re-issue the same command once the user is watching / says send. Do not claim deploy/ship success until the post-auth command actually runs and you verify (e.g. SHA match).

## Linked references

- `references/pre-deploy-live-stack-audit.md` — **required** before Tim/wabi.chat
- `references/tim-update-runbook.md` — commands-only update (WabiDB); lock-clear on every swap
- `references/user-record-postcard-compat-and-owner-recovery.md` — "owner killed" after deploy: postcard UserRecord V1 dual-decode, auth smoke, no register probes, change-password threat model
- `references/tim-wabidb-cutover-checklist.md` — STDB-era Tim → WabiDB cutover (backup, env keys, locks, CF vs origin)
- `references/wabichat-502-diagnosis.md` — public 502: origin-alive, **client-IP split**, dual cloudflared+quic, SOCKS egress test, compose service names
- `references/network-cgnat-and-cloudflare.md` — CF optional, calling, secure context, CF-less IP hide
- `references/frontend-deploy-cache-visibility.md` — SW / cache headers after UI ship
- `references/cloudflare-websocket-strip.md` — WS upgrade stripped by Cloudflare/cloudflared: curl 101-vs-200 probe, socket.io polling-fallback fix, quic-tunnel caveat
- `references/tailscale-ssh-auth.md` — browser auth flow + deterministic auth-URL extraction technique
- `references/backup-tarball-handoff.md` — archive/handoff only (no deploy): tar working tree incl. uncommitted changes, exclusions, scp to Tim, SHA verify
- `references/live-stack-verification.md` — inventory patterns

Repo human doc: `docs/NETWORKING.md` (LAN → Tailscale → domain/HTTPS → port-forward).

### Historical / archive only (STDB era — do not follow for new deploys)

- `references/stdb-source-reconciliation.md`
- `references/local-privacy-stdb-podman.md`
- `references/localdev-minimal-2proc.md` (STDB-shaped)
- `references/localdev-reset-and-bot-sandbox.md` (STDB reset)

Prefer real WabiDB local-dev: `scripts/local-dev.sh` / host binary + vite with `WABI_JWT_KEY` and current compose.

## Pitfalls

1. **Binary swap onto STDB Tim** — causes 502 / wrong stack. Audit first. Full recipe: `references/tim-wabidb-cutover-checklist.md`.
2. **Missing `STATIC_BUILD=1`** — Node adapter output; rust-embed useless; crash/stale UI.
3. **Wrong JWT env name** — compose wants `WABI_JWT_KEY`, not `JWT_SECRET` / `JWT_SIGNING_KEY` leftovers in old docs.
4. **Missing `WABIDB_ROOT_KEY`** — crash-loop: `validation failed for load_bootstrap_key`. Need 64 hex chars (`openssl rand -hex 32`) **and** list it under `environment:` so the container receives it (env_file alone is not reliable).
5. **`TURN_HMAC_KEY` required even when turn profile is off** — compose interpolates `${TURN_HMAC_KEY:?…}` for coturn; stub any base64 in `.env` so `compose up wabi-server` can parse the file.
6. **`engine already running` after stop/start** — WabiDB engine lock is at **`data/wabi-server/wabidb/.lock`** (VERIFIED 2026-07-19: removing only the top-level `data/wabi-server/.lock` did NOT clear the crash-loop "Error: engine already running"; removing the deeper `wabidb/.lock` did — the runbook already removes it). **Proactive on every Tim swap:** `rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock` between `docker compose stop wabi-server` and `up -d`. Do not wait for a crash-loop. (Older skill text claimed the `wabidb/.lock` path did not exist — that was wrong; this session proved it is the real engine lock.) This also applies to a full `docker compose stop` → `rm` → `up` cycle: a stale `wabidb/.lock` with no container running still makes the next start crash-loop, so always clear both before `up`.
7. **Origin healthy, public CF still 502** — not a binary deploy. Prove `:3001` + `:8088` on Tim, then public from **Ronin and Tim**. Recipe: `references/wabichat-502-diagnosis.md`. Bypass: `http://100.96.11.45:3001`.
8. **Client-IP / path split 502** (2026-07-17) — Tim public can be 200 while Ronin gets CF **Host Error** (~4s, `cfOrigin;dur≈4000`) with **zero** cloudflared log lines for the Ronin IP. SOCKS via Tim → 200. Single `docker restart cloudflared` is often incomplete. Durable: **two connectors** (`cloudflared-named` + `cloudflared-named-2`) with **`--protocol quic`**. Always re-verify the **user** path after tunnel changes.
9. **Compose names** — services `caddy-tunnel` / `cloudflared-named` (not only container names). Host file `Caddyfile.tunnel`. cloudflared is distroless (no `sh`); probe with sidecar curl on `wabi_default`.
10. **Curl 200 ≠ Zen works** — prove real browser load; SW/cache may stick Host Error after edge recovers (hard refresh / private window).
11. **`${VAR}` mangling** on compose writes — verify with `grep` / `docker compose config`.
12. **LAN HTTP mic** — need 127.0.0.1 or HTTPS.
13. **docker cp binary** — wrong; bind-mount only.
14. **Assuming Debian Tim** — Dockerfile is Fedora 44.
15. **Syncing data/** — can destroy live DB/tokens.
16. **Runtime block / denied** — not a refusal; with YOLO/go-ahead, brief ack and **retry the same command**. No multi-option stall menus. But distinguish the TWO distinct blockers: (a) Tailscale web-auth checkpoint → extract + surface the `login.tailscale.com/a/<hash>` URL (see `references/tailscale-ssh-auth.md`); never report "blocked" without the link. (b) Client-side command-approval prompt on raw-IP URLs → re-issue the same command once the user is watching. Both require a retry after the user acts, not abandonment.
17. **SPA 8317-byte 200 on junk paths** — wabi-server SPA fallback, not Caddy misconfig.
18. **`setupRequired:false` but nobody can log in / "owner killed"** — two distinct causes, both covered in `references/user-record-postcard-compat-and-owner-recovery.md`:
    - (a) **Postcard decode failure** (logs show `postcard`/`user_registered` corrupt): dual-decode missing for `UserRecord` → ship the V1 dual-decode fix, restart with lock clear.
    - (b) **Event absent from commit log** (logs CLEAN, login 401): the owner exists only in `projections/snapshot.json`, never as a durable `user_registered` event; the server replays the log only (not the snapshot), so every restart drops the owner. Diagnose with the **offline snapshot decode** (python recipe in the reference) + `bcrypt.checkpw` — proves the credential WITHOUT touching prod. Recovery = re-emit the owner's `user_registered` (id 1, snapshot hash) into the log. Verified incident 2026-07-19: owner `wabi`/`Please1` 401'd after a deploy restart; snapshot decode confirmed the record+password; the restart had dropped it because its event wasn't in the log.
19. **Never diagnose accounts with live `POST /api/auth/register` probes** — creates real users, can claim/overwrite owner on empty projection, leaves probe passwords on production. **Confirmed 2026-07-19 incident:** a `register wabi` probe (to test "is this username free?") created a NEW `wabi` with `user_id 2` because the live `users_by_name` index had no `wabi` (owner had been dropped by an event-log-missing restart). Result: a duplicate owner and an orphaned id 1. Diagnose with the **offline snapshot decode** instead (reference recipe) — no production mutation. If you already created a probe account, recover via the reference's recipe and do NOT leave the probe credential live.
20. **Do not casually delete `projections/snapshot.json`** on prod to force rebuild unless dual-decode is shipped and recovery is intentional.
21. **`STATIC_BUILD=1` is REQUIRED for the rust_embed SPA path — do NOT skip it.** The binary embeds `frontend/build` via `rust_embed` and serves pages through a `serve_static` SPA fallback that looks up `index.html`. The repo's `svelte.config.js` uses **adapter-node by default** (plain `bun run build` → `handler.js`/`server/`/`client/`, **no `index.html`**) and only emits `index.html` when built with `STATIC_BUILD=1` (adapter-static, `fallback: 'index.html'`). Shipping a plain-node build → **every page route 404s while `/health` still returns 200** (the only real route). Verified incident 2026-07-19: deployed a node-build binary, user got 404 on all pages, `/health` 200. Fix: `STATIC_BUILD=1 bun run build`, confirm `ls frontend/build/index.html`, then `cargo build --release -p wabi-server`. (This corrects older "do NOT require STATIC_BUILD=1" guidance — that was wrong for this rust_embed path and directly caused the 404 incident.)
22. **Tim `:3000/health` returns 000 from host** — the `wabi-server` container binds `0.0.0.0:3000` inside the container, but the **host loopback is not routed to it** (only the caddy tunnel / CF edge reaches it). A `curl http://127.0.0.1:3000/health` returning `000` on Tim is **expected, not a failure**. Verify health via the caddy tunnel (`http://127.0.0.1:8088/health` → 200) and/or public `https://wabi.chat/health` (200 from an external egress). `docker logs` "Server ready" + container "Up (healthy)" are also sufficient proof. (Verified 2026-07-19: swap deploy showed `:8088` 200, `:3000` 000, public 200.)
23. **`pkill -f 'cargo build --release'` kills the agent shell** — the cargo command runs inside a wrapper whose argv contains the pattern, so `pkill -f` matches the wrapper and terminates the agent's own terminal. Prefer `process(action='wait')` on the background build, or kill by exact PID; never `pkill -f` the build pattern while it's your own foreground/background task.
24. **Full fix→deploy chain when the user is awake** — when the user says "send to Tim and redeploy" / "fix this plus redeploy", that is ONE bundled go-ahead: fix → commit → (merge to `main` + push origin) → `bun run build` then `cargo build --release -p wabi-server` → scp binary → Tim stop/rm/lock-clear/up → health check. Execute the whole chain without re-listing steps or pausing for approval between stages. The standing "go ahead = autonomous" rule applies; the user explicitly bundling fix+deploy means do the full sequence inline (2026-07-19 correction: user said "you're thinking too much, I'm awake, chill out" after I re-listed the fixes instead of just shipping them).
25. **`n.subscribe is not a function` after rapid redeploys = stale cached chunk graph, NOT a build bug.** Two back-to-back binary swaps (one broken, one fixed) leave the user's browser with an `index.html` pointing at deploy #1's hashed chunks that deploy #2 replaced → a module evaluates `undefined` → store auto-subscription `.subscribe` throws. The `static.cloudflareinsights.com` beacon CSP error in the same console is a **red herring** (harmless blocked analytics). Diagnose headlessly against the LIVE site with Playwright (`npx playwright install chromium`; repro recipe in `references/frontend-deploy-cache-visibility.md`) — if the headless run shows 0 pageerrors but the user's browser throws, it is stale cache. Fix shipped 2026-07-19: `serve_static` sends `Cache-Control: no-cache` on `index.html`/`service-worker.js`. Unblock: one hard refresh. (Do NOT chase a phantom code bug here.)
26. **Stale auth-token bounce loop = client `localStorage`, NOT a server regression.** Symptom: main page flashes then bounces to `/login` with `session_expired`; `/api/user/settings` → 401. Cause: old token in `localStorage` from a prior server session; boot trusts it, socket is rejected, frontend clears session, loops. Prove server health with `curl -X POST /api/auth/guest` (returns 200 + token, no password). Unblock: clear site data (hard refresh alone does NOT clear localStorage). A `Cache-Control: no-cache` header does NOT prevent this — tokens live in localStorage, not the HTTP cache.
27. **socket.io `transports: ['websocket']` + Cloudflare strips the WS `Upgrade` = app never connects.** Symptom in browser console: `Firefox can't establish a connection to wss://…/socket.io/…` and the app sits disconnected. Root cause: socket.io client set to **WebSocket-only** (no polling fallback), while the Cloudflare→cloudflared→caddy hop drops the `Upgrade: websocket` header (proven 2026-07-19: caddy `:8088` returns `101 Switching Protocols` on a direct WS handshake, but the same request through `wabi.chat` returns `200` with no `101`; the tunnel/cloudflared strips the upgrade). **Fix:** set `transports: ['websocket', 'polling']` in the socket.io client (`frontend/src/lib/socketConnectionCore.ts`) so socket.io negotiates polling first then upgrades to WS when the transport allows it. Polling works through Cloudflare (engine.io handshake returns a session id + `upgrades:["websocket"]`), so the app connects regardless. Verify end-to-end: `curl` the polling handshake `https://wabi.chat/socket.io/?EIO=4&transport=polling` (expect `{"sid":…,"upgrades":["websocket"]}`) and a POST connect with an auth token (`40{"token":"…"}` → `ok`). After a deploy change, rebuild frontend `STATIC_BUILD=1` + release binary. NOTE: this is a frontend-transport config issue, NOT a server bug — do not chase the Rust binary for WS.
28. **cloudflared `--protocol quic` connectors break socket.io WebSocket (and contradict pitfall 8).** Pitfall 8 recommends quic tunnels for the 502 client-IP-split fix, but **quic tunnels also strip the WS `Upgrade` header** (same root cause as pitfall 27). If `wabi.chat` load-balances across both quic and http2 connectors, WS requests hitting a quic connector fail and the app disconnects — even though polling works. Verified 2026-07-19: removing the two orphan `cloudflared-named-2`/`-3` quic connectors (leaving only the http2 `cloudflared-named`) did NOT by itself restore WS (the http2 tunnel also stripped the upgrade in that incident), but the durable fix is `transports:['websocket','polling']` (pitfall 27) on the client. Net guidance: prefer **http2** connectors for socket.io-heavy apps; only use quic if the 502 client-split recurs AND you accept that native WS may need the polling fallback. Don't add quic connectors to "fix" WS — that makes it worse.
- `references/frontend-deploy-cache-visibility.md` — expanded: stale-chunk `n.subscribe` headless repro + stale-token bounce diagnosis.
- `references/cloudflare-websocket-strip.md` — NEW: WS-upgrade-strip diagnosis (curl 101 vs 200 probe), socket.io polling-fallback fix, quic-tunnel caveat.

## Production stop/restart

Stopping Tim `wabi-server` is a live outage. Need user intent for cutover. If the approval UI times out while the user said YOLO/continue, retry once rather than abandoning.

## Service worker / cache

After frontend deploys, verify hashed assets and cache headers (`references/frontend-deploy-cache-visibility.md`). Health 200 alone does not prove UI updated.
