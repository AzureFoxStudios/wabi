# Wabi Multi-Node Runtime Plan

> **Status:** In progress; this document distinguishes available behavior from working-tree candidates and future gates.
> **Last revision:** 2026-09-28.
> **Owner:** Backend / state-plane / runtime workstream.

## 1. Goal

Give Wabi a bounded multi-node path without turning a small self-hosted community into an active-active distributed database by default.

The preferred progression is:

1. one **Authority** owns canonical community state;
2. **Helper nodes** offload bounded work/media/cache jobs;
3. optional **regional Anchors** proxy canonical traffic to the Authority and serve matching embedded versioned app assets locally;
4. encrypted **warm standby** recovery is manual first;
5. only consider automatic/active-active failover after replication, routing and split-brain controls are proven.

Nearby TURN/SFU/media infrastructure is independent from backend-state failover.

## 2. Terminology

- **Authority** — the canonical Wabi server and WabiDB writer.
- **Helper** — paired worker with scoped capabilities (CPU, thumbnails, transcode, search, media relay, etc.). Helpers do not become authorities by implication.
- **Anchor** — stateless regional HTTP/WebSocket entry point to one Authority. It owns no WabiDB state and can serve public versioned app assets from its embedded build.
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

- HTTP method/path/query/body/auth forwarding with streamed request and response bodies: implemented and tested in the current working tree;
- matching `/_app/immutable/` assets from the Anchor's embedded build are served locally for GET/HEAD; missing versions and all other paths still reach the Authority. A [real three-process loopback check](../testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md) compared a 28,424-byte chunk at both Anchors. This is static byte offload, not local chat state or a physical uplink result;
- Anchor rebuilds forwarding identity headers. By default it reports only its immediate socket peer. With explicit `WABI_TRUSTED_PROXIES`, it uses the shared rightmost-untrusted client resolver and forwards that resolved address followed by its real socket peer. The Authority must trust the Anchor and every intended upstream proxy in that chain to recover the member address; trusting an arbitrary client range permits spoofing. HTTP and WebSocket use the same resolver. Public health/errors omit private Authority URLs; detailed connection failures stay in operator logs;
- Anchor accepts HTTPS Authority origins, loopback HTTP for development, or literal private/Tailcat IP HTTP only with `WABI_ANCHOR_ALLOW_PRIVATE_HTTP=true`; it rejects URL credentials, paths, query strings, and upstream redirects. The opt-in does not secure the private link or the member-facing Anchor listener;
- local WabiDB state on Anchor: none by design;
- Authority unavailable: canonical proxied requests and cached uploads fail with `503 authority unavailable`; local `/health` and embedded public app assets may still respond but cannot serve community state;
- WebSocket upgrade proxying: implemented in the current working tree; focused loopback tests cover authenticated WebSocket frames and actual Engine.IO polling plus Socket.IO WebSocket connection. A [real Authority plus two-Anchor disposable run](../testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md) also passed two-site sign-in, cross-Anchor live messaging and upload/cache checks, one-Anchor loss and expected Authority-loss 503. Physical multi-network, long-lived session and operational acceptance remain open. Anchor still forwards chat/API to the Authority rather than owning regional conversation state.

### 3.3 WabiDB replication — experimental only

`AppState` contains a runtime hook for WabiDB's replication configuration when `WABIDB_PEER_ENDPOINT` is present, and the server has an authenticated HTTP `ReqwestTransport`. The current worker is **not a complete Authority-replication implementation**:

- the worker reads the fenced receiver's applied commit position, checks the canonical commit-index prefix for divergence, and pushes missing segment bytes in bounded batches; [two-process loopback checks](../testing/DB_REPLICA_PROCESS_2026-09-27.md) cover catch-up after receiver restart, catch-up from an encrypted stopped baseline, and rejection of a same-key divergent baseline. Post-baseline `upload_published_v1` and `upload_revoked_v1` events follow WabiDB. When both upload trees are configured, the sender also copies nonrevoked published bytes in bounded chunks after database catch-up; the receiver resumes by exact offset, verifies SHA-256 and publishes atomically. Applied revocation records remove matching current-tree files and staged chunks on the passive copy, with a separate cleanup watermark. An Authority startup can reconstruct a stale registry's new canonical entries only after verifying the copied files. Older registered files can enter this path through the explicit stopped-Authority backfill. An opt-in, fixed allowlist sidecar lane copied the upload registry and later notes update/deletion in a disposable process check. The sidecar lane has no checkpoint tied to database commits, no completeness watermark and no promotion protocol. A [two-network field check](../testing/REMOTE_FENCED_REPLICA_2026-09-27.md) observed post-baseline WabiDB commits and one verified upload reach a fenced receiver while the Authority ran. That receiver still reported `fullInstanceReady: false`. A copied upload or sidecar does not make the passive tree complete;
- pushed segment shipping existed, but stream-id association could select same-numbered segments from the wrong stream; the transport now resolves streams by the commit index's BLAKE3 stream-id hash, refuses missing/unsafe/short source segments before sending, and reads each unique segment once per batch. The [transport integrity check](../testing/REPLICATION_TRANSPORT_INTEGRITY_2026-09-27.md) and two-process checks cover this narrower behavior;
- the push receiver requires a durable local WabiDB writer fence, validates encrypted records against their commit references, preserves existing segment prefixes, and applies accepted events to its live projections. A [disposable two-commit check](../testing/FENCED_REPLICATION_2026-09-27.md) covers that narrow path. `wabi-db-replica-dev` is a separate fenced development receiver with optional upload copying, not a complete passive Wabi runtime or whole-instance state replica;
- there is no safe active-active writer/election model around commit-sequence conflicts.

