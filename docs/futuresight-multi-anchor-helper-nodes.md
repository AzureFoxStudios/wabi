# Wabi Multi-Anchor + Helper Node Architecture — Futuresight Proposal

**Version:** 1.1 (Updated after review, May 2026)  
**Status:** Proposal / notes for later. Not for implementation until core Wabi chat, calls, storage, and addon fracture work are stable.  
**Prerequisite:** `wabi-mesh` addon must be replaced with real infrastructure, not extended.

**Problem:** Wabi's current `wabi-mesh` addon (141 lines) is scaffolding only. `send_heartbeat()` logs a debug message and returns `Ok(())`. `get_optimal_node()` returns the local node_id. `sync_status` is hardcoded `"synced"`. This document replaces that fake scaffolding with a real, bounded, average-joe-friendly scaling path.

**Core idea:** Keep Wabi simple for normal self-hosters, but allow larger communities to pair extra machines as scoped helper nodes, regional anchors, media nodes, cache nodes, and warm standbys. One authority owns truth. Helpers do bounded work. Complexity is opt-in.

---

## 1. Design Philosophy

Wabi should not begin with "server mesh." That phrase is too vague and implies every node is equal.

The safer framing:

- **One community authority** owns truth.
- **Helper nodes** do bounded work.
- **Regional anchors** absorb public traffic (large scale only).
- **Media/cache/worker nodes** offload expensive paths.
- **Warm standby nodes** preserve recoverability.
- **Full active-active multi-writer mesh** is a last resort, not the starting point.

This keeps Wabi closer to a self-hosted Minecraft/Discord alternative than a Matrix-sized distributed protocol.

### 1.1 UX Language vs. Internal Language

Public-facing UX should not expose distributed-systems vocabulary.

| What the user sees | What it is internally |
|---|---|
| Main server | Authority node |
| Add helper computer | Worker node pairing |
| Call helper | Media node |
| File cache | Cache / blob node |
| Regional entry | Anchor node |
| Backup computer | Warm standby |

Advanced terms (authority, anchor, route token, live-state snapshot, read replica, node capability) stay in docs/config/API for expert operators only.

---

## 2. Node Roles

### 2.1 Authority Node

The authority node is the canonical brain of a Wabi community.

Responsibilities:

- Canonical community identity
- User auth
- Roles and permissions
- Channel definitions
- Message ordering
- Moderation actions
- Payment/provider config
- Live-state snapshot export for opt-in standby/backup nodes
- Node registry
- Signed route token minting
- Job scheduling

In small Wabi installs, the authority is just the normal `wabi serve` process.

In large installs, the authority should be hidden behind anchors and not directly exposed to public clients.

### 2.2 Helper Worker Node

A helper worker is an extra computer paired to the authority.

Examples:

- old laptop
- gaming PC
- studio workstation
- friend's spare computer
- mini PC
- home server
- VPS/dedicated server when available

Responsibilities:

- Thumbnail generation
- Video transcoding
- Search indexing
- Addon jobs
- Bot execution
- AI/GPU tasks
- Backup jobs
- Optional local media serving

Default connectivity mode: outbound-only tunnel to the authority.

This is important because average users should not need port forwarding for helper nodes.

### 2.3 Relay Node

A relay node helps route traffic when direct connectivity fails.

Responsibilities:

- WebSocket/QUIC/TCP forwarding
- NAT traversal assist
- Fallback media/file routing
- Possibly STDB/TCP call fallback later

Trust level depends on deployment:

- Private relay: trusted by the server operator
- Volunteer relay: untrusted or semi-trusted; must only see encrypted/token-scoped traffic

### 2.4 Cache Node

A cache node stores content-addressed blobs and derived media.

Responsibilities:

- File downloads
- Public media cache
- Thumbnails
- Optimized images
- Video preview variants
- Static assets

Rules:

