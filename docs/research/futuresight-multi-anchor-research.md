# Wabi Multi-Anchor + Helper Node Architecture — Research Appendix

Companion to `futuresight-multi-anchor-helper-nodes.md`.

---

## 12. Research: Existing Implementations and Efficacy

### 12.1 LiveKit Distributed Multi-Region

Sources:

- https://docs.livekit.io/transport/self-hosting/distributed/
- https://blog.livekit.io/scaling-webrtc-with-distributed-mesh/

What exists:

LiveKit supports distributed self-hosted deployments. Its docs state that with Redis configured, LiveKit switches to distributed mode using Redis as shared room data store and message bus. Nodes report stats to Redis, become cluster-aware, and make routing decisions based on availability/load. When a room is created, the receiving node can choose an available node to host it. Client signaling may connect to one instance while that instance proxies signaling to the actual room host. LiveKit also supports region-aware node selection with Geo/latency-aware DNS/load balancing.

Important limitation:

LiveKit docs state that a room must fit on a single node, so distributed LiveKit scales many rooms well but does not magically make one gigantic room infinite.

Relevance to Wabi:

Very high for voice/media nodes.

Verdict:

Confirmed pattern. Effective for media routing if Wabi treats media nodes as scoped infrastructure and keeps room authority/token issuance in Wabi. This is the strongest proof that Wabi should not invent media mesh first; it should integrate or mimic the LiveKit-style room placement model.

### 12.2 Matrix Synapse Workers

Sources:

- https://github.com/matrix-org/synapse/blob/develop/docs/workers.md
- https://matrix.org/blog/2020/11/03/how-we-fixed-synapse-s-scalability/

What exists:

Synapse can split functionality into multiple worker processes for larger instances. The worker docs say all processes share the same database, workers require PostgreSQL, and processes communicate through a Synapse-specific replication protocol. Redis can carry replication streams and act as shared cache/pub-sub.

Relevance to Wabi:

High as a cautionary example.

Efficacy:

It works, but it is operationally complex. It moved Matrix.org-scale Synapse beyond one monolithic Python process, but requires PostgreSQL, Redis, multiple configured worker types, and deep understanding of which worker handles which endpoint.

Verdict:

Useful pattern for splitting hot paths, but too heavy as Wabi's default UX. Wabi should learn from the concept — specialized workers and shared event streams — without forcing average users into PostgreSQL/Redis/worker topology.

### 12.3 CDN / Origin Shield / Tiered Cache

Sources:

- https://developers.cloudflare.com/smart-shield/
- https://developers.cloudflare.com/smart-shield/configuration/smart-tiered-cache/

What exists:

Cloudflare Smart Shield / tiered cache concepts place intermediate caching layers between global edge and origin. Search snippets from Cloudflare docs describe Smart Shield as consolidating multiple requests from many locations into fewer origin requests, and tiered cache as a hierarchy where lower-tier data centers ask upper-tier caches rather than all edges hitting origin.

Relevance to Wabi:

High for public artist mode.

Efficacy:

Very effective for static/public media and origin protection. Does not solve real-time write consistency. It proves the value of hiding origin and putting disposable/cache-heavy edges in front.

Verdict:

Wabi regional anchors should copy the principle, not the whole CDN product: reduce origin hits, protect authority, cache public/read-heavy content, and make public edges disposable.

### 12.4 Cloudflare Tunnel / Outbound-Only Connectors

Sources:

- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- https://developers.cloudflare.com/tunnel/

What exists:

Cloudflare Tunnel uses outbound-only connections from an origin to Cloudflare's network and does not require inbound ports on the origin.

Relevance to Wabi:

High for average-joe helper nodes.

Efficacy:

The outbound connector pattern is proven and user-friendly for NAT/CGNAT cases. It does not remove dependency on a public ingress provider/anchor, and Cloudflare-specific use has privacy/trust tradeoffs.

Verdict:

Wabi should implement its own simpler version for helpers: helpers connect outbound to the authority/anchor. Do not require inbound ports for worker pairing.

### 12.5 IPFS Gateways / Content Addressing

Sources:

- https://docs.ipfs.tech/concepts/ipfs-gateway/

