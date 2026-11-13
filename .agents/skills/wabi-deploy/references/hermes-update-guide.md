# Hermes: Updating <host> And <staging-host> (Rust Stack)

Teaching-oriented walkthrough for pushing the Rust single-binary `wabi-server`
to <host>.  For commands-only, read `references/host-update-runbook.md` instead.
This one explains the *why* and the things that bite.

## The two hosts and what they're for

- **`<user>@<host>`** — live deployment target.  Receives the built
  Rust binary and a bind-mount restart.  Does not build locally.
- **`<user>@<staging-host>`** — synced staging machine.  Receives the full
tree so the binary can be built and tested natively if needed.

Both hosts keep the project at `<wabi-root>/` (capital W).

## What changed from the old stack

The previous runbook (pre-May 11 2026) described a Node backend (`wabi-backend`)
+ frontend (`wabi-frontend`) rebuilt inside docker on <host>.  That stack is
gone.

Current architecture:

- `wabi-server` — single Rust binary (Axum + embedded static frontend).
- Built **locally** on <dev-host> or Ronin's machine via `cargo build --release -p wabi-server`.
- Shipped to <host> via `scp`.
- Bind-mounted into a minimal debian container that only adds SSL certs.
- The container is stopped ─ binary copied ─ container restarted.

Services still running via docker compose on <host>:

- `wabi-spacetimedb` — STDB database
- `wabi-stdb-proxy` — Caddy reverse proxy for STDB
- `wabi-tunnel-caddy` — Caddy for Cloudflare tunnel
- `wabi-cloudflared-named` — Cloudflare tunnel client

Optional profiles (turn on with `docker compose --profile booster-full up -d`):

- `wabi-coturn` — TURN server
- `wabi-livekit` — LiveKit SFU
- `wabi-media-gateway` — SRT/media gateway

## Preflight

```bash
ssh <user>@<host> 'echo ok; ls -d <wabi-root>'
ssh <user>@<staging-host> 'echo ok; ls -d <wabi-root>'
```

Fix SSH/Tailscale before going further — there is no recovery path from a half-applied sync.

## Build locally

```bash
cd <wabi-root>

# 1. Frontend (required — binary embeds frontend/build/ at compile time)
cd frontend
STATIC_BUILD=1 bun run build
cd ..

# 2. Rust binary
cargo build --release -p wabi-server
```

If you skip the frontend build, the binary contains a stale `build/` folder
and <host>'s users see old UI even though the server logic is new.

## Sync the binary to <host>

```bash
scp target/release/wabi-server <user>@<host>:<wabi-root>/target/release/wabi-server
```

## Swap the binary on <host>

The running container locks the bind-mount.  Stop the container before writing
the new binary, then restart.

```bash
ssh <user>@<host> 'cd <wabi-root> && docker compose stop wabi-server'
# scp already overwrote the file while the container is stopped
ssh <user>@<host> 'cd <wabi-root> && docker compose up -d wabi-server'
```

**What not to do:**

- Do **not** `docker compose up --build wabi-server`.  The Dockerfile only
  installs `ca-certificates` + `libssl3` — it doesn't build the binary.
  `--build` wastes time rebuilding a 20 MB base image that never changes.
- Do **not** `cp` the new binary while the container is running.  The bind
  mount is locked and the write will fail or be ignored until restart.
  Old versions also corrupted the binary because Linux would page in the
  partially overwritten file.

## Restart tunnel if Caddyfile changed

`Caddyfile.tunnel` is bind-mounted read-only.  The container must be restarted
to pick up changes:

```bash
ssh <user>@<host> 'docker restart wabi-tunnel-caddy'
```

## Full-tree sync (non-binary changes)

If you changed frontend source, STDB bindings, compose files, or anything else
that isn't just the binary:

```bash
cd <wabi-root>
rsync -az --delete \
  --exclude='data/' \
  --exclude='uploads/' \
  --exclude='.git/' \
  --exclude='target/' \
  --exclude='node_modules/' \
  --exclude='spacetimedb/target/' \
  --exclude='frontend/node_modules/' \
  --exclude='frontend/.svelte-kit/' \
  --exclude='frontend/build/' \
  --exclude='logs/' \
  --exclude='.env' \
  ./ <user>@<host>:<wabi-root>/
```

After a full-tree sync, rebuild the binary locally and swap it on <host> as
shown above.

## Verify <host>

```bash
# Container state
ssh <user>@<host> 'docker compose ps wabi-server'

# Health endpoint
ssh <user>@<host> 'curl -fsS http://127.0.0.1:3001/health'

# Frontend response
ssh <user>@<host> 'curl -I http://127.0.0.1:3001'
```

Expected: `wabi-server` status `Up ... (healthy)`, `/health` returns 200,
and `/` returns the HTML shell.

## Gotchas (real ones that have bitten us)

### Shadow directory (`<wabi-root>/` vs `~/wabi/`)

`docker compose` uses the basename of the working directory as the project
name (`wabi`).  If both `Wabi/` and `wabi/` exist, containers get
bind-mounts from whichever was last `up`'d.  Keys drift, tokens go stale.
Verify mounts with `docker inspect wabi-server | grep Source`.

### STDB token / fingerprint mismatch

After a republish, the publisher JWT in
`data/stdb-publisher-config/cli.toml` must be copied into `.env` as
`WABI_STDB_AUTH_TOKEN`.  Symptom: backend logs
`TokenError(Error(InvalidSignature))`.  Fix in `references/host-update-runbook.md`
under "STDB Token/Fingerprint Gotcha".

### Wiping STDB state

If you `rm -rf data/spacetimedb/`, you **must** also wipe
`data/stdb-publisher-config/`.  They are a matched pair.  Orphaning one
leaves an identity the other cannot authenticate, and republish returns
`403 Forbidden ... not authorized`.

### `docker cp` vs bind-mount

An older deploy method used `docker cp bin wabi-server:/app/wabi-server`
followed by `docker restart`.  This is now the wrong approach — the compose
file uses a **volume mount** (`./target/release/wabi-server:/wabi-server:ro`),
not an embedded file.  `docker cp` would be overwritten on the next compose
restart because docker re-applies volume mounts.  Always write the binary
to the host path (`<wabi-root>/target/release/wabi-server`) and let
compose bind-mount it.

### Sudo password piping blocked

Fully automated deploy steps that pipe passwords to `sudo -S` are blocked by
guardrails (security policy rejects brute-force attack vector).  This means
automatic package installs or reboots on remote machines are not possible.
Either pre-configure passwordless sudo, or accept that those steps require
manual user action.

## Rollback

If the new binary breaks the live stack:

```bash
# On <host> — restore the previous binary if you saved it
ssh <user>@<host> 'cd <wabi-root> && cp target/release/wabi-server.bak target/release/wabi-server'
ssh <user>@<host> 'cd <wabi-root> && docker compose restart wabi-server'
```

Or, if you didn't save a backup, build the old version locally and re-scp.

## When in doubt

`references/host-update-runbook.md` is the canonical commands-only doc.  If this
guide and the runbook disagree, the runbook wins and this file is stale —
please update it.

## Historical note before May 11, 2026

Before the Rust cutover, <host> ran a Node backend (`wabi-backend`) rebuilt
inside docker with `docker compose up -d --build`.  The old commands and
compose profiles are no longer valid.  If you see references to
`docker-compose-wabi-node.yml` or `docker compose --profile tunnel up`,
they are from that era and will fail on the current stack.  The only
required compose operations today are `stop wabi-server` / `up -d wabi-server`
for binary swaps, or `restart wabi-tunnel-caddy` for config changes.
