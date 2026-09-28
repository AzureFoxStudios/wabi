# Wabi Networking Model

**Status:** living operator document  
**Updated:** 2026-09-14

Wabi is a self-hosted tool, not a required SaaS. Keep three separate questions separate:

1. **Reachability:** how does a client reach its Wabi Authority?
2. **Media:** which path carries voice/video/screenshare for this deployment/session?
3. **Topology:** is this one Authority plus optional helpers, or experimental multi-node work?

A tunnel, VPN, relay, Anchor, and database replica solve different problems. Do not call all of them “mesh.”

## 1. The normal deployment

The canonical production shape today is one **Authority**:

```text
client ── HTTPS/Socket.IO/WebSocket ──► Authority (wabi-server + WabiDB)
                                           │
                                           ├─ uploads
                                           └─ optional scoped helpers
```

The Authority owns the community's accounts, permissions, durable state, and canonical realtime decisions.

A user may save/switch among multiple independent Wabi servers in the client. That is a **multi-server client**, not federation. Independent Authorities do not share identities or community state.

## 2. Reachability choices

Start with localhost/LAN. Add only what the deployment needs.

| Mode | Public home IP? | Third-party/control dependency | Good for |
|---|---:|---|---|
| Localhost / LAN | No | None | Same machine / house / local studio |
| Private overlay VPN (Tailscale/Headscale/WireGuard) | No | Depends on control/relay choice | Trusted team/friends |
| Wabi Tailcat private access | No inbound port | Tailcat + DERP path unless self-hosted | Supported desktop clients behind CGNAT |
| Domain + reverse proxy at home | Usually yes | DNS/CA | Public self-host with routable home internet |
| VPS reverse proxy + private tunnel home | Home hidden | VPS + DNS/CA | Public host behind CGNAT without putting origin on the internet |
| Cloudflare Tunnel | Home hidden | Cloudflare | Convenient public ingress |

Cloudflare is optional. Tailscale is optional. Tailcat is optional. Wabi's core chat/server model should not require one particular edge vendor.

### Recommended public pattern without exposing home

```text
Internet
   │
   ▼
small VPS / reverse proxy / TLS
   │
   └── private WireGuard/Tailscale link ──► Wabi Authority at home
```

The public sees the VPS, not the home origin. This still has an intermediary; the difference is that the operator chooses and controls it.

## 3. HTTPS and browser media permissions

Browser microphone/camera access generally requires a secure context: HTTPS, `localhost`, or another browser-recognized secure origin.

Do not assume that plain `http://192.168.x.x` or an arbitrary private IP will receive the same media permissions as `https://community.example` or `http://localhost`.

Caddy is the repository's boring reverse-proxy/TLS option, not a mandatory component. nginx/Traefik or another correctly configured proxy can fill the same role.

When using a reverse proxy, preserve the HTTP and realtime upgrade behavior Wabi requires and keep the origin private where practical.

## 4. Calls and media

Wabi's calling implementation has evolved across WebRTC and Wabi relay/media-lane paths. Optional coturn and LiveKit profiles exist for deployments that need TURN/SFU behavior.

The safe operator rule is:

- reaching the **Authority's web/realtime endpoint** is required;
- TURN is only required when the selected WebRTC/NAT path needs it;
- LiveKit is only required when the deployment explicitly enables that SFU path;
- Cloudflare is not inherently required for calling;
- do not infer current media behavior from an old diagram or an old “default transport” sentence.

For transport-level implementation detail and current limitations, use [architecture/CALLING_TRANSPORT_ARCHITECTURE.md](architecture/CALLING_TRANSPORT_ARCHITECTURE.md) and [PROJECT_STATUS.md](PROJECT_STATUS.md).

Calling remains an area where real-device/network acceptance matters. A green browser harness is not proof that every NAT, Bluetooth, mobile, or screenshare case is release-certified.

## 5. Tailcat private access

Wabi's optional private-access integration provides reachability without making the Authority publicly listen for inbound internet traffic.

Important boundary:

- **transport grants reachability, not membership**;
- Wabi authentication/authorization still decides what the user can do;
- member/client keys should be revocable independently;
- disabling the feature should remove its runtime footprint;
- public DERP infrastructure has its own operator/SLA/privacy boundary; self-host DERP if that boundary matters to your community.

See [features/PRIVATE_ACCESS_GUIDE.md](features/PRIVATE_ACCESS_GUIDE.md) and [deployment/DERP_SELF_HOST_GUIDE.md](deployment/DERP_SELF_HOST_GUIDE.md).

## 6. Multi-node Wabi is a different problem

### Authority

`WABI_SERVER_ROLE=authority` is the normal state-owning runtime.

