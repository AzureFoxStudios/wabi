# Wabi Architecture

> **Status:** canonical high-level architecture for the current Rust + WabiDB product line.  
> **Updated:** 2026-09-14  
> For exact handler/projection details, read [`overview.md`](overview.md) and current source. For maturity claims, [`../PROJECT_STATUS.md`](../PROJECT_STATUS.md) wins over old plans/proposals.

## 1. Product model

Wabi is a self-hosted communication and collaborative-workspace application for small communities.

The normal deployment is deliberately simple:

```text
Wabi client
    │
    ├─ HTTP
    ├─ Socket.IO
    └─ WebSocket / media transports
    │
    ▼
┌───────────────────────────────────────────┐
│ wabi-server — Authority                   │
│                                           │
│ Axum API + auth                           │
│ Socket.IO / WebSocket realtime            │
│ embedded SvelteKit static frontend        │
│ WabiStore / WdbAdapter                    │
│ embedded WabiDB                           │
└───────────────────────────────────────────┘
    │
    ├─ data/wabi-server/
    ├─ uploads/
    └─ optional helpers/integrations
```

One Authority owns one community's canonical accounts, permissions, content, and durable state.

A client can save/switch among multiple independent Authorities. That is **not federation**: those servers do not share a global identity database or community state.

## 2. Core runtime

`core/crates/wabi-server/` is the main server binary. It owns:

- HTTP API routes;
- authentication/authorization;
- Socket.IO and raw WebSocket entry points;
- call/session coordination;
- uploads/files and feature APIs;
- the `WdbAdapter` bridge into WabiDB;
- optional helper/integration coordination;
- serving the compiled static frontend through `rust_embed`.

The normal server does not require PostgreSQL, SQLite, SpacetimeDB, Redis, or another external state service. WabiDB is linked in-process.

Optional TURN/SFU/tunnel/media helpers are separate deployment choices; they do not replace the Authority as source of truth.

## 3. WabiDB mental model

Durable state follows the event-sourced path:

```text
request / socket command
        │
        ▼
   validation + auth
        │
        ▼
     WabiStore
        │
        ▼
   CommandCommit
        │
        ▼
 single sequencer
        │
        ├─ encrypted event segment(s)
        ├─ global commit index
        └─ projection application
                 │
                 ▼
          typed read projections
                 │
                 └─ response / live broadcast
```

Key properties of the current engine:

- one sequenced durable writer;
- monotonic commit ordering;
- encrypted append-only stream segments plus commit index;
- in-memory materialized projections rebuilt/recovered from durable state;
- command success is tied to the engine/application completion contract, not merely “bytes were handed to a socket”;
- projection/read models are the normal query path;
- durable-record compatibility matters because old events must remain replayable.

See [`PERSISTENCE_MODEL.md`](PERSISTENCE_MODEL.md), [`STORAGE_FORMAT.md`](STORAGE_FORMAT.md), [`STORAGE_MANIFEST.md`](STORAGE_MANIFEST.md), and `../ai/`.

### Persistent schema rule

Many records are postcard-encoded. Adding/reordering fields without a versioned/dual-decode path can make old events unreadable. Persistent-record evolution is therefore an architectural migration, not a casual Rust-struct edit.

## 4. Retention is decided before persistence

Wabi separates retention from confidentiality.

Typical message storage classes include:

- **live** — delivered from memory without the normal durable message write;
- **timed** — durable, then removed according to retention policy;
- **forever** — durable until explicitly removed.

These classes answer **how long the server keeps content**. They do not answer **whether the operator can read it**.

Current DMs/private rooms are server-readable and are not a shipped E2EE path. See [`../PRIVACY_STANCE.md`](../PRIVACY_STANCE.md).

## 5. API and realtime ownership

REST and realtime handlers must enforce the same resource/membership rules.

The server owns:

- account/session authentication;
- channel/conversation membership;
- owner/admin/role authorization;
- admission to group/private content;
- persistence outcomes;
- authoritative call/session state where the corresponding path uses WabiDB;
- correlated success/failure so a client does not invent a successful mutation after a transport failure.

