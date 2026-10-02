# Geographic community nodes: capacity and failure design

**Recorded:** 2026-09-26  
**Status:** Engineering target and implementation plan; the resilient topology described here is not shipped.  
**Related:** [multi-node runtime plan](../architecture/SERVER_MESH_PLAN.md), [project status](../PROJECT_STATUS.md), [backup and recovery](../deployment/BACKUP_AND_RECOVERY.md).

## Design objective

An experienced operator can place Wabi nodes in different cities, use ordinary spare computers where appropriate, and keep one community usable across those regions. Nearby nodes should absorb work that can safely be performed near members. Loss of one node should have a defined recovery path, with no duplicate writable community and no silent loss or resurrection of retained data.

Wabi is open source and independently hosted. The sizing target is the largest **single community installation**, not the total number of people across all Wabi installations. A large creator community should be able to add regional nodes and stronger hardware as its own load grows; small installations should not inherit that operational complexity.

This is one community with one canonical state, not three independent Wabi communities that happen to be visible in the same client. It is also not a promise that every computer shares every task. The operator should choose which nodes are trusted to hold full community data and which provide only scoped services.

The product needs separate, truthful claims:

| Capability | Meaning | Current status |
|---|---|---|
| Regional offload | Serve eligible files/media/compute near members; proxy interactive traffic correctly | Scoped helpers and candidate file boosters exist; a [three-process loopback Anchor preflight](../testing/THREE_SITE_ACCESS_PREFLIGHT_2026-09-27.md) and an [opt-in upload-cache loopback check](../testing/REGIONAL_UPLOAD_CACHE_2026-09-27.md) passed. A [fresh three-site Tailscale check](../testing/THREE_SITE_FIELD_2026-09-28.md) passed site-origin HTTP/WebSocket writes and scoped static/cache byte measurements after iRonin moved; full desktop/media and whole-uplink acceptance remain open |
| Local conversation ownership | Two members using a room owned by their region can send, persist and receive messages there without a cross-region round trip | Not implemented; all canonical conversation writes belong to one Authority |
| Recoverable standby | Another site has a complete, verified copy and an operator can promote it | A complete stopped-instance archive can be encrypted, sent to a separate inbox, fetched and restored in a disposable loopback test. Narrow WabiDB and verified-upload catch-up passed a two-network field check. A controlled passive move passed a local stopped-tree comparison and restart after the old writer was fenced. Complete-instance live checkpoint/catch-up and unavailable-host promotion are not ready |
| Automatic survival of one node loss | Remaining nodes select one writer, redirect clients and continue within a measured recovery target | Not implemented; requires a quorum/fencing and routing design |
| Concurrent writes to the same room during a partition | Two isolated regions both change one room and merge later | A separate conflict-resolution problem; not part of this release requirement |

## October 2 checkpoint prerequisite

The working tree now has a locally accepted, default-off signed checkpoint
producer and a separate versioned encrypted-byte consumer/store. The real
capture, protected decrypt, root-derived community identity and actual
same-database Authority reconstruction checks pass. Final frozen workspace
acceptance is **2,663 passed, 0 failed, 15 ignored**, with unchanged source and
frontend hashes; ignored external fixtures are not claimed accepted.
See [the exact source/outcome record](../testing/SIGNED_CHECKPOINT_SOURCE_2026-10-02.md).

This is a prerequisite for recovery, not automatic survival or local room
ownership. Allocation knowledge and every writer/quorum/full-instance permit
remain unknown/false. The first signed-byte schema is limited to 64 MiB of
logical ciphertext. The [next transfer contract](2026-10-02-checkpoint-byte-rpc-contract.md)
requires authenticated voter/store binding, exact peer acknowledgments,
retrieval/reseeding and owned storage work; its two draft files are still
unreferenced and uncompiled. Committed tail/blob availability, full enabled
state, safe writer allocation, client recovery, regional room ownership and
large-community measurement remain mandatory gates below.

## Reference topology

```text
City A: active Authority + local media/file helper
                   | authenticated node transport
City B: regional access/cache node + eligible standby
                   | authenticated node transport
City C: regional access/cache node + eligible standby or witness

Members connect through an available, nearby entry point.
Only the active Authority accepts canonical community writes.
```

The node roles can share a physical computer, but their permissions cannot be conflated. A cache or media helper does not need WabiDB root keys. A standby that can become Authority is highly trusted and needs a complete, recoverable state set. Three nodes make a majority possible for a future automatic leader decision; merely installing Wabi on three machines does not create that safety property.

For small communities, the normal one-computer deployment stays simple. The regional topology is an explicit advanced mode with visible health, lag, authority and recovery state.

The diagram above is the incremental recovery topology for today's single-Authority product. It does **not** make same-region chat local when that region is far from the Authority. The full geographic-load goal needs the room-ownership design below in addition to recovery.

## Local conversation ownership and selective delivery

For a larger community, give each channel or conversation a stable home node or region. That node sequences its writes, checks current membership and fans out to nearby members. Other nodes receive only the events needed for their authorized local subscribers and any explicitly required recovery replica. A room with only local members can complete its normal send and delivery path locally. A room spanning regions necessarily sends its relevant events across those regions. This is **one writer per room or partition**, not conflicting writes to the same record in every city.

The community still needs a reliable way to manage shared identity, membership, roles, room ownership and routing. A role change or member removal must reach room owners before they authorize subsequent activity, according to a defined consistency rule. Moving a room to another node needs a fenced handoff: transfer retained state, establish the new owner and prevent the old owner from accepting later writes. Presence, notifications, search and attachment references need similarly scoped routing instead of a global broadcast by default.

Locality is a measurable property, not a label. In the three-site field test, two local members in a locally owned room should exchange messages while the inter-site link is blocked, subject to that room's published durability and permission rules. A remote member's delivery should queue and catch up after the link returns. Record whether a local send was acknowledged before or after its recovery replica durably received it; that determines the possible loss window if the local node also fails.

Selective delivery can reduce data exposure, but every node that stores or handles server-readable content is another trust location. A regional node must see only the rooms it owns, serves to authorized members or replicates for recovery. Cross-region messages and files need explicit storage, retention, deletion and access rules. Transport encryption protects the link; it does not make a regional operator blind to content that Wabi sends there in readable form. Current experimental room encryption cannot be treated as an independently verified operator-blind guarantee.

## Capacity model: 500,000 members as a sizing exercise

Member count alone is a weak capacity measure. Size and test these separately: registered accounts, simultaneous sessions, peak room writes, live recipients per message, attachment bytes, cross-region subscribers, simultaneous calls and recovery-copy lag. An especially large or active room can be harder than many small rooms with the same total membership.

An illustrative workload—not a measured Wabi result—uses 500,000 accounts, 10% simultaneously connected, 20 messages per account per day, a peak ten times the daily average, 50 online recipients per message and 1 kB per stored/delivered message envelope:

