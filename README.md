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
- Saves data by default (SQLite), with optional Postgres mode for larger/community setups
- Theme customization and saved user preferences
- Plugin system with integrity/signature policy controls
- Optional `relay-node` (file delivery network phase) and `media-gateway` (SRT control-plane phase)

## Feature table

| Area | Status | Notes |
|---|---|---|
| Real-time chat | Available | Channels, DMs, presence, typing indicators |
| Voice/video calls | Available | WebRTC with TURN REST credentials |
| Screen sharing | Available | Real-time share flows in client |
| Auth + roles | Available | JWT auth, guest codes, RBAC |
| Persistence | Available | SQLite default, Postgres community mode |
| Theming | Available | Saved user theme/preferences |
| Relay network | Optional/Phase 1 | `relay-node/` for file delivery relays |
| SRT media gateway | Optional (Phase 2 MVP) | `media-gateway/` control-plane foundation |
| Plugin system | In progress | Core framework is live (integrity/signing). Plugin mode completion is on roadmap. |

## Architecture at a glance

- `frontend/`: SvelteKit client (web + Tauri support)
- `backend/`: Node.js + Socket.IO API/server, auth, policy, persistence, plugins
- `turn-server/`: Dockerized coturn for TURN REST auth
- `relay-node/`: Volunteer-hosted relay node for file delivery
- `media-gateway/`: Phase 2 SRT gateway control plane

See full architecture and deep technical docs in `PROJECT_DOCS/ARCHITECTURE.md` and `PROJECT_DOCS/CODEBASE_OVERVIEW.md`.

## Quick start (recommended: Docker)

If you can run Docker, you can run Wabi.

1. Clone the repo:

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
```

2. Create env files:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```
(Don't worry about populating the .env files yet. The setup scripts will do this for you.)

3. Start core services:

```bash
docker compose up -d --build
```

4. Optional: include TURN for production-quality calling:

```bash
docker compose --profile turn up -d --build
```

Default local endpoints:
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8080`
- Health check: `http://localhost:8080/health`

## Guided setup (self-hosted Linux)

For first-time server provisioning, use:

```bash
./scripts/setup.sh
```

The setup wizard asks a few questions, generates your config files, helps with Caddy, and prints the exact deploy commands.

Windows launcher (requires WSL):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/launch-forWindows.ps1
```

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

This mode forces local runtime defaults:
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- Health check: `http://localhost:3000/health`
- SQLite DB path: `backend/data/chat.db`

Service scripts:
- Root scripts: `package.json`
- Backend scripts: `backend/package.json`
- Frontend scripts: `frontend/package.json`

## Deployment modes

Wabi supports a few deployment combinations:

- `normal + node` (default): SQLite + Node containers
- `normal + bun`: SQLite + Bun containers
- `community + node`: Postgres + Node containers
- `community + bun`: Postgres + Bun containers

Compose examples:

```bash
# normal + node
docker compose -f docker-compose.yml up -d --build

# community + node
docker compose -f docker-compose.yml -f docker-compose.community.yml up -d --build

# community + bun
docker compose -f docker-compose.yml -f docker-compose.community.yml -f docker-compose.bun.yml up -d --build
```

See `PROJECT_DOCS/DEPLOYMENT.md` for full deployment guidance.

## Configuration

Primary env files:
- `.env` (backend/runtime/deployment/turn/media flags)
- `frontend/.env` (socket URL, TURN client config, GIF key, relay toggle)

Start from:
- `.env.example`
- `frontend/.env.example`

Important settings to review before production:
- `FRONTEND_URL`, `PUBLIC_URL`, `ALLOWED_ORIGINS`
- `JWT_SECRET`
- `TURN_EXTERNAL_IP`, `TURN_REALM`, `TURN_SHARED_SECRET`
- `WABI_MODE`, `WABI_RUNTIME`, `DB_MODE`
- Postgres settings if using community mode

If you are new to this, start with `./scripts/setup.sh` and only edit advanced variables later.

## Plugins

Wabi has a modular plugin system in `plugins/` with:
- manifest-based capabilities and permissions
- integrity checksum support
- optional signing + trusted signer policy
- audit/logging hooks

Plugin authoring guide: `plugins/README.md`  
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
