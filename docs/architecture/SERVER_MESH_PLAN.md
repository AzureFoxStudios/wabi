# Wabi Multi-Node Runtime Plan

> **Status:** In progress; this document describes shipped boundaries, not aspirational feature names.
> **Last revision:** 2026-09-13.
> **Owner:** Backend / state-plane / runtime workstream.

## 1. Goal

Give Wabi a bounded multi-node path without turning a small self-hosted community into an active-active distributed database by default.

The preferred progression is:

1. one **Authority** owns canonical community state;
2. **Helper nodes** offload bounded work/media/cache jobs;
3. optional **regional Anchors** proxy public HTTP traffic to the Authority;
4. encrypted **warm standby** recovery is manual first;
5. only consider automatic/active-active failover after replication, routing and split-brain controls are proven.

Nearby TURN/SFU/media infrastructure is independent from backend-state failover.

## 2. Terminology

- **Authority** — the canonical Wabi server and WabiDB writer.
- **Helper** — paired worker with scoped capabilities (CPU, thumbnails, transcode, search, media relay, etc.). Helpers do not become authorities by implication.
- **Anchor** — stateless regional HTTP proxy to one Authority. It owns no WabiDB state.
- **Warm standby** — high-trust recovery target for encrypted current/live-state snapshots. Promotion is intentionally manual.
- **WabiDB replication** — database commit/segment synchronization configured with `WABIDB_PEER_ENDPOINT`; this is not the same thing as Anchor routing or helper heartbeats.
- **Legacy mesh coordinator / `wabi-mesh` addon** — deprecated prototypes. They are not proof of state replication or failover.

## 3. Current Baseline

### 3.1 Authority + helpers

The normal `wabi-server` process is the Authority. `--helper-mode` runs the outbound helper-node client and uses the core node registry/job/media infrastructure.

Helper identity, pairing, revocation, heartbeat/reachability and bounded capabilities live in `core/crates/wabi-server/src/nodes/` and related core modules. This is the multi-machine path for ordinary Wabi installations.

### 3.2 Regional Anchor runtime

`WABI_SERVER_ROLE=anchor` now enters the stateless Anchor router **before** JWT resolution, WabiDB open, upload-directory creation or normal Authority startup. `WABI_AUTHORITY_URL` is required.

Current boundary:

- HTTP method/path/query/body/auth forwarding: implemented and tested;
- local WabiDB state on Anchor: none by design;
- Authority unavailable: Anchor fails fast with `503 authority unavailable`;
- native WebSocket upgrade proxying: **not implemented yet**. Socket.IO may fall back to HTTP polling, so do not describe Anchor mode as completed realtime regional fanout.

### 3.3 WabiDB replication

Replication is no longer merely an unused module. When `WABIDB_PEER_ENDPOINT` is configured, `AppState` gives WabiDB a real `ReqwestTransport` and replication config.

The HTTP transport uses:

- `/api/v1/sync/pull`
- `/api/v1/sync/push`
- `/api/v1/sync/status`
- `WABI_SYNC_TOKEN` / `x-wabi-sync-token`
- bounded connect/request timeouts
- explicit non-2xx failure handling

This means replication plumbing is runtime-wired. It **does not** mean Wabi has production failover. Before claiming HA, require a real two-node test covering initial sync, ongoing writes, restart/catch-up, deletion/retention behavior and operator recovery.

### 3.4 Warm standby

Encrypted snapshot storage primitives exist, but WabiDB live-state export/import is not complete.

Important current behavior:

- encrypted snapshot envelope receive/store: implemented;
- Wabi-generated complete live-state export: **not ready**;
- manual restore/import: **not ready**;
- manual promotion: **not ready**;
- automatic promotion/election: intentionally disabled.

The API fails closed instead of returning an encrypted empty payload that looks like a valid backup. `/api/standby/status` exposes the readiness flags.

Do not build standby by copying raw event/commit history until deletion/retention semantics are proven safe. Recovery should preserve current retained state, not resurrect deleted history.

### 3.5 Media and relay selection

The frontend can measure configured relay `/health` latency and independently prefer responsive file, TURN and SFU relays. TURN credentials use the selected relay id. Media placement can therefore be regional even while Authority state remains centralized.

This improves the media path; it is not backend-state failover.

## 4. Deprecated / Legacy Paths

### 4.1 `core/addons/mesh` / `wabi-mesh`

The old addon is compatibility-only scaffolding. It must not be extended into the production node architecture. `wabi-server` no longer links it as a runtime dependency.

### 4.2 `WABI_MESH_ENABLED` coordinator

`core/crates/wabi-server/src/mesh.rs` is a legacy peer-heartbeat coordinator. Its status now reports `heartbeat_only`, never `synced`.

It is separate from WabiDB replication and the core helper registry. New work should prefer helper-node health for worker/media nodes and WabiDB's replication status for state synchronization rather than adding features to this coordinator.

## 5. What Wabi Does Not Claim Today

- no automatic backend failover;
- no automatic Authority election;
- no active-active multi-writer community state;
- no shared Socket.IO namespace/presence across independent backends;
- no geo-aware selection of chat/API Authority;
- no guarantee that an Anchor keeps chat writable while its Authority is down;
- no production-ready warm-standby restore yet.

## 6. Recommended Deployment Modes

### Small / LAN community

```text
Clients -> Authority
              |
              +-> optional helper computers
```

Multiple machines on one router should normally be helpers, not multiple pretend Authorities.

### Regional media acceleration

```text
Bangkok user -> nearby TURN/SFU/media relay --+
Florida user -> nearby TURN/SFU/media relay --+-> Authority
SF user      -> nearby TURN/SFU/media relay --+
```

Chat/API still terminate at the Authority unless a regional Anchor is explicitly deployed.

### Future resilient deployment

```text
Clients -> regional Anchors -> Authority
                               |  \
                               |   +-> helper/media/cache nodes
                               +----> encrypted warm standby
```

If the Authority fails, initial recovery target is explicit operator promotion/restore. Do not introduce automatic election until split-brain prevention is designed and tested.

## 7. Acceptance Gates Before Calling This HA

1. **Replication integration test:** two real WabiDB nodes sync retained state both directions with authenticated transport.
2. **Restart/catch-up test:** stop one node, write on the other, restart and verify convergence.
3. **Deletion test:** deleted/expired content must not reappear after sync or restore.
4. **Anchor realtime test:** WebSocket/Socket.IO behavior through an Anchor must be explicitly supported and tested, not assumed from HTTP proxying.
5. **Standby export/import:** a complete encrypted current-state snapshot can restore a clean node without raw-history resurrection.
6. **Manual promotion runbook:** operator can promote a tested standby and redirect clients without two writable Authorities.
7. Only then evaluate automatic failover/election.

## 8. Cross-References

- `core/crates/wabi-server/src/anchor.rs` — stateless regional HTTP proxy
- `core/crates/wabi-server/src/nodes/` — core helper-node identity/health/capabilities
- `core/crates/wabi-server/src/replication_transport.rs` — authenticated WabiDB HTTP transport
- `core/crates/wabi-server/src/api/sync.rs` — replication endpoints
- `core/crates/wabidb/src/replication/` — replication engine
- `core/crates/wabi-server/src/standby/` — encrypted standby primitives
- `core/crates/wabi-server/src/api/standby.rs` — standby readiness/export/restore boundary
- `frontend/src/lib/relaySelector.ts` — measured relay preference
- `frontend/src/lib/turnConfig.ts` — selected TURN relay credential path
- `docs/research/futuresight-multi-anchor-helper-nodes.md` — broader helper/anchor direction