Advanced operators can set `WABI_NODE_ID` to a stable, unique ID for this Authority, using 1–64 ASCII letters, digits, hyphens or underscores and starting with a letter or digit. The default remains `node-1` for ordinary single-Authority installs. Keep the value across restarts: changing it after rooms are created can make this server refuse their writes because their recorded owner ID stays the old value. Restore the original ID instead of editing placement events. New channels and private conversations now commit a local owner placement with creation; older rooms can receive a matching local placement through the [stopped-Authority backfill](deployment/ROOM_PLACEMENT_BACKFILL.md). Selected durable chat, channel and group-membership writes now carry their observed owner and epoch into the sequencer; a changed placement is rejected before commit. Live-room sends also receive an entry-point check before entering the session cache. Other room operations still lack this sequenced admission. There is no operator move command, remote-room routing or complete atomic owner fence. Setting a node ID does not create another room owner, a voting node, a standby or automatic recovery.

### Anchor — experimental

The current `anchor` runtime is a **proxy to one Authority without local community state**. It intentionally starts without opening WabiDB. An operator can enable a bounded, temporary in-memory copy of eligible uploads; this does not make the Anchor an Authority or a standby.

Current boundary:

- `WABI_AUTHORITY_URL` is required and must be an origin. HTTPS is required for a public upstream. Loopback HTTP works for development; protected private/Tailcat IP HTTP needs `WABI_ANCHOR_ALLOW_PRIVATE_HTTP=true` and an actual private transport. The Anchor's public member-facing endpoint also needs HTTPS;
- Anchor is not another writer/Authority;
- HTTP streaming and WebSocket upgrade forwarding have focused loopback checks, including Engine.IO polling and Socket.IO WebSocket connection;
- matching public `/_app/immutable/` frontend assets come from the Anchor's embedded build without an Authority request; absent versions fall back to the Authority. A [three-process loopback check](testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md) compared one chunk at both Anchors. This is static byte offload, not community availability;
- `WABI_ANCHOR_UPLOAD_CACHE_MB` optionally caches verified canonical uploads. Every hit rechecks availability and digest with the Authority; revocation or Authority loss prevents a hit. A [real Authority-to-Anchor loopback check](testing/REGIONAL_UPLOAD_CACHE_2026-09-27.md) passed, but physical bandwidth savings are unmeasured. See [regional upload cache operations](deployment/REGIONAL_UPLOAD_CACHE.md);
- physical multi-network and long-lived realtime acceptance remain open, so Anchor is **not yet a proven regional realtime edge**.

Do not put “regional HA” or “automatic failover” in front of this behavior.

### Trusted helper pairing

An Authority grants helper capabilities when it creates a pairing token. A helper heartbeat can report current load and reachability, but cannot grant itself another capability such as `Standby` or `Backup`. The Authority keeps node IDs, one-time tokens, node secrets, revocations and granted capabilities in `node_registry.json`. On Unix, saves use a private `0600` file and an atomic replacement; a damaged or unreadable registry now stops Authority startup instead of silently replacing the trusted-node list with an empty one. Restore this file from a verified instance backup rather than deleting it to make startup succeed. This registry is for scoped helpers; it is not a voting membership list, a writer lease or proof of a recoverable standby.

### WabiDB peer replication — experimental

WabiDB replication transport/security code exists, but the full live-state convergence contract is not proven. It is explicitly gated for developer testing and must not be treated as a normal deployment option.

Do **not** enable peer replication because you want a backup. Use [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md).

### Warm standby — not production recovery yet

Standby/export/import/promotion work is incomplete and fails closed where a safe state export is not available. There is no automatic Authority election.

The future order is:

1. real export/import;
2. tested manual promotion;
3. failure injection and no-split-brain proof;
4. only then consider automatic failover.

See [architecture/SERVER_MESH_PLAN.md](architecture/SERVER_MESH_PLAN.md).

## 7. Operator sequence

For a new server:

1. Start one Authority locally.
2. Verify `http://localhost:3001/livez` and `/readyz` for the Docker default.
3. Create the owner account and exercise normal chat/workspace behavior.
4. Take a baseline backup.
5. Add one ingress/private-access layer.
6. Add optional TURN/SFU/helpers only if your use case needs them.
7. Do not enable experimental replication/standby as part of ordinary setup.

When debugging, prove each layer independently:

```text
process alive → application ready → local/LAN access → proxy/tunnel → media helper → client UX
```

An ingress outage is not necessarily an Authority outage. A DERP/TURN/SFU failure is not necessarily a chat/storage failure. Keep observability and troubleshooting scoped to the layer that actually failed.

## 8. Related files

- [Alternative communications transports](COMMUNICATIONS_TRANSPORTS.md) — research inventory of mesh, radio, through-the-earth, acoustic, satellite, and telecom integration paths
- `docker-compose.yml` — canonical minimal Authority plus optional profiles
- `Caddyfile.example` / `Caddyfile.tunnel` — reverse-proxy examples
- [deployment/FRESH_INSTALL.md](deployment/FRESH_INSTALL.md) — first install
- [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md) — recovery
- [architecture/WABI_MULTI_SERVER_ARCHITECTURE.md](architecture/WABI_MULTI_SERVER_ARCHITECTURE.md) — independent servers in one client
- [architecture/SERVER_MESH_PLAN.md](architecture/SERVER_MESH_PLAN.md) — intra-deployment topology and HA acceptance gates