- Store by hash/CID-like content key, not arbitrary paths.
- Primary/authority owns metadata and permissions.
- Clients receive signed download/upload tokens.
- Cache nodes should not be able to mint permissions.

### 2.5 Media Node

A media node handles voice/video routing.

Responsibilities:

- SFU/media relay
- Voice room hosting
- Regional call routing
- Screen-share relay
- Recording/transcoding only if explicitly enabled

Primary still owns:

- who may enter the room
- channel membership
- moderation state
- room lifecycle

Media node only accepts signed room tokens.

### 2.6 Regional Anchor

An anchor is a public gateway for a large community.

Responsibilities:

- Public WebSocket/API entrypoint
- Regional client fanout
- Local cache
- Upload ingress
- Voice/media coordination
- DDoS blast-radius reduction
- Route users toward local media/cache nodes

Anchors are not equal authorities. They are scoped gateways.

For a worldwide art team:

- Asia anchor
- North America anchor
- Europe anchor
- optional South America/Oceania anchors

Users connect to the closest healthy anchor. The anchor talks to the authority.

**Important:** Regional anchors are Phase 7. Do not build them until workers, cache, media offload, LAN acceleration, and warm standby are all proven.

### 2.7 Warm Standby / Backup Node

A warm standby is a high-trust backup target paired to the authority. It receives encrypted live-state snapshots only when the operator explicitly enables this feature.

Responsibilities:

- Store encrypted live-state snapshots after retention/deletion has already been applied
- Preserve a recent restore point for the same server operator
- Serve as a manual restore/promotion target if the authority dies

Non-goals:

- No append-only message/event log
- No telemetry/audit trail
- No raw STDB data-directory copy unless proven deletion-safe
- No automatic failover

Initial rule: promotion is manual.

Automatic failover risks split-brain. Manual promotion is more understandable and safer for self-hosted operators.

---

## 3. Deployment Modes

### 3.1 Simple Mode

One machine.

```text
Client -> Wabi authority
```

Use for:

- friend groups
- small servers
- LAN communities
- initial Wabi releases

### 3.2 Helper Mode

One authority plus paired helper machines.

```text
Client -> Authority
             |
             +-> Worker node: thumbnails/transcodes/search
             +-> Cache node: blobs/thumbnails
             +-> Backup node: encrypted live-state snapshots
```

Use for:

- average joe with multiple computers
- artists with one main server plus a studio PC
- gaming groups with spare machines

This mode should be easy:

On authority:

```bash
wabi node invite --role worker
```

On helper:

```bash
wabi worker join https://myserver.example.com ABCD-EFGH
```

### 3.3 Public Scale Mode

One authority, multiple public anchors.

```text
Users in Asia  -> Asia Anchor  -> Authority
Users in EU    -> EU Anchor    -> Authority
Users in NA    -> NA Anchor    -> Authority
```

Use for:

- large public artists
- public communities
- communities that attract raids/scrapers/DDoS

### 3.4 Public Figure Mode

Harder posture for Akimichan/Sakimichan-scale communities.

```text
Public clients -> Regional anchors -> Hidden authority
                                      |
                                      +-> Warm standby
                                      +-> Worker fleet
                                      +-> Media nodes
                                      +-> Cache nodes
```

Properties:

- Authority is not directly public.
- Only anchors talk to authority.
- Anchors are disposable and revocable.
- Public traffic hits anchors/caches/media nodes.
- Admin/mod/payment operations stay pinned to authority.
- Emergency lockdown mode exists.

---

## 4. Average-Joe UX

Wabi should make helper pairing feel like pairing a device, not configuring a distributed system.

Admin flow:

1. Settings -> Scale with another computer
2. Choose helper type:
   - General worker
   - Media relay
   - File cache
   - Backup node
   - LAN accelerator
   - GPU worker
3. Wabi shows a join command:

```bash
wabi worker join https://server.url JOIN-CODE
```

4. Helper appears in admin panel.

