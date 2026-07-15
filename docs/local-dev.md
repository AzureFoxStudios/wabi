# Wabi Local Development Setup

Wabi has two explicitly different local modes. Do not blur them:

- `dev:mock` is frontend-only visual smoke.
- `dev:local` is real development: Rust server + SpacetimeDB + frontend.

Shared server state belongs in SpacetimeDB. Browser-local client caches belong in IndexedDB.

## Prerequisites

- Bun 1.1+
- Rust and Cargo
- Git
- Docker or a working Podman/Compose setup for local SpacetimeDB services
- The Wabi SpacetimeDB module at `spacetimedb/wabi_state_bridge`

## Install dependencies

```bash
bun install
```

## Development modes

### Frontend-only mock mode

```bash
bun run dev:mock
```

Use this only for quick layout and visual smoke checks.

What it does:

- starts Vite on `http://127.0.0.1:5173/`
- uses an in-browser mock socket
- uses browser-local fake data
- does not verify real auth, uploads, profile pictures, permissions, reducers, or STDB state

Mock mode must never be treated as real dev verification.

### Real local dev mode

```bash
bun run dev:local
```

What it expects:

- SpacetimeDB on `http://127.0.0.1:3030`
- STDB proxy on `http://127.0.0.1:3100`
- Rust `wabi-server` on `http://127.0.0.1:3001`
- Vite frontend on `http://127.0.0.1:5173`

`dev:local` refuses to silently fall back to mock or legacy persistence. If `spacetimedb/wabi_state_bridge` is missing, or Docker/Compose is unavailable, it exits with a specific error.

## Verification

For mock mode:

1. Open `http://127.0.0.1:5173/`.
2. Confirm the UI shell renders.
3. Treat all backend-dependent behavior as unverified.

For real local mode:

1. Open `http://127.0.0.1:5173/`.
2. Confirm backend health:
   ```bash
   curl http://127.0.0.1:3001/health
   ```
3. Register or guest-login through the real Rust backend.
4. Verify profile pictures, permissions, uploads, messages, and settings through the real stack.

## Ports

- Frontend dev server: `5173`
- Rust backend: `3001`
- SpacetimeDB direct HTTP: `3030`
- STDB proxy: `3100`
- Optional Chromium remote debugging for smoke tests: `9223`-`9229`

## Troubleshooting

- Missing `spacetimedb/wabi_state_bridge`: restore/add the STDB module before using real dev mode.
- Docker permission denied: fix Docker socket access, configure Podman Compose, or start STDB/Rust services separately and point the frontend at them.
- Need pure visual smoke: use `bun run dev:mock`, but do not treat that as backend verification.

## Useful checks

```bash
cd frontend && bun run check
cd frontend && bun run build:only
cargo check -p wabi-server
```
