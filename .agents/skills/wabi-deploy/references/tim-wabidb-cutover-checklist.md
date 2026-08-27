# Tim STDB → WabiDB cutover checklist (2026-07-15)

Session-proven sequence. Re-probe before repeating; live state drifts.

## Signals Tim is still STDB-era

- `docker-compose.yml` header mentions SpacetimeDB / has `spacetimedb:` service
- `docker ps` shows `wabi-stdb-proxy` / cloudflared / tunnel caddy but **no healthy `wabi-server`**
- Binary mtime ancient; `curl :3001/health` connection refused
- Public `https://wabi.chat` → **502** while tunnel containers “Up”

## Do not

- Binary-swap onto STDB-era compose and call it done
- rsync `data/` or overwrite `.env` without backup
- Assume CF health == origin health

## Sequence that worked

1. **Backup on Tim**  
   `~/Desktop/wabi-pre-wabidb-cutover-<stamp>/` with compose, `.env`, full `data/`, `docker-ps.txt`.

2. **Build on Ronin**  
   - `STATIC_BUILD=1 bun run build` → static `frontend/build/` (index.html + `_app`, not handler.js)  
   - `cargo build --release -p wabi-server`  
   - Dockerfile target is **fedora:44**; GLIBC up to 2.39 OK for Fedora runtime.

3. **Rsync code only**  
   Exclude: `data/`, `uploads/`, `.env`, `target/`, `node_modules/`, `.git/`, frontend build artifacts.

4. **Ship binary**  
   `scp …/wabi-server` → `~/Desktop/Wabi/target/release/wabi-server`.

5. **`.env` minimum (WabiDB)**  
   ```
   WABI_JWT_KEY=<openssl rand -base64 48>
   WABIDB_ROOT_KEY=<openssl rand -hex 32>   # 64 hex chars
   WABI_PORT_OUT=3001
   TURN_HMAC_KEY=<openssl rand -base64 32>  # required by compose interpolation even if turn profile off
   # optional: CLOUDFLARE_TUNNEL_TOKEN=… for later
   ```
   Keep old env as `.env.stdb-era-backup`.

6. **Compose must pass root key into container**  
   ```yaml
   - WABIDB_ROOT_KEY=${WABIDB_ROOT_KEY:?…}
   ```
   env_file alone is not enough if the var is not listed under `environment:`.

7. **Stop STDB leftovers** (leave CF until user detaches)  
   `docker stop wabi-stdb-proxy wabi-spacetimedb wabi-stdb-publisher` (and old server if any).

8. **Build image + start core**  
   `docker compose build wabi-server && docker compose up -d wabi-server`

9. **If crash-loop**  
   - `WABIDB_ROOT_KEY not set` → add key + recreate container  
   - `engine already running` → `docker compose stop wabi-server` then delete `data/wabi-server/**/.lock`  
   - `TURN_HMAC_KEY missing` → stub in `.env` (compose evaluates all services)

10. **Verify origin (authoritative)**  
    ```bash
    curl -fsS http://127.0.0.1:3001/health
    curl -fsS http://127.0.0.1:3001/api/setup/status   # often setupRequired:true on fresh DB
    docker logs wabi-server --tail 40
    ```

11. **CF optional**  
    Host `:8088` (tunnel caddy) → `wabi-server:3000` can be healthy while **public CF still 502**. Fix ingress separately or CF-less via Tailscale `http://100.96.11.45:3001`.

## Data note

Fresh `data/wabi-server` is a **new** WabiDB. Old STDB under `data/spacetimedb` is not auto-migrated; keep the pre-cutover backup.

## Approval / YOLO

If a multi-step Tim stop/start is denied because the user was away, **retry once** with standing permission — do not invent a "user refused cutover" story without an explicit no.

**Do not turn a denied command into a multi-option menu and wait** (Ronin 2026-07-17). A runtime block is not a user refusal — it will clear on retry. Acknowledge the block once, briefly (one line, not a paragraph), then re-issue the same command. Do NOT type out a 4-option "go / go no-exec / just restart / specific instructions" menu and explain you'll wait for direction — the user read that as "throwing a tantrum." Do NOT split the batch to hedge ("is it the `docker exec cat Caddyfile` subcommand you don't want?"). Do NOT treat a clean "yes go ahead" reply as needing further branching unless the user explicitly overrides the planned command. Right rhythm: brief stop → retry → continue the workflow that was already approved.

## 502 with origin alive (post-cutover diagnosis)

After cutover, a wabi.chat 502 is rarely an origin problem. See `references/wabichat-502-diagnosis.md` for the full recipe: confirm origin 200 on Tim (`wabi-server` :3001 + Caddy :8088), confirm Caddyfile is the clean single-line `reverse_proxy wabi-server:3000`, check cloudflared PID start time vs container "Up" duration for the re-registration smoking gun, `docker restart wabi-cloudflared-named` to force edge re-registration. Do NOT scp a new binary when public 502 has a healthy origin.
