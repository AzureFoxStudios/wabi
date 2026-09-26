# Wabi

> **Self-hosted communication and collaborative workspaces for small communities.**

Wabi is a free and open-source app for friends, studios, classrooms, project groups, and small communities that want modern chat and collaboration without moving the community itself onto a central platform.

It borrows useful ideas from Discord, TeamSpeak, LINE, project workspaces, and creative review tools, but the deployment model is deliberately simpler: **each Wabi community owns its own server and data**. A Wabi client can save and switch between multiple independent servers; those servers do **not** federate, share accounts, or silently synchronize state.

Wabi is under active development. See **[Project status](docs/PROJECT_STATUS.md)** for the current shipped/experimental boundary before relying on a feature in production.

## What Wabi includes

- **Communication** — channels, server-local friends, one-to-one DMs, group conversations, replies, presence, typing indicators, roles, and guest access.
- **Optional translation** — local-first Translator Assist provides on-demand and viewport-aware automatic translation through user-controlled LibreTranslate endpoints, without making translation a Wabi server dependency or bundling language models.
- **Calls** — voice, video, and screen sharing with Wabi's current call transports plus optional coturn TURN and LiveKit SFU deployment paths.
- **Collaborative workspaces** — whiteboards, wiki/content surfaces, Planner/Notes-style workspaces, files/media, Reader, and dockable layouts instead of forcing every task through a chat scrollback.
- **CAD and model review** — read-only DXF/DWG drawing review, 3MF and STEP/IGES model import, 3D inspection, and collaborative drawing-space markup. Wabi is a **review surface, not a CAD editor**.
- **Lore project workspace** — file/history/review workflows and local-folder tooling around the optional external Lore backend.
- **Customization** — themes, theme editing, animated/sprite emotes, pointer effects, and a local visual-effects host that does not require arbitrary JavaScript execution.
- **Private access** — optional Tailcat-based access for desktop clients when a community should be reachable without opening a public inbound port or running a public domain.
- **Self-contained core** — one Rust `wabi-server` binary serves the API, realtime layer, embedded SvelteKit frontend, and embedded event-sourced **WabiDB** storage engine. No external database service is required for the normal single-server deployment.

### Current maturity

| Area | Current boundary |
|---|---|
| Authority server + WabiDB | ✅ Core path |
| Chat, DMs, groups, roles, presence | ✅ Core path |
| New DM/group encryption default | 🧪 Experimental Tim rollout: pending until device keys are ready, then encrypted text; explicit server-readable fallback |
| Server-local friend requests and friendships | ✅ Available on the current Tim release branch; physical phone acceptance pending |
| Translator Assist | 🔌 Optional, off by default; local/self-hosted LibreTranslate |
| Voice/video/screen sharing | ✅ Available; transport/device hardening continues |
| Whiteboards, wiki, Reader, workspace shell | ✅ Available |
| CAD/model viewing + review markup | ✅ Available |
| Lore workspace | 🔌 Available with optional external Lore integration |
| Tauri desktop client | ✅ Source/build path available; release packaging remains a release concern |
| Tailcat private access | 🔌 Optional, off by default |
| Runtime plugin framework | 🚧 Opt-in/in progress; do not treat plugins as fully sandboxed untrusted code |
| Regional Anchor role | 🧪 Experimental HTTP proxy path; native WebSocket forwarding is not complete |
| WabiDB network replication / warm standby | 🧪 Experimental and fail-closed by default; **not production HA** |
| Native mobile clients | 🚧 Active development; not a production release claim yet |

## Quick start

### Docker / Podman — recommended

A normal Wabi server does not need a separate database container or a hand-written `.env` file. First boot can create and persist its JWT secret and WabiDB root key under `./data/wabi-server`.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
docker compose up -d --build
```

Open **http://localhost:3001** and create the owner account.

Useful checks:

```bash
curl http://localhost:3001/livez
curl http://localhost:3001/readyz
```

`/livez` answers whether the process is alive. `/readyz` is the stronger application-readiness check.

Compose prepares fresh storage directory ownership before starting the non-root Authority. Podman users can use `podman compose`. If you prefer externally managed secrets, copy `.env.example` to `.env` and configure the relevant values rather than relying on first-boot generation.

### Bare Cargo

Install Node.js 22 with npm and Rust through rustup. The repository selects its
pinned Rust toolchain; install the system build dependencies for your platform.

```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cd frontend
npm ci --no-audit --no-fund
npm run build:static
cd ..
cargo build --locked --release -p wabi-server
mkdir -p data/wabi-server uploads plugins
./target/release/wabi-server --data-dir ./data/wabi-server --host 0.0.0.0 --port 3000
```

Open **http://localhost:3000**.

For optional compiled integrations such as Lore, add `--features addons` to the
Cargo build and configure the integration's external dependencies separately.

### Local development

```bash
bun run dev        # frontend :5173 + backend :3001
bun run dev:local  # local stack
```

See [docs/local-dev.md](docs/local-dev.md).

### Desktop app

```bash
bun run desktop:dev
bun run desktop:build
bun run desktop:check
```

The native shell lives in [`src-tauri/`](src-tauri/). It provides desktop integration and is also the client surface used by optional private-access features.

## Reaching your server

Start local and add networking only after the Authority is healthy.

- **LAN / private overlay VPN** — simplest trusted-network access.
- **Domain + HTTPS** — Caddy or another reverse proxy in front of Wabi.
- **VPS reverse proxy** — useful when a home server is behind CGNAT and you do not want to expose the home IP.
- **Cloudflare Tunnel** — optional convenience, not a Wabi requirement.
- **Tailcat private access** — optional private reachability for supported desktop clients without a public inbound port.

See [Networking](docs/NETWORKING.md) and [Fresh install](docs/deployment/FRESH_INSTALL.md).

## CAD and 3D import paths

Wabi converges imported content into the same review/workspace experience instead of growing a separate editor for every format.

| Format | Path |
|---|---|
| DXF | Built-in read-only 2D parser/viewer with Model/Paper Space handling and review markup |
| DWG | Optional authenticated server conversion through an operator-installed `dwg2dxf`, then the DXF viewer |
| 3MF | Browser import → temporary GLB → normal Wabi 3D viewer |
| STEP / STP / IGES / IGS | OpenCascade WASM import → temporary GLB → normal Wabi 3D viewer |

The DWG helper is intentionally **not bundled** into Wabi's MIT server image. Unsupported solid/editing operations fail visibly rather than pretending a flattened preview is a complete CAD editor.

## Architecture in one minute

The normal deployment is one **Authority** process:

```text
client
  ├─ HTTP / Socket.IO / WebSocket
  ▼
