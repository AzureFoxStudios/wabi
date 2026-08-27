# Pre-deploy live stack audit (mandatory)

Use this **before** shipping a binary to Tim / claiming wabi.chat is updated.

## Why this exists

The deploy skill describes the **target** WabiDB architecture (single binary, Fedora 44 image, no STDB). Live Tim can still run an older checkout for weeks. Blindly following “scp + compose stop wabi-server + up” when Tim’s compose is still STDB-era will fail or brick the tunnel path.

Ronin (2026-07-15): *do not blindly trust the skill; verify critical things changed.*

## Local tree (source of truth for *what you are about to ship*)

```bash
# Compose era
head -15 /var/home/Ronin/wabi/docker-compose.yml
grep -E 'spacetimedb|wabidb|data/wabi-server|WABI_JWT_KEY|FROM ' \
  /var/home/Ronin/wabi/docker-compose.yml \
  /var/home/Ronin/wabi/core/crates/wabi-server/Dockerfile | head -40

# Embed path still valid?
grep -n 'RustEmbed\|folder =' /var/home/Ronin/wabi/core/crates/wabi-server/src/main.rs | head

# Git identity of the tree
cd /var/home/Ronin/wabi && git rev-parse HEAD && git status -sb | head
```

**Current local facts (2026-07):**
- Dockerfile: `FROM fedora:44` (not Debian bookworm)
- Data mount: `./data/wabi-server:/data`
- JWT env: `WABI_JWT_KEY`
- No SpacetimeDB service in canonical compose

## Remote probe (what is actually running)

Prefer Tailscale SSH if plain `ssh` hangs:

```bash
# Reachability
tailscale status | grep -iE 'tim|100.96'
# Probe (BatchMode first; if auth URL appears, show raw URL and wait)
ssh -o ConnectTimeout=15 -o BatchMode=yes tim@100.96.11.45 'hostname'
# or
tailscale ssh tim@100.96.11.45 -- 'hostname'
```

On Tim:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
head -25 ~/Desktop/Wabi/docker-compose.yml
ls -lh ~/Desktop/Wabi/target/release/wabi-server 2>/dev/null
# Health (host-mapped port is often 3001; container internal is 3000)
curl -fsS -m 3 http://127.0.0.1:3001/health; echo
curl -fsS -m 3 http://127.0.0.1:3000/health; echo
```

Public:

```bash
curl -fsS -I --max-time 15 https://wabi.chat/ | head -15
```

## Decision matrix

| Live Tim signal | Meaning | Action |
|-----------------|---------|--------|
| `wabi-server` Up (healthy) + compose has WabiDB/`data/wabi-server` + no STDB service | Aligned with skill | Binary swap workflow OK after STATIC_BUILD + release build |
| STDB containers present, no `wabi-server`, compose still “Rust + STDB” | **Stale host tree** | **Cutover plan first**: rsync WabiDB compose + binary + frontend build process, migrate data story, env `WABI_JWT_KEY`, do **not** only scp binary |
| Tunnel up but local health fails + public 502 | Origin dead, tunnel still advertised | Fix origin stack; restarting only cloudflared is not enough |
| Binary mtime months old vs local HEAD recent | Host never got last deploys | Full ship after audit |

## Binary ABI note (update 2026-07)

- **Canonical Dockerfile is Fedora 44**, not Debian slim.
- Older skill text said “Tim is Debian-based → always bookworm-build.” That was for a prior crash-loop observation; **re-check the image actually used on Tim** (`docker inspect wabi-server --format '{{.Config.Image}}'` or compose Dockerfile path).
- If Tim still runs an old Debian-era image, bookworm-build may still matter; if Tim uses the Fedora 44 Dockerfile, prefer building on Fedora/Bazzite or a Fedora-based builder and verify `strings … \| grep GLIBC` against the container.

## Safe binary-swap sequence (only if audit = aligned)

1. `STATIC_BUILD=1` frontend build; confirm static `_app/` + `index.html` (not `handler.js`).
2. `cargo build --release -p wabi-server` (or ABI-matched container build per probe).
3. `scp` binary to `~/Desktop/Wabi/target/release/wabi-server`.
4. `docker compose stop wabi-server` → confirm file replaced → `up -d wabi-server`.
5. Verify: container healthy, `curl http://127.0.0.1:3001/health`, `curl -I https://wabi.chat`.

## What never to do

- Deploy without live `docker ps` + compose header check
- Assume STDB sections of old runbooks still apply to production
- Sync `data/` or wipe host DB without explicit user order
- Claim wabi.chat updated after only local build success
- Treat skill prose as live inventory

## Related

- `references/tim-update-runbook.md` — commands-only swap (still requires this audit first)
- `references/live-stack-verification.md` — deeper inventory patterns
- `references/tim-glibc-compatible-build.md` — ABI build recipes when container is older than host glibc
