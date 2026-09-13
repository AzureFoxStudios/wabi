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
- **WabiDB replication** — experimental commit/segment synchronization scaffolding configured with `WABIDB_PEER_ENDPOINT`; this is not the same thing as Anchor routing or helper heartbeats and is not production HA.
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

### 3.3 WabiDB replication — experimental only

`AppState` contains a runtime hook for WabiDB's replication configuration when `WABIDB_PEER_ENDPOINT` is present, and the server has an authenticated HTTP `ReqwestTransport`. During this audit we found that the underlying worker is **not a complete live-replication implementation**:

- pulled data is currently commit metadata only; the worker advances a peer watermark without ingesting pulled segment bytes into live projections;
- pushed segment shipping existed, but stream-id association could select same-numbered segments from the wrong stream; the transport now resolves streams by the commit index's BLAKE3 stream-id hash;
- receiving pushed segment/index files does not by itself update the running node's in-memory projections;
- there is no safe active-active writer/election model around commit-sequence conflicts.

Therefore network replication is **disabled by default even when a peer endpoint is configured**. Developer testing additionally requires:

- `WABIDB_EXPERIMENTAL_REPLICATION=true`
- `WABI_SYNC_TOKEN` matching the peer

The HTTP transport uses:

- `/api/v1/sync/pull`
- `/api/v1/sync/push`
- `/api/v1/sync/status`
- `WABI_SYNC_TOKEN` / `x-wabi-sync-token`
- bounded connect/request timeouts
- explicit non-2xx failure handling
- stream-id hash validation while locating shipped segments

This is scaffolding for the acceptance work below, not a production replica. Do not put `WABIDB_EXPERIMENTAL_REPLICATION=true` in normal deployment examples.

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

`core/crates/wabi-server/src/mesh.rs` is retired. Setting the old `WABI_MESH_ENABLED` path now fails closed with migration guidance rather than starting a heartbeat loop against a nonexistent receiver or reporting fake synchronized state.

Use:

- core helper nodes for worker/media health;
- `WABI_SERVER_ROLE=anchor` for a stateless regional HTTP gateway;
- the explicitly experimental WabiDB path only for replication development.

## 5. What Wabi Does Not Claim Today

- no production WabiDB state replication;
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

1. **Replication integration test:** two real WabiDB nodes ship segment bytes, apply them to live projections, and expose the same retained state with authenticated transport.
2. **Restart/catch-up test:** stop one node, write on the Authority, restart the replica and verify convergence without commit-sequence collisions.
3. **Deletion test:** deleted/expired content must not reappear after sync or restore.
4. **Passive-writer rule:** a replica/standby cannot independently accept canonical writes before promotion.
5. **Anchor realtime test:** WebSocket/Socket.IO behavior through an Anchor must be explicitly supported and tested, not assumed from HTTP proxying.
6. **Standby export/import:** a complete encrypted current-state snapshot can restore a clean node without raw-history resurrection.
7. **Manual promotion runbook:** operator can promote a tested standby and redirect clients without two writable Authorities.
8. Only then evaluate automatic failover/election.

## 8. Cross-References

- `core/crates/wabi-server/src/anchor.rs` — stateless regional HTTP proxy
- `core/crates/wabi-server/src/nodes/` — core helper-node identity/health/capabilities
- `core/crates/wabi-server/src/replication_transport.rs` — authenticated experimental WabiDB HTTP transport
- `core/crates/wabi-server/src/api/sync.rs` — replication endpoints
- `core/crates/wabidb/src/replication/` — replication scaffolding
- `core/crates/wabi-server/src/standby/` — encrypted standby primitives
- `core/crates/wabi-server/src/api/standby.rs` — standby readiness/export/restore boundary
- `frontend/src/lib/relaySelector.ts` — measured relay preference
- `frontend/src/lib/turnConfig.ts` — selected TURN relay credential path
- `docs/research/futuresight-multi-anchor-helper-nodes.md` — broader helper/anchor direction
