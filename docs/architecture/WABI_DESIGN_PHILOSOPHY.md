# Wabi design philosophy and Authority future-proofing

**Status:** Direction document, 2026-10-10. It states principles and constraints for future design. It does not claim any multi-node, multi-owner or storage-volume feature exists. [PROJECT_STATUS.md](../PROJECT_STATUS.md) remains the maturity boundary; [GEOGRAPHIC_COMMUNITY_WEB.md](GEOGRAPHIC_COMMUNITY_WEB.md) remains the master multi-region design.

## Why this document exists

Wabi should let anyone run their own community on one computer and grow it outward — more storage, more regions, more delivery capacity — without becoming a company and without a central service. That goal only holds if many small decisions point the same way. This document records the direction so that contributors and AI agents make those decisions consistently.

## 1. Growth principles

1. **One computer is a complete Wabi.** A single Authority with local storage needs no extra nodes, services or configuration. Every feature below is additive.
2. **Every added node is optional.** Adding a machine or storage volume makes the community faster, larger or safer. Removing it degrades performance or capacity, never correctness, and never silently loses data.
3. **Authority is clear; bytes are mobile.** One owner decides each room's permissions, history and deletion. File bytes and delivery traffic may live wherever they are closest or cheapest, because content hashes make every copy verifiable.
4. **The system does the placement work.** An operator should not need to understand replication to benefit from it. Wabi measures, proposes and executes; the operator approves the decisions that carry trust.
5. **Automatic for performance, approved for authority.** Choosing a download source, caching a hot file or copying bytes toward demand is automatic: a wrong guess costs speed and self-corrects. Moving room ownership, admitting a node that stores readable content or changing which volume holds a room's files is proposed by the system and approved by an owner/admin: a wrong decision there can split history or place private data somewhere unintended.
6. **No flapping.** Placement decisions use sustained measurements and hysteresis. A brief slowdown must not bounce a room, cache or file between locations.
7. **Make growth easy and trust unnecessary.** Adding a node should be close to "run one command, paste an invite, approve it in Admin". Hashes, signatures, epochs and revocation bound what a misbehaving or departing node can do. Volunteers can make Wabi slower by leaving; they can never make it wrong.
8. **Correctness before cleverness.** No feature is described as replication, failover or HA until its acceptance gates pass (see `AGENTS.md` rule 11 and [SERVER_MESH_PLAN.md](SERVER_MESH_PLAN.md)). One data-loss story damages trust in every self-hosted instance.
9. **Measure, then claim.** Bandwidth relief, latency and hit rate are reported as numbers from real runs, not inferred from topology.

### Two kinds of "huge"

- **Many Wabis.** Thousands of independent communities, each bringing its own server. This scales naturally; the work is making install, updates and operation easy. It is not federation ([WABI_MULTI_SERVER_ARCHITECTURE.md](WABI_MULTI_SERVER_ARCHITECTURE.md)).
- **One huge Wabi.** A single community spread across regions, owners, storage volumes and volunteers. This is the geographic design and is mostly future work.

Both should stay possible. Neither may compromise the one-computer case.

## 2. Values and responsibility

Wabi is a general-purpose tool. Like email, BitTorrent or Tor, it will be used by people the project would never choose. The project's stance:

- **Honest tools, no hidden controls.** No secret scanning, reporting, backdoors or undisclosed enforcement paths. Every control that exists is documented and visible to the operator it affects. Hidden mechanisms betray honest users and become an attack surface.
- **Operators own their communities.** In self-hosting, each operator is responsible for what their instance hosts. Wabi's job is to give them real, documented tools to act: moderation, bans, deletion, upload revocation, retention policy and export. Providing these tools is not the project enforcing anything.
- **Nobody hosts content they did not knowingly agree to.** A volunteer, regional node or storage volume holds only what its owner explicitly consented to, within visible budgets, with a clear way to stop and clear it. The current [volunteer booster](../deployment/VOLUNTEER_BOOSTERS.md) rule — volunteers cache only files they themselves downloaded — is the template.
- **Never claim more protection than exists.** Wabi is not an anonymity network. Server-readable content is labeled server-readable; experimental encryption is labeled experimental and not operator-blind (`AGENTS.md` rule 13, [PRIVACY_STANCE.md](../PRIVACY_STANCE.md)). Every new node that stores or handles readable content is another trust location and must be described as one.

Short form:

> Wabi builds honest tools, not hidden controls. Operators own their communities and get real moderation tools. Nobody hosts content they didn't knowingly agree to. We never claim more protection than we provide.

## 3. Future-proofing the Authority

