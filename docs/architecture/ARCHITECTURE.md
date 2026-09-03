# Wabi — Architecture

> **Status:** Canonical reference for the current (Rust + Wabidb) implementation.
> **Last major revision:** 2026-06-22 (STDB → Wabidb rip complete).
> **Audience:** Engineers integrating with Wabi, contributors, and curious newcomers.

---

## 1. What Wabi Is

Wabi is a **private, self-hosted, real-time chat platform** for small-to-medium communities (10-50 concurrent users). The application runs as a web app, a native desktop app (Tauri), and a TUI (terminal UI). The same server binary serves all three.

**Core philosophy:** No spying. No bloat. Just chill.

Wabi prioritizes user privacy through:

- **Self-host ownership** — operators run the server; no third-party telemetry, analytics, or data collection
- **Ephemeral by default** — calls, typing indicators, and presence are in-memory only
- **Explicit persistence** — when messages are stored, they're stored in the operator's local database under their control
- **Per-server deployment** — each Wabi instance is a single tenant; no shared multi-tenant cloud

---

## 2. High-Level System

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (SvelteKit)                         │
│  - Pages: Login, Chat, Settings, Voice, Screen Share, Whiteboard │
│  - Components: Messages, Users, DM Panel, Theme, Plugins         │
│  - State: Svelte stores (users, channels, theme, presence)       │
│  - Realtime: Socket.IO client + native WebSocket                  │
│  - Media: WebRTC peer connections (audio/video/screen share)     │
└─────────────┬───────────────────────────────────┬────────────────┘
              │                                   │
        Socket.IO + HTTP                  HTTP + WebSocket
              │                                   │
