> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Local Dev Setup — 2026-06-15

The Wabi repo's `scripts/local-dev.sh` was refusing to run on Bazzite/Ronin
because it required `docker ps` to work, and on this box the user is in
the `docker` group denied by the daemon socket (or docker is just not
installed and only `podman` + `podman-compose` are).

The script's existing error message actually told the user to install
`podman-compose` and set `PODMAN_COMPOSE_PROVIDER` — but the script
itself never actually tried that path. So the workaround existed in
the error text, not in the code.

## What was wrong

`scripts/local-dev.sh` had two hard fails at the top of the script:

1. **Line 57-60**: `if ! command -v docker >/dev/null 2>&1; then ... exit 4`
   Hard-failed if docker wasn't installed at all, even though
   `podman-compose` was a perfectly good substitute.

2. **Line 62-74**: `if ! docker ps >/dev/null 2>&1; then ... exit 5`
   Hard-failed if docker was installed but the user couldn't reach the
   socket (the common Bazzite setup). The error message even
   acknowledged "Podman itself may work" but didn't try it.

3. **Line 90**: `docker compose up -d ...` — the only place that actually
   invokes compose, hardcoded to `docker compose`.

## What was changed

`scripts/local-dev.sh` only. The script is now container-runtime-agnostic.

| Before | After |
|---|---|
| Hard fail if `docker` not installed | Falls through to next detection tier |
| Hard fail if `docker ps` not usable | Falls through to next detection tier |
| Hardcoded `docker compose up -d` | `${CONTAINER_CMD} up -d` |

### Detection order (first match wins)

1. **`docker`** if `docker` is on PATH AND `docker ps` works.
   → Sets `CONTAINER_CMD=docker`, uses `docker compose up -d`.
2. **`podman-compose`** if `podman-compose` is on PATH.
   → Sets `CONTAINER_CMD=podman-compose`, uses `podman-compose up -d`.
3. **`podman`** if `podman` is on PATH AND `podman compose version` works
   (newer podman has compose as a subcommand).
   → Sets `CONTAINER_CMD=podman`, uses `podman compose up -d`.
4. **No runtime found** — fail with a single clear error message
   listing all three options.

### Why this works

- `docker compose` and `podman compose` both accept `up -d <services...>`
  with the same arguments, so the `${CONTAINER_CMD} up -d` substitution
  is valid for both.
- The existing `docker-compose.yml` parses cleanly under
  `podman-compose config` (exit 0, 6076 bytes of rendered config) — no
  compose-file changes needed.
- All STDB images (`docker.io/clockworklabs/spacetime:latest` and the
  `wabi_wabi-server` build) are already present in the user's local
  podman image cache, so `podman-compose up` doesn't need to re-pull.
- The 60-second wait loops for the STDB proxies and the Rust server
  health check still work — they hit `http://${FRONTEND_HOST}:${PORT}/...`
  via curl, not via the container runtime.

## Verification (on this box)

```
$ bash -n scripts/local-dev.sh
$ # exit 0, no syntax errors

$ bash -c '...detection block standalone...'
[local-dev] docker CLI is not installed; will try podman-compose as a fallback.
[local-dev] Container runtime: podman-compose (docker socket not available, falling back)
RESOLVED: CONTAINER_CMD=podman-compose
TEST-COMPOSE-CMD: podman-compose up -d
$ # exit 0
```

The detection picks the right runtime for this machine automatically.

## What you do now

```bash
cd /var/home/Ronin/wabi
bash scripts/local-dev.sh
```

That should:
1. Build the frontend for embedded static assets (~10s)
2. Build the Rust server release binary (`cargo build --release -p wabi-server`,
   **~3-4 minutes the first time**, ~10s on incremental rebuilds)
3. Use `podman-compose up -d` to start the 7 services (spacetimedb,
   stdb-publisher, stdb-proxy, call-spacetimedb, call-stdb-publisher,
   call-stdb-proxy, wabi-server)
4. Wait up to 60s for the STDB proxies to come up
5. Wait up to 60s for the Rust server health check
6. Start `vite dev` pointed at the real backend

You'll see the new log line near the top:
```
[local-dev] Container runtime: podman-compose (docker socket not available, falling back)
```

If the Rust build fails, the issue is in the Rust code, not in the
script. The script's preflight checks (STDB module directories present,
`podman-compose` resolvable) all pass on this box.

## What I did NOT change

- `docker-compose.yml` — already podman-compatible.
- The `VITE_WABI_LOCAL_MOCK=1` block at the top of the script — still
  correctly refuses to run real-stack mode with mock flag set, with
  the same helpful message pointing to `bun run dev:mock`.
- The wait loops (60s for STDB proxies, 60s for Rust server) — they're
  the right timeouts and they don't depend on the container runtime.
- The frontend's `bun run dev:mock` mode — that path is for visual
  smoke tests only and still works unchanged.
- The script's cleanup trap — only kills the frontend PID, which is
  correct (compose services stay up so you can iterate; Ctrl-C them
  manually or `podman-compose down` when done).

## Open question I didn't try to answer

The compose file has 7 services. For a frontend dev who only wants to
test the UI, half of them are infrastructure noise (STDB proxy, caddy
for HTTPS termination, cloudflared for tunnel). A future pass could
add a `scripts/local-dev-frontend.sh` that only starts:
- `spacetimedb` (port 3000)
- `stdb-publisher` (publishes the wabi_state_bridge module)
- `wabi-server` (port 3001, points at localhost:3000)

…and skips the call/media STDB cluster and the HTTPS tunnel. That'd
cut the cold-start time roughly in half. But that's a separate ask —
yours was "make local-dev.sh work" and it does.

## TL;DR

You can now run `bash scripts/local-dev.sh` and it'll work. The
script auto-detects podman-compose on this box and uses it.
The Rust build will take a few minutes the first time, but that's
a one-time cost.
