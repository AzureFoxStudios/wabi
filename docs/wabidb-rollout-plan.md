# Wabi + WabiDB v1 — Rollout Plan

> **Date:** 2026-06-21
> **Audience:** Self-hosters deploying wabi-server with WabiDB for the first time.
> **Scope:** v1 production cutover. Assumes the operator is comfortable with Linux, systemd, and Rust toolchain basics.

## What you're deploying

Wabi is a self-hosted chat application. WabiDB is its embedded storage engine — a log-structured, per-stream database with X3DH/DR crypto, projections, and a STDB-shaped API.

- **wabi-server** — Rust binary. HTTP + WebSocket. The "back end" most users don't see.
- **wabi-frontend (Tauri)** — desktop client (5–10 MB). Most users get this. Connects to wabi-server over LAN or Tailscale.
- **WabiDB** — embedded in wabi-server. No separate process. **WDB is the only persistence layer; STDB is gone.**

## System requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| OS | Linux x86_64 (Bazzite/Fedora/RHEL/Ubuntu), macOS, or Windows + WSL2 | Linux x86_64 |
| CPU | 2 cores | 4+ cores |
| RAM | 512 MB | 1 GB+ |
| Disk | 200 MB (binary + deps) | 5+ GB (logs, message history, blobs) |
| Network | LAN (Tailscale recommended for self-hosting) | Public IP + reverse proxy (Caddy/nginx) |

Database directory: 1–10 GB per 1M messages, depending on average message size. Monitor via `wabi-server admin disk` (CLI).

## Install

### 1. Build from source

```bash
# Rust toolchain (stable + nightly for benchmarks)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup install nightly

# Clone the wabi monorepo
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi

# Build the wabi-server (release, LTO, strip)
cargo build -p wabi-server --release \
    --config 'profile.release.lto="fat"' \
    --config 'profile.release.codegen-units=1' \
    --config 'profile.release.strip="symbols"'

# Binary: target/release/wabi-server (~50-80 MB)
ls -lh target/release/wabi-server
```

### 2. Choose your data dir

The data dir holds WabiDB's commit log, projections, and any uploaded blobs.

```bash
sudo mkdir -p /var/lib/wabidb
sudo chown $USER:$USER /var/lib/wabidb
chmod 700 /var/lib/wabidb
```

### 3. Configure

`wabi-server` reads env vars. Minimum set:

```bash
# Required: where WDB stores its data
export WABI_DB_DATA_DIR=/var/lib/wabidb

# Required for production: a passphrase to derive the bootstrap key
# (instead of using a baked-in test key)
export WABI_DB_PASSPHRASE='<long random string>'
export WABI_DB_PASSPHRASE_SALT='<16 random bytes hex>'

# Optional: bind address (default 0.0.0.0:3000)
export WABI_BIND=0.0.0.0:3000

# Optional: Tailscale-only mode (no public internet)
export WABI_TAILSCALE_ONLY=1
```

Generate a passphrase + salt:
```bash
PASS=$(openssl rand -base64 32)
SALT=$(openssl rand -hex 16)
echo "WABI_DB_PASSPHRASE=$PASS"
echo "WABI_DB_PASSPHRASE_SALT=$SALT"
```

Save these to `/etc/wabidb.env` (mode 600) and source them in the systemd unit.

### 4. systemd unit

`/etc/systemd/system/wabi-server.service`:

```ini
[Unit]
Description=Wabi chat server (WabiDB)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wabi
Group=wabi
EnvironmentFile=/etc/wabidb.env
ExecStart=/usr/local/bin/wabi-server
Restart=on-failure
RestartSec=5s

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/wabidb
PrivateTmp=true
PrivateDevices=true

# Resource limits
MemoryMax=2G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin wabi
sudo install -m 755 target/release/wabi-server /usr/local/bin/
sudo systemctl daemon-reload
sudo systemctl enable --now wabi-server
sudo systemctl status wabi-server
```

### 5. Reverse proxy (Caddy)

`/etc/caddy/Caddyfile`:

```
wabi.example.com {
    reverse_proxy 127.0.0.1:3000
    basicauth {
        admin JDJhJDE0JDlMcXhRZzJ0...
    }
}
```

For Tailscale-only, no reverse proxy needed — Tailscale handles TLS.

