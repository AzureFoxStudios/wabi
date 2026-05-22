# Wabi Multi-Anchor + Helper Node Architecture — Futuresight Proposal

**Status:** Proposal / notes for later. Not for immediate implementation until core Wabi chat, calls, storage, and addon fracture work are stable.

**Problem:** Wabi's current mesh addon is scaffolding only. It does not provide real routing, replication, offload, heartbeat handling, or server-to-server state sync. This document proposes a realistic path for letting Wabi scale beyond one box without jumping straight into cursed full federation.

**Core idea:** Keep Wabi simple for normal self-hosters, but allow larger communities to pair extra machines as scoped helper nodes, regional anchors, media nodes, cache nodes, and warm standbys.

---

## 1. Design Philosophy

Wabi should not begin with “server mesh.” That phrase is too vague and implies every node is equal.

The safer framing:

- **One community authority** owns truth.
- **Helper nodes** do bounded work.
- **Regional anchors** absorb public traffic.
- **Media/cache/worker nodes** offload expensive paths.
- **Warm standby nodes** preserve recoverability.
- **Full active-active multi-writer mesh** is a last resort, not the starting point.

This keeps Wabi closer to a self-hosted Minecraft/Discord alternative than a Matrix-sized distributed protocol.

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
- Canonical event log
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
- fallback media/file routing
- possibly STDB/TCP call fallback later

Trust level depends on deployment:

- Private relay: trusted by the server operator
- Volunteer relay: untrusted or semi-trusted; must only see encrypted/token-scoped traffic

### 2.4 Cache Node

A cache node stores content-addressed blobs and derived media.

Responsibilities:

- file downloads
- public media cache
- thumbnails
- optimized images
- video preview variants
- static assets

Rules:

- Store by hash/CID-like content key, not arbitrary paths.
- Primary/authority owns metadata and permissions.
- Clients receive signed download/upload tokens.
- Cache nodes should not be able to mint permissions.

### 2.5 Media Node

A media node handles voice/video routing.

Responsibilities:

- SFU/media relay
- voice room hosting
- regional call routing
- screen-share relay
- recording/transcoding only if explicitly enabled

Primary still owns:

- who may enter the room
- channel membership
- moderation state
- room lifecycle

Media node only accepts signed room tokens.

### 2.6 Regional Anchor

An anchor is a public gateway for a large community.

Responsibilities:

- public WebSocket/API entrypoint
- regional client fanout
- local cache
- upload ingress
- voice/media coordination
- DDoS blast-radius reduction
- route users toward local media/cache nodes

Anchors are not equal authorities. They are scoped gateways.

For a worldwide art team:

- Asia anchor
- North America anchor
- Europe anchor
- optional South America/Oceania anchors

Users connect to the closest healthy anchor. The anchor talks to the authority.

### 2.7 Warm Standby Node

A warm standby receives replicated event logs/snapshots from the authority.

Responsibilities:

- encrypted event log backup
- snapshot storage
- restore target
- manual promotion if authority dies

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
             +-> Backup node: event log copy
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

## 6. Signed Tokens as the Safety Primitive

Helper nodes should not need full database access or global permission logic.

The authority should mint scoped signed tokens.

### 6.1 SignedRouteToken

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

### 6.2 NodePairingToken

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

### 6.3 Node Revocation

Authority must be able to revoke a node instantly.

Revocation should:

- invalidate route tokens issued to the node
- reject node heartbeats
- stop assigning jobs
- ask anchors/clients to fail over
- mark cached data as suspect if needed

---

## 7. State and Data Levels

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

A standby receives event log/snapshots and can be manually promoted.

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

## 8. Regional Anchor Semantics

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

## 9. Emergency Lockdown Mode

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

## 10. Threat Model

### 10.1 Small Server Threats

- misbehaving user
- accidental spam
- weak admin password
- local machine failure

### 10.2 Large Public Artist Threats

- DDoS
- scraper farms
- jealous/drama raids
- impersonation
- doxxing attempts
- malicious helper nodes
- compromised moderator account
- payment/subscription abuse
- malicious media uploads

### 10.3 Isolation Rules

- Public cache nodes must not see private DMs/mod logs/payment config.
- Worker nodes should only receive the data required for a job.
- Anchors should not mint authority signatures.
- Media nodes should only accept signed room tokens.
- Backup nodes should store encrypted data when possible.
- Revocation must be fast.

---

## 11. Implementation Sketch

### Phase 1: Real Node Registry

Goal: replace fake mesh scaffolding with actual node presence.

Tasks:

- Add node table/types:
  - node_id
  - public_key
  - role
  - capabilities
  - reachability
  - last_seen
  - status
- Add pairing token creation endpoint.
- Add helper join endpoint.
- Add heartbeat endpoint/tunnel message.
- Show nodes in admin UI.
- Remove/replace fake `sync_status: synced` behavior.

Verification:

- Start authority.
- Pair local helper.
- Kill helper.
- Admin UI marks it dead after timeout.

### Phase 2: Job Offload

Start with safe jobs:

- thumbnail generation
- video metadata extraction
- search indexing

Tasks:

- Add job queue table.
- Add worker job pull API.
- Add signed job lease.
- Add result submission.
- Add retry/failure handling.

Verification:

- Upload image.
- Worker generates thumbnail.
- Kill worker mid-job.
- Job retries or falls back.

### Phase 3: Blob Cache/File Offload

Tasks:

- Store blobs by hash.
- Add storage locations to file metadata.
- Add signed upload/download route tokens.
- Add cache node quota.
- Add verification by hash.

Verification:

- Upload file via authority.
- Mirror to cache node.
- Download from cache node.
- Tamper with cached blob; client/server rejects by hash mismatch.

### Phase 4: Media Node / Voice Offload

Tasks:

- Define media node capability.
- Authority assigns room to media node.
- Authority mints signed room token.
- Client connects to media node.
- Existing room can drain/migrate when node shuts down.

Verification:

- Join voice room hosted on helper media node.
- Revoke media node.
- Client falls back or reconnects.

### Phase 5: LAN Acceleration

Tasks:

- mDNS discovery for helper nodes.
- Client asks authority if local helper is allowed.
- Authority returns signed local route token.
- Client uses LAN helper for media/cache.

Verification:

- Same-LAN client downloads from local helper.
- Remote client ignores LAN-only helper.

### Phase 6: Warm Standby

Tasks:

- Append-only authority event log.
- Stream log to standby.
- Periodic snapshots.
- Manual promotion command.
- Anchor reconnect to promoted authority.

Verification:

- Kill primary authority.
- Promote standby manually.
- Anchors reconnect.
- No automatic split-brain.

### Phase 7: Regional Anchors

Tasks:

- Define anchor node role.
- Public client connection through anchor.
- Anchor forwards writes to authority.
- Anchor caches reads/media.
- Anchor supports degraded read-only mode.
- Region selection logic.

Verification:

- Two anchors in different regions/local ports.
- Client connects to nearest/preferred anchor.
- Authority outage makes admin/payment actions unavailable but cached reads continue.

---


---

## Research Appendix

Detailed research notes, implementation comparisons, and future backlog live in `futuresight-multi-anchor-research.md`.
