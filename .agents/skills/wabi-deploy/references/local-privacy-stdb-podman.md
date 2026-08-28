# Wabi local privacy-first SpacetimeDB compose on Bazzite/Podman

Use this when restoring or verifying Wabi real localdev with split durable/ephemeral SpacetimeDB modules.

## BSL Additional Use Grant: two STDB instances are allowed

Wabi's privacy architecture is "default/privacy-first mode must keep
ephemeral call/media STDB separate from durable core STDB." This
requires running **two SpacetimeDB instances** per Wabi server
deployment: one for durable state (`wabi_state_bridge`), one for
ephemeral call/media coordination (`wabi_call_state_bridge`).

This is permitted under the SpacetimeDB BSL 1.1 license. The
Additional Use Grant states:

> "You may make use of the Licensed Work provided your application
> or service uses the Licensed Work with no more than one
> SpacetimeDB instance in production and provided that you do not
> use the Licensed Work for a Database Service."

Wabi is the application. Each STDB instance is a separate
deployment of the Licensed Work for that application. The grant
is per-instance, not a hard cap on the application's instance
count. Both instances are covered. The "no Database Service"
restriction is not violated — Wabi is a self-hosted tool, not a
multi-tenant hosted STDB offering.

**Pin a specific STDB version on both instances.** Self-hosting both
from the same GitHub release is the simplest path. Version drift
between the durable and media instances is a real risk. As of
2026-06-18, pin **v1.12.0** on both — it's the last 1.x, mature,
supports binary columns for voice/media payloads, and is
self-hostable from source. The 2.x upgrade is a separate
workstream, deferred until fracture work and basic call
functionality ship.

The 2.0 launch's "audio/video streamed through the database"
demo uses the same architecture (`Vec<u8>` binary columns with
subscription-based real-time delivery) that v1.12.0 supports.
The 2.0 performance improvements (V8 threading fix, 304k TPS
on the transfer benchmark) are real but not load-bearing for
Wabi's workload (1k TPS peak). Pinning v1.12.0 does not foreclose
using STDB for voice media.

## Privacy-first module shape

Default/private mode keeps call/media coordination out of durable server state:

- `spacetimedb/wabi_state_bridge`: durable core/community state only.
  - Expected reducers: `set_ingest_key`, `ingest_wabi_event`.
  - Should not include call/session/signal tables.
- `spacetimedb/wabi_call_state_bridge`: ephemeral call/media coordination only.
  - Expected tables: `state_call_session`, `state_call_participant`, `state_call_signal`.
  - Expected reducers: `call_session_create`, `call_session_join`, `call_session_leave`, `call_session_end`, `call_signal_emit`.

Do not copy a unified call-enabled STDB module wholesale as the ephemeral module if it also contains durable tables. Extract/create a minimal call module instead.

**TTL is the architectural privacy guarantee for ephemeral media.** Every table in `wabi_call_state_bridge` should have a `purge_after` column. A scheduled reducer purges rows where `purge_after < now()`. For live call audio frames: TTL = call end + 5 minutes. For voice notes: TTL = transcript generated + 1 minute. For screen share: TTL = call end + 5 minutes. Server-admin configurable (off / 1 min / 5 min / 15 min / 1 hour) but the schema enforces it on every insert.

## Bazzite/Podman setup notes

On Ronin, Docker socket access may be unavailable to the user even when Podman is present. Prefer `podman-compose` for local Wabi compose.

Install path on Bazzite/rpm-ostree:

```bash
sudo rpm-ostree install podman-compose
systemctl reboot
podman-compose --version
```

Because Podman short-name resolution cannot prompt in non-TTY agent runs, compose images should be fully qualified:

```yaml
image: docker.io/clockworklabs/spacetime:latest
image: docker.io/library/caddy:2
```

## Compose shape for rootless Podman

SpacetimeDB containers run as user `spacetime` inside the image. On rootless Podman, normal `:z` bind mounts can pass SELinux relabeling but still fail host-volume ownership. Symptoms:

- SpacetimeDB process spins at high CPU and never listens.
- `curl http://127.0.0.1:3030/v1/ping` resets/refuses.
- Logs may only show `Saving config to /home/spacetime/.config/spacetime/cli.toml.`
- A persistent smoke test may show `Permission denied (os error 13) at path "/var/lib/spacetimedb/.tmp..."`.

Use `:Z,U` for writable SpacetimeDB data/config volumes so Podman relabels and shifts ownership for the container user:

```yaml
volumes:
  - ./data/spacetimedb:/var/lib/spacetimedb:Z,U
  - ./data/spacetimedb-config:/home/spacetime/.config/spacetime:Z,U
  - ./data/call-spacetimedb:/var/lib/spacetimedb:Z,U
  - ./data/call-spacetimedb-config:/home/spacetime/.config/spacetime:Z,U
```

For publisher config dirs, also use `:Z,U` because `spacetime server add` / `login` writes under `/home/spacetime/.config/spacetime`:

```yaml
volumes:
  - ./data/stdb-publisher-config:/home/spacetime/.config/spacetime:Z,U
  - ./data/call-stdb-publisher-config:/home/spacetime/.config/spacetime:Z,U
```

