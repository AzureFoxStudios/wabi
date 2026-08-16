# Wabi

Wabi is a free, self-hosted communication app for people who want to leave Discord without needing a computer science degree.

Think: Discord-style servers and channels, reliable calls inspired by TeamSpeak, and easy social messaging in the spirit of LINE.

You run it yourself, so your community controls its own space and data.

Positioning references:
- Like [LINE](https://line.me/en/) for social/group messaging UX
- Like [Discord](https://discord.com/) for server/channel community structure
- Built on standard communication tech: [WebRTC](https://webrtc.org/), [Socket.IO](https://socket.io/), [TURN](https://en.wikipedia.org/wiki/Traversal_Using_Relays_around_NAT)

## What Wabi includes

- Real-time text chat, channels, one-to-one DMs, private group conversations, presence, and typing indicators
- Private, browser-local notes with pinning, color labels, a quick scratchpad, and Reader integration
- Voice, video, and configurable-quality screen sharing via WebRTC
- Better call connectivity across networks using TURN (coturn)
- User accounts, JWT auth, guest access codes, and role-based permissions
- Saves shared server state in the embedded Wabidb engine; browser-local client caches belong in IndexedDB
- Eight built-in themes, timed light/dark switching, and a custom theme editor
- Optional Lore-backed version control for large assets and call recordings
- Plugin system with integrity/signature policy controls
- Optional `relay-node` (file delivery network phase) and `media-gateway` (SRT gateway daemon + worker bridge)

## Feature table

| Area | Status | Notes |
|---|---|---|
| Real-time chat | Available | Channels, one-to-one DMs, private groups, replies, uploads, presence, and typing indicators |
| Notes | Available | Private browser-local workspace, quick scratchpad, pinning, colors, and Reader view |
| Voice/video calls | Available | Direct, group, and voice-channel calls over WebRTC; TURN and LiveKit are optional |
| Screen sharing | Available | Browser/desktop capture with quality presets from low-data 144p through source resolution |
| Auth + roles | Available | JWT auth, guest codes, RBAC |
| Persistence | Available | Wabidb server state (embedded engine) + IndexedDB client-local cache |
| Theming | Available | Eight presets, custom colors/gradients/backgrounds, per-panel colors, import/export, and timed switching |
| Lore asset VCS | Optional | Compile-time addon for revisioned large-file storage, history, branches, merges, diffs, and locks |
| Relay network | Optional/Phase 1 | `relay-node/` for file delivery relays |
| SRT media gateway | Optional/Partial | Control-plane sync and worker orchestration are present; browser call media still uses WebRTC |
| Plugin system | In progress | Core framework is live (integrity/signing). Plugin mode completion is on roadmap. |

## Feature guide

### Notes

Wabi includes a private notes workspace alongside chat. Notes are scoped to the signed-in user in the current browser profile and support:

- Create, edit, and delete
- Pin-to-top ordering and theme-aware color labels
- A resizable list/editor workspace and compact panel layout
- Opening a note in Reader mode
- A separate quick scratchpad

Notes currently use browser `localStorage`; they are not synced to Wabidb or another device. The DM hub can also launch or test links to Obsidian, Notion, Logseq, or a custom URL, but this is an external-app shortcut rather than two-way note synchronization.

Implementation: `frontend/src/lib/notesStore.ts`, `frontend/src/lib/components/NotesWorkspace.svelte`, and `frontend/src/lib/components/QuickScratchpad.svelte`.

### Direct messages

The DM hub combines one-to-one conversations and private group conversations. Users can start a conversation from the people picker, see presence, unread counts, last-message previews, and open a conversation in the main view, side panel, detached desktop window, or both center and side layouts.

DM conversations reuse the main chat composer and message renderer, so they support text, replies, GIFs, emoji, spoilers, and file/media uploads. Voice and video call actions are available when a DM is open in the main chat surface. The Rust server owns DM/group creation and deletion, call signaling, and Wabidb-backed message/channel state; guests cannot create or delete DMs.

Current DMs are **not end-to-end encrypted**. The server and server operator may be able to read DM text and attachments. The repository contains experimental X25519/AES-GCM, recovery, ratchet, and encrypted-envelope groundwork, but those pieces are not connected to the production send/upload path and provide no current E2EE guarantee.

Implementation: `frontend/src/lib/components/DmHub.svelte`, `frontend/src/lib/components/DmConversationView.svelte`, `frontend/src/lib/dm/`, and `core/crates/wabi-server/src/socketio/dm_moderation.rs`.

### Lore asset version control

[Lore](https://github.com/EpicGames/lore) is an optional version-control backend for large binary assets such as video, audio, textures, CAD files, and 3D models. Wabi exposes Lore through Asset Storage channels with:

- Drag-and-drop upload, download, deletion, folders, and media previews
- Immutable revision and per-file history
- Snapshots with commit messages
- Revision diffs
- Branch creation and merging
- File locking for assets that cannot be merged safely
- Optional upload of completed call recordings to a configured Recordings channel

Wabidb stores repository and commit metadata while the Lore server stores the file bytes. The addon is excluded from the default server binary: build `wabi-server` with `--features wabi-lore` (or the aggregate `addons` feature), enable `[addons.lore]`, and provide a working Lore CLI/server. Without that feature, the REST routes do not exist and the shared frontend quietly disables Lore behavior.

See [`docs/addons/lore.md`](docs/addons/lore.md) for build, configuration, API, security, and operations details.

### Themes and appearance

The current theme system derives application-wide semantic CSS tokens from eight curated palettes: Nebula, Daylight, Midnight Blue, High Contrast, Forest, Warm Red, Sakura, and Space. Several themes include ambient effects and frosted surfaces.

Appearance settings also support:

- Custom surface, text, accent, border, and gradient colors
- Independent colors for the server rail, sidebar, chat, and side panels
- Background images, uniform font controls, and a live preview
- JSON theme import/export
- Scheduled switching between a chosen daytime and nighttime theme
- Message density, layout, motion, and lower-power presentation controls

Theme choices fall back to browser-local persistence when the optional server theme endpoint is unavailable. This means a theme may remain device-local on deployments whose Wabidb user settings do not yet persist theme fields.

Implementation: `frontend/src/lib/theme/`, `frontend/src/lib/components/ThemeCustomizer.svelte`, and `frontend/src/lib/timedThemeMode.ts`.

### Calling

Wabi supports one-to-one voice/video calls, private group calls, and persistent voice channels. The browser baseline is WebRTC:

- Direct calls use peer-to-peer media.
- Self-hosted coturn provides relay connectivity when peers cannot connect directly.
- Group/channel calls can use an optional LiveKit SFU when configured, with fallback to peer-to-peer WebRTC.
- Call controls cover microphone, camera, deafen, device selection, participant layouts, connection diagnostics, and recording.
- Video sender quality can step down under load to prioritize audio.
- Call session, participant, and signaling state is represented in Wabidb-backed server APIs.

The optional SRT media gateway currently supplies gateway heartbeats, session lifecycle/control-plane integration, recording, and distribution hooks. It does not replace WebRTC as the browser’s interactive media path.

See [`PROJECT_DOCS/01-architecture/CALLING_TRANSPORT_ARCHITECTURE.md`](PROJECT_DOCS/01-architecture/CALLING_TRANSPORT_ARCHITECTURE.md) for transport boundaries and rollout status.

### Screen sharing

Screen sharing uses the platform’s display-capture picker and participates in the active WebRTC or LiveKit call. It supports screen audio when the browser and operating system expose an audio track, automatically stops when the captured track ends, and provides saved quality profiles:

- Auto: up to 2560×1440 at 30 fps
- 1080p: up to 8 Mbps at 30 fps
- Source: up to 3840×2160 at 60 fps with no application bitrate cap
- 720p, 480p, and 144p low-data modes
- Optional custom bitrate override

Available resolution, frame rate, window/tab capture, and system audio still depend on the browser, operating system, permissions, and network capacity.

Implementation: `frontend/src/lib/callingScreenShare.ts`, `frontend/src/lib/media/screenShare.ts`, and `frontend/src/lib/callingLivekit.ts`.

## Architecture at a glance

- `frontend/`: SvelteKit client (web + Tauri support)
- `core/crates/wabi-server/`: Rust API and Socket.IO server, auth, policy, persistence, calls, and plugins
- `core/crates/wabidb/`: embedded event store, projections, snapshots, and domain commands
- `core/addons/lore/`: optional Lore large-asset version-control bridge
- `docker-compose.yml`: optional coturn profile for TURN relay service
- `relay-node/`: Volunteer-hosted relay node for file delivery
- `media-gateway/`: SRT gateway daemon (control-plane + worker orchestration)

See full architecture and deep technical docs in `PROJECT_DOCS/01-architecture/ARCHITECTURE.md` and `PROJECT_DOCS/archive/CODEBASE_OVERVIEW.md`.

## Quick start

### Docker (recommended)

Works on **Windows, Mac, and Linux** with Docker or Podman.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cp .env.example .env
# Edit WABI_JWT_KEY and WABIDB_ROOT_KEY in .env (see comments)
docker compose up -d
```

Open `http://localhost:3001`, create the owner account, and you're in.

If you ship Podman instead of Docker, replace `docker compose` with `podman compose`.

**Optional: voice/video calling via TURN:**

```bash
# Also set TURN_HMAC_KEY in .env before running:
docker compose --profile turn up -d
```

### Cargo (bare metal)

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cd frontend && STATIC_BUILD=1 npm run build && cd ..
cargo build --release -p wabi-server
mkdir -p data/wabi-server uploads plugins
export WABI_JWT_KEY="$(openssl rand -base64 48)"
export WABIDB_ROOT_KEY="$(openssl rand -hex 32)"
./target/release/wabi-server --data-dir ./data/wabi-server --host 0.0.0.0 --port 3000
```

Open `http://localhost:3000`, create the owner account.

### Local development

```bash
bun run dev
```

Then open `http://localhost:5173` (frontend) + `http://localhost:3001` (backend). See `docs/NETWORKING.md` for networking details.

### Deployment paths (pick one)

| Path | Entry point | Use when |
|------|-------------|----------|
| **Docker / Podman** | `docker-compose.yml` + `.env` | Most self-hosters, production servers |
| **Bare cargo** | `cargo build --release -p wabi-server` | No-Docker hosts, dev, debugging |
| **`scripts/launch.sh`** | `wabi.config` → `.env` | Local dev with tunneling/turn profiles |

> **NOTE:** `scripts/setup.sh` and `docker-compose.bun.yml` are **removed**. Use `docker-compose.yml` (this repo's canonical compose) and `.env.example`.

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

## Launch helper (optional)

For local dev with profiles (tunnels, TURN, media gateway), use:

```bash
cp wabi.config.example wabi.config
# Edit wabi.config
./scripts/launch.sh
```

`launch.sh` is optional. For production servers, `docker-compose.yml` + `.env` is the simpler path.

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

Start from `.env.example` (root). If you use `scripts/launch.sh`, treat `wabi.config` as your primary operator surface and avoid hand-editing env files unless you need an advanced variable not exposed there.

`scripts/launch.sh` does not configure relay-node deployment; relay setup uses `scripts/relay-launch.sh`.

Important settings to review before production:
- `FRONTEND_URL`, `PUBLIC_URL`, `ALLOWED_ORIGINS`
- `WABI_JWT_KEY` (generate: `openssl rand -base64 48`)
- `WABIDB_ROOT_KEY` (generate: `openssl rand -hex 32`)
- `TURN_HMAC_KEY` (only when using `--profile turn`)
- `WABI_MODE`, `WABI_RUNTIME`, `WABI_SERVER_ROLE`
- `PLUGINS_ENABLED`, `PLUGINS_ALLOW_INSTALL` (both default to `false`)
- Server data dir and storage config (see `docker-compose.yml`)
- Optional launch page branding: `WABI_LAUNCH_PAGE_JSON` or `WABI_LAUNCH_PAGE_PATH`

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
