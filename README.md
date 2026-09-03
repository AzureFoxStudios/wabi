# Wabi

Wabi is a free, self-hosted communication app for people who want to leave Discord without needing a computer science degree.

Think: Discord-style servers and channels, reliable calls inspired by TeamSpeak, and easy social messaging in the spirit of LINE.

You run it yourself, so your community controls its own space, data, and rules.

## What's included

- Real-time text chat: channels, one-to-one DMs, private groups, replies, presence, typing indicators
- Voice, video, and screen sharing (WebRTC; optional coturn TURN and LiveKit SFU)
- Shared whiteboards and wiki pages inside your server
- **Private access** — let family/friends reach a home-hosted server through an encrypted tunnel with one code: no port forwarding, no domain, nothing public ([guide](docs/features/PRIVATE_ACCESS_GUIDE.md))
- User accounts, JWT auth, guest access, role-based permissions — eight themes, full theme editor
- **One Rust binary is the whole product**: REST API + Socket.IO live updates + the embedded frontend, backed by the in-process event-sourced engine **WabiDB** (no external database)
- Optional addons: Lore large-asset version control, volunteer relay nodes, SRT media gateway, plugin system with signing/integrity controls

| Area | Status |
|---|---|
| Real-time chat, DMs, groups | ✅ Available |
| Voice/video calls + screen share | ✅ Available (P2P WebRTC; TURN/SFU optional) |
| Whiteboards & wiki | ✅ Available |
| Private access tunnels (tailcat) | ✅ Available — desktop clients, disabled by default |
| Auth + roles + guests | ✅ Available |
| Theming (8 presets + editor) | ✅ Available |
| Lore asset VCS | 🔌 Optional compile-time addon |
| Relay network / SRT media gateway | 🧩 Optional, partial |
| Plugin system | 🚧 In progress (core framework live) |

## Quick start

### Docker (recommended)

Works on Windows, Mac, and Linux with Docker or Podman. No `.env`, no secrets to generate — first boot creates them inside `./data/wabi-server`.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
docker compose up -d --build
```

The first build compiles everything from source (10+ minutes, cached afterwards). Open `http://localhost:3001`, create the owner account, and you're in. Podman: `podman compose`. Want to manage secrets yourself? `cp .env.example .env` and set `WABI_JWT_KEY` / `WABIDB_ROOT_KEY`.

**Voice/video via TURN (optional):** set `TURN_HMAC_KEY` in `.env`, then `docker compose --profile turn up -d`.

### Bare cargo

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cd frontend && STATIC_BUILD=1 npm run build && cd ..
cargo build --release -p wabi-server
mkdir -p data/wabi-server uploads plugins
./target/release/wabi-server --data-dir ./data/wabi-server --host 0.0.0.0 --port 3000
```

Open `http://localhost:3000` and create the owner account.

### Local development

```bash
bun run dev        # frontend :5173 + backend :3001
bun run dev:local  # full local stack, no remote server needed
```

Details: [docs/local-dev.md](docs/local-dev.md).

### Desktop app (Tauri)

```bash
bun run desktop:dev   # dev
bun run desktop:build # bundles (installer embeds WebView2 offline for Windows)
bun run desktop:check # fast Rust-side validation
```

The desktop shell lives in [`src-tauri/`](src-tauri/) and is also what enables private-access tunnels for members.

## Reaching your server

- **LAN / Tailscale / port-forward / domain+TLS** — the classic paths, see [docs/NETWORKING.md](docs/NETWORKING.md)
- **Cloudflare quick tunnel** (temporary URL, zero config): `docker compose --profile tunnel --profile tunnel-quick up -d`, URL in `docker logs wabi-cloudflared-quick`
- **Named tunnel** (your domain): set `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, `docker compose --profile tunnel --profile tunnel-named up -d`
- **Private access** — no domain, no ports, encrypted tunnels for family/friend instances: enable in Admin → Runtime ([guide](docs/features/PRIVATE_ACCESS_GUIDE.md))

## Architecture at a glance

| Path | What it is |
|---|---|
| `core/crates/wabi-server/` | The binary: Axum REST + Socket.IO + auth + calls + addons |
| `core/crates/wabidb/` | Embedded event-sourced engine (append-only store → projections) |
| `frontend/` | SvelteKit client (Svelte 5, static build embedded in the binary) |
| `src-tauri/` | Tauri desktop shell |
| `core/addons/` | Optional addon backends (lore, tailcat, mesh, webhooks, payments) |
| `relay-node/`, `media-gateway/` | Optional relay + SRT media helpers |

Mental model: **commands → events → projections → live socket push**. Start at [docs/architecture/overview.md](docs/architecture/overview.md).

## Privacy & honesty

- **Your server, your data.** The operator (you) controls everything — which also means the operator can read server content. [Privacy stance](docs/PRIVACY_STANCE.md).
- **DMs are not end-to-end encrypted** today. E2EE groundwork exists in the repo but is not connected to the send path. Assume the server operator can read DMs.
- **Back up `data/wabi-server/`.** It contains the root key; lose it and the server's data is gone. ([Backup & restore guidance](docs/deployment/BACKUP_AND_RESTORE.md) — historical doc, current runbooks in `docs/deployment/`)

## Configuration

Start from `.env.example` (root). `scripts/launch.sh` + `wabi.config` is the operator-friendly surface for local profiles. Review before production: `ALLOWED_ORIGINS`, `PLUGINS_ENABLED` (default false), TURN keys if you use the turn profile. Community-branded login page: copy `data/launch-page.example.json` → `data/launch-page.json` and restart.

## Plugins

Manifest-based with permissions, integrity checksums, optional signing, and crash-loop safe mode. Authoring guide: [`plugins/README.md`](plugins/README.md); bundled test add-ons: [`addons/README.md`](addons/README.md). If you just want to host Wabi, you can ignore plugins.

## Documentation

Everything lives in [`docs/`](docs/README.md) — start at its index:

- [Architecture](docs/architecture/overview.md) · [Networking](docs/NETWORKING.md) · [Deployment](docs/deployment/FRESH_INSTALL.md) · [Private access](docs/features/PRIVATE_ACCESS_GUIDE.md) · [Lore addon guide](docs/addons/lore.md) · [All docs](docs/README.md)

Historical documentation (pre-2026-09) lives on the `docs-history` branch, browsable and downloadable as a ZIP.

**AI agents:** read [`AGENTS.md`](AGENTS.md) first — it is the canonical orientation for working in this repo.

## License

MIT ([LICENSE](LICENSE))

## Roadmap

1. Clean up open bugs; polish UI/CSS consistency
2. Finish plugin mode
3. See [docs/ROADMAP.md](docs/ROADMAP.md)