Admin panel should show:

- node name
- node role
- connected/disconnected
- CPU/RAM
- disk quota
- measured upload
- public reachability
- LAN reachability
- capabilities
- current jobs
- revoke button

Important: helpers should connect outbound by default. Requiring inbound router config defeats the point.

**Initial pairing delivery mechanism:** CLI join command. QR code as a later enhancement if mobile helpers become a use case.

---

## 5. Networking Reality

A private helper behind NAT cannot magically reduce public bandwidth for random internet clients unless clients can reach it.

A helper can help in these cases:

1. **Outbound-only helper:** useful for CPU jobs, search, transcodes, backups, bot/addon work.
2. **LAN-reachable helper:** useful for local users on the same network.
3. **Publicly reachable helper:** useful for direct public media/file/voice routing.
4. **Reverse-tunneled helper:** useful when traffic can enter through a public relay/anchor and tunnel to the helper.

Therefore Wabi should classify nodes by reachability:

- `outbound_only`
- `lan_reachable`
- `public_reachable`
- `relay_reachable`

And route accordingly.

---

## 6. Control Tunnel Protocol

**Phase 1 default:** WebSocket over HTTPS.

Wabi already has Axum + Socket.IO-style infrastructure. A helper opening one outbound WebSocket control tunnel is sufficient for Phase 1.

**Future upgrades:** QUIC can be added later if the control tunnel becomes a bandwidth or latency bottleneck. Do not start with QUIC. One less protocol to debug.

**Why not gRPC or libp2p:**
- gRPC adds protobuf tooling and a heavy dependency stack.
- libp2p is powerful but violates Wabi's "simple durable tool" preference.
- Custom protocol can be evaluated later, but WebSocket is the right Phase 1 default.

---

## 7. Signed Tokens as the Safety Primitive

Helper nodes should not need full database access or global permission logic.

The authority should mint scoped signed tokens.

### 7.1 SignedRouteToken

Fields:

- user_id
- node_id
- capability
- resource_id
- permissions snapshot
- expires_at
- nonce
- authority signature

Capabilities:

- `download_blob`
- `upload_blob`
- `join_voice_room`
- `submit_job_result`
- `read_cached_history`

Helpers verify the authority signature and expiry.

**Token format recommendation:** Evaluate Biscuit or Macaroon-style caveats before choosing. Both support attenuation (scope reduction) and third-party caveats natively. JWT is common but less naturally caveat-oriented. PASETO is simpler but lacks caveats.

### 7.2 NodePairingToken

Fields:

- invite_id
- allowed roles
- allowed capabilities
- expires_at
- one_use flag
- authority signature

Pairing flow:

1. Admin creates invite.
2. Helper generates keypair.
3. Helper connects outbound with invite token and public key.
4. Authority stores helper public key.
5. Future node messages are signed/mTLS-authenticated.

### 7.3 Node Revocation

Authority must be able to revoke a node instantly.

Revocation should:

- invalidate route tokens issued to the node
- reject node heartbeats
- stop assigning jobs
- ask anchors/clients to fail over
- mark cached data as suspect if needed

---

## 8. Heartbeat Granularity

Do not put everything in one heartbeat message. Separate channels with different frequencies:

| Channel | Interval | Content |
|---|---|---|
| **Heartbeat** | 5 seconds | "I'm alive" + node_id |
| **Capability report** | 30-60 seconds | CPU, RAM, capabilities, load, reachability |
| **Job status** | On demand | Progress, completion, failure |

The current fake `wabi-mesh` heartbeat conflates these. The real implementation should keep them separate so heartbeat stays lightweight and capability reports don't spam the control tunnel.

---

## 9. State and Data Levels

Do not start with distributed writes.

### Level 0: Single-node Wabi

One authority. No helpers.

### Level 1: Worker Offload

Helpers do jobs. Authority owns truth.

Safe first target.

