# Wabi Local Development Setup

This guide explains how to set up Wabi for local development on any computer.

## Prerequisites

- [Bun](https://bun.sh/) (version 1.1+)
- [Rust](https://www.rust-lang.org/tools/install) and Cargo
- Git
- (Optional) [Docker](https://www.docker.com/) for containerized dependencies (not required for basic dev)

## Setup

1. Clone the repository (if you haven't already):

   ```bash
   git clone https://github.com/AzureFoxStudios/wabi.git
   cd wabi
   ```

2. Install Bun dependencies:

   ```bash
   bun install
   ```

   Note: The frontend has its own `package.json` but Bun hoists dependencies, so a single `bun install` at the root is sufficient.

## Development Modes

Wabi provides two local development modes:

### 1. Frontend-Only Mock Dev Mode (`bun run dev:mock`)

Use this mode when you want to work on the frontend UI without a real backend or SpacetimeDB.

- Starts a Vite dev server for the frontend only.
- Uses an in-browser mock socket that simulates connected state.
- Seeds mock data: users, channels, messages, roles.
- Persists mock messages to browser `localStorage` (key: `wabi:local-mock:messages:v1`).
- Ideal for rapid UI iteration, offline work, or when backend setup is problematic.

To start:

```bash
bun run dev:mock
```

Then open: <http://127.0.0.1:5173/>

### 2. Real Stack Dev Mode (`bun run dev:local`)

Use this mode when you need the real Rust backend and Socket.IO connection.

- Starts the Rust `wabi-server` on port 3000.
- Starts the frontend Vite dev server on port 5173.
- Requires a working SpacetimeDB setup (or local STDB container) for full functionality.
- Backend data is stored in `backend/data/`.

To start:

```bash
bun run dev:local
```

Then open:
- Frontend: <http://127.0.0.1:5173/>
- Backend health: <http://127.0.0.1:3000/health>

## Verification

### Quick Smoke Test

Run the smoke helper script to verify both modes:

```bash
./scripts/local-dev-smoke.sh
```

It will check:
- Frontend HTTP 200 (both modes)
- Backend HTTP 200 (only in `dev:local` mode)
- Print clear PASS/FAIL lines.

### Manual Checks

#### For `dev:mock`:
1. Confirm you see the app shell after guest login.
2. Verify no "Connection Lost" banner appears.
3. Check that mock channels (`general`, `Voice Lounge`) and users (`Mira`, `Taro`) are present.
4. Send a message in `general` and confirm it does not remain stuck as "sending".
5. Refresh the page and confirm mock messages persist.

#### For `dev:local`:
1. Confirm frontend loads and you can log in (guest or registered).
2. Verify backend `/health` returns HTTP 200 with JSON:
   ```json
   {"role":"authority","service":"wabi-server","status":"ok",...}
   ```
3. Note: You may see a reducer failure in the backend logs during startup:
   ```
   wabi_server::db: Reducer call failed: Failed to call reducer
   ```
   This is a known issue with default channel seeding in SpacetimeDB but does not block the health check or basic functionality. It is safe to ignore for frontend work.

## Ports

- Frontend dev server: `5173`
- Backend server: `3000`
- (Optional) Chromium remote debugging: `9223`-`9229` (used by smoke tests)

## Troubleshooting

### Common Issues

- **"Address already in use"**: Kill existing processes:
  ```bash
  pkill -f 'bun run dev:mock' || true
  pkill -f 'bun run dev:local' || true
  pkill -f 'vite dev --host 127.0.0.1' || true
  pkill -f 'wabi-server' || true
  ```
- **Missing dependencies**: Ensure Bun and Rust are installed and in your PATH.
- **Backend health fails**: Verify the `wabi-server` binary is built (it should be on first `bun run dev:local`). Check logs for Rust panics.
- **Mock mode not working**: Ensure `VITE_WABI_LOCAL_MOCK=1` is set (the `dev:mock` script does this automatically).

### Logs

- Frontend dev server logs: stdout of `bun run dev:mock` or `bun run dev:local`
- Backend logs: stdout of `bun run dev:local` (look for lines starting with `wabi_server`)

## Next Steps

Once you have local dev working, you can:
- Work on UI components using `bun run dev:mock` for fast iteration.
- Switch to `bun run dev:local` when you need to test real socket/backend behavior.
- Run `bun run check` to verify TypeScript and Svelte types.
- Run `STATIC_BUILD=1 bun run build` to verify production build.

---

> **Note**: This document is intended for developers setting up Wabi on a new machine or refreshing their environment. For detailed architecture and contribution guidelines, see other docs in `/docs`.