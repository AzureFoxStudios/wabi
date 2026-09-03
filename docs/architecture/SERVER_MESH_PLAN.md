# Wabi Server Mesh Plan

> **Status:** Implementation plan (in progress).
> **Last revision:** 2026-06-22 (rewritten for Wabidb era; previously described SpacetimeDB-era mesh).
> **Owner:** Backend / state-plane / runtime workstream.

## 1. Goal

Give Wabi a real multi-node path so that:

- one backend dying does not take the whole app down
- users can connect to a healthy nearby backend when possible
- call quality improves via nearby TURN/media infrastructure
- the system stays privacy-clean and does not become a tracking or data-hoarding platform

## 2. Non-Goals

Out of scope:

- storing audio/video packets in the shared state plane
- building detailed user tracking, geo history, or behavioral analytics
- long-term retention of presence, typing, socket routing, or region history
- turning Wabi into a global surveillance-style control plane

Privacy rule:

- keep only the minimum coordination data needed for routing, reconnect, and failover
- use TTL/lease-based ephemeral records wherever possible
- avoid persisting raw IP addresses or fine-grained location history

## 3. Current Baseline

What Wabi has today:

- core durable app state lives in the embedded Wabidb engine (one process per server, per `core/crates/wabidb/src/engine/`)
- frontend can choose the best file relay and TURN relay by measured latency
- browser calls remain WebRTC with TURN fallback
- the `wabidb::replication` module (anti-entropy, snapshot shipping, failover, sync worker) is in place for state-plane mesh; not yet wired into `wabi-server`'s mesh runtime

What Wabi does not have today:

- multi-backend Socket.IO fanout (each backend owns its own socket namespace)
- shared socket ownership across backend nodes
- shared presence/typing/session coordination across nodes
- automatic backend failover when one node dies
- geo-aware backend selection for chat/api traffic

Important distinction:

- nearest backend helps chat/api latency somewhat
- nearest TURN/media node helps calls much more
- file relays are not backend failover

## 4. Target Architecture

### 4.1 Edge routing

- one public Wabi domain
- edge layer routes clients to a healthy backend region
- selection should prefer health first, then closeness
- backend selection is independent from TURN/SFU/media selection

### 4.2 State plane (Authority + Anchors)

- **Authority** is the canonical owner of all Wabidb state. Only one Authority per mesh.
- **Anchor** nodes are stateless regional proxies that forward all reads/writes to the Authority via the Wabidb mesh protocol.
- Anchors do NOT persist any state. They have no `./data/wabi-server/` directory (or it's empty).
- Authority mode is set via `WABI_SERVER_ROLE=authority` in `.env`. Anchor mode via `WABI_SERVER_ROLE=anchor`.

### 4.3 State replication (Authority + Authority mesh)

For the future: two Authority nodes sharing state via the `wabidb::replication` module.

- `snapshot_shipping` for initial sync
- `anti_entropy` for ongoing drift resolution
- `failover` for promoting an Anchor to Authority if the primary Authority dies
- `sync_protocol` + `sync_worker` for the wire format and transport

The replication module is implemented in code but not yet wired into the wabi-server runtime mesh (see `wabidb::replication::mod` for the implementation; see `core/crates/wabi-server/src/mesh.rs` for the runtime mesh coordinator).

### 4.4 TURN / SFU / media placement

- TURN and SFU are deployed close to users
- Selection is per-call, measured at call start
- Media is not stored; only routed
- See `docs/deployment/TURN_SETUP.md`

## 5. Privacy + Operational Posture

- No client telemetry. Backend selection is a user-facing client decision (the client picks which server to connect to); the backend never tracks or influences it.
- No IP logging. Connection metadata is TTL-ephemeral (lease-based, default 5 min).
- No cross-backend user tracking. A user is "registered" with each backend independently; the user's own client holds the credential.
- All mesh coordination is over mTLS with mesh-shared keys (per `WABI_MESH_SHARED_TOKEN` in `.env`).

## 6. Implementation Phases

| Phase | Status | Description |
|-------|--------|-------------|
| P1: Authority + Anchor modes | ✅ Done (in `WABI_SERVER_ROLE`) | Single Authority, multiple stateless Anchors. |
| P2: State replication | 🚧 Code present, runtime not wired | `wabidb::replication` module implemented; `wabi-server/src/mesh.rs` exposes mesh configuration but doesn't yet drive replication. |
| P3: Automatic failover | Not started | Blocked on P2. Anchor promotion requires replication to be live. |
| P4: Geo-aware client selection | Not started | Client-side change, not server-side. Out of scope for this doc. |

## 7. Cross-References

- `core/crates/wabidb/src/replication/` — replication module implementation
- `core/crates/wabidb/src/replication/mod.rs` — module overview
- `core/crates/wabi-server/src/mesh.rs` — wabi-server mesh runtime
- `docs/architecture/ARCHITECTURE.md` §6 — multi-server topology overview
- `docs/deployment/TURN_SETUP.md` — TURN deployment
- `docs/architecture/WABI_MULTI_SERVER_ARCHITECTURE.md` — user-facing multi-server UX (separate concern: federation, not mesh runtime)