A UI hiding a button is not authorization.

Private-resource discovery and mutation must be filtered/validated on the server even if the normal client never asks for unauthorized data.

See [`../SECURITY-MODEL.md`](../SECURITY-MODEL.md).

## 6. Frontend architecture

`frontend/` is a SvelteKit/Svelte 5 static application. Production/static builds are embedded into the Rust server.

Important UI ownership:

- the main layout owns dockable left/right/center workspace structure;
- shared workspace navigation should be reused instead of each feature inventing its own top-level router/state store;
- server/account-scoped state must remain scoped when switching communities;
- client offline/outbound queues are not a second authoritative database;
- local drafts/preferences/effects are distinct from published/shared server state.

### Workspace model

Wabi's product is broader than chat scrollback. Center-stage/dock surfaces include communication plus tools such as whiteboard, Planner/Notes-style workspaces, files/media, Reader, project/Lore, CAD/3D, and related inspection/review views.

New tools should normally integrate with this layout model rather than adding a permanent parallel sidebar/header system.

## 7. Native clients

### Web

The browser client is the canonical shared frontend and is served by the Authority.

### Desktop / Tauri

`src-tauri/` wraps the web client in a native shell and adds OS/native capabilities such as local file workflows, sidecars, private-access tooling, native dialogs, and platform integration.

A successful web build does not prove native packaging/permissions/sidecars on every OS.

### Mobile

Phone-native Tauri work is active but remains a separate release/physical-device acceptance boundary. Do not treat a mobile branch or successful source compile as a production mobile release.

### TUI

`core/crates/wabi-tui/` provides terminal-client functionality against the same server trust boundary.

## 8. Multi-server client model — not federation

The server bar/client can remember multiple Wabi Authorities:

```text
client
  ├─ community A → Authority A + its account
  ├─ community B → Authority B + its account
  └─ community C → Authority C + its account
```

No global Wabi username service is required. Credentials/offline actions must remain scoped to the correct server/account.

See [`WABI_MULTI_SERVER_ARCHITECTURE.md`](WABI_MULTI_SERVER_ARCHITECTURE.md).

## 9. One-deployment topology

Multi-node work inside **one** community is distinct from the multi-server client model.

### Authority — available/core

The Authority owns durable community state and canonical mutation decisions.

### Scoped helpers — optional

TURN, SFU, SRT/media gateway, tunnels/private access, and other helpers perform bounded jobs. They should be observable and optional where practical.

### Anchor — experimental

`WABI_SERVER_ROLE=anchor` creates a stateless proxy toward `WABI_AUTHORITY_URL` without opening a local community WabiDB.

Current limitation: the path is HTTP-oriented; native WebSocket upgrade forwarding is not a completed guarantee. Therefore Anchor is not yet a complete regional realtime edge.

### WabiDB peer replication — experimental

Authentication/timeouts/failure handling exist in the replication transport, but full live projection convergence, deletion semantics, and writer/failover safety are not proven.

The network sync surface is explicitly experimental/fail-closed by default. It is not a production backup or HA feature.

### Warm standby — incomplete

Standby envelope/storage groundwork exists, but safe export/import/promotion of live current state is not complete. Automatic Authority election is intentionally disabled.

The required progression is real backup/export → tested restore → manual promotion → failure injection/no split-brain proof → only then consider automatic failover.

See [`SERVER_MESH_PLAN.md`](SERVER_MESH_PLAN.md) and [`../deployment/BACKUP_AND_RECOVERY.md`](../deployment/BACKUP_AND_RECOVERY.md).

## 10. Calling/media architecture

Calling spans several layers:

- authenticated call/session/admission state;
- signaling/realtime delivery;
- media transport (WebRTC and/or Wabi media-relay paths depending current configuration/path);
- optional coturn TURN;
- optional LiveKit SFU;
- optional media gateway paths.

These are not interchangeable.

Do not infer that an SFU is required because the codebase supports one, or that a browser harness certifies real NAT/audio-device behavior. Use [`CALLING_TRANSPORT_ARCHITECTURE.md`](CALLING_TRANSPORT_ARCHITECTURE.md) for transport detail.