| Derived load | Calculation | Approximate result |
|---|---|---|
| Connected sessions | 500,000 × 10% | 50,000 |
| Messages written | 500,000 × 20 per day | 10 million/day; 116/second average; 1,160/second at the assumed peak |
| Live deliveries | 1,160 peak writes/second × 50 recipients | 58,000 deliveries/second across all regional nodes |
| Message delivery bandwidth | 58,000 × 1 kB × 8 | 460 Mb/s aggregate before protocol overhead |
| Message storage | 10 million × 1 kB | 10 GB/day logical payload; about 30 GB/day for three full copies before indexes and metadata |

This traffic can be divided across room owners and regional fanout nodes. A local room's delivery traffic stays local. For a cross-region room, send an event once per destination region and fan it out there rather than sending one intercontinental copy per recipient. Recovery replication still consumes WAN bandwidth even for local rooms. Files and media need separate budgets because they can dominate text traffic.

### Largest-clump event

A creator community can concentrate traffic in one room or one publication. Suppose 100,000 people are watching one live channel and the channel displays ten 1 kB messages per second. That is **one million client deliveries per second**, or about **8 Gb/s aggregate message payload egress** before overhead. With twenty equally loaded regional delivery nodes, each sends about 400 Mb/s locally. The room owner needs to send roughly one copy of each message to each region: about 1.6 Mb/s of inter-region payload for this example, plus durability replication and protocol overhead. Regional fanout can dramatically reduce the origin's upload demand, but the aggregate delivery work remains real and more edge capacity must be added as viewers grow.

An art drop of one 10 MB file downloaded by 100,000 people is 1 TB of delivered bytes. Regional caches, content-addressed storage, access checks and invalidation matter more than room-write throughput for that event. A 100,000-viewer live video stream at 2 Mb/s is about 200 Gb/s of viewer delivery; that calls for a broadcast distribution tier, not the same SFU topology used for small interactive calls. The media tier is optional to the core communication capacity target, but Wabi must not funnel such traffic through one home Authority.

The scale design must avoid per-message scans of all 500,000 accounts and per-user inter-region copies. It needs subscription indexes, bounded regional fanout, queue/backpressure behavior for hot rooms, regional file delivery and measured per-node limits. A three-node quorum can decide which copy owns data after failure; it does not by itself provide enough delivery bandwidth for a large live audience. The capacity exercise must include a hot-room benchmark as well as normal many-room traffic.

The durability/locality tradeoff is explicit: if the local owner acknowledges a message only after another city has durably accepted it, acknowledgment latency includes the inter-city round trip. If it acknowledges locally and replicates asynchronously, nearby members can converse at local latency but an owner failure can lose the unreplicated tail. A second local durable replica can protect against one local machine failure without a distant round trip, while regional disaster recovery still has its own lag. The operator must see the chosen acknowledgment rule and measured recovery point.

For media, an illustrative 5,000 simultaneous video participants in four-person rooms, each publishing 1 Mb/s and receiving the other three tracks, require roughly 15 Gb/s of aggregate SFU outbound traffic before overhead. SFUs can be distributed among rooms; an SFU does not store messages, authorize workspace edits or remove the need to size a very large individual call. These numbers establish that a multi-node architecture is plausible to explore, not that a particular Wabi build or three laptops have passed this load.

## Trusted managers and voluntary delivery capacity

Keep canonical room owners, recovery replicas, permissions and node elections on trusted operator-managed computers. A member volunteer contributes an optional, bounded delivery path. It cannot become a room owner or recovery voter simply by donating upload bandwidth. The recipient must have a normal authorized fallback when the volunteer is unavailable.

The current helper registry now keeps capabilities fixed by the operator's pairing token: a node heartbeat cannot add `Standby` or `Backup` to its own grant. Damaged registry state stops Authority startup rather than silently resetting the trusted-node list. This closes a helper trust gap, but the registry is not quorum membership and does not elect or fence writers.

The potential savings are large for popular files. In an idealized future 10 MB art drop with 100,000 downloads, total delivery is 1 TB. If 100 volunteers each serve 1,000 downloads over one hour, each contributes 10 GB, averaging about 22 Mb/s upload; the origin seeds roughly 1 GB if it sends one copy to each volunteer, plus misses and protocol overhead. These are capacity arithmetic, not observed Wabi performance. Volunteers need distinct useful uplinks: devices behind the same saturated site connection do not increase that site's internet upload capacity.

The current working-tree booster candidate is narrower: member opt-in, explicit channel attachments of at most 8 MiB, up to 16 cached files in memory for five minutes, direct WebRTC delivery without TURN, verified bytes and Authority fallback. It does not carry inline media, calls, chat, room state or failover. A three-machine field run verified two direct 256 KiB transfers without a second Authority file request, but the peer path started more slowly than the origin and another network pair fell back to origin. See [booster operations](../deployment/VOLUNTEER_BOOSTERS.md) and [field evidence](../testing/BOOSTER_FIELD_TEST_2026-09-20.md).

To extend volunteering beyond this bounded file path, define transport reachability, cache admission/expiry, rate budgets, integrity, permission revocation, privacy and origin fallback per content class. A volunteer that receives readable private content or peer IP addresses changes the trust/privacy exposure. Real-time message or media relaying needs a separate design with stable routing and bounded failure behavior; it must not inherit the file boost's consent or integrity model by assumption.

## Networking and discoverability

- A domain is optional. A node may advertise a reachable IP endpoint or a private transport endpoint such as Tailcat. All three sites must be tested on their actual separate networks; three clients on one LAN do not prove the cross-region path.
- Node reachability and community identity are different. Clients must recognize the same community after its active endpoint changes and must not mistake a different server at a reused address for the old community.
- A connection profile or invitation needs more than the current Authority address: at least two verified entry points, a stable community identity and a way to learn the current active Authority. The working-tree candidate signs an owner-approved, versioned entry-point roster with a key derived from the WabiDB root key. It lists access addresses, not an elected live writer. Clients pin the key per account and exact URL and reject older, altered or expired rosters. A WabiDB event now carries owner roster changes to a fenced development receiver in a loopback check; this does not give Anchors an independent authenticated roster endpoint or a recoverable whole instance. See [entry-point operations](../deployment/COMMUNITY_ENTRY_POINTS.md). Promotion, complete roster delivery to surviving entry points and offline bootstrap beyond the roster lifetime remain open.

- The bootstrap path must still work when the original Authority is offline. A domainless installation cannot depend on one dead IP or one dead Tailcat listener to discover its replacement.
- An Anchor must carry HTTP streaming/uploads, Socket.IO polling and WebSocket upgrades with correct authentication, timeouts and backpressure before it can be an interactive regional entry point. Forwarding every response through the Authority reduces locality; cache/media services need explicit authorization and fallback.
- Tailcat and public IP are alternative reachability paths. Switching between them must not change community identity or state ownership. A relay path may work when direct peer connections do not, but its throughput and availability are part of the field acceptance result.