┌─────────────▼───────────────────────────────────▼────────────────┐
│                  wabi-server (single Rust binary)                 │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ HTTP API (axum): /api/auth, /api/channels, /api/messages, │  │
│  │ /api/calls/*, /api/upload, /api/user, /api/setup, ...     │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Realtime: Socket.IO + WebSocket for presence, chat, calls  │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Storage Adapter (WdbAdapter): translates HTTP requests to  │  │
│  │ wabidb commands and projection queries                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Wabidb Engine (embedded in-process) — single source of    │  │
│  │ truth for all persistent state                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Plugins: hot-loaded modules under /plugins                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────┬───────────────────────────────────────────────────┘
              │
        Filesystem (data/, uploads/, plugins/, target/)
```

**Key simplification:** There is no separate database server. The Wabidb engine is a Rust library linked directly into `wabi-server`. State is persisted to disk inside `wabi-server`'s data directory.

---

## 3. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | SvelteKit | Web framework with file-based routing |
| Frontend state | Svelte stores | Reactive state management |
| Frontend desktop | Tauri | Native desktop app wrapper |
| Frontend TUI | Ratatui (Rust) | Terminal UI client (`wabi-tui`) |
| Frontend realtime | Socket.IO client + WebSocket | Real-time message and presence |
| Frontend media | WebRTC | Peer-to-peer audio, video, screen share |
| Backend runtime | Tokio + axum (Rust) | Async HTTP/WebSocket server |
| Backend storage | Wabidb (embedded) | Per-stream log-structured store with commit index |
| Backend auth | JWT (custom) | Token-based session management |
| Backend realtime | Socket.IO + axum WebSocket | Per-client event delivery + call session push |
| File storage | Filesystem (./uploads, ./data/wabi-server) | User uploads, wabidb streams |
| TURN | Coturn (optional profile) | NAT-traversal media relay |
| SFU | LiveKit (optional profile) | Centralized media routing for >2 participants |
| Reverse proxy | Caddy (optional profile) | TLS + Cloudflare tunnel entrypoint |

---

## 4. Wabidb Engine (The Storage Layer)

Wabidb is the custom storage engine that replaced SpacetimeDB. It is a **per-stream log-structured object store with a global commit index**. The full design is documented in `docs/proposals/wabidb-endstate.md`; the on-disk binary format is in `core/crates/wabidb/docs/STORAGE_FORMAT.md`.

### 4.1 Architecture

```
                ┌───────────────────────────────────────┐
                │            Wabidb Engine              │
                │                                       │
   CommandCommit │  ┌─────────────┐  ┌──────────────┐  │ Projections
   ─────────────►│  │  Commit     │  │  Projection  │  │◄─────────
   (via Wdb-     │  │  Sequencer  │  │  Dispatcher  │  │  (lock-free
    Adapter)     │  │ (Semaphore  │  │  (mpsc       │  │   SkipMap
                │  │   permit 1) │  │   channel)   │  │   reads)
                │  └──────┬──────┘  └──────┬───────┘  │
                │         │              │           │
                │         ▼              ▼           │
                │  ┌─────────────────────────────────────┐
                │  │  ProjectionState (in-memory index) │
                │  │  + per-stream segments on disk     │
                │  └─────────────────────────────────────┘
                └───────────────────────────────────────┘
```

- **Commit sequencer** — single async task holding a `Semaphore(1)` permit. Assigns monotonic `commit_seq`, writes to per-stream segments, appends to the commit index, fsyncs. Projections update asynchronously.
- **Projections** — materialized views of the commit log, indexed for read-path queries. Lock-free `crossbeam-skiplist::SkipMap` per index. Rebuildable from snapshots + post-snapshot commit index entries.
- **Subscription engine** — topic-based pub/sub with snapshot barrier, resume, ticket-auth WebSocket, and membership revalidation.
- **Ephemeral bus** — in-memory broadcast for events that must not survive a crash (typing, call signals, cursor movement).
- **Retention engine** — per-scope TTL with cryptographic deletion (key destruction + tombstone) and segment compaction.
- **Blob store** — BLAKE3 content-addressed files, atomic write ordering, range read protocol.
- **Storage CLI** — operator-facing tools (`wabidb check`, `dump-stream`, `rebuild-indexes`, manifest-based backup).

### 4.2 On-Disk Layout

Per `core/crates/wabidb/docs/STORAGE_FORMAT.md`:

```
$DATA_DIR/
├── streams/
│   ├── channel/
│   │   └── ch_01J.../
│   │       ├── events/00000001.wseg  (segment, 64 MiB max)
│   │       └── snapshots/00000001.wsnap
│   ├── dm/dm_01J.../events/00000001.wseg
│   └── ...
├── global/
│   └── commit-index/
│       ├── 00000001.widx  (sealed)
│       └── 00000002.widx  (current, still appending)
├── blobs/ab/abcd....bin  + abcd....meta
└── manifests/storage-manifest.json
```

Segments are AES-256-GCM encrypted with the stream's key. The commit index is the canonical ordering of all writes; the sequencer fsyncs the index before advancing the linearizability barrier.

### 4.3 Domain Types

The Wabidb domain (`wabidb::domain`) is the typed shape that flows between the engine and the wabi-server adapter. Key types:

- `User`, `Channel`, `ChannelMember` — identity and structure
- `Message`, `Reaction` — chat content
- `CallSession`, `CallParticipant`, `CallSignal` — voice/video call state (replaces STDB call tables)

Each type is serializable via `serde` and is the wire format between the adapter and the projections.

### 4.4 Command Surface

Five wabidb commands (F17) implement the call-session state:

- `create_call_session` — new call session
- `join_call_session` — user joins
- `leave_call_session` — user leaves
- `end_call_session` — host ends the call
- `emit_call_signal` — signaling message (offer, answer, ICE, mute, etc.)

Each command goes through the sequencer, gets a `commit_seq`, and updates the relevant projection.

---

## 5. wabi-server (The HTTP Layer)

`wabi-server` is the single Rust binary that the operator runs. It:

- Serves the embedded SvelteKit frontend (compiled into the binary via `rust_embed`)
- Exposes the HTTP API for all client actions
- Hosts Socket.IO and WebSocket endpoints for real-time
- Owns the Wabidb engine instance (no IPC, no separate process)
- Manages the mesh of helper nodes (in multi-server topology)
- Handles uploads, plugins, and TURN/SFU coordination

### 5.1 Module Boundaries

```
core/crates/wabi-server/
├── src/
│   ├── main.rs           # entrypoint, ServerConfig from env
│   ├── state.rs          # AppState (shared, Arc'd)
│   ├── config.rs         # ServerConfig struct
│   ├── adapter/          # WdbAdapter — implements WabiStore
│   ├── api/              # axum routes
│   │   ├── auth.rs
│   │   ├── channels.rs
│   │   ├── messages.rs
│   │   ├── calls.rs      # NEW: call-session HTTP endpoints
│   │   ├── upload.rs
│   │   ├── user.rs
│   │   ├── public.rs
│   │   └── ...
│   ├── socketio/         # Socket.IO handlers (chat, presence)
│   ├── websocket.rs      # native WebSocket (call session push)
│   ├── auth_extractor.rs # JWT validation
│   ├── mesh.rs           # multi-node coordination
│   ├── nodes.rs          # helper-node registry
│   └── jobs.rs           # offload queue
```

### 5.2 Data Flow Examples

**Writing a message:**
1. Client emits `socket.emit('message:send', { channel_id, content })` over Socket.IO
2. Handler in `socketio/messages.rs` validates auth, calls `state.wdb.send_message(...)`
3. `WdbAdapter.send_message` constructs a `CommandCommit` and submits to `engine.run_command()`
4. The sequencer assigns `commit_seq`, writes to the per-stream segment, appends to the commit index, fsyncs, advances the linearizability barrier
5. The projection dispatcher fans out to the relevant projection handler (e.g. `MessagesProjection::apply`)
6. The HTTP response is returned to the client; other clients receive the event via Socket.IO broadcast

**Reading a message:**
1. Client makes `GET /api/messages/{channel_id}`
2. Handler in `api/messages.rs` calls `state.wdb.list_messages_typed(channel_id, limit)`
3. `WdbAdapter.list_messages_typed` queries `ProjectionState` (in-memory) and deserializes the JSON values
4. The HTTP response is returned to the client

**Joining a call (with WS push):**
1. Client makes `POST /api/calls/sessions/{id}/join` over HTTP
2. Handler in `api/calls.rs` calls `state.wdb.join_call_session(...)`
3. The sequencer writes the new `CallParticipant` and advances the linearizability barrier
4. The handler then pushes a `WsMessage::CallParticipantChanged` event to `state.call_session_push`
5. WebSocket connections subscribed to this session (via `SubscribeCall` message) receive the push event and forward to their clients

---

## 6. Multi-Server Topology

Wabi supports three operational modes (set via `WABI_SERVER_ROLE` in `.env`):

### 6.1 Authority (default)
A standalone server that owns all state. Suitable for single-server deployments. Other Wabi instances cannot connect to it for state sync.

### 6.2 Anchor
A stateless regional proxy that forwards all requests to a designated Authority. Used to provide low-latency access for distant users without running a full server. Anchors do not persist any state.

### 6.3 Mesh
A federated deployment where multiple Authority servers share state via the Wabidb replication module (`wabidb::replication`). The mesh handles:
- Snapshot shipping (initial state sync)
- Anti-entropy (resolving drift between peers)
- Failover (promoting an Anchor to Authority if the primary fails)

The mesh runs on top of helper-node connections, not direct peer-to-peer. See `docs/architecture/WABI_MULTI_SERVER_ARCHITECTURE.md` for the full design.

---

## 7. Client Surfaces

Wabi ships three clients, all speaking the same backend:

### 7.1 Web (SvelteKit)
Located at `frontend/`. The canonical UI. Bundled into `wabi-server` at compile time via `rust_embed` and served at `/`.

### 7.2 Desktop (Tauri)
Located at `frontend/src-tauri/`. Wraps the web client in a native shell. Adds OS integration (notifications, file dialogs, system tray) and bundles a separate `wabi-server` process for desktop-only deployments.

### 7.3 TUI (Ratatui)
Located at `core/crates/wabi-tui/`. A terminal client for headless environments. Speaks the same HTTP + WebSocket API as the web client.

---

## 8. Security Posture

- **No telemetry, no analytics, no auto-update.** The server makes no outbound connections except to the user's configured TURN/SFU/tunnel providers.
- **JWT-only auth.** All HTTP routes (except `/api/public/*` and `/api/setup/*`) require a valid JWT in the `Authorization` header.
- **Per-server data.** No shared multi-tenant cloud. Each deployment is a single tenant.
- **Default non-root.** Docker compose runs `wabi-server` as UID 1000; the binary mount is read-only.
- **No privileged containers.** Compose grants no `privileged: true`, no `cap_add`, no `network_mode: host`.
- **BLAKE3 content addressing for blobs.** Tamper-evident.
- **AES-256-GCM for streams at rest.** Per-stream keys, with cryptographic deletion via key destruction.
- **Bcrypt + Argon2id for password hashing.** (See `auth.rs` and the `wabidb::crypto::bootstrap` module.)

---

## 9. Cross-References

- `core/crates/wabidb/docs/STORAGE_FORMAT.md` — on-disk binary format
- `docs/proposals/wabidb-endstate.md` — Wabidb endstate design
- `docs/proposals/wabidb-call-session-design.md` — call-session design (F16)
- `docs/architecture/wabidb-council-reviews.md` — Council Review #1 invariants
- `docs/architecture/PERSISTENCE_MODEL.md` — persistence tier model
- `docs/architecture/SERVER_MESH_PLAN.md` — multi-server topology
- `docs/architecture/ADDON_ARCHITECTURE.md` — plugin system
- `docs/architecture/CALLING_TRANSPORT_ARCHITECTURE.md` — call media routing
- `docker-compose.yml` — production stack definition
- `scripts/local-dev.sh` — local dev stack bootstrap

---

## 10. What This Document Does Not Cover

- Wire protocol details for Socket.IO events (see `socketio/wiring.rs` and the API reference)
- Internal Wabidb key derivation details (see `wabidb::crypto::bootstrap`)
- Plugin authoring (see `docs/architecture/ADDON_ARCHITECTURE.md`)
- TURN/SFU configuration (see `docs/deployment/TURN_SETUP.md`)
- Operator runbooks (see `docs/deployment/`)