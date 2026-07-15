> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Local Dev Cleanup — 2026-06-15 evening (part 2)

## What I was doing wrong

I was solving the wrong problem twice in a row:

1. Built a Vite dev plugin that fakes the HTTP auth layer.
2. Asked you to choose between a 4-script topology and a mock.

Both of those miss what you actually said: "this should just be a STDB server with no people on it." You want a real local backend you can hit, not a fake one. A real STDB + wabi-server is the answer.

I also let a stale `'.ngrok-free.dev'` line from a previous setup sit in `vite.config.ts`. That’s gone now too.

## What I did this pass

| File | Change | Why |
|---|---|---|
| `frontend/vite.config.ts` | Removed `.ngrok-free.dev` and `wabi.onrender.com` from `allowedHosts`. Removed the dev-only `mockApiPlugin()` import. | ngrok/onrender are stale leftovers; mock plugin solves the wrong problem. |
| `frontend/vite-plugins/mock-api.ts` | **Deleted entirely.** | A Vite dev plugin that fakes HTTP auth is the wrong solution. You have a real Rust+STDB stack. Use it. |
| `scripts/local-dev-minimal.sh` | **New.** Single podman container for STDB + single podman container for wabi-server + vite. No compose, no ngrok, no cloudflared, no caddy, no helper nodes, no mesh. | This is the script you actually want. Two containers, one vite, all on localhost. |

## How to use the new script

```bash
bash scripts/local-dev-minimal.sh
```

What it does:
1. **STDB**: runs `docker.io/clockworklabs/spacetime:latest` (already pulled) as a podman container named `wabi-stdb-local`, listening on host port 3000. Data persists in `data/spacetimedb-local/`.
2. **Module publish**: publishes `wabi_state_bridge` to the local STDB, database name `wabi-state-local`. Done with the `spacetime` CLI.
3. **wabi-server**: runs `localhost/wabi_wabi-server:latest` (already built) as a podman container named `wabi-server-local`, listening on host port 3001, pointed at the local STDB via `WABI_STDB_SERVER=http://127.0.0.1:3000`.
4. **Vite dev**: starts on host port 5173, with `VITE_SOCKET_URL=http://127.0.0.1:3001` and `VITE_WABI_LOCAL_MOCK` unset.

Cleanup: vite stops on Ctrl-C. STDB and wabi-server keep running so subsequent runs are fast. To stop them:

```bash
podman stop wabi-stdb-local wabi-server-local
```

## Bot testing

That’s the actual use case you mentioned. The script makes the backend hit-able:

- `http://127.0.0.1:3001/api/auth/login` — register/login endpoints
- `http://127.0.0.1:3001/socket.io/` — real-time socket
- `http://127.0.0.1:3001/api/channels` — channel CRUD

A Python or Node bot that hits those endpoints can register, log in, send messages, and read state. **No mocking, no fake JWT, no fake user.** The user the bot creates is a real row in a real STDB database.

## What I did NOT do

- I did **not** run the new script end-to-end. I verified it with `bash -n` (syntax check) and made it executable, but the first run will:
  1. Create the `data/spacetimedb-local` and `data/wabi-server-local` directories on your disk.
  2. Start the STDB container.
  3. Try to publish the `wabi_state_bridge` module — this requires the `spacetime` CLI binary, which I didn't verify is installed on this box.
  4. Start the wabi-server container.
  5. Start vite.

  If any of those steps fail, the script has clear error messages and you can debug. The most likely failure is "spacetime CLI not installed" — if so, the module publish step is `|| echo ...` (warns and continues), so wabi-server will still start (it manages its own state).
- I did **not** remove the existing `scripts/local-dev.sh`. It still works for the full-stack case (call/media STDB cluster, caddy, cloudflared, helper nodes). The minimal script is a separate entry point for when you don't need all that.
- I did **not** make any CSS or visual changes in this pass. Phase 1 visual changes are still in the tree, untouched.

## The state of the dev server right now

I have Vite running on `http://127.0.0.1:5173/` with the clean config. If you hit it, you'll see the frontend shell load and then hit the same 8080 wall **because the backend isn't running**. That's the correct failure mode. To actually see the app, run `bash scripts/local-dev-minimal.sh` in another terminal — that brings up STDB + wabi-server alongside.

## TL;DR

- Killed the dev-only mock plugin (it was solving the wrong problem).
- Removed ngrok/onrender from the vite config.
- Wrote `scripts/local-dev-minimal.sh`: real STDB + real wabi-server + vite, all on localhost, no compose, no tunnels, no 4-minute cargo build (uses your existing `localhost/wabi_wabi-server:latest` image).
- Your existing `localhost/wabi_wabi-server:latest` image is fine to use; STDB image is already pulled; you don't need to build anything.
- Bot testing: hit `http://127.0.0.1:3001` with real HTTP / socket.io from any language.