### Roster projection change (2026-09-27)

`community_roster_replaced_v1` is an additive JSON event on the `community-roster:v1` stream (kind 6). Its `community_roster` projection stores one `v1` record with `schemaVersion`, monotonic `version`, and the canonical array of `{nodeId, role, url}` entries. An existing `community_roster.json` is imported only when that projection has no row; later owner updates are WabiDB commands and the sidecar is no longer written. The event adds no fields to older postcard records. Old binaries may not understand the event and can see a stale sidecar after rollback, so a matching stopped backup or explicit migration is required. A fenced development receiver can catch this control record, but it still cannot become a Wabi Authority without matching uploads, remaining sidecars, keys, and a safe writer fence.

### Upload revocation projection change (2026-09-27)

`upload_revoked_v1` is an additive JSON event on the `upload-revocations:v1` stream (kind 6). Its `upload_revocations` projection indexes a bounded `{schemaVersion: 1, filename}` denial by filename. At Authority startup, legacy `upload_registry.json` revocations absent from WabiDB are imported as events, and projected revocations are merged back into the local registry. Owner/admin deletion routes commit the event before removing the file and confirming success. A configured fenced receiver excludes revoked names from later copying and removes matching published or staged files after applying the denial, including on restart. It records the cleanup position separately from WabiDB application. This is current-tree deletion, not secure erasure of caches, backups or raw historic database records. Old binaries do not understand this event and may serve a stale registry after rollback; use a matching stopped backup or an explicit migration when downgrading.

### Upload publication projection change (2026-09-27)

`upload_published_v1` is an additive JSON event on the `upload-assets:v1` stream (kind 6). Its `upload_assets` projection indexes immutable filename, original name, channel/uploader association, kind, byte count, SHA-256, and creation time. The Authority commits this expectation while bytes are still staged and acknowledges only after the final file is published and synced. Retrying the same filename preserves its timestamp and refuses conflicting metadata or digest. An explicitly configured fenced receiver can request missing files after WabiDB catches up. The Authority checks its projected expectation and local hash before sending bounded chunks; the receiver resumes at an exact staged offset and verifies the hash before public rename. Authority startup can finish a recognized staged direct or resumable upload after a publication crash only when its bytes match the canonical size and SHA-256. It also hashes existing canonical files and can reconstruct entries absent from a stale upload registry when the matching bytes are present; a missing or changed nonrevoked file refuses startup. Hashing the full canonical upload tree increases startup time as the tree grows. Uncommitted private staging files are not published by this recovery path. Preexisting registered files can gain these events through the explicit stopped-Authority [legacy upload backfill](../deployment/LEGACY_UPLOAD_BACKFILL.md); unregistered files are never inferred, and the tool does not create a whole-instance checkpoint. The receiver itself does not serve clients, and copied files do not constitute a complete cross-file checkpoint. Old binaries do not understand this event and can retain stale metadata after rollback; use a matching stopped backup or explicit migration when downgrading.

## State and failover contract

1. **One writer and fencing.** Define who may accept writes in each epoch. A standby must refuse writes until promoted. The old Authority must remain fenced after promotion, including when it reconnects from a network partition. Health checks alone cannot authorize promotion.
2. **Complete state inventory.** Recovery must account for WabiDB durable state and projections, uploads/blobs, server identity and encryption keys, configuration, plugin-owned state and file-backed sidecars such as retention policy, encryption registry, shared notes and node/Tailcat settings. Classify each item as replicated, reconstructed, local-only or deliberately excluded. A replica of commit metadata alone is not recoverable Wabi.
3. **Consistent copying.** Define a crash-consistent checkpoint or retained-state export with an ordering boundary shared by the database and required sidecars/uploads. Do not treat a copied segment or encrypted empty envelope as a backup. Restoring retained state must not resurrect deleted or expired content.
4. **Catch-up and proof.** A standby must receive missing bytes, verify hashes and sequence continuity, apply them to live projections, expose its applied position and survive restart. Replication lag and the last recoverable checkpoint must be visible to the operator.
5. **Recovery objective.** Before promising failover, choose and publish a recovery time objective (time until members can use Wabi again) and recovery point objective (maximum acknowledged data loss). A zero-loss claim needs writes acknowledged only after the required replica quorum has durably accepted the complete write. Asynchronous replication needs a stated possible loss window.
6. **Promotion and rollback.** First implement a tested operator-driven promotion with an explicit fence and a safe client redirect. Rejoining the old Authority must use a full reconciliation/reseed path; it cannot resume as a second writer or overwrite newer state.
7. **Automatic election, if claimed.** For a three-node automatic design, specify majority membership, terms/epochs, durable votes, fencing, witness/standby roles, behavior under a 1-versus-2 partition and endpoint updates. The minority must stop canonical writes. Implement and test this only after manual promotion and complete state replication work.

### Runtime pause foundation (2026-09-28)

The working tree adds a shared local operation gate for HTTP handler execution,
89 asynchronous Socket.IO callbacks, owned account publication and background
mutation passes. Nested work shares admission, and owned work retains it after
caller cancellation. A pause drains these participants and holds new work
until released. This addresses one cross-file ordering prerequisite; it does
not freeze arbitrary direct engine/plugin/external writers or produce a
complete encrypted checkpoint. No exporter or promotion is enabled by it.
See [the implementation and remaining coordination contract](../deployment/RUNTIME_OPERATION_PAUSE.md).
Gate B, C and D remain open.

The subsequent [coordinated database/copy boundary](../deployment/CHECKPOINT_BOUNDARY.md)
holds local commit windows and inbound ingestion after that application drain,
checks indexed/applied prefix agreement and holds the projection snapshot writer
through blocking file work. Caller cancellation cannot release its guards while
started copying continues. An interrupted admitted task vetoes preparation.
An asynchronous preparation deadline refuses stalled or late preparation
without aborting admitted work. The [153 final focused checks](../testing/CHECKPOINT_BOUNDARY_2026-09-28.md)
include a matching local main Wabi copy/reopen and failure/cancellation cases.
This advances shared ordering; it does not enable a complete encrypted live
exporter, unknown/external participant coverage or unavailable-host promotion.

The internal [encrypted live core archive candidate](../deployment/LIVE_CHECKPOINT_ARCHIVE.md)
now streams whole data/uploads roots from that boundary directly into age
ciphertext, declares three omitted runtime paths and two active-key
substitutions, and protects resolved server configuration. The V2 restorer
checks file/inventory hashes, applied prefix and active keys, then publishes
only an inactive writer-fenced copy; stopped-move activation refuses it.
Unknown core files are included. External/operator/plugin state remains
unverified, enabled Lore and external blacklist are refused, and no operator
trigger or unavailable-source promotion is enabled. `fullInstanceReady` remains
false; Gate B, C and D remain open.