What exists:

IPFS gateways expose content-addressed IPFS data over HTTP for clients that do not speak IPFS natively. IPFS docs describe gateways as standardized HTTP APIs for retrieving content-addressed data from IPFS nodes/providers.

Relevance to Wabi:

Medium-high for blob cache design.

Efficacy:

Content addressing is excellent for cache integrity: a node cannot silently serve different bytes if clients verify the hash. But IPFS as a public network introduces persistence, privacy, naming, and moderation concerns. Wabi should borrow content-addressed blob storage, not necessarily join public IPFS.

Verdict:

Use hash-addressed blobs and signed Wabi permissions. Avoid making Wabi media globally discoverable by default.

### 12.6 GitLab Geo / Warm Standby Pattern

Sources:

- https://docs.gitlab.com/administration/geo/disaster_recovery/
- https://docs.gitlab.com/administration/geo/disaster_recovery/planned_failover/

What exists:

GitLab Geo supports secondary sites and disaster recovery. Search snippets note asynchronous replication and planned failover requiring a maintenance window where updates to the primary are blocked.

Relevance to Wabi:

High for warm standby / manual promotion.

Efficacy:

Effective for disaster recovery, but operationally serious. The key lesson is that async replicas are not magic active-active nodes; failover needs controlled promotion to avoid data loss/split-brain.

Verdict:

Wabi should support warm standby before active-active. Manual promotion fits self-hosted understandability.

### 12.7 MinIO Distributed Object Storage

Sources:

- https://github.com/minio/minio/blob/master/docs/distributed/README.md
- https://docs.min.io/enterprise/aistor-object-store/operations/core-concepts/erasure-coding/

What exists:

MinIO distributed mode pools multiple servers/drives and uses erasure coding to tolerate failed nodes/drives while continuing to serve objects, within quorum limits.

Relevance to Wabi:

Medium for storage clusters; high as proof that object storage scales differently from chat state.

Efficacy:

Effective for object storage, but it is a storage subsystem with quorum/erasure rules, not a general Wabi state mesh.

Verdict:

For serious large deployments, Wabi should allow S3-compatible object storage or dedicated object clusters. For average joe, Wabi cache nodes should stay simpler: content-addressed mirrors with fallback, not full distributed erasure coding.

### 12.8 PeerTube / P2P Media Distribution

Sources:

- https://joinpeertube.org/
- https://docs.joinpeertube.org/

What exists:

PeerTube historically used federation plus browser-side P2P/WebTorrent-style video sharing to reduce server bandwidth. Search results and community discussion note that P2P efficacy depends heavily on concurrent viewers; it helps when many viewers watch the same content simultaneously but helps less for cold/low-concurrency content.

Relevance to Wabi:

Medium.

Efficacy:

Useful for public hot media, not reliable as the only distribution layer. For artist communities, it could help during premieres/livestream-like events, but cache/anchor nodes are more predictable.

Verdict:

Possible later addon, not core scaling foundation.

### 12.9 ActivityPub/Mastodon-Style Federation

Sources:

- https://www.w3.org/TR/activitypub/
- https://docs.joinmastodon.org/spec/activitypub/

What exists:

ActivityPub provides server-to-server federation used by Mastodon, PeerTube, and other fediverse software.

Relevance to Wabi:

Low for helper-node scaling; medium for future shared-channel bridge.

Efficacy:

Federation works for independent communities, but it brings moderation, identity, delivery, and defederation complexity. It does not solve “make one community resilient under attack” as cleanly as anchors/caches/standby.

Verdict:

Do not use federation as the scaling primitive. If Wabi ever supports cross-server shared channels, make it explicit and opt-in, separate from helper/anchor infrastructure.

---

## 13. Overall Evaluation

Has this been implemented elsewhere?

Yes, in pieces:

- LiveKit proves distributed media room placement and regional SFU routing.
- Synapse proves worker splitting for giant real-time social/chat servers, with high ops complexity.
- CDNs prove regional edge/cache/origin shielding.
- Cloudflare Tunnel proves outbound-only connector UX for NAT-hosted services.
- IPFS proves content-addressed retrieval and gateway patterns.
- GitLab Geo proves async warm standby/manual failover for serious self-hosted services.
- MinIO proves multi-node object storage, but with quorum complexity.
- PeerTube proves P2P media can reduce hot-content bandwidth, but not consistently enough to be the foundation.
- ActivityPub proves open federation, but also demonstrates the social/moderation complexity Wabi should not inherit by accident.

Has this exact Wabi-shaped model been implemented?

Not as a single integrated self-hosted Discord-like product with average-joe helper pairing, regional anchors, scoped route tokens, media/cache/job nodes, and warm standby. The pieces are proven, but the productized combination is the opportunity.

Efficacy estimate:

| Feature | Proven elsewhere | Useful for Wabi | Risk |
|---|---:|---:|---:|
| Outbound helper workers | High | High | Low |
| Job offload | High | High | Low |
| Content-addressed cache nodes | High | High | Medium |
| Signed route tokens | High | High | Low-medium |
| Media/SFU regional nodes | High | High | Medium |
| Regional anchors | High | High for public figures | Medium-high |
| Warm standby | High | High | Medium |
| Active-active multi-writer mesh | High only in complex systems | Low initially | Very high |
| ActivityPub-style federation | High | Not for scaling one community | High social complexity |
| P2P browser media distribution | Medium | Situational | Medium |

Recommended Wabi path:

1. Build node identity/pairing/heartbeat first.
2. Build worker offload second.
3. Build content-addressed cache/file routing third.
4. Build media node routing fourth.
5. Build warm standby fifth.
6. Build regional anchors for public figure mode sixth.
7. Keep full multi-writer mesh out of scope until Wabi has a real need.

---

## 14. Key Decision

Wabi should not advertise “mesh networking” until it has real node identity, heartbeats, routing, and scoped capabilities.

Better names:

- Wabi Helper Nodes
- Wabi Scale Nodes
- Wabi Anchors
- Wabi Worker Nodes
- Wabi Media Nodes
- Wabi Cache Nodes

Use “mesh” only if Wabi eventually supports actual multi-node routing between peer authorities.

---

## 15. Short Version

For normal users:

> Run Wabi on one machine. Pair extra computers when you want them to help.

For large teams:

> Run one hidden authority, several regional anchors, scoped workers/media/cache nodes, and a warm standby.

For Wabi engineering:

> Build helper-node primitives first. Do not jump to active-active federation.

---

## 16. Flexibility Principle: Piss-Easy Entry, Expert Escape Hatches

Clarification from Ronin: Wabi should be flexible, but the entry path must be piss easy.

This changes how to think about the architecture.

The goal is not to make every deployment simple. The goal is:

1. **Default path is dead simple.** One binary, one machine, no distributed-systems vocabulary.
2. **Upgrade path is obvious.** Add helper computer, add media node, add cache node, add anchor.
3. **Expert path is unconstrained.** If a Google-scale engineer wants to take Wabi and sprint, the architecture should not block them.
4. **Complexity is opt-in.** Advanced topology should be available, not required.

This implies Wabi needs layered capabilities, not one monolithic “mesh mode.”

### 16.1 UX Tiers

| Tier | User | UX | Architecture |
|---|---|---|---|
| Simple | normal self-hoster | `wabi serve` | one authority node |
| Helper | average joe with spare PC | “Add helper computer” join code | outbound worker/cache/media helper |
| Team | art team/studio | admin UI for anchors/workers/cache | authority + scoped nodes |
| Expert | infrastructure engineer | config files, APIs, custom routing | pluggable node protocol/topology |

The same core primitives should support all tiers.

### 16.2 Product Rule

Do not expose internal terms by default.

Bad first-run UX:

- authority
- anchor
- relay
- signed route token
- event log
- read replica
- node capability

Good first-run UX:

- Start server
- Invite users
- Add another computer to help
- Make calls faster in another region
- Store files on another machine
- Add backup computer

The advanced terms can exist in docs/config/API for expert operators.

### 16.3 Architecture Rule

Internally, Wabi should still be precise.

Friendly label -> internal role:

- “Main server” -> authority node
- “Helper computer” -> worker node
- “File helper” -> cache/blob node
- “Call helper” -> media node
- “Regional entry” -> anchor node
- “Backup computer” -> warm standby

This lets Wabi stay understandable without making the internals vague.

---

## 17. Additional Research Backlog

The first research pass showed that Wabi’s proposed model is made of proven pieces. The next research pass should answer load-bearing design questions.

### 17.1 NAT Traversal / Connectivity

Research targets:

- Tailscale DERP
- Headscale DERP
- Syncthing relays/discovery
- libp2p AutoNAT, Circuit Relay, DCUtR hole punching
- STUN/TURN/ICE outside browser WebRTC
- QUIC hole punching realities

Why it matters:

Average-joe helper nodes will often sit behind NAT, CGNAT, phone hotspots, hotel WiFi, or ISP firewalls. Wabi must not promise impossible direct routing.

Current research signals:

- Syncthing supports NAT punching and relays; relays make connection possible when direct connection fails, but perform worse than direct connections.
- Tailscale uses direct WireGuard when possible and DERP relay fallback when NAT traversal fails.
- libp2p has AutoNAT, Circuit Relay, and DCUtR hole punching; powerful but possibly heavy.

Likely Wabi decision:

Use a Tailscale/Syncthing-style model:

1. Try LAN/direct when available.
2. Use outbound helper tunnel by default.
3. Use relay fallback when direct fails.
4. Keep route classification explicit: `outbound_only`, `lan_reachable`, `public_reachable`, `relay_reachable`.

Do not claim helpers reduce public bandwidth unless clients can actually reach them directly or through a public relay/anchor.

### 17.2 libp2p vs Custom Node Protocol

Research targets:

- rust-libp2p maturity
- binary size/dependency impact
- QUIC transport
- relay/hole punching support
- key identity model
- production users

Why it matters:

libp2p already contains many peer-network primitives, but it may violate Wabi’s “simple durable tool” preference by pulling in a large generic networking stack.

Likely Wabi decision:

For first helper-node implementation, use a custom minimal protocol:

- helper connects outbound to authority
- node keypair
- pairing token
- heartbeat
- capability advertisement
- job pull/result submit
- signed route tokens

Evaluate libp2p later only for optional public peer/relay features.

### 17.3 Signed Capability Tokens

Research targets:

- Biscuit tokens
- Macaroons
- PASETO
- JWT only as baseline comparison
- object-storage signed URLs

Why it matters:

Signed route tokens are the safety primitive for helpers, media nodes, cache nodes, and anchors. They let a node verify “this user may do this exact thing briefly” without full DB access.

Current research signals:

- Biscuit tokens are public-key signed, decentralized, and can be attenuated with additional restrictions.
- Macaroons were designed as contextual caveat credentials for decentralized authorization.
- JWT is common but less naturally caveat/attenuation-oriented.

Likely Wabi decision:

Research Biscuit/Macaroon deeply before choosing. Wabi wants caveats like:

- only this node
- only this blob
- only this voice room
- expires soon
- max bytes
- upload only
- this user only

### 17.4 Event Log / Replication Spine

Research targets:

- NATS JetStream
- NATS leaf nodes
- STDB-backed authority logs
- helper-node cache snapshots
- GitLab Geo
- Matrix Synapse replication streams
- SpacetimeDB durability/event semantics

Why it matters:

Warm standby, anchors, cache invalidation, search indexing, and worker jobs all benefit from one canonical append-only stream of authority events.

Current research signals:

- NATS leaf nodes are explicitly useful for IoT/edge and hub-spoke topologies where edge traffic should stay local unless routed upstream.
- Synapse workers use replication streams and Redis/pubsub to keep multiple processes synced.
- GitLab Geo demonstrates async secondary sites and controlled failover rather than casual active-active.

Likely Wabi decision:

Do not introduce NATS as a default dependency. Instead, use it as design inspiration.

Wabi should eventually maintain a compact canonical event log for durable authority events:

- message_created
- message_deleted
- file_uploaded
- role_changed
- user_banned
- node_joined
- node_revoked
- channel_created

Do not put high-volume ephemeral packets/presence/media frames in this log.

### 17.5 Media Node Strategy

