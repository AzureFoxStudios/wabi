# Wabi

Wabi is a free, self-hosted communication app for people who want to leave Discord without needing a computer science degree.

Think: Discord-style servers and channels, reliable calls inspired by TeamSpeak, and easy social messaging in the spirit of LINE.

You run it yourself, so your community controls its own space and data.

Positioning references:
- Like [LINE](https://line.me/en/) for social/group messaging UX
- Like [Discord](https://discord.com/) for server/channel community structure
- Built on standard communication tech: [WebRTC](https://webrtc.org/), [Socket.IO](https://socket.io/), [TURN](https://en.wikipedia.org/wiki/Traversal_Using_Relays_around_NAT)

## What Wabi includes

- Real-time text chat, channels, DMs, presence, typing indicators
- Voice, video, and screen sharing via WebRTC
- Better call connectivity across networks using TURN (coturn)
- User accounts, JWT auth, guest access codes, and role-based permissions
- Saves shared server state in the embedded Wabidb engine; browser-local client caches belong in IndexedDB
- Theme customization and saved user preferences
- Plugin system with integrity/signature policy controls
- Optional `relay-node` (file delivery network phase) and `media-gateway` (SRT gateway daemon + worker bridge)

## Feature table

| Area | Status | Notes |
|---|---|---|
| Real-time chat | Available | Channels, DMs, presence, typing indicators |
| Voice/video calls | Available | WebRTC with TURN REST credentials |
| Screen sharing | Available | Real-time share flows in client |
| Auth + roles | Available | JWT auth, guest codes, RBAC |
| Persistence | Available | Wabidb server state (embedded engine) + IndexedDB client-local cache |
| Theming | Available | Saved user theme/preferences |
| Relay network | Optional/Phase 1 | `relay-node/` for file delivery relays |
| SRT media gateway | Optional | `media-gateway/` daemon with control-plane sync + worker orchestration |
| Plugin system | In progress | Core framework is live (integrity/signing). Plugin mode completion is on roadmap. |

## Architecture at a glance

- `frontend/`: SvelteKit client (web + Tauri support)
- `backend/`: Node.js + Socket.IO API/server, auth, policy, persistence, plugins
- `turn-server/`: Dockerized coturn for TURN REST auth
- `relay-node/`: Volunteer-hosted relay node for file delivery
- `media-gateway/`: SRT gateway daemon (control-plane + worker orchestration)

See full architecture and deep technical docs in `PROJECT_DOCS/ARCHITECTURE.md` and `PROJECT_DOCS/CODEBASE_OVERVIEW.md`.

## Quick start (recommended: Docker or Podman)

If you can run Docker or Podman, you can run Wabi. Works on **Windows, Mac, and Linux** with zero config.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
docker compose up -d --build
```

Open `http://localhost:3000`, create the owner account, and you're in. No `.env` editing is required for local bring-up; localhost defaults are baked into Compose, and backend secrets are auto-generated on first boot.

If your host ships Podman instead of Docker, replace `docker compose` with `podman compose`. The setup and launch scripts auto-detect either runtime; set `WABI_CONTAINER_RUNTIME=podman` to force Podman when both are installed.

**Optional: include TURN for production-quality calling:**

```bash
docker compose --profile turn up -d --build
```

Default local endpoints:
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8080`
- Health check: `http://localhost:8080/health`

For public domains, TURN, reverse proxies, mesh config, or other non-local settings, use `./scripts/setup.sh` on Linux or `scripts/setup-forWindows.ps1` on Windows. Login-page branding is configured separately via `data/launch-page.json`.

### Manual .env setup (advanced)

If you prefer to set secrets manually:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
# Edit .env with your JWT_SECRET, domain, etc.
docker compose up -d --build
```

## Public Access Without Port Forwarding

Wabi supports two tunnel paths out of the box:

1. Domainless quick tunnel (free, temporary URL):

```bash
docker compose --profile tunnel --profile tunnel-quick up -d --build
docker logs -f wabi-cloudflared-quick
```

Use the `https://*.trycloudflare.com` URL printed in logs.

2. Named tunnel (your own domain, stable URL):

```bash
# Set in .env first:
# CLOUDFLARE_TUNNEL_TOKEN=<token from Cloudflare Zero Trust>
docker compose --profile tunnel --profile tunnel-named up -d --build
```

In both modes, Wabi routes frontend + backend through `Caddyfile.tunnel` so `/api` and `/socket.io` stay on one origin.

## Guided setup (server bootstrap)

For first-time server provisioning, use:

```bash
./scripts/setup.sh
```

The setup wizard asks a few questions, generates your config files, helps with Caddy, and prints the exact deploy commands.

Windows guided setup without WSL:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-forWindows.ps1
```

Windows deploy helper (requires WSL):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/launch-forWindows.ps1
```

Use `setup-forWindows.ps1` for first-run config generation on Windows. `launch-forWindows.ps1` is a WSL wrapper around the more advanced `launch.sh` deploy helper.

Optional operator config (used by `scripts/launch.sh`):

```bash
cp wabi.config.example wabi.config
```

`wabi.config` is the operator-friendly control file (`PROFILE`, `RUNTIME`, `CALLS`, plugin/privacy toggles).  
Edit `wabi.config`, then run `./scripts/launch.sh`; it syncs supported keys into `.env` and `frontend/.env`.

### Relay Node Setup (separate from core server setup)

Relay node deployment is intentionally separate from core server launch.

Linux/macOS:

```bash
./scripts/relay-launch.sh configure
./scripts/relay-launch.sh up
```

Windows (WSL required):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/relay-launch-forWindows.ps1 configure
powershell -ExecutionPolicy Bypass -File scripts/relay-launch-forWindows.ps1 up
```

Relay runbook: `PROJECT_DOCS/RELAY_PHASE1_SERVER_RUNBOOK.md`

## Development

Run frontend and backend together from repo root:

```bash
bun run dev
```

Localhost-first dev mode (recommended when remote/prod server is down):

```powershell
bun run dev:local:windows
```

```bash
bun run dev:local
```

This mode is the real local stack, not UI mock mode:
- Frontend: `http://localhost:5173`
- Rust backend: `http://localhost:3001`
- Wabidb data dir: `./data/wabi-server`
- *(no proxy needed; Wabidb is in-process)*

If `spacetimedb/wabi_state_bridge` is missing, `bun run dev:local` fails loudly instead of falling back to a fake persistence layer.

Backend-only localhost mode (skips frontend; still expects only the wabi-server binary to be valid):

```powershell
bun run dev:backend:local:windows
```

```bash
bun run dev:backend:local
```

Service scripts:
- Root scripts: `package.json`
- Backend scripts: `backend/package.json`
- Frontend scripts: `frontend/package.json`

## Desktop App

The active Tauri desktop app lives in `frontend/src-tauri`.

From repo root on Windows:

```bash
bun run desktop:dev
bun run desktop:build
bun run desktop:check
```

Use `desktop:check` first if you only want to validate the Rust side quickly.

Windows desktop bundles are emitted to `frontend/src-tauri/target/release/bundle/`.
The Windows installer is configured to embed the WebView2 offline installer so it can install on machines that do not already have WebView2 or cannot download it during setup. This makes the installer much larger, but it avoids the common "works on my machine, fails on another PC" problem.

`tauri-app/` is a legacy wrapper kept around for compatibility; it is not the primary desktop source of truth anymore.

## Deployment modes

Wabi's canonical deployment is Rust + Wabidb (engine embedded). Optional profiles add tunnels, TURN, SFU, and media helpers.

Compose example:

```bash
docker compose -f docker-compose.yml up -d --build
```

See `PROJECT_DOCS/DEPLOYMENT.md` for full deployment guidance.

## Configuration

Primary env files:
- `.env` (backend/runtime/deployment/turn/media flags)
- `frontend/.env` (socket URL, TURN client config, GIF key)

Start from:
- `.env.example`
- `frontend/.env.example`

If you use `scripts/launch.sh`, treat `wabi.config` as your primary operator surface and avoid hand-editing env files unless you need an advanced variable not exposed there.
`scripts/launch.sh` does not configure relay-node deployment; relay setup uses `scripts/relay-launch.sh`.

Important settings to review before production:
- `FRONTEND_URL`, `PUBLIC_URL`, `ALLOWED_ORIGINS`
- `JWT_SECRET`
- `TURN_EXTERNAL_IP`, `TURN_REALM`, `TURN_SHARED_SECRET`
- `WABI_MODE`, `WABI_RUNTIME`, `JWT_SIGNING_KEY` (see docker-compose.yml for required env)
- `PLUGINS_ENABLED`, `PLUGINS_ALLOW_INSTALL` (both default to `false`)
- `WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED` / `VITE_VIDEO_COMPRESSION_CLIENT_METRICS` (both default to `false`)
Server data dir and storage config (see `docker-compose.yml`)
- Optional launch page branding: `WABI_LAUNCH_PAGE_JSON` or `WABI_LAUNCH_PAGE_PATH`

If you are new to this, start with `./scripts/setup.sh` and only edit advanced variables later.

### Custom Login Launch Page

Wabi can serve a community-branded launch page on the login screen.

1. Copy `data/launch-page.example.json` to `data/launch-page.json`.
2. Edit the content, palette, hero links, and highlights.
3. Restart backend.

Backend serves this config from `GET /api/public/launch-page`.

## Plugins

Wabi has a modular plugin system (runtime install dir: `plugins/`) with:
- manifest-based capabilities and permissions
- integrity checksum support
- optional signing + trusted signer policy
- audit/logging hooks

Plugin authoring guide: `plugins/README.md`  
Bundled test add-ons (not installed by default): `addons/README.md`  
If you just want to host Wabi, you can ignore plugins at first.

### Plugin Safe Mode Recovery

If you see logs like `Safe mode: skipping third-party plugin ...`, plugin crash-loop safe mode is active.

To clear previous crash history:

```powershell
Set-Content -Path backend/data/.plugin-storage/plugin-crash-state.json -Value "{}"
```

Then restart the backend server and run add-on detection again from Settings if needed.

## Key docs

- Overview: `PROJECT_DOCS/README.md`
- Architecture: `PROJECT_DOCS/ARCHITECTURE.md`
- Deployment: `PROJECT_DOCS/DEPLOYMENT.md`
- Translation guide: `TRANSLATION_GUIDE.md`
- TURN setup: `PROJECT_DOCS/TURN_SETUP.md`
- TURN REST auth: `PROJECT_DOCS/TURN_REST_AUTH.md`
- Calling transport: `PROJECT_DOCS/CALLING_TRANSPORT_ARCHITECTURE.md`
- Policy system: `PROJECT_DOCS/POLICY_SYSTEM.md`
- Tauri readiness: `PROJECT_DOCS/TAURI_BUILD_READINESS.md`

## License

MIT (`LICENSE`)

## Roadmap (current)

1. Clean up open bugs.
2. Polish and stabilize CSS and UI consistency.
3. Finish plugin mode.