[Forty-five selected local checks](../testing/LIVE_CHECKPOINT_ARCHIVE_2026-09-28.md)
passed for this component, including a real authenticated inbox round-trip and
CLI restore without the passive flag. These are local core recovery and fence
checks, not physical multi-network recovery, complete external inventory or
unavailable-host failover acceptance.

### Session revocation ordering (2026-09-28)

The working tree now persists individual-token denials, account/global floors,
current-session exemptions and imported legacy denials as bounded
`auth_revocations_updated_v1` deltas. Sequencer isolation/preflight rejects
stale floors before preparation; new acknowledgments follow durability and
application. Startup imports the legacy revocation file before serving and
resumes an interrupted bounded import; later canonical state overrides a stale
file. A fenced receiver can apply these denials and retain them after event
replay. This closes one account-state lane needed for deletion/revocation-safe
recovery. It does not certify a complete checkpoint, remaining compound
operations, distributed fencing or zero-loss asynchronous replicas. Code-based
recovery has the separate component contract below.
See [operator guidance](../deployment/SESSION_REVOCATION_RECOVERY.md).

### Code-based account recovery ordering (2026-09-28)

The working tree now puts recovery-code hashes and consumed-code records in
ordered `recovery_codes_updated_v1` events after a bounded legacy import.
Code-based recovery spends the code, restores its bound account as owner and
advances global session revocation in one event/commit. Admission rechecks the
canonical owner for new issuance and refuses code reuse, missing accounts and
stale cutoffs before durability. Owned workers publish committed auth state
despite a dropped request. Ordinary ownership assignment also publishes after
durability and guards against stale transfers; operator reset/ordinary transfer
still contain separate revocation writes. See
[account recovery operations](../deployment/ACCOUNT_RECOVERY_STATE.md).
This removes another account sidecar from canonical catch-up and closes the
code-recovery compound boundary. Complete-instance checkpointing, all other
compound workflows, promotion, distributed fencing and zero-loss replication
remain open.

## What can be offloaded before full HA

Prioritize traffic that burdens a home connection: eligible attachment downloads through authorized regional caches or peer delivery; local media relay/SFU/TURN placement; bounded CPU jobs; and static application assets. Preserve the Authority as the permission and state owner. Measure origin upload bytes, cache hit rate, relay bytes and user latency in each region. Do not report a regional proxy as bandwidth relief when it still pulls and forwards every byte from the Authority.

Database reads may move to a regional node only after live projection convergence, per-request permission checks and a stated staleness/read-after-write rule are proven. Presence, calls and Socket.IO sessions need their own cross-node behavior; a database copy alone cannot keep them alive.

## Concrete work packages

| Work package | Deliverable | Current gap |
|---|---|---|
| Instance state map | [Inventory and consistency rules](../architecture/INSTANCE_RECOVERY_INVENTORY.md) for WabiDB, uploads, keys, sidecars and optional addons | Source inventory, offline encrypted export/isolated restore, and [disposable file/API rehearsal](../testing/INSTANCE_RECOVERY_2026-09-26.md) exist; live cross-file consistency and external-store coverage remain open |
| Standby data path | Snapshot plus ordered incremental catch-up, verification and live projection application | [Encrypted offsite transport](../deployment/ENCRYPTED_INSTANCE_INBOX.md) exists for a complete **stopped** archive and passed a disposable loopback restore. A passive restore is durably fenced before publication. A separate fenced receiver passed [two-process loopback catch-up and encrypted-baseline checks](../testing/DB_REPLICA_PROCESS_2026-09-27.md), including rejection of a push that skipped a committed entry; legitimate numeric sequence gaps are allowed. Ordered `upload_revoked_v1` denials and `upload_published_v1` file expectations reach the receiver. When both upload trees are configured, newly published nonrevoked files can also follow in bounded, hash-verified chunks. Authority startup can reconstruct missing registry entries from these events and bytes. Older registered files can join this path after explicit offline backfill. An opt-in fixed sidecar lane copied a later notes change and deletion plus the upload registry in the disposable process check. It has no cross-file checkpoint, completeness proof or promotion path; unregistered uploads, other files, external services and plugin state remain outside the path. The stopped archive crossed from Iyoku to Ronin in a [two-network controlled-move field check](../testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md). A [two-network live receiver check](../testing/REMOTE_FENCED_REPLICA_2026-09-27.md) then saw applied/indexed commit position advance from 19 to 21 and copied one later 4,096-byte upload with a matching hash while the Authority ran. A [local stopped-tree comparison](../testing/REPLICA_STATE_COMPARISON_2026-09-27.md) found all fixture paths present on both sides and equal decoded projection state at one watermark after graceful receiver shutdown; it does not cover unknown/external state or a live cross-file checkpoint. This is narrow WabiDB/upload acceptance, not a complete standby or three-site check |
| Recovery control | Operator promotion, durable writer fence, old-node rejoin and tested restore tooling | WabiDB has a tested local durable sequencer fence. A controlled stopped move now fences the old tree before export; its guarded restore requires that archived fence and remains inactive until it receives a receipt for the exact encrypted archive. The receipt is not remote attestation; the operator must physically control and stop the old host. A [two-network field check](../testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md) moved a disposable stopped Authority from Iyoku to Ronin, then reseeded Iyoku from Ronin's later stopped archive as a fenced passive copy; 30 durable file hashes matched. There is no distributed lease/epoch, live standby promotion, or automated old-node rejoin acceptance |
| Client and node routing | Stable community identity, multiple trusted endpoints, active-node discovery and reconnect | Candidate signed entry-point roster, owner editor in Server Center, and client URL pinning exist in the working tree. Roster updates now enter WabiDB after one-time sidecar import, and a fenced development receiver caught an update in a disposable loopback check. Desktop Tailcat probes its temporary proxy without credentials and restores the previous URL after a stopped tunnel; it still requires a fresh sign-in because peer identity is not roster-bound. A complete standby, independent Anchor roster serving, live-leader discovery and cross-site acceptance remain open |
| Regional traffic | WebSocket-capable Anchor, authorized file cache, measured media placement and origin fallback | Current Anchor passes focused streaming and WebSocket tests. A [real Authority plus two-Anchor loopback preflight](../testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md) passed disposable sign-in, live messaging, upload/download, polling/WebSocket and independent Anchor-loss checks. The same loopback run confirmed each Anchor serves an identical 28,424-byte embedded app chunk locally, without an Authority request, and forwards missing versions; this is scoped static byte offload, not regional chat locality. An optional bounded upload cache passed a real Authority-to-Anchor loopback fill, hit and revocation check; it requires a fresh Authority HEAD check for each hit. See [test receipt](../testing/REGIONAL_UPLOAD_CACHE_2026-09-27.md). Its 8 MiB per-file limit excludes the 10 MB art-drop scenario above. A three-computer Tailscale follow-up counted zero upstream bytes for that app chunk at both Anchors. For a 262,144-byte upload, the equipment Anchor drew 263,175 Authority-to-Anchor bytes on a miss and 504 on a hit. These are controlled TCP-path samples, not whole-uplink or sustained bandwidth results; media placement and long-lived regional realtime remain open. That earlier run found iRonin and Iyoku on the same uplink. After the operator reported iRonin's move, a [fresh run](../testing/THREE_SITE_FIELD_2026-09-28.md) confirmed three distinct egresses and exercised local HTTP/WebSocket clients on the remote hosts. Same-desktop, sustained traffic and media acceptance remain open. Helpers do not carry canonical state |
| Room ownership and routing | Stable per-room home, local sequence/permission enforcement, selective cross-region delivery and fenced moves | Bounded versioned WabiDB placement records now store channel ID, owner, recovery-replica IDs and an increasing epoch. [Focused checks](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md) show new ordinary/private rooms initialize a local placement in their creation commit, replay it, and refuse tested local chat writes after a different owner is recorded. `WABI_NODE_ID` is operator-configurable. A [stopped backfill](../deployment/ROOM_PLACEMENT_BACKFILL.md) can place legacy active rooms and retained direct-call scopes on the same node; selected durable writes now carry owner/epoch admission, but complete live admission, a distributed writer lease, room moves and owner routing remain open. WabiStore and realtime still assume one Authority |
| Automatic leader control | Three-node membership, quorum/epoch protocol and partition tests | There is no safe election or two-writer prevention today |
| Operator experience | Expert setup, node roles, capacity/lag/health display, recovery instructions and alerts | Infrastructure now probes the selected endpoint's own Authority/Anchor role and separates Authority measurements from helper heartbeats. The signed address list is still a declaration, not live-writer discovery; there is no recovery-ready/lag display, production alerting or physical desktop check |