Keep module source mounts readable by the container. If a module was created by a file-writing tool with `0600` modes, the publisher user may fail with bare `Permission denied (os error 13)`. Normalize to `0644` for source files:

```bash
chmod 644 spacetimedb/wabi_call_state_bridge/Cargo.toml \
  spacetimedb/wabi_call_state_bridge/README.md \
  spacetimedb/wabi_call_state_bridge/src/lib.rs
```

SpacetimeDB 2.5 defaults to an 8GiB page pool. In local rootless compose, prefer explicit smaller dev memory and non-interactive mode:

```yaml
command:
  ["start", "--listen-addr", "0.0.0.0:3000", "--data-dir", "/var/lib/spacetimedb", "--non-interactive", "--page_pool_max_size", "268435456"]
```

Publishers should not build into the bind-mounted module source directory. Set a writable container-local target dir:

```yaml
environment:
  - CARGO_TARGET_DIR=/tmp/cargo-target
```

Otherwise `spacetime publish --module-path /module ...` may fail with:

```text
error: Permission denied (os error 13) at path "/module/target..."
```

## Compose command shape

From `/var/home/Ronin/wabi`:

```bash
WABI_STDB_BRIDGE_DATABASE=wabi-state-local \
WABI_CALL_STDB_DATABASE=wabi-call-state-local \
podman-compose up -d \
  spacetimedb stdb-publisher stdb-proxy \
  call-spacetimedb call-stdb-publisher call-stdb-proxy \
  wabi-server
```

Use `$${VAR}` inside compose `command:` scripts when the container shell, not host Compose interpolation, must expand the variable:

```yaml
spacetime publish --module-path /module --server wabi-local "$${WABI_STDB_BRIDGE_DATABASE}" --yes
spacetime publish --module-path /module --server wabi-call-local "$${WABI_CALL_STDB_DATABASE}" --yes
```

Avoid `podman-compose up -d --force-recreate <publisher>` for just a publisher rerun: it may try to recreate dependencies and collide with existing named containers. Prefer removing/recreating the one publisher container, or plain `podman-compose up -d <publisher>` after ensuring dependencies are healthy.

## Verification gates

Static/build gates:

```bash
docker compose config --services || podman-compose config --services
cargo check --manifest-path spacetimedb/wabi_call_state_bridge/Cargo.toml
cargo check --manifest-path spacetimedb/wabi_state_bridge/Cargo.toml
cargo check -p wabi-server
bun run --cwd frontend check
STATIC_BUILD=1 bun run --cwd frontend build
cargo build --release -p wabi-server
```

Runtime health probes after compose starts:

```bash
curl -fsS http://127.0.0.1:3030/v1/ping   # direct core STDB
curl -fsS http://127.0.0.1:3031/v1/ping   # direct call/media STDB
curl -fsS http://127.0.0.1:3100/v1/ping   # core proxy
curl -fsS http://127.0.0.1:3101/v1/ping   # call/media proxy
curl -fsS http://127.0.0.1:3001/health    # Wabi server
```

Publisher success signals:

```text
Created new database with name: wabi-state-local
Created new database with name: wabi-call-state-local
```

If the STDB servers/proxies are healthy but `wabi-server` exits, check publisher completion first. The server may start before both expected databases/modules exist.

## Debugging unhealthy SpacetimeDB containers

If SpacetimeDB containers stay unhealthy, inspect non-destructively before changing architecture:

```bash
podman ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
podman logs --tail=120 wabi-spacetimedb
podman logs --tail=120 wabi-call-spacetimedb
podman inspect --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} exit={{.State.ExitCode}}' wabi-spacetimedb wabi-call-spacetimedb
```

If permitted, inspect inside the container:

```bash
podman exec wabi-spacetimedb sh -lc 'whoami; id; ps aux; command -v spacetime; command -v wget; wget -S -O- http://127.0.0.1:3000/v1/ping 2>&1 | head -80 || true'
```

A useful isolation sequence:

```bash
# In-memory smoke: verifies image + port can work.
podman run -d --name wabi-stdb-smoke -p 127.0.0.1:3999:3000 \
  docker.io/clockworklabs/spacetime:latest \
  start --listen-addr 0.0.0.0:3000 --in-memory --non-interactive --page_pool_max_size 268435456
curl -fsS http://127.0.0.1:3999/v1/ping

# Persistent smoke with rootless ownership fix.
rm -rf /tmp/wabi-stdb-smoke-data-u && mkdir -p /tmp/wabi-stdb-smoke-data-u
podman run -d --name wabi-stdb-smoke-persistent-u -p 127.0.0.1:3997:3000 \
  -v /tmp/wabi-stdb-smoke-data-u:/var/lib/spacetimedb:Z,U \
  docker.io/clockworklabs/spacetime:latest \
  start --listen-addr 0.0.0.0:3000 --data-dir /var/lib/spacetimedb --non-interactive --page_pool_max_size 268435456
curl -fsS http://127.0.0.1:3997/v1/ping
```

If `podman exec` inspection is needed and an approval denial appears inconsistent with the user's messages, stop and ask/retry only after the user explicitly says it was accidental. Do not treat accidental missed approvals as architectural failure.