### Level 2: Media/File Routing

Helpers can receive client traffic directly with signed route tokens.

Still safe. Authority owns permissions.

### Level 3: Read Replicas / Caches

Helpers serve cached/read-only data:

- media metadata
- message history slices
- search indexes
- public channel previews

### Level 4: Warm Standby

A standby receives encrypted live-state snapshots after retention/deletion has been applied and can be manually promoted.

### Level 5: Active-Active Mesh

Multiple nodes accept writes and reconcile.

Avoid until absolutely necessary.

Problems introduced:

- split-brain
- duplicate events
- message ordering conflicts
- moderation races
- payment state conflicts
- role changes out of order
- offline conflict reconciliation

---

## 10. Snapshot Scope (Live State, Not Surveillance Logs)

The authority does **not** maintain a new append-only application event log for standby. Wabi's durable truth lives in STDB, and Wabi's privacy model depends on deletion/retention being meaningful.

For warm standby, export current live state after retention/deletion has already been applied. Do not copy raw STDB internals or WAL/commitlog segments unless they are proven deletion-safe.

**May be included in an encrypted full standby snapshot:**

- active users and user metadata required for restore
- active channels and channel membership
- retained messages
- retained file metadata
- current roles and permissions
- current moderation state
- current node registry state

**Should not be included unless explicitly required:**

- expired/deleted messages
- expired presence/typing/read receipts
- historical audit trails
- raw media packets
- raw STDB commitlog/WAL segments
- old payment events beyond current operational state

The snapshot is a backup of live state, not a history-preserving log. A standby/backup node is a high-trust opt-in node controlled by the same operator, not a general helper.

---

## 11. Node Registry: Core vs. Addon

**The node registry is core infrastructure.** Do not implement it as an addon.

Individual node capabilities can be optional:

- Thumbnail worker → optional addon
- Transcode worker → optional addon
- Media relay → optional addon
- Cache node → optional addon
- Backup node → optional addon

But the node identity, pairing, heartbeat, capability registry, and revocation are foundational. They enable the addon system to offload work safely. Without a core registry, every addon would reinvent node trust.

**What to do with `wabi-mesh`:**

Do not extend it. The `MeshConfig`, `MeshStatus`, and `MeshPresence` types are the right shape, but the implementation is fake. Create a new `core/crates/wabi-server/src/nodes/` module with real logic. Remove or deprecate `wabi-mesh` once the new system is proven.

---

## 12. Regional Anchor Semantics

A regional anchor may accept local client traffic, but not all writes should be equal.

Recommended behavior when authority is reachable:

1. Client sends event to regional anchor.
2. Anchor forwards to authority.
3. Authority assigns canonical sequence/event id.
4. Anchor broadcasts confirmed event.

When authority is unavailable, per-channel policy decides behavior:

| Area | Behavior if authority unavailable |
|---|---|
| Announcements | read-only |
| Paid/subscriber channels | read-only |
| Admin/mod actions | blocked |
| Payments | blocked |
| Casual chat | optionally queue pending messages |
| Typing/presence | local-only/degraded |
| Media downloads | continue from cache if tokens valid |
| Voice rooms | continue existing room if token lease valid; block new sensitive joins |

This avoids pretending that disconnected anchors can safely own the whole community.

---

## 13. Emergency Lockdown Mode

Large artists need raid/attack controls.

One button: **Lock server**.

Effects:

- disable new account creation
- freeze invites
- slow-mode public channels
- pause expensive endpoints
- restrict media uploads
- require approval for first-time posters
- keep announcements readable
- preserve paid/private access where possible
- force anchors to reject unauthenticated traffic
- revoke suspicious helper/anchor nodes quickly

This is more useful for public figures than abstract federation complexity.

---

## 14. Threat Model

### 14.1 Small Server Threats

- misbehaving user
- accidental spam
- weak admin password
- local machine failure

### 14.2 Large Public Artist Threats