wabi-server (Rust)
  ├─ API + realtime
  ├─ embedded SvelteKit frontend
  └─ WabiDB
       commands → events → projections → live push
```

Important directories:

| Path | Purpose |
|---|---|
| `core/crates/wabi-server/` | Authority server: Axum API, auth, Socket.IO/WebSocket, jobs/helpers |
| `core/crates/wabidb/` | Embedded event-sourced storage engine and projections |
| `frontend/` | SvelteKit/Svelte 5 client and workspace UI |
| `src-tauri/` | Native desktop shell |
| `core/addons/` / `addons/` | Curated integrations and compatibility/sample addon material |
| `plugins/` | Operator-installed runtime plugins when plugin mode is enabled |
| `relay-node/`, `media-gateway/`, `turn-server/` | Optional networking/media helpers |

A single client connecting to many Wabi servers is **not federation**. Inside one deployment, an Authority may use scoped helpers. Experimental Anchor/replication/standby work does **not** make Wabi active-active or automatically highly available. Read [Architecture overview](docs/architecture/overview.md) and [Server topology](docs/architecture/SERVER_MESH_PLAN.md) before attempting multi-node operation.

## Privacy, trust, and backups

Self-hosting changes **who you trust**; it does not magically remove trust.

- The server operator controls the instance and its stored data.
- New DMs and groups in the Tim rollout start **encryption-pending**. Plaintext sends are blocked while pending; once every participant has a device key, the room can use experimental encrypted text. A participant may choose server-readable chat, but each sender must confirm that choice before sending plaintext.
- Existing DMs/groups retain their earlier policy, including server-readable rooms. The encrypted path has **not** been independently verified as E2EE or operator-blind; attachment and device-recovery behavior still need acceptance work.
- Ephemeral/no-retention content is not the same thing as operator-blind content.
- Optional tunnels, media providers, plugins, and external integrations add their own trust boundaries.
- Translator Assist does not relay message text through the Authority for translation; choosing a remote translator still gives that translator the plaintext being translated.
- Back up the complete Wabi data directory and preserve the WabiDB root key. Losing that key can make existing encrypted state unrecoverable.

Read [Privacy stance](docs/PRIVACY_STANCE.md), [Security model](docs/SECURITY-MODEL.md), and [Backup & recovery](docs/deployment/BACKUP_AND_RECOVERY.md).

## Plugins and addons

Wabi has both curated integrations and a runtime plugin framework. They are not the same maturity boundary. Runtime plugins are disabled by default and should currently be treated as trusted operator-installed code even though checksum/signing/scanning/audit controls exist.

Translator Assist is a curated frontend-only addon: it is disabled by default, lazy-loads its translation runtime, and requires a local or explicitly chosen self-hosted translator. See [Translator Assist](docs/addons/TRANSLATOR_ASSIST.md).

The old `mesh` addon is legacy compatibility material, **not** the production multi-node mechanism. See [Addons & plugins](docs/ADDONS.md) and [`plugins/README.md`](plugins/README.md).

## Documentation

Start with:

- **[Project status](docs/PROJECT_STATUS.md)** — what is shipped, experimental, or explicitly not claimed
- **[Documentation index](docs/README.md)** — map of the living docs
- **[Architecture overview](docs/architecture/overview.md)** — contributor mental model
- **[Fresh install](docs/deployment/FRESH_INSTALL.md)** — canonical first deployment
- **[Networking](docs/NETWORKING.md)** — access, ingress, calls, and multi-node boundaries
- **[Backup & recovery](docs/deployment/BACKUP_AND_RECOVERY.md)** — what must be preserved and how to restore it
- **[Roadmap](docs/ROADMAP.md)** — current priorities and acceptance gates

Historical documentation lives on the `docs-history` branch. Dated plans under `docs/plans/` record how work evolved; they are evidence/history, not automatically the current product contract.