### 6. Frontend (Tauri client)

The frontend is a separate Tauri build. For the v1 desktop client, your users install it from your distribution channel (e.g., GitHub releases, internal web download). The Tauri client connects to your wabi-server.

The Tauri config points at the server URL:
```toml
# src-tauri/tauri.conf.json
"build": {
    "beforeBuildCommand": "npm run build",
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../build"
}
```

Build:
```bash
cd frontend
npm install
npm run tauri-build
# Output: src-tauri/target/release/bundle/{deb,dmg,msi,appimage}/
```

## Verify

```bash
# Health check
curl -s http://localhost:3000/health | jq
# {"status":"ok","engine":"wabidb","version":"1.0.0","commit_seq":N}

# Disk usage
wabi-server admin disk

# Recent commits (audit trail)
wabi-server admin log --since 1h
```

## Maintenance

### Backup

The data dir is a single tree. Back it up however you back up other files:

```bash
# Cold backup (stop server first)
sudo systemctl stop wabi-server
sudo tar czf /backup/wabidb-$(date +%Y%m%d).tar.gz /var/lib/wabidb
sudo systemctl start wabi-server

# Hot backup (uses WDB's built-in snapshot)
wabi-server admin snapshot --output /backup/wabidb-$(date +%Y%m%d).tar.gz
```

Restore:
```bash
sudo systemctl stop wabi-server
sudo rm -rf /var/lib/wabidb
sudo tar xzf /backup/wabidb-20260621.tar.gz -C /
sudo systemctl start wabi-server
```

### Update

```bash
git pull
cargo build -p wabi-server --release
sudo install -m 755 target/release/wabi-server /usr/local/bin/
sudo systemctl restart wabi-server
```

WDB is forward-compatible across v1.x patch releases. For v1.0 → v2.0, see the migration doc (TBD).

### Monitor

```bash
# Commit throughput (last 1 min)
wabi-server admin metrics --window 60s --rate

# Disk pressure
wabi-server admin disk

# Active sessions
wabi-server admin sessions
```

For external monitoring, the wabi-server exposes `/metrics` (Prometheus format). Use the Caddyfile's `/metrics` route to expose internally.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `lock file` error on startup | Another wabi-server is running on the same data dir | `wabi-server admin unlock` (or find the other process) |
| `UnknownStreamKey` errors on writes | A new stream was created without registering its key | Restart the server (recovery rebuilds projections) |
| Slow commit throughput | Disk full or fsync bottleneck | `wabi-server admin disk`; check disk IO with `iostat` |
| Cannot connect from Tauri client | Tailscale not running, or wrong server URL | Check `tailscale status`; verify `WABI_BIND` is reachable |
| Memory growing unbounded | Likely a connection leak; check `/health` for `open_connections` count | Restart; report bug |

## When things go wrong

The data dir is your blast radius. Every WDB commit goes to disk via fsync. A pull-the-plug event loses the last unfinished batch (at most a few hundred events). WDB replays from the commit log on restart and rebuilds projections. **You will not corrupt data on crash.** But:

- **Disk full**: writes fail with `StorageFull`. WDB doesn't auto-evict; you have to free space.
- **Permission denied on data dir**: server won't start. Check the systemd unit's `User` and `ReadWritePaths`.
- **Wrong passphrase**: WDB can't decrypt the bootstrap key, can't open the data dir, server panics. **The passphrase is not recoverable. Lose it = lose the data.**

## When you don't need this doc

- You're running wabi in dev mode (`cargo run -p wabi-server`)
- You're integrating wabi as a library (the WabiDB crate is `core/crates/wabidb/`)
- You're using wabi for a single-user self-host (skip the reverse proxy + systemd, run the binary directly)

## Where to go next

- **`docs/wabidb-test-plan.md`** — the validation suite (MIRI, valgrind, load test)
- **`docs/wabidb-council-reviews.md`** — design decisions (Option B, burned-seq, MAX_SKIPPED_KEYS)
- **External DB review** — for the engine internals
- **Frontend rewrite** — Svelte vs htmx decision, Tauri config
- **Wabi client desktop build** — bundle the Tauri app for distribution

---

*Document version: 2026-06-21. WabiDB v1.0.*