- DDoS
- scraper farms
- jealous/drama raids
- impersonation
- doxxing attempts
- malicious helper nodes
- compromised moderator account
- payment/subscription abuse
- malicious media uploads

### 14.3 Isolation Rules

- Public cache nodes must not see private DMs/mod logs/payment config.
- Worker nodes should only receive the data required for a job.
- Anchors should not mint authority signatures.
- Media nodes should only accept signed room tokens.
- Backup nodes should store encrypted data when possible.
- Revocation must be fast.

### 14.4 Public Figure Threat Model Document

A dedicated threat model document is planned for later: `docs/futuresight-public-figure-threat-model.md`.

Topics to cover:
- hidden authority
- regional anchors
- emergency lockdown
- invite freeze
- expensive endpoint shutdown
- media upload restrictions
- mod-account hardening
- cache poisoning prevention

This is deferred until the core helper-node architecture is stable.

---

## 15. Implementation Sketch

### Phase 1: Real Node Registry

**Goal:** Replace fake mesh scaffolding with actual node presence. This is the foundation everything else builds on.

**Prerequisites before starting:**
- Fracture branch landed and stable
- `bun run check` clean
- `cargo check` clean
- Runtime calling/chat verification complete

**Tasks:**

- Add `core/crates/wabi-server/src/nodes/` module:
  - `registry.rs` — HashMap<node_id, NodeRecord> with persistence
  - `pairing.rs` — Invite token creation, validation, one-time use
  - `heartbeat.rs` — Heartbeat handler, dead detection (5s interval, 15s threshold)
  - `auth.rs` — Node keypair signature verification
- NodeRecord fields:
  - node_id
  - public_key
  - role
  - capabilities
  - reachability (outbound_only / lan_reachable / public_reachable / relay_reachable)
  - last_seen
  - status (pending / connected / degraded / dead / revoked)
  - paired_at
- Control tunnel: WebSocket over HTTPS (Axum upgrade path)
- Heartbeat: lightweight "I'm alive" only (5s)
- Capability report: CPU/RAM/load/capabilities (30-60s)
- Admin REST endpoints: `GET /api/admin/nodes`, `POST /api/admin/nodes/invite`, `DELETE /api/admin/nodes/:id`
- Admin UI: Settings -> Scale with another computer -> show nodes table + revoke button
- Remove/replace fake `sync_status: synced` behavior from `wabi-mesh`

**Verification:**
- Start authority.
- Pair local helper.
- Kill helper.
- Admin UI marks it dead after timeout.

### Phase 2: Job Offload

**Start with safe jobs:**
- thumbnail generation
- video metadata extraction
- search indexing

**Tasks:**
- Add job queue table (SQLite or in-memory with persistence).
- Add worker job pull API.
- Add signed job lease.
- Add result submission.
- Add retry/failure handling.

**Verification:**
- Upload image.
- Worker generates thumbnail.
- Kill worker mid-job.
- Job retries or falls back.

### Phase 3: Blob Cache/File Offload

**Tasks:**
- Store blobs by hash (SHA-256 or BLAKE3).
- Add storage locations to file metadata.
- Add signed upload/download route tokens.
- Add cache node quota.
- Add verification by hash.

**Verification:**
- Upload file via authority.
- Mirror to cache node.
- Download from cache node.
- Tamper with cached blob; client/server rejects by hash mismatch.

### Phase 4: Media Node / Voice Offload

**Tasks:**
- Define media node capability.
- Authority assigns room to media node.
- Authority mints signed room token.
- Client connects to media node.
- Existing room can drain/migrate when node shuts down.

**Verification:**
- Join voice room hosted on helper media node.
- Revoke media node.
- Client falls back or reconnects.

### Phase 5: LAN Acceleration

**Tasks:**
- mDNS discovery for helper nodes.
- Client asks authority if local helper is allowed.
- Authority returns signed local route token.
- Client uses LAN helper for media/cache.

