# Wabi Installation Guide

> **Status:** Updated 2026-06-22 (Wabidb era; SpacetimeDB install steps no longer needed).

## Requirements

- **Docker** or **Podman** (with `docker compose` or `podman compose`)
- A Linux, macOS, or Windows host
- 1 GB RAM minimum, 2 GB recommended
- 5 GB free disk for the Wabidb data directory

That's it. Wabidb is embedded in the `wabi-server` binary — there is no separate database server to install.

---

## Option 1: Docker (Recommended)

One command, everything included:

```bash
docker compose up -d
```

This starts:
- `wabi-server` (Rust binary with embedded Wabidb engine)
- (Optional profile) Caddy reverse proxy
- (Optional profile) TURN server
- (Optional profile) SFU (LiveKit)
- (Optional profile) Cloudflare tunnel

**Access:** `http://localhost:3001`

**Configuration:** create a `.env` file in the repo root with at minimum:
```
JWT_SIGNING_KEY=<run: openssl rand -base64 48>
```

Optional `.env` values for the various profiles are documented in `docker-compose.yml`.

---

## Option 2: Native Install (No Docker)

### Step 1: Install Rust toolchain
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Step 2: Clone and build
```bash
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi
cargo build --release -p wabi-server
```

### Step 3: Create data directory
```bash
mkdir -p data/wabi-server uploads plugins
```

### Step 4: Run
```bash
JWT_SIGNING_KEY=$(openssl rand -base64 48) \
  ./target/release/wabi-server --data-dir ./data/wabi-server --port 3000
```

**Access:** `http://localhost:3000`

The Wabidb engine creates its subdirectory structure under `./data/wabi-server/` on first run.

---

## Option 3: Tauri Desktop App

If you want a bundled desktop client (includes a private `wabi-server` instance):

```bash
cd frontend/src-tauri
cargo build --release
./target/release/wabi-desktop
```

The Tauri build embeds both the SvelteKit frontend and a wabi-server binary. See `PROJECT_DOCS/05-tauri/TAURI_BUILD.md` for build details.

---

## First-Run Configuration

On first run, the server creates an admin user from these env vars (or interactive setup):
- `WABI_ADMIN_USER_IDS` (comma-separated user IDs allowed to create/delete channels)

After first run, additional configuration is done via the Web UI.

---

## Optional: TURN Server (for voice/video NAT traversal)

Add the `turn` profile to your compose invocation:
```bash
docker compose --profile turn up -d
```

See `PROJECT_DOCS/02-deployment/TURN_SETUP.md` for full TURN configuration.

---

## Optional: Multi-Server (Mesh)

For Authority + Anchor topology:

1. Set `WABI_SERVER_ROLE=authority` on one node, `WABI_SERVER_ROLE=anchor` on others
2. Set `WABI_AUTHORITY_URL` on the Anchors pointing to the Authority
3. Set `WABI_MESH_SHARED_TOKEN` (a random shared secret) on all nodes
4. Start the services

See `PROJECT_DOCS/01-architecture/SERVER_MESH_PLAN.md`.

---

## Verification

After install, verify the server is healthy:
```bash
curl http://localhost:3000/health
# expected: {"status":"ok"}
```

And verify the Wabidb engine started cleanly:
```bash
docker logs wabi-server 2>&1 | grep -i 'wabidb\|engine started'
```

---

## Cross-References

- `PROJECT_DOCS/01-architecture/ARCHITECTURE.md` — system architecture
- `PROJECT_DOCS/02-deployment/DEPLOYMENT.md` — production deployment
- `PROJECT_DOCS/02-deployment/FRESH_INSTALL.md` — fresh install walkthrough
- `PROJECT_DOCS/02-deployment/TURN_SETUP.md` — TURN deployment
- `docker-compose.yml` — production stack definition
- `scripts/local-dev.sh` — local dev stack bootstrap