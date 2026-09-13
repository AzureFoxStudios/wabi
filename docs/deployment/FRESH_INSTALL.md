# Fresh Install

**Status:** canonical clean single-Authority install  
**Updated:** 2026-09-14

Start with one boring Wabi Authority on localhost. Do **not** begin by enabling old mesh/STDB settings, experimental replication, tunnels, or every optional media helper at once.

WabiDB is embedded in `wabi-server`; there is no SpacetimeDB service in the normal stack.

## Prerequisites

Recommended path:

- Git
- Docker with Compose support, or Podman + Compose

For source/native development, also install the repository's pinned Rust toolchain and frontend tooling.

## 1. Clone and start

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
docker compose up -d --build
```

The default Compose stack starts only `wabi-server`.

You do **not** need to create `.env` just to boot a local server. When not supplied through the environment, first boot generates/persists required server secrets under `./data/wabi-server`.

Open:

```text
http://localhost:3001
```

Create the first/owner account.

## 2. Verify the Authority before adding anything else

```bash
curl -f http://localhost:3001/livez
curl -f http://localhost:3001/readyz
```

- `/livez` — process liveness.
- `/readyz` — stronger application readiness; use this before declaring the server healthy.

Also verify a real client flow: log in, open/create a channel, send/read representative content, and reload.

If the Authority is not ready locally, adding a tunnel, TURN server, or second machine only makes debugging harder.

## 3. Understand your data before exposing the server

The default host state lives under:

- `data/wabi-server/` — WabiDB and persisted core secrets;
- `uploads/` — uploaded files;
- `plugins/` — runtime plugins, if you use them.

Before the server becomes important, read [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) and take a baseline stopped-server backup.

The WabiDB root key is part of the recovery boundary. Do not lose it or casually replace it.

## 4. Optional explicit configuration

If you want to manage secrets/settings yourself:

```bash
cp .env.example .env
```

Review the example and set only the values you actually need.

Do not copy old STDB/mesh environment blocks from historical deployment notes into a new WabiDB install.

In particular:

- do not enable legacy `WABI_MESH_ENABLED` as a path to HA;
- do not set WabiDB peer replication merely because you want a backup;
- experimental replication requires an explicit experimental gate by design;
- keep plugin mode disabled if you do not need runtime plugins.

## 5. Choose one access path

Only after localhost works, choose how users will reach the Authority.

### LAN / private VPN

Simplest for trusted/local groups. Use LAN, WireGuard, Tailscale/Headscale, or equivalent.

### Public HTTPS

Put Caddy/nginx/Traefik or another TLS reverse proxy in front of Wabi. A public origin should use HTTPS.

### Cloudflare Tunnel

Optional convenience profile; not required by Wabi.

Quick tunnel example:

```bash
docker compose --profile tunnel --profile tunnel-quick up -d
```

Named tunnel example after setting `CLOUDFLARE_TUNNEL_TOKEN`:

```bash
docker compose --profile tunnel --profile tunnel-named up -d
```

### Tailcat private access

Optional private-access transport for supported desktop/Tauri clients. Enable it intentionally after the normal server is healthy. It grants reachability, not Wabi membership.

See [../features/PRIVATE_ACCESS_GUIDE.md](../features/PRIVATE_ACCESS_GUIDE.md).

For the full decision tree, see [../NETWORKING.md](../NETWORKING.md).

## 6. Optional call/media helpers

Do not run every media service by default.

### coturn

If your selected call/WebRTC path needs TURN, set the required TURN configuration and start the profile:

```bash
docker compose --profile turn up -d
```

See [TURN_SETUP.md](TURN_SETUP.md).

### LiveKit SFU

Only enable the `sfu` profile when you intentionally configure that path.

### SRT media gateway

Only enable the `srt-gateway` profile when that media-ingest workflow is needed.

## 7. Another independent Wabi community

Run another independent Authority with its own data directory/domain/secrets. Do **not** connect databases just because one client will display both servers.

The client multi-server model is not federation. See [../architecture/WABI_MULTI_SERVER_ARCHITECTURE.md](../architecture/WABI_MULTI_SERVER_ARCHITECTURE.md).

## 8. Multi-node deployment of one community — advanced/experimental

Do not make “second machine” step three of a fresh install.

The current safe boundary is:

- one Authority owns state;
- scoped helper/media nodes may be added where documented;
- the experimental Anchor is stateless and does not become another Authority;
- WabiDB peer replication and warm standby are not production HA today;
- automatic Authority election/failover is not enabled.

Read [../architecture/SERVER_MESH_PLAN.md](../architecture/SERVER_MESH_PLAN.md) and [../PROJECT_STATUS.md](../PROJECT_STATUS.md) before touching these paths.

## 9. Upgrades

Before a meaningful upgrade:

1. take a stopped-server backup;
2. record the current Wabi commit/release;
3. upgrade/build;
4. verify `/livez` and `/readyz`;
5. log in and prove representative reads/writes;
6. only then clean up the pre-upgrade backup.

Do not assume a green process-liveness check means WabiDB application/replay is healthy; readiness is the stronger gate.

## Minimal mental model

For the first deployment, this is enough:

```text
Docker/Podman
   └─ wabi-server (Authority)
       ├─ embedded frontend
       ├─ API + realtime
       ├─ WabiDB
       └─ filesystem uploads
```

Everything else is optional or advanced. Get this healthy first.