The earlier [three-computer Tailscale check](../testing/THREE_SITE_FIELD_2026-09-27.md) used a signed roster, remote-host HTTP clients, live WebSockets and per-Anchor TCP meters; its later placement had only two observed public egresses. After iRonin moved again, a [fresh three-site run](../testing/THREE_SITE_FIELD_2026-09-28.md) qualified three distinct uplinks and added remote-host authenticated WebSocket sends with canonical cross-site history. Full desktop/media and sustained traffic acceptance remain open; the Authority is still the sole writer. A separate [Tailcat service-port check](../testing/TAILCAT_SERVICE_PORT_FIELD_2026-09-27.md) proved device-limited port reachability and Wabi role-gated TCP bytes on a disposable endpoint; it did not promote an Anchor or make RustDesk a native Wabi service client.

Room placement groundwork uses JSON events and the `room_placements` projection. An ordinary channel's `room_placement_initialized_v1` event shares its creation commit and derives the same `ch_<commit-sequence>` ID; DMs/groups with known IDs include `room_placement_changed_v1` in their aggregate creation commit. Epoch one is the first record; reopening a deleted DM or later changing placement advances it by exactly one. IDs and replica counts are bounded, and a record on the wrong stream is rejected. Placement commands now receive sequencer preflight before durability, with isolated group-commit boundaries so epoch checks see earlier applied placements. This is durable placement **intent**, not a lease. The local Authority refuses tested chat/channel mutations when a changed placement names another owner; Live-room session sends and edits have an entry-point guard too. Selected durable chat, channel, group-membership, channel-stream workspace, album, whiteboard-document, persisted call-state and channel-scoped upload publication writes now carry an observed owner and epoch to the sequencer, which rejects a stale placement before durability. New call events also require that condition to match the stored session parent and event stream; isolated creation rejects a queued same-ID parent change before durability, and a disposable replay check kept the first accepted parent. Standalone direct calls now retain their public/stored scope while using separate canonical placement IDs. Unplaced creation initializes that placement in the same commit, recreation retains an existing epoch, and stopped migration includes retained active/ended direct sessions. Live media admission is outside this check. Other internal writers and Live session-only paths do not have complete atomic admission; upload staging and JSON metadata may remain after a late owner rejection. Album access and parent-room lookup now use the derived `album_by_id` index; focused projection and engine-startup checks rebuilt it from older snapshots while preserving durable album records and the applied watermark. Large-album capacity remains unmeasured. There is no operator move command, room routing, selective fanout or per-room recovery yet. Existing active channels and retained direct-call scopes without a placement can be assigned to the same Authority node using the [stopped-Authority backfill](../deployment/ROOM_PLACEMENT_BACKFILL.md); until then they keep their current single-Authority behavior. A mixed-version peer that does not register both event types cannot be considered a room-owner candidate; any future placement rollout needs an explicit version gate and migration for existing rooms.

A [controlled passive move loopback](../testing/CONTROLLED_PASSIVE_MOVE_2026-09-27.md) advances recovery control at a stopped boundary: a caught-up receiver's whole fixture data/uploads tree matched after removing its empty staging directory, the old Authority was fenced, and the replacement served the same community/session/history/upload and accepted a new write through a known Anchor URL. A later loopback run also kept a durably deleted message out of history and a revoked upload denied after the controlled move; the source commit position, receiver applied/indexed position, prune position, registry and passive file absence were checked before activation. A subsequent run at commit 27 also kept a channel-wide clear in effect after activation, using a new ordered `channel_messages_cleared` event; one focused test verified that an unconfirmed clear leaves history visible. A later loopback run also kept a five-second expired message absent after the move at commit 32. These cover a few current-view deletion and expiry fixtures, not all retention or erasure paths. This does not complete Gate B: the receiver has no self-certified complete checkpoint, optional/external state and general deletion-safe recovery remain open, and an unreachable old Authority cannot be fenced by this command. It also does not complete the physical three-network, automatic-election or local-room gates.

New local message create/edit/delete, channel clear and reaction commands now
bind their condition to the actual message parent and expected stream. Placed
rooms refuse missing/unrelated conditions before durability. Successful creates
prepared within an ordinary group-commit window provide parent bindings to
later commands; failed preparation contributes no binding, and an ID cannot
be moved to a different room. Placement changes and these message writes use
separate commands. The adapter's ID-only read uses a compact derived pointer
index, rebuilt and validated at startup from older snapshots with durable
message encodings and applied watermark preserved. Legacy duplicate IDs remain
in their scoped rooms and produce an explicit ID-only ambiguity error. Startup
still scans retained history and needs temporary memory proportional to its
size; capacity is unmeasured. See [operator guidance](../deployment/MESSAGE_ID_LOOKUP.md).
This closes selected local admission paths, while other event types, Live
admission, authenticated node enrollment, distributed leases and routing remain
open. It does not pass Gate C or D.