## 11. CAD / model review architecture

Wabi's design boundary is **inbox/viewer/review surface**, not authoring CAD.

Current convergence paths:

```text
DXF ─────────────────────────► 2D CAD viewer/review
DWG ─ optional dwg2dxf ──────► 2D CAD viewer/review
3MF ─ browser loader ─► GLB ─► normal 3D viewer
STEP/IGES ─ OCCT WASM ► GLB ─► normal 3D viewer
```

Important design rules:

- review marks use drawing/model coordinates rather than screenshot pixels;
- converted temporary URLs must preserve stable attachment/review identity;
- Model Space/Paper Space and spatial-content warnings must not imply a flattened preview is the complete solid model;
- optional DWG conversion stays an operator-provided helper rather than silently changing the MIT distribution boundary.

## 12. Lore/project integration

Wabi supplies a real Lore project workspace and local-folder/review UX, while the Lore backend/tooling remains an optional external integration.

Architecturally, keep these states distinct:

- local/private draft or filesystem state;
- staged/proposed change;
- reviewed/published server/project state.

Do not describe local editor changes as live shared publication unless an actual collaborative protocol exists.

## 13. Plugins and addons

There are two different maturity levels:

- curated/compiled integrations under `core/addons/`, `addons/`, and feature code;
- operator-installed runtime plugins under `plugins/`.

Plugin manifests/checksums/signatures/scanning/audit controls improve supply-chain safety. They do not by themselves prove a hostile-code sandbox.

The legacy `mesh` addon is compatibility/history, not the living topology.

See [`../ADDONS.md`](../ADDONS.md) and [`ADDON_ARCHITECTURE.md`](ADDON_ARCHITECTURE.md).

## 14. Storage and backup boundary

The key deployment state includes:

- `data/wabi-server/` — WabiDB + persisted secrets when locally generated;
- `uploads/` — uploaded user content;
- external secret/config sources when used;
- optional plugin/helper data needed by that deployment.

A WabiDB root key must be preserved with the encrypted data it protects.

Experimental peer replication/standby is not a backup substitute. See [`../deployment/BACKUP_AND_RECOVERY.md`](../deployment/BACKUP_AND_RECOVERY.md).

## 15. Security/privacy invariants

- Self-hosted does not mean operator-blind.
- Current DMs/private rooms are not E2EE.
- Independent servers do not receive a global trust relationship merely because one client displays them together.
- Resource authorization belongs on the server.
- Operator/break-glass interfaces must remain private and strongly gated.
- Runtime plugins/external helpers expand the trust/attack surface.
- Public deployments should use TLS or a deliberately private encrypted access path.
- Experimental sync/standby write surfaces should fail closed unless explicitly enabled for development/testing.

## 16. Repository map

| Path | Responsibility |
|---|---|
| `core/crates/wabi-server/` | Authority/API/realtime/auth/integration coordinator |
| `core/crates/wabidb/` | Event store, sequencer, projections, recovery, experimental replication |
| `crates/wabi-core/` | Shared protocol/domain wire types and TS generation |
| `frontend/` | Web/static client and workspace UI |
| `src-tauri/` | Native shell |
| `core/crates/wabi-tui/` | Terminal client |
| `core/addons/`, `addons/` | Curated/compatibility/sample integrations |
| `plugins/` | Runtime-installed plugin packages |
| `turn-server/`, `media-gateway/`, `relay-node/` | Optional transport/media helpers |
| `docs/` | Living architecture, deployment, security, product-status docs |

## 17. What Wabi does not currently claim

- social federation between independent servers;
- global Wabi identity;
- E2EE DMs/private rooms;
- production active-active writers;
- automatic Authority failover/election;
- production-ready WabiDB peer replication/standby restore;
- a complete regional WebSocket edge through Anchor;
- a full CAD editor;
- safely sandboxed arbitrary hostile backend plugins;
- production-certified native mobile clients.

Those boundaries are architectural constraints, not embarrassing footnotes. Keeping them explicit is what makes future work testable.