**Verification:**
- Same-LAN client downloads from local helper.
- Remote client ignores LAN-only helper.

### Phase 6: Warm Standby / Backup Node

**Tasks:**
- Define standby/backup capability as a high-trust opt-in node type.
- Pair standby with a public key for snapshot encryption.
- Export current live STDB state after retention/deletion has already been applied.
- Encrypt snapshot before writing or sending it to the standby.
- Send/store encrypted snapshot on the standby.
- Add manual restore/import path.
- Add manual promotion command.
- Anchor/client reconnect to promoted authority.

**Non-goals:**
- No append-only event log.
- No raw STDB data-directory copy unless proven deletion-safe.
- No automatic failover.
- No hidden long-term audit/history layer.

**Verification:**
- Pair standby node.
- Trigger encrypted live-state snapshot.
- Confirm no plaintext snapshot remains on either side.
- Confirm deleted/expired data is not present in the next snapshot.
- Kill primary authority.
- Restore/promote standby manually.
- Anchors/clients reconnect.
- No automatic split-brain.

### Phase 7: Regional Anchors

**Tasks:**
- Define anchor node role/capability.
- Start with stateless public gateway mode.
- Public clients connect through anchor.
- Anchor forwards reads and writes to authority.
- Anchor may cache static frontend assets and scoped media blobs.
- Authority outage returns clear unavailable/degraded responses.
- Defer read-only history cache until it has explicit opt-in, TTL, and scope rules.
- Region selection logic.

**Non-goals for first implementation:**
- No local STDB replica on anchors by default.
- No private channel/DM cache on anchors.
- No admin/payment/mod cache on anchors.
- No offline write acceptance.

**Verification:**
- Two anchors in different regions/local ports.
- Client connects to nearest/preferred anchor.
- Reads/writes forward to authority.
- Authority outage makes writes unavailable quickly and clearly.
- Cached static/media assets, if enabled, still serve within their scoped TTL.

---

## 16. Scaling Middleware (When, Not Now)

Basic protections for 50+ concurrent users should be added when the server actually serves that many. Not before. Not as defensive architecture theater.

When needed:
- **Socket event rate limiting:** Per-connection throttle, ~50-80 lines Rust middleware.
- **Consistent auth middleware:** Single `require_role(minimum)` wrapper, replaces scattered `is_admin()` checks.
- **Call transport validation:** Verify user is in voice channel before accepting WebRTC signaling.
- **Admin API rate limiting:** Sliding window per-session on admin routes.

What NOT to add:
- Template-based config pipelines (Sovereign pattern)
- Sidecar auth/rate-limit containers
- Request validation with schema rendering
- DDoS protection at the proxy layer (that's Cloudflare/provider's job)

These are in `docs/futuresight-scaling-middleware.md`.

---

## Research Appendix

Detailed research notes, implementation comparisons, and future backlog live in `futuresight-multi-anchor-research.md`.

Key verified precedents:
- **LiveKit distributed:** Many rooms across nodes, one room per node. Confirmed by docs.livekit.io.
- **Matrix Synapse workers:** Worker splitting is real but operationally heavy. Good cautionary example.
- **Cloudflare Tunnel:** Outbound-only connector pattern proven for NAT/CGNAT.
- **GitLab Geo:** Async warm standby with manual promotion. Good precedent.
- **IPFS:** Content-addressed retrieval proven. Use hash-addressing, not public IPFS.

---

## Summary

For normal users:

> Run Wabi on one machine. Pair extra computers when you want them to help.

For large teams:

> Run one hidden authority, several regional anchors, scoped workers/media/cache nodes, and a warm standby.

For Wabi engineering:

> Build helper-node primitives first. Do not jump to active-active federation. Start with WebSocket control tunnels. Keep the node registry in core. Make every phase additive, not destructive. Verify each phase before building the next.

