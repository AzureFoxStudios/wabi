# Geographic community web

**Date:** 2026-09-26  
**State:** Master architecture and implementation contract. The multi-owner and automatic-failover behavior described here is not implemented.  
**Scope:** One independently hosted Wabi community, from a small personal instance to a large community that adds trusted regional machines and optional member-contributed bandwidth.

## 1. Purpose

Wabi should let an experienced operator grow a community without making one home computer deliver every file, call and conversation to every region. A regional node should serve work that belongs near its members. A trusted replica should let the community recover when a node fails. Member volunteers should be able to donate bounded delivery capacity without receiving control of the community.

This is a topology for **one community**. Separate Wabi communities remain independent. Operators choose their own machines, locations and connectivity; Wabi does not require a central Wabi-operated service or a domain name. A community may begin with one Authority and gain nodes as its actual load warrants.

Four requirements are independent and must be measured independently:

1. **Locality:** members of a locally owned conversation can send, persist and receive locally; remote members receive only the events they are authorized to see.
2. **Capacity:** room owners, regional delivery nodes, media services and file caches can be added so the busiest community is bounded by provisioned hardware and network capacity, not one fixed origin uplink.
3. **Resilience:** loss of a node has a defined recovery path and never creates two writers for the same state partition. Automatic recovery requires a tested election and fencing protocol.
4. **Operator control:** the operator can see ownership, placement, lag, volunteer contribution, degraded modes and the actual recovery window.

## 2. Node roles and trust

| Role | Holds | May do | Failure effect |
|---|---|---|---|
| Community control | Community identity, node membership, global roles and routing epochs | Authorize node membership and publish signed routing state | New placement and global role changes pause until control recovers |
| Room owner | Canonical retained state for assigned rooms | Sequence writes, check permissions, publish ordered room events | Its rooms need a fenced replica promotion |
| Recovery replica | Complete, verified state for specific control/room partitions | Apply ordered copies; become owner only after promotion | Reduces recovery margin; never accepts writes while passive |
| Regional access/delivery | Session ingress, authorized local fanout and eligible cached bytes | Connect members to owners and deliver selected events/files | Clients choose another entry point or origin fallback |
| Media helper | TURN/SFU or other scoped media work | Carry assigned calls/media | Calls move or reconnect; canonical chat state is unaffected |
| Volunteer booster | Bounded, revocable cache or delivery session | Serve specifically authorized bytes when reachable | Performance may fall back; no authority or recovery role is lost |

One physical machine may hold several trusted roles. A volunteer role never implies trust for other roles. Recovery replicas require greater trust than caches because they may hold full community state and keys. Roles must be explicit in configuration and UI rather than inferred from machine size or heartbeat.

## 3. Data ownership and routing

Each durable room or work partition has one owner in a numbered epoch. The owner alone accepts canonical writes for that partition. A stable community ID and stable room IDs survive endpoint changes. The placement map records owner, recovery replicas, eligible regional delivery nodes and the epoch. Clients may connect through any authenticated entry point, but writes route to the current owner.

For a local room, the owner persists and fans out to local subscribers without a distant Authority round trip. For a room with remote members, the owner sends an ordered event once to each region with authorized subscribers; the regional node fans it out locally. Regional nodes do not scan all community accounts or receive all rooms by default. A room can move after an explicit fenced handoff and verified state transfer.

Global identity and roles need a strong consistency rule. A node must not keep accepting a removed member because a remote role update was silently delayed. During partitions, define which operations pause and which may proceed under a bounded last-known policy. Room-local actions may continue only under the published durability and permission contract; cross-region delivery queues and catches up without duplicate accepted messages.

Attachments belong to a stable content identity and a permission scope. The room owner records the reference; delivery may use regional caches or eligible volunteer devices. Revocation, deletion, expiry, integrity and origin fallback apply to every copy. Presence and notifications use subscriptions and summaries; they must not create all-to-all traffic as membership grows.

## 4. Availability and durability