The Authority and stopped backfill now select node identity before opening
WabiDB. The engine and sequencer retain it for their lifetime, and the adapter
reads that single value. Every provided owner condition must equal this local
identity before its owner/epoch match is accepted. A correct remote placement
condition cannot impersonate that owner on this engine. Default embedding
remains `node-1`; custom embedding must use an identity-aware opener rather
than renaming a running adapter. Durable record shapes and historical replay
are unchanged. See [operator guidance](../deployment/NODE_RUNTIME_IDENTITY.md).
This is still operator configuration; it does not prevent copied instances
using the same ID, authenticate node membership or establish a distributed
lease. Full live/durable admission, owner routing and per-room recovery remain
required for Gate D.

The database now also binds all 22 new local Wiki, Forum, incident, gallery
and project-task/run event types to their payload's actual parent and expected
channel stream. The adapter and sequencer share the catalog. Placed rooms
refuse missing/unrelated conditions before preparation, and workspace writes
cannot share a command with a placement change. Full typed payload decoding
and shared Forum action decoders preserve the existing postcard layouts and
historical replay. Unplaced legacy rooms retain single-Authority compatibility.
See [workspace admission operations](../deployment/WORKSPACE_ROOM_ADMISSION.md).
This closes these raw internal bypasses; complete admission for other event
families and live work, leases, routing and per-room recovery remain required.

The first three packages establish a recoverable standby. Routing and regional traffic are parallel prerequisites for the user-visible multi-city experience. Room ownership is the additional step that makes ordinary conversations local and lets different regions carry different partitions of one large community. Automatic leader control depends on the standby and routing contracts; it must not be inferred from successful helper pairing.

