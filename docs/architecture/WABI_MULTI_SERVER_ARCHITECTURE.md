# Wabi Architecture — Multi-Server Model

> **Status:** Live on wabi.chat (user-facing federation UX).
> **Date:** 2026-04-27 (originally); 2026-06-22 (rewritten for Wabidb era).
> **Scope:** How users connect to and switch between multiple self-hosted Wabi servers.

This document is the **user-facing federation UX**. It is distinct from `SERVER_MESH_PLAN.md`, which describes the runtime mesh between Authority and Anchor nodes of a single Wabi deployment.

## Core Principle

**Wabi is a TOOL, not a SERVICE.**

- Users run their own servers
- A single client can connect to multiple independent servers
- No central coordination between servers (no global user directory, no cross-server messaging)
- Clean legal separation: "I publish software, you run your server"

## User Experience

### Adding a Server

1. Click server button (top-left corner)
2. Click "Add server"
3. Enter server URL (e.g., `https://friend-server.com` or `http://192.168.1.100:3000`)
4. Click "Open"
5. Client saves server to localStorage
6. User can switch between servers anytime

### Server Switcher Panel

Shows:

- List of saved servers (with favicons/logos)
- Recent servers
- Followed servers (future feature)
- Add/Remove server buttons
- Server folders (organize servers into groups)

### Multi-Server Client

**Tauri app (desktop/mobile):**

- Stores list of servers locally
- Connects to multiple servers simultaneously
- Shows server switcher (like Slack workspace switcher)
- Each server has independent auth (different accounts possible)
- Notifications per server

## Server Architecture (per server)

Each server is a self-contained `wabi-server` binary instance. It:

- Serves frontend (embedded static files via `rust_embed`)
- Handles HTTP API routes (`/api/*`)
- Manages Socket.IO connections
- Manages the embedded Wabidb engine for all state
- Persists to its own `./data/wabi-server/` directory
- No peer-to-peer sync with other servers (use `SERVER_MESH_PLAN.md` for multi-node within a deployment)

A user connecting to a single Wabi server experiences the same UI as one connecting to many — the server is just a URL.

## Privacy Implications

Because each server is independent:

- A user's identity (account, password hash, message history) exists ONLY on the server they registered with
- There is no global username registry — two users with the same name on different servers are unrelated
- A user joining a second server must register separately; they have a different account on each
- Cross-server DMs are not supported (the server is the trust boundary)

This is by design. Wabi is not a federated protocol like Matrix or ActivityPub; it is a self-hosted single-tenant server that happens to support a multi-server UI for users who want to interact with multiple Wabi deployments.

## Cross-References

- `docs/architecture/SERVER_MESH_PLAN.md` — runtime mesh between Authority and Anchor nodes (separate concern)
- `docs/architecture/ARCHITECTURE.md` §6 — multi-server topology
- `frontend/src/lib/components/` — server switcher UI components (Svelte)
- `core/crates/wabi-tui/` — TUI client (also supports multi-server)