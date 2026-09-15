# Shared Wabi Media Nodes

**Status:** architecture and implementation boundary  
**Updated:** 2026-09-14

Wabi Media Nodes may serve more than one independent Wabi Authority. This is
infrastructure sharing, **not federation**. A shared Media Node routes ephemeral
real-time media for Authorities that explicitly trust it; it does not join their
communities, receive their databases, or become a source of identity or policy.

This design exists for two practical reasons:

1. many Wabi Authorities will live behind NAT/CGNAT and cannot host a public UDP
   media endpoint themselves;
2. one well-connected machine may have enough bandwidth and CPU to help many
   small Wabi communities.

A large node in San Francisco, Singapore, Tokyo, a university, a studio, or a
friend's VPS should therefore be able to provide call capacity to many unrelated
Wabi servers without those servers becoming related to each other.

## 1. Roles

### Authority

The Authority owns the community:

- accounts and identity;
- channel/group membership;
- roles and moderation;
- mute/deafen/speaking policy;
- whether a participant may publish camera/screen;
- whether a participant has chosen to subscribe to media;
- durable WabiDB state.

### Media Node

The Media Node owns packet-moving infrastructure only:

- SFU lifecycle;
- TURN where configured;
- short-lived room/session resources;
- transport health and capacity reporting;
- media statistics required for routing and diagnostics.

A Media Node does **not** become an Authority merely because it routes a call.

### Media Pool

A Media Pool is the set of Media Nodes one Authority has explicitly paired or
configured. A pool may contain the Authority's own node, friends' nodes, shared
community infrastructure, commercial third-party nodes, or any mixture of them.
No project-operated directory is required.

## 2. Multi-tenant trust model

A physical Media Node may maintain separate pairings with many Authorities.
Each Authority receives its own scoped relationship with that node. One
Authority must never receive another Authority's node credential or SFU root
secret.

The Media Node, not the Authority, owns backend root credentials such as the
LiveKit API secret. Authorities request narrowly scoped media capability; the
Media Node converts that request into backend-specific credentials.

Conceptually:

```text
Authority A -- scoped pairing A --\
Authority B -- scoped pairing B ----> Shared Media Node --> SFU/TURN
Authority C -- scoped pairing C --/
```

Compromise of Authority A must not grant access to Authority B's rooms.

## 3. Tenant and room isolation

Every media room routed through a shared node must be namespaced by an opaque,
stable Authority identity plus a random call/room identifier. Human channel
names such as `general`, usernames, server names, or other personally meaningful
labels are not acceptable backend room identifiers.

The minimum room identity carried across the Authority -> Media Node boundary is:

```text
tenantNamespace   opaque stable Authority namespace
roomId            Authority-local random room id
externalRoomName  tenant-scoped backend room name
```

The backend-facing room name must be collision-resistant across Authorities.
The first implementation generates a separate random tenant UUID in the local
media registry and persists it in `media_rooms.json`; it deliberately does not
reuse human-configurable server/instance names. A restored backup therefore
retains its tenant identity while independent Authorities generate different
namespaces.

A certification test must prove that two Authorities can use the same physical
Media Node while being unable to join, enumerate, publish into, subscribe to, or
terminate each other's rooms.

## 4. Capability issuance

The eventual shared-node authorization request should be short lived and narrow.
A capability should be able to express at least:

- Authority/tenant namespace;
- exact room;
- exact participant/device identity;
- expiry;
- may join;
- may publish microphone;
- may publish camera;
- may publish screen;
- may subscribe;
- optional bitrate/quality limits.

Server mute, muted-on-entry, listen-only, role-gated speaking, and equivalent
Wabi policy must therefore be enforceable at credential/media-boundary level,
not only as UI state.

The shared Media Node must never need the Authority's durable user database to
make these decisions. The Authority supplies the already-authorized result.

## 5. Privacy boundary

A shared Media Node necessarily handles network metadata and encrypted media
packets. Operators should assume it can observe at least:

- client IP addresses;
- connection timing;
- opaque tenant/room/participant identifiers;
- packet/bitrate statistics;
- transport/fallback choice.

It should not require:

- passwords;
- chat messages;
- WabiDB contents;
- unrelated roles/profile data;
- human-readable room names.

Media E2EE is a strong long-term requirement for shared nodes so the node's trust
role can approach "forward encrypted packets and remain available" rather than
"trusted participant in every call."

## 6. Capacity, quotas, and fairness

Shared nodes require explicit capacity controls. A node should eventually
advertise global capacity and allow per-Authority quotas such as:

- maximum active rooms;
- maximum concurrent participants;
- maximum publishers;
- aggregate bitrate or transfer budget;
- priority/weight;
- optional backend/feature availability.

Existing calls should be protected from overload. When a node approaches its
admission limit, the Authority should choose another healthy node from its pool
or fall back according to configured policy rather than over-admitting and
ruining established calls.

## 7. Selection and geography

An Authority may trust several nodes. Selection should use measured/runtime
facts rather than a central Wabi service:

- node health;
- advertised capacity/load;
- supported media backend/features;
- configured operator priority;
- measured client/node latency where practical;
- region as a hint, not an unquestioned truth.

A Thailand-based community may choose a Singapore node over San Francisco even
when both are healthy. A shared San Francisco node can still serve many Wabis;
it is simply one candidate in each Authority's independently configured pool.

## 8. Pairing UX

Sharing must be opt-in. Wabi must not silently discover and trust arbitrary
Internet media nodes.

A future simple flow should look approximately like:

```text
Media Node operator:
  Offer Call Capacity -> Generate pairing code

Authority operator:
  Add Call Helper -> paste pairing code -> verify health -> save
```

A public directory may exist later as an optional convenience, but the protocol
must work with nothing more than an explicitly exchanged endpoint/pairing code.

## 9. CGNAT behavior

The Authority may remain entirely behind CGNAT. Only the selected Media Node
needs public media reachability.

```text
CGNAT Authority -- outbound authenticated control --> Public shared Media Node
Clients          ---------------- WebRTC/TURN ------> Public shared Media Node
```

Wabi should detect when a machine cannot provide a public media endpoint and
present actionable choices instead of requiring administrators to understand NAT
terminology before setup.

## 10. Backend independence

Shared-node semantics belong to Wabi, not LiveKit or mediasoup.

Wabi 1.x may implement the node with LiveKit. A future mediasoup-rust node may
implement the same Authority/tenant/room contract. Authority-side code should
not need to know which backend's root secret or internal room object the node
uses.

See `MEDIA_BACKEND_AND_CERTIFICATION.md` for the provider contract and release
gates.

## 11. Implementation order

1. Namespace media rooms by Authority/tenant and carry that namespace in media
   jobs. **First implementation slice.**
2. Add node media metadata (provider, region, capacity, shared/private mode).
3. Add scoped Authority <-> Media Node pairing suitable for a physical node that
   serves multiple Authorities.
4. Add admission/quotas and best-node selection.
5. Add backend token minting behind the Wabi media-node boundary.
6. Add selective subscription and Wabi voice-policy enforcement.
7. Add shared-node isolation, overload, and malicious-tenant certification tests.
8. Add admin UI/pairing UX and Call Doctor visibility.

Until those later steps land, existing helper-node assignment is infrastructure
scaffolding rather than a claim that safe public multi-tenant media hosting is
already complete.