A [real-process controlled-move loopback](../testing/THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md#planned-stopped-move-through-a-known-anchor-url) carries one known Anchor URL across a manually fenced replacement Authority, preserving community identity, an existing member session, history and upload bytes before accepting a new write. The [two-network field check](../testing/REMOTE_CONTROLLED_MOVE_2026-09-27.md) repeated the stopped move between Iyoku and Ronin and reseeded the retired site as a fenced passive copy. This advances recovery control and client entry-point evidence for a planned move. It does not complete the standby, automatic leader, room ownership or physical three-network packages.

A focused [client reconnect rotation check](../testing/CLIENT_ENTRY_POINT_ROTATION_2026-09-27.md) found and fixed a candidate-order bug that could keep cycling between two sites. The signed-roster path now walks all approved HTTPS entries in order in a code-level test. Actual distant-host reconnect, URL-scoped offline work and long-lived sessions remain field gates.

## Implementation order and verification gates

### Remaining execution plan — resumed 2026-09-30

The September 28 components are now consolidated in commit `138abe39` on
`codex/friends-dm-rebuild-20260925`. The clean working tree is the starting point
for this execution. Earlier evidence remains evidence for its recorded build;
each changed contract needs fresh focused acceptance. Main Wabi owns all of the
work below. ERP follows after these contracts are proven.

| Order | Deliverable | Completion evidence | Status |
|---|---|---|---|
| 1 | Local operator checkpoint control: configured recipient/output root, one owned job at a time, bounded drain/copy, safe receipts/status, cancellation-safe work | Real full-router authorization/refusal tests, checkpoint produced through the running Authority, inactive restore preserves acknowledged state, ordinary writes resume | Local contract passed 2026-09-30; operator deployment not exercised |
| 2 | Bounded restore and transfer: entry/byte/path/time budgets, authenticated source digest, crash/cancellation cleanup, explicit disk retention | Malformed/oversized archives cannot exhaust the destination; interrupted inbox requests leave no owned partial files; receipt survives restart and binds the fetched ciphertext | Limits/digest/cancellation/restart contracts passed 2026-09-30; physical crash remains open |
| 3 | Whole-instance inventory and clean restore verifier | Explicit core-only support profile; every enabled external store/plugin/config/key is either coordinated and validated or refuses readiness. Clean-machine replay compares users, permissions, room policy, denials, retained messages, uploads and keys; source mismatch fails closed | October 1 stopped-tree/V1 replay and [inactive V2 complete-history core verification](../testing/INACTIVE_CORE_VERIFY_2026-10-01.md) passed, including matching replay on Ronin. Full enabled-instance inventory, comprehensive policy semantics and promotion remain open |
| 4 | Trusted recovery membership and durable writer authority | Separately enrolled trusted recovery nodes, version/protocol checks, authenticated control transport, durable consensus log and membership. Vetted consensus implementation selected before automatic promotion; helper pairing is never voting membership | Open — isolated OpenRaft/redb/Noise passes 39 local checks and actual Rust/Python control. A later three-computer private-overlay trial passes four exact durable operations and each owned worker's kill/restart/majority-write/catch-up with cleanup. A further physical owned-proxy trial passes minority no-ACK/heal and actual purged metadata snapshot/second restart with32accepted operations. Whole-host/Wabi faults, dynamic enrollment/revocation and canonical writer integration remain open; no writer permit |
| 5 | Writer fencing across every mutation path and manual recovery | Engine commits, session-only sends, upload/sidecar publication and queued work require current authority. Former writer cannot acknowledge after its authority expires/is superseded, even when unreachable. Verified checkpoint/catch-up promotion, old-node reseed, no acknowledged-state resurrection | Open |
| 6 | Surviving entry-point discovery and client continuity | Available nodes return authenticated current routing; clients pin community identity and retain account/offline intent across entry points; expired roster and unavailable original address have explicit behavior | Open |
| 7 | Automatic one-node recovery | Three processes exercise each node loss, 1-versus-2 partition, delayed messages, restart and old-writer return with one writer and measured RPO/RTO, then repeat across three actual networks | Open |
| 8 | Regional room data plane and fenced moves | Separate room state/sequence domains, complete owner admission, local subscribers, authenticated remote routing, selective fanout, permission epochs, ordered catch-up and retention/deletion propagation. Room migration transfers a verified prefix and fences the old owner | Open |
| 9 | Per-room recovery and explicit partition behavior | Concurrent different room owners, each owner's failure/recovery, WAN-isolated local work under the declared permission/durability policy, remote catch-up without duplicate or unauthorized delivery | Open |
| 10 | Reusable failure and capacity harness | Configuration plus bounded workload, executable scenarios, passed/failed/blocked/not-run assertions, source/build/network provenance, traffic and latency evidence, owned-process cleanup | Bounded room workload implemented; local and three-uplink passes recorded September 30 / October 1. Linux helpers pass 33 supervisor and 25 controller checks locally and on each of Ronin/Iyoku. Actual local Rust/Python integration and a later three-computer encrypted metadata worker-loss trial pass exact receipts/restart/cleanup; physical minority/purged metadata snapshot/second restart also pass with complete cleanup; whole-host and full Wabi fault/capacity scenarios stay open |
| 11 | Physical desktop, Tailcat/IP, file and media acceptance | Same desktop build on three uplinks; authenticated chat, attachments, reconnect and calls; Tailcat and operator IP path measured separately; no production interruptions | Open |
| 12 | Capacity/privacy/operator release gates | Many-room and hot-room workloads, measured connection/write/fanout/file/media limits and backpressure, revocation/retention/trust review, recovery UI/runbook, exact release provenance | Open |

Dependencies: 1–3 provide recovery material, 4–5 provide safe writer authority,
and 6 permits clients to reach its replacement. All are prerequisites to 7.
Room placement intent is not enough for 8–9: independent local storage and
permission semantics must be implemented, then per-room authority uses the
same proven fencing mechanism. The harness in 10 grows alongside each step.
Steps 11–12 close the original physical-network and scale requirements; a
successful loopback run never substitutes for them.

The October 1 [probe-supervisor acceptance](../testing/GEOGRAPHIC_PROBE_SUPERVISOR_2026-10-01.md)
covers actual local controller/supervisor death, PID/start/executable-checked
adoption, lock-preserving cleanup and suspend-aware lifetime bounds. It uses
synthetic children, not Wabi. It creates no
node keys; the initial local slice creates no remote fixture. The [encrypted transport acceptance plan](../testing/ENCRYPTED_RECOVERY_RPC_PLAN.md)
now records local compiled-worker acceptance; it still requires repeating
authenticated RPC and failure/cleanup on all three physical sites before any
writer or recovery gate can close.

The [probe-controller acceptance](../testing/GEOGRAPHIC_PROBE_CONTROLLER_2026-10-01.md)
adds bounded private Unix requests, worker identity checks and original-command
fingerprint validation after a lost reply. Its 25 checks use synthetic peers;
the corresponding Rust worker fingerprint and codec golden subsequently passed,
as did real Rust replies through the controller and guarded local restart.
Neither matching receipt counts nor epoch/log positions alone prove that the
exact timed-out proposal was stored.

The same four helper sources then passed all 58 synthetic checks separately
on Ronin and Iyoku with Python 3.14.7, zero skips and verified disposal of their
private stages and processes. See the
[remote runtime receipt](../testing/geographic-2026-10-01/remote-python-helper-contracts.json).
This qualifies helper behavior on those hosts, not Rust, encrypted interhost
RPC, complete Wabi recovery or regional room ownership.

The later [physical encrypted coordination acceptance](../testing/PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md)
uses the frozen Rust worker and unchanged helpers across all three computers.
Four operations and every worker's loss/majority write/return pass exact receipt
and full operation-state comparison. All owned roots/processes are cleaned.
Tailscale ping/SSH did not imply application-port reachability: Iyoku rejected
the random listener but its existing allowed unused private port 3000 passed
all six actual TCP paths. No firewall or live service was changed. This does
not activate Wabi, recover a complete instance or close Gates B, C or D.

The subsequent [local opaque recovery-byte store](../testing/RECOVERY_MATERIAL_2026-10-01.md)
adds exact manifest/object durability and bounded crash recovery. Eleven new
parent checks pass, including eight SIGKILL publication cases; the package's
same-source rerun passes 50 checks after one preserved existing leader-selection
failure. It is not connected to recovery transport, a required-byte majority,
real inactive Wabi verification or writer activation. Gates B/C/D stay open.

Implementation rules:

- Default single-Authority installations keep their current configuration and
  data formats. Advanced recovery/regional mode is explicit and versioned.
- No ad-hoc heartbeat election or marker deletion can stand in for consensus.
  A writer that cannot prove authority refuses writes. The chosen lease/fencing
  model must account for process pauses, clock behavior and queued publication.
- Permission revocation and local work during WAN isolation need an explicit
  consistency contract. An isolated owner cannot simultaneously promise
  immediate remote revocation and unrestricted offline authorization.
- Source checkpoints remain incomplete until inventory validation proves the
  enabled deployment. No boolean operator acknowledgment invents a missing
  external-store checkpoint.
- Keep resource ceilings, disk headroom, artifact retention and cleanup in
  every implementation and test. Record what ran and what is still blocked.

This list is the remaining scope, not a replacement for Gates A–D below. Each
gate stays open until its complete acceptance evidence exists.

### Gate A — truthful three-region access and scoped offload

- Three physical networks can use one community and the same desktop client through Tailcat or operator-provided IP endpoints.
- Regional file/media/helper paths are measured and fall back to Authority delivery without data or authorization errors.
- Any regional interactive entry point passes authentication, upload, polling and WebSocket tests against a live Authority.
- The UI tells the operator which node is active and which services are merely helpers. The current Infrastructure view probes the selected endpoint's Authority/Anchor role and shows helpers separately, but it does not verify that the roster's Authority entry is the live writer or that a listed site is online.

Passing Gate A supports **multi-region access and scoped offload**. It does not support an availability or failover claim.

### Gate B — recoverable community after Authority loss

- A complete encrypted state set is produced, received, restored on a clean computer and compared with the Authority's retained state, accounts, permissions and uploads.
- A stopped or isolated Authority cannot accept writes after standby promotion; clients can find the promoted node through a second endpoint and keep the same community identity.
- Restart/catch-up, expiry/deletion, duplicate delivery, key continuity and old-node rejoin are exercised on actual separate networks.
- The operator can see checkpoint age and a measured recovery time/loss window and follow a documented manual promotion/reseed procedure.

Passing Gate B supports **tested manual recovery**. If there is an interruption, the UI and docs should call it recovery, not uninterrupted availability.

### Gate C — automatic survival of one node loss

- A three-node deployment has a tested majority decision and durable writer fencing. Kill any one node, including the Authority, and the remaining nodes keep exactly one writer.
- A 1-versus-2 network partition never produces two writers. Restore connectivity and verify convergence without lost acknowledged writes outside the published recovery point objective.
- Clients already connected in each region reconnect or redirect to the surviving entry points without creating a new community or silently switching identities.
- Repeated failures, slow links, concurrent uploads, websocket sessions, media calls, and a returning former Authority are covered in a sustained three-site field run.

Only Gate C supports an **automatic one-node-failure survival** claim. It does not imply unlimited scale; a single-writer community can still have a write throughput ceiling. Large-scale partitioning across independent communities is a later, separately specified product path.

### Gate D — local conversations and partitioned growth

- Rooms have explicit owners and recovery replicas. Two members on the owner's local network use that region's room owner and local delivery path; client fanout does not transit an unrelated region. Packet traces separate local delivery, permission/control traffic and recovery replication. Canonical acknowledgments obey the published durability policy: with one voter at each of three sites, strict-majority persistence includes another site's durable acknowledgment. WAN-independent writes require a separately proven local authority/durability topology and its stated offsite loss window; they cannot be inferred from local delivery.
- A remote participant receives only authorized room events, and a remote send reaches the room owner without duplicating or reordering accepted messages.
- Global role/member changes, owner moves, deletions, retention, reconnect and inter-region partitions follow documented consistency rules. A local room's behavior during a partition is explicit and tested.
- Multiple room owners operate concurrently without conflicting writers for any room. Failure and promotion tests cover each room owner, not only the original community Authority.
- Load tests separately report registered accounts, concurrent connections, messages per second, attachment delivery and simultaneous call participants. No membership-count claim is inferred from an SFU benchmark.

Passing Gate D supports a **regional conversation locality** claim. The full requested promise of local work **and** surviving a node loss requires Gate C and Gate D together, with per-room failover proven rather than assuming community-wide leader election covers every owner.

For the initial three-site/three-machine pilot, use strict quorum durability and
stop an isolated minority from acknowledging canonical writes. This preserves
the node-loss goal while still measuring local fanout and origin upload relief.
The earlier WAN-isolated conversation scenario is a later explicit policy/topology
gate, not an implicit fallback when this quorum is unavailable. See the
[delivery and recovery traffic contract](../architecture/GEOGRAPHIC_WRITER_AUTHORITY.md#delivery-locality-and-recovery-traffic-are-separate-measurements).

## Three-site acceptance scenario

### First field run: regional access, before HA

Use one disposable community and the same desktop build at all three sites. Put the Authority at the roofing/fabrication site. Put one stateless Anchor at materials/sales and one at equipment storage, with each site on its own actual internet connection. Each Anchor points at a protected, reachable Authority endpoint through the chosen private transport or a correctly secured public endpoint:

```sh
WABI_SERVER_ROLE=anchor \
WABI_AUTHORITY_URL="http://AUTHORITY_PRIVATE_IP:3000" \
WABI_ANCHOR_ALLOW_PRIVATE_HTTP=true \
WABI_ANCHOR_UPLOAD_CACHE_MB=64 \
./wabi-server --host 0.0.0.0 --port 3000
```

Record the exact build, endpoint scheme, address and transport at each site. The private-HTTP switch only permits a literal private or Tailcat IP upstream; the operator must actually protect that link. Public Authority upstreams require HTTPS, and the Anchor's member-facing public endpoint needs HTTPS as well. A public IP needs a working encrypted endpoint and the relevant firewall setup. A domain is optional. The upload cache setting is optional; it holds at most the configured RAM amount and [has explicit limits](../deployment/REGIONAL_UPLOAD_CACHE.md). Do not count three devices on one LAN or three paths through the same uplink as a three-network result.

From Ronin's and iRonin's devices, sign in, exchange a message, upload and download an attachment, and join a live Socket.IO session through each site's entry point. Record whether the client used polling, WebSocket or a fallback, plus latency, reconnect behavior and the bytes sent by the Authority and each Anchor. Request a versioned app chunk named by the current Authority shell through each Anchor, compare its digest, confirm `X-Wabi-Anchor-Static: local`, and measure each site's delivered bytes against Authority egress. A chunk absent from an older Anchor build should fall back to the Authority while it is online. Interrupt each Anchor separately and confirm an alternate reachable endpoint still serves the community. Interrupt the Authority and observe the expected outage: these Anchors have no recoverable community state and cannot promote themselves, even if a temporary upload copy remains in RAM. Restore it and check message identity and duplicate handling.

The working-tree client candidate recognizes an approved second URL through a signed roster and can carry a registered member's session to a listed HTTPS entry point. It still stores local server-scoped state by URL; it does not merge local caches, credentials or drafts across entry points into one complete community profile. Plain HTTP private addresses remain usable for manual connection, but the client does not automatically copy credentials to them. Record whether switching URLs duplicates local state or loses work before claiming seamless entry-point switching. A plain proxy still pulls each file from the Authority. The optional Anchor cache can serve repeat eligible upload bytes locally after Authority revalidation; count both HEAD request load and byte egress in the three-site measurement. Measure scoped booster/media paths separately.

### Business workflow and later failure gates

Use one real node at each business site: roofing/fabrication, materials/sales and equipment storage. Each has its own internet connection and local users. Keep the data disposable for the first run. Create a job at the roofing site, request materials from the sales site, and reserve equipment at the storage site. Include an attachment, live conversation and a call. Record user-visible latency and origin upload volume.

Then disconnect each regional helper in turn; work must fall back without granting extra access. Once Gate B exists, stop the active Authority, promote the prepared standby, reconnect the three clients and verify the job, messages, permissions, file, deletion state and community identity. Once Gate C exists, repeat by cutting power or network to each node without operator promotion, including a network partition and old-node return. Save the observed recovery time, loss window and role transitions alongside the exact build and configuration.

## Engineering conclusion

The current branch does not pass Gate B, C or D. Gate A can be advanced independently and gives real geographic value while the state, locality and failover work is built. For a 500,000-member single installation, Gate D, regional file/media delivery and the hot-room workload are essential capacity exercises; Gate C addresses node loss. Scale experiments must show how adding nodes increases throughput and where the next bottleneck moves. A helper, Anchor or experimental replication peer does not currently keep a community writable after the Authority fails, and a single distant writer does not make local conversations local.


### October 2: authenticated checkpoint byte candidate

After the UI owner completed its release and explicitly released the build slot,
this geographic phase compiled an optional Linux-only byte service on the same
fixed three-voter Noise roster. Configuration compares the actual opened store
binding; the receiver verifies complete content-addressed bytes and a signed
manifest. A separate strict wire receipt becomes an immutable peer acknowledgment
only after the target and every source/content field match. It grants no quorum,
writer, encryption-allocation or full-instance permission. Normal Authority
startup does not enable these library entry points automatically.

The whole consensus package passed 73 checks (zero failures, five ignored
fixtures). Six producer/operator checks passed using a real encrypted capture,
a registered 160 KiB upload and more than two ordered chunks: transfer, fresh
readback, copy loss and reseeding on authenticated loopback endpoints, followed
by actual Authority reconstruction. The initial unregistered test-upload fixture
correctly failed safe startup; its failure is retained and only the test fixture
was corrected to use the durable upload publisher. These counts describe
separate receipts, not additional unique checks.

See [the byte-RPC contract](2026-10-02-checkpoint-byte-rpc-contract.md) and
[actual producer acceptance](../testing/geographic-2026-10-02/byte-rpc-producer4.json).
Fresh frozen-workspace session 47619 passed 2,673 checks, zero failures and 15 ignored entries across 88 groups, with unchanged source/build hashes. Physical three-site byte transfer,
committed availability, inactive verification, safe activation, automatic recovery,
regional room ownership and capacity/privacy gates remain open.

The subsequent [physical ciphertext fixture](../testing/PHYSICAL_CHECKPOINT_BYTES_2026-10-02.md)
passed its local consensus/producer/export guards, copied the genuine encrypted
capture to Ronin and Iyoku, and reseeded Ronin's deleted copy directly from
Iyoku. The complete physical run remains failed because its final restarted
listener request refused. All three test roots and tool directories were
removed. A bounded listener-ready check is prepared; automatic approval review
timed out before its final retry could execute. Current independent uplinks
were not rechecked, and no writer activation or automatic recovery occurred.