The legacy `replication::failover::FailoverCoordinator` is an in-memory health observer, not an election participant. It now reports `PrimaryDown` on heartbeat timeout and never returns a promotion verdict. A focused WabiDB test covers that fail-closed behavior. It has no durable term, vote, majority, complete-state proof or runtime writer gate; none of those may be inferred from health alone.

Therefore network replication is **disabled by default even when a peer endpoint is configured**. Both the client and sync API require these settings for developer testing:

- `WABIDB_EXPERIMENTAL_REPLICATION=true`
- `WABI_SYNC_TOKEN` matching the peer

The HTTP transport uses:

- `/api/v1/sync/push`
- `/api/v1/sync/status`
- `WABI_SYNC_TOKEN` / `x-wabi-sync-token`
- bounded connect/request timeouts
- explicit non-2xx failure handling
- stream-id hash validation while locating shipped segments

The legacy `/api/v1/sync/pull` endpoint remains available behind the gate but the current sender does not use it for catch-up. Its decoder now preserves binary caller hashes and rejects malformed hash or ordering data; this has a focused unit check, not a separate multi-process pull acceptance run. This is scaffolding for the acceptance work below, not a production replica. The [experimental receiver guide](../deployment/EXPERIMENTAL_DB_REPLICA.md) is for disposable labs; do not put `WABIDB_EXPERIMENTAL_REPLICATION=true` in normal deployment examples.

### 3.4 Warm standby

Encrypted snapshot storage primitives exist, and the separate [offline stopped-instance snapshot tool](../deployment/BACKUP_AND_RECOVERY.md#candidate-encrypted-stopped-instance-tool) can encrypt and restore a complete local data/uploads tree. Its `--passive-replica` mode installs a durable WabiDB writer fence before publishing a restored tree. The separate [encrypted instance inbox](../deployment/ENCRYPTED_INSTANCE_INBOX.md) can send, store and fetch that stopped archive; a disposable loopback transfer restored the complete fixture. Experimental incremental catch-up now covers ordered WabiDB state, verified bytes for published nonrevoked uploads when both trees are configured, and an optional fixed set of sidecars. It still does not cover unregistered uploads, files beyond that sidecar set or external state; there is no cross-file consistent recovery point. These tools do not constitute a complete standby.

The working tree also has an internal [encrypted live core archive candidate](../deployment/LIVE_CHECKPOINT_ARCHIVE.md).
It consumes the coordinated application/database/snapshot boundary, streams
whole data/uploads roots into age ciphertext and binds inventory, active keys,
resolved server configuration and applied prefix. V2 restores always remain
inactive and writer-fenced; the stopped-move commands cannot activate them.
External blacklist and enabled Lore are refused, and operator/plugin/external
state remains unverified. The opt-in [local operator control](../deployment/OPERATOR_CHECKPOINT_CONTROL.md)
starts owned, bounded core jobs; no complete-instance readiness certificate is available. This is one recovery component, not an available standby
promotion path.

Important current behavior:

- encrypted snapshot envelope receive/store: implemented; the current working tree publishes a fully written envelope under an immutable snapshot ID and rejects a second write to that ID with HTTP 409;
- Wabi-generated complete live-state export: **not ready**;
- manual restore/import: **not ready**;
- manual promotion: **not ready**;
- automatic promotion/election: intentionally disabled.

WabiDB now has a local, durable `writer-fenced-v1` marker and a sequencer gate: a successful `fence_local_writer()` call waits for the current commit window to finish, rejects later local canonical commits, and remains fenced after restart. `/api/standby/status` reports `localWriterFenced`. There is no operator promotion endpoint or automatic unfence. This local primitive does not fence an unreachable former Authority, govern sidecar writes, or grant a replacement writer an epoch; a quorum/lease protocol and complete state path are still required before manual or automatic failover can be claimed.

A separate [controlled stopped move](../deployment/BACKUP_AND_RECOVERY.md#candidate-controlled-move-of-a-stopped-authority) can retire a machine that the operator physically controls, start its guarded replacement, and later [reseed the retired machine as a fenced passive copy](../deployment/BACKUP_AND_RECOVERY.md#rejoin-the-retired-machine-as-a-passive-copy). A disposable integration case checked the replacement's new write reaches that reseeded passive tree while both old-site trees refuse Authority startup. This is planned maintenance with a stopped complete archive, not promotion of a live replica after an unreachable-node failure.

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

- `docs/architecture/GEOGRAPHIC_COMMUNITY_WEB.md` — canonical design for local room ownership, regional delivery, volunteer capacity and node-loss recovery
- `docs/plans/2026-09-26-geographic-community-nodes.md` — capacity arithmetic, implementation gates and three-site field acceptance
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