Research targets:

- LiveKit distributed multi-region
- Jitsi Videobridge Octo
- mediasoup PipeTransport
- SFU cascading tradeoffs

Why it matters:

Voice/video is the first Wabi feature that truly needs multi-node scaling. Text chat can go far on one box; media burns bandwidth.

Current research signals:

- LiveKit distributed mode supports many rooms across nodes, but one room must fit on one node.
- Jitsi Octo supports cascading media bridges and regional bridge selection.
- mediasoup PipeTransport can pipe media between routers/workers, but requires a more custom media architecture.

Likely Wabi decision:

Start with LiveKit-style room placement:

- many rooms across many nodes
- one room hosted on one media node initially
- authority signs room tokens
- regional placement where useful

Do not start with cascading SFU mesh unless Wabi has a concrete large-room requirement.

### 17.6 Blob/Object Storage

Research targets:

- Garage object storage
- MinIO distributed mode
- IPFS content addressing
- S3 multipart uploads
- SeaweedFS/Tahoe-LAFS as references

Why it matters:

Media/files should scale independently from chat state.

Current research signals:

- Garage is designed for self-hosted geo-distributed object storage at small-to-medium scale.
- MinIO demonstrates distributed object storage with erasure coding/quorum, but can be ops-heavy.
- IPFS proves content-addressed retrieval and gateway access, but public IPFS has privacy/moderation/persistence concerns.

Likely Wabi decision:

Use content-addressed blobs internally. Allow storage backends:

- local disk default
- helper cache nodes
- S3-compatible storage for experts
- maybe Garage/MinIO docs for large deployments

### 17.7 Pairing and Admin UX

Research targets:

- Syncthing device approval/discovery/introducers
- Tailscale device enrollment
- Plex/Jellyfin server claim flows
- Headscale admin UX
- Minecraft whitelist/op flow

Why it matters:

This is the difference between “powerful” and “usable.”

Current research signals:

- Syncthing’s explicit device approval and introducer model is highly relevant: devices are identities, not anonymous servers.
- Tailscale proves mesh networking can feel simple when key exchange, NAT traversal, and routing are hidden behind a good UX.

Likely Wabi decision:

Device pairing should feel like:

1. Admin clicks “Add helper computer.”
2. Wabi shows one command or QR code.
3. Helper appears as pending.
4. Admin approves capabilities.
5. Wabi explains what the helper can and cannot do based on reachability.

### 17.8 Worker Sandboxing

Research targets:

- Wasmtime/WASM component model
- process isolation
- addon permission systems
- Firecracker/microVMs as expert mode only
- VS Code/Obsidian/Blender plugin models

Why it matters:

If helper nodes eventually run arbitrary addons/bots/jobs, Wabi needs isolation. But default workers should stay simple.

Likely Wabi decision:

Early workers run built-in Wabi job types only. Arbitrary third-party code execution is a separate future addon/sandbox problem.

### 17.9 Public Figure Threat Model

Research targets:

- DDoS origin hiding
- CDN origin shield
- websocket rate limiting
- raid/lockdown controls
- Discord/Mastodon moderation failure modes
- cache poisoning defenses

Why it matters:

A large public art community is not merely “more users.” It attracts hostile traffic.

Likely Wabi decision:

Create a dedicated future doc:

`docs/futuresight-public-figure-threat-model.md`

Topics:

- hidden authority
- regional anchors
- emergency lockdown
- invite freeze
- expensive endpoint shutdown
- media upload restrictions
- mod-account hardening
- cache poisoning prevention

### 17.10 Expert Escape Hatches

Research targets:

- Kubernetes operator patterns as expert-only
- declarative config examples
- systemd templates
- Caddy/Nginx examples
- Prometheus/OpenTelemetry optional monitoring

Why it matters:

Ronin’s clarification: entry should be piss easy, but a Google vet should be able to adapt Wabi and sprint.

Likely Wabi decision:

Default UX should be UI/CLI guided. Expert UX should expose stable primitives:

- node registry API
- route token format
- event log stream
- storage backend interface
- media node interface
- worker job interface
- health/metrics endpoints

This gives experts power without forcing normal users into expert mode.
