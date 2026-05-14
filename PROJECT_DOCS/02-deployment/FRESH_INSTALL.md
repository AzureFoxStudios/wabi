# Fresh Install

Use this path for a clean single-machine Wabi install.

Do not start with mesh, STDB, or Cloudflare Tunnel.
Get one machine healthy on `localhost` first, then add one extra layer at a time.

## Prerequisites

- Docker Desktop or Podman with Compose support
- Bash available as `bash`
- Git

## 1. Create `wabi.config`

Copy [wabi.config.example](C:/Users/Willp/Documents/GitHub/Wabi/wabi.config.example) to `wabi.config`.

Start with this minimal config:

```env
PROFILE=starter
RUNTIME=node
DOMAIN=localhost
CALLS=self_hosted_turn

USE_TUNNEL_PROFILE=false
TUNNEL_CONNECTOR=named
CLOUDFLARE_TUNNEL_TOKEN=

PLUGINS_ENABLED=false
PLUGINS_ALLOW_INSTALL=false

ENABLE_RELAYS=false
ENABLE_MEDIA_GATEWAY=false
ENABLE_SFU=false
SFU_PROVIDER=none
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

Leave these unset for the first install:

- `STATE_*`
- `WABI_STDB_*`
- `WABI_SERVER_*`
- `WABI_MESH_*`

## 2. Launch

From the repo root:

```bash
./scripts/launch.sh --reconfigure
```

This generates `.env` and `frontend/.env`, builds the containers, and starts Wabi.

## 3. Verify

Check:

- `http://localhost:3000`
- `http://localhost:8080/health`

If those are not healthy yet, do not add tunnel or mesh.

## 4. Optional: Public Domain

Only after localhost is working:

1. Set `USE_TUNNEL_PROFILE=true`
2. Set `TUNNEL_CONNECTOR=named`
3. Set `CLOUDFLARE_TUNNEL_TOKEN=<your token>`
4. Run:

```bash
./scripts/launch.sh --reconfigure
```

This starts:

- `wabi-tunnel-caddy`
- `wabi-cloudflared-named`

## 5. Optional: Second Machine / Mesh

Only after one machine is stable:

1. Bring up the second machine with the same single-machine install first
2. Add STDB and mesh settings after both standalone installs are healthy
3. Re-run `./scripts/launch.sh --reconfigure` on each machine

## Rule Of Thumb

- first machine: `localhost`
- second step: named tunnel
- third step: STDB + mesh

If you skip that order, debugging gets much harder.