Start with a safe, operable recovery path: complete state inventory, consistent snapshot, ordered incremental catch-up, verified retained-state restore, manual promotion, old-owner fencing and client redirect. Include WabiDB, uploads, identities/keys, retention and encryption sidecars, shared notes, node state and relevant addon data. An event segment or standby envelope alone is not a recoverable community.

Then add automatic recovery if the operator enables it. Three trusted voting nodes can form a majority after one node fails. Every partition has a durable owner epoch; a minority cannot create a second owner. Promotion must also transfer or account for uploads and sidecars. The former owner must rejoin as a follower after reconciliation rather than resume stale writes.

There is a latency/durability choice. Waiting for a distant replica before acknowledging each write adds the inter-region round trip. Acknowledging locally and copying later gives local latency with a measured possible-loss window. An additional nearby durable replica can protect against one machine failure without a distant round trip. The selected acknowledgment rule and recovery point must be visible to the operator. No protocol can promise zero acknowledged-write loss and zero remote durability traffic after losing the only local copy.

## 5. Connectivity without a domain

An operator may publish reachable IP endpoints, private Tailcat endpoints or a domain. Community identity is independent of all of them. An invitation or saved connection profile needs multiple authenticated entry points and a signed/versioned placement map so a dead original host is not the only path to its replacement. Tailcat transports traffic; it neither grants Wabi membership nor elects a writer. Regional entry points must carry HTTP streaming, uploads, Socket.IO polling and WebSocket upgrades. Client reconnect must preserve optimistic message identity and avoid duplicate sends.

Public IP, Tailcat, relay and direct peer delivery have different performance and reachability. A field test must use real separate networks, record which path carried each payload and retain fallback evidence. Operator-owned routing/discovery must be replaceable; no central Wabi domain or relay is mandatory for the topology.

## 6. Trusted capacity plus volunteers

Trusted room/control nodes handle writes and recovery. Trusted regional delivery and media nodes absorb predictable load. Volunteers add optional capacity for popular eligible content with user consent, budgets, verification, expiry and origin fallback. A volunteer never holds Authority credentials, votes in an election or becomes the only copy of a file. Volunteer departure changes performance, not correctness.

The [current booster candidate](../deployment/VOLUNTEER_BOOSTERS.md) is limited to small, explicitly downloaded channel attachments in memory and direct peer transfer. Broad file caching, inline assets, hot-room message relay and media contribution are separate designs with different privacy, reachability and reliability requirements. Volunteers on the same saturated uplink as the origin do not increase that uplink; geographically distributed volunteers with independent uplinks can.

## 7. Privacy and authorization

Inter-node transport encryption does not make server-readable content invisible to a node that stores it. Replicate full state only to trusted recovery nodes. Send room data to a regional delivery node only for a room it owns or for authorized local subscribers. Volunteer delivery of private content needs an explicit content and consent policy; peer IP disclosure, cache expiry and revocation are part of that policy. Content encryption can narrow node visibility only when its actual client/key contract is established; Wabi's current experimental encryption is not an independently verified operator-blind guarantee.

Node transport admission, Wabi account authentication, room permissions, service grants and media access remain separate checks. No helper or volunteer role can bypass membership or permissions. Deletion and retention must propagate to every durable copy, cache and recovery path without resurrecting expired content.

## 8. Capacity model

Size a **single installation**, never the aggregate of all Wabi communities. The detailed arithmetic and assumptions live in the [capacity and failure design](../plans/2026-09-26-geographic-community-nodes.md). The acceptance envelope must include many-room traffic and a hot creator event:

- 500,000 registered accounts, with measured simultaneous sessions, writes per second and recipient fanout;
- a 100,000-viewer channel, where even ten visible 1 kB messages per second produce about 8 Gb/s aggregate client delivery;
- an asset drop whose repeated downloads are served from regional caches and volunteers rather than the origin;
- interactive calls measured separately from one-to-many broadcast delivery; an SFU is not a chat database or a general audience CDN;
- one regional node down, one room owner down, a 1-versus-2 partition and the old owner returning.

