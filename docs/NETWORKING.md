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

### Anchor — experimental

The current `anchor` runtime is a **stateless proxy to one Authority**. It intentionally starts without opening local WabiDB/community state.

Current boundary:

- `WABI_AUTHORITY_URL` is required;
- Anchor is not another writer/Authority;
- current proxying is HTTP-oriented;
- native WebSocket upgrade forwarding is not complete;
- therefore Anchor is **not yet a complete regional realtime edge**.

Do not put “regional HA” or “automatic failover” in front of this behavior.

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

- `docker-compose.yml` — canonical minimal Authority plus optional profiles
- `Caddyfile.example` / `Caddyfile.tunnel` — reverse-proxy examples
- [deployment/FRESH_INSTALL.md](deployment/FRESH_INSTALL.md) — first install
- [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md) — recovery
- [architecture/WABI_MULTI_SERVER_ARCHITECTURE.md](architecture/WABI_MULTI_SERVER_ARCHITECTURE.md) — independent servers in one client
- [architecture/SERVER_MESH_PLAN.md](architecture/SERVER_MESH_PLAN.md) — intra-deployment topology and HA acceptance gates