Today each community has exactly one Authority. The long-term design splits ownership by room across trusted nodes, with replicas for recovery and regional nodes for delivery ([GEOGRAPHIC_COMMUNITY_WEB.md](GEOGRAPHIC_COMMUNITY_WEB.md), [GEOGRAPHIC_WRITER_AUTHORITY.md](GEOGRAPHIC_WRITER_AUTHORITY.md)). Code written for the single Authority today should not block that future. The rules below are cheap to follow now and expensive to retrofit later.

### 3.1 Separate the record from the bytes

| | Size | Single source of truth? | Lives on |
|---|---|---|---|
| **Record** — identity, room, uploader, size, SHA-256, permissions, deletion state, where copies live | Tiny | Yes | The room's owner (today: the Authority), as WabiDB events |
| **Bytes** — the file content | Large | No | Any storage volume or node allowed to hold it; verified by hash |

`upload_published_v1` already records filename, size and SHA-256, and `upload_revoked_v1` already records deletion. New file features should extend this split rather than adding paths that only work when bytes sit next to the database.

### 3.2 Rules for new server code

1. **Refer to files by identity, not by path.** New code should resolve an upload through one storage interface (see [STORAGE_VOLUMES.md](../proposals/STORAGE_VOLUMES.md)) rather than joining `config.uploads_dir` with a filename. A direct path assumes one disk on one machine.
2. **Route room writes through placement.** Room-scoped durable writes carry the observed owner and epoch to the sequencer, as selected chat/channel paths already do. A new write path that skips this check is a future split-brain bug.
3. **Additive, versioned events.** New durable facts use additive JSON events with a schema version (the pattern used by `upload_published_v1`, `room_placement_changed_v1` and `community_roster_replaced_v1`). Do not change postcard record layouts without a dual-decode migration (`AGENTS.md` rule 5).
4. **No local-only state that matters.** Any file-backed sidecar holding community state must appear in the [instance recovery inventory](INSTANCE_RECOVERY_INVENTORY.md) and have a defined replication or reconstruction story.
5. **Community identity is not a host.** Do not key long-lived client or server state on one URL or IP. The signed entry-point roster ([COMMUNITY_ENTRY_POINTS.md](../deployment/COMMUNITY_ENTRY_POINTS.md)) is the direction: a stable community key with several approved entry points.
6. **Every remote dependency has a fallback.** Caches, regional nodes, volunteers and storage volumes fail clearly and fall back to an authorized source. An unavailable optional component degrades one feature, not the whole server.
7. **Deletion reaches every copy.** Any new location that can hold bytes must consume revocation/deletion events and prove cleanup in tests.
8. **Expose measurements.** New delivery or storage paths report enough (bytes served, hits, latency, free space) for the system to place work and for operators to see bottlenecks.

### 3.3 Path from one Authority to many owners

Each step is useful on its own and keeps the one-computer case intact.

| Step | What it adds | State |
|---|---|---|
| Storage interface + local volumes | More capacity on one Authority; admin-controlled placement | Proposed: [STORAGE_VOLUMES.md](../proposals/STORAGE_VOLUMES.md) |
| Regional entry and caches | Nearby connection and repeat-download offload | Experimental Anchor and [regional upload cache](../deployment/REGIONAL_UPLOAD_CACHE.md) |
| Complete standby | Another site can be promoted after failure | Experimental pieces; not a standby |
| Room placement records | Each room has a durable owner and epoch | Groundwork exists; no room moves or routing |
| Remote storage volumes | Bytes stored near uploaders on trusted nodes; small records cross regions | Design only |
| Room moves and per-room owners | Rooms owned near their members; operator-approved moves | Design only |
| Automatic recovery | Majority-based promotion with fencing | Design only |

### 3.4 How "linking fast" should work

| Job | Meaning | Today |
|---|---|---|
| Discover | Clients learn which nodes and entry points exist | Signed roster candidate |
| Measure | Clients and nodes track latency, health and free capacity | Clients measure relay `/health` latency for file/TURN/SFU relays |
| Choose | Each request uses the best healthy source, with origin fallback | Single Anchor path; no multi-source selection |
| Place | Hot files copy toward demand; rooms are proposed for moves toward members | Not built |
| Verify | Clients and nodes check content hashes from the record | Hashes recorded; Anchor cache verifies |

## 4. What this document does not change

- Today there is one Authority per community, and every upload is stored by it.
- WabiDB replication and warm standby remain experimental and are not HA.
- Multi-server client support is not federation.
- Nothing here is a shipped feature until source, tests and PROJECT_STATUS say so.