The implementation must demonstrate predictable scaling as delivery nodes and room owners are added. A single huge room remains a hotspot: one owner sequences it, while regional nodes share its delivery load. No finite benchmark proves arbitrary size, but a demanding 500,000-member envelope gives useful evidence for smaller communities with similar activity patterns.

## 9. Build sequence

1. **Regional entry:** make the existing stateless Anchor correctly stream HTTP bodies and proxy WebSocket upgrades. Prove real Socket.IO, upload and failure behavior. This is connectivity groundwork; chat still terminates at the Authority.
2. **State inventory and recovery:** identify all durable instance state, implement consistent snapshots/catch-up and complete restore, then manual fenced promotion and client redirect.
3. **Room placement:** stable community/room identity, ownership epochs and routing; one room can be assigned to a second trusted node while existing single-Authority rooms continue to work.
4. **Selective regional delivery:** subscription-based inter-node events, local fanout and backpressure, with permission and retention checks.
5. **Automatic recovery:** three-node membership, durable election/fencing per partition and partition/return tests. Keep manual recovery available.
6. **Capacity tier:** regional file/media placement, measured volunteer extension, hot-room load testing and operator-visible bottlenecks.

Each step needs a narrow migration path for existing single-server data and a reversible operator procedure. Do not change postcard durable record layouts without versioned decoding. The simple one-server mode remains a valid deployment.

## 10. Current boundary and source of truth

The current worktree also preflights the actual parent and channel stream for
all 22 local Wiki, Forum, incident, gallery and project-task/run event types.
The adapter shares that catalog with the database; placed rooms refuse missing
or unrelated owner conditions before preparation, and workspace mutations
cannot be combined with a placement change. This closes these raw-command
bypasses while preserving supported historical record decoders and replay.
Other internal and live paths, authenticated enrollment, distributed leases,
independent room owners and selective routing remain incomplete. See the
[workspace admission contract](../deployment/WORKSPACE_ROOM_ADMISSION.md).

Today Wabi has one Authority per community; helpers have scoped capabilities; the current working-tree Anchor streams canonical HTTP, bridges WebSockets, and serves matching embedded versioned app assets locally. Chat and API work still reaches the Authority. An [optional bounded upload cache](../deployment/REGIONAL_UPLOAD_CACHE.md) passed a loopback fill, hit and revocation check for eligible files; it still needs the Authority for each request. A [fresh three-site run](../testing/THREE_SITE_FIELD_2026-09-28.md) measured one equipment-Anchor cache miss at 263,175 upstream bytes and its hit at 504, plus zero upstream bytes for each sampled embedded app asset. These are scoped TCP samples; whole-uplink and sustained measurements remain open. A working-tree [signed entry-point roster](../deployment/COMMUNITY_ENTRY_POINTS.md) gives registered clients a stable community key and approved URLs, but it does not discover or elect a live writer and local client state remains URL-scoped. A new WabiDB room-placement projection records bounded owner/replica IDs and a monotonic epoch. New rooms commit a local placement with creation, and the sequencer now checks placement validity before durability. A stopped-Authority tool can assign legacy active rooms to that same node. Selected local chat paths refuse a write when a changed record names another owner, including Live-room session sends. Selected durable chat, channel and group-membership writes now recheck owner and epoch before durability, but Live session-only and other room paths still lack a complete atomic owner fence. Regional routing and operator room move do not exist yet. WabiDB network replication and warm standby are experimental and incomplete. The [project status](../PROJECT_STATUS.md) gives the maturity boundary. The [existing multi-node runtime plan](SERVER_MESH_PLAN.md) describes the current Authority/helper/Anchor code, and the [capacity and failure design](../plans/2026-09-26-geographic-community-nodes.md) gives calculations and verification gates. Source and measured field runs decide whether a build has passed a step. This document defines the target architecture and does not promote unfinished code into a working multi-owner cluster.
