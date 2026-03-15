# Wabi Server Mesh Plan

Last updated: 2026-03-12
Status: Draft implementation plan
Owner: Backend/state-plane/runtime workstream

## 1) Goal

Give Wabi a real multi-node path so that:

- one backend dying does not take the whole app down
- users can connect to a healthy nearby backend when possible
- call quality improves via nearby TURN/media infrastructure
- the system stays privacy-clean and does not become a tracking or data-hoarding platform

## 2) Non-Goals

Out of scope:

- storing audio/video packets in STDB or SQLite
- building detailed user tracking, geo history, or behavioral analytics
- long-term retention of presence, typing, socket routing, or region history
- turning Wabi into a global surveillance-style control plane

Privacy rule:

- keep only the minimum coordination data needed for routing, reconnect, and failover
- use TTL/lease-based ephemeral records wherever possible
- avoid persisting raw IP addresses or fine-grained location history

## 3) Current Baseline

What Wabi has today:

- core durable app state is moving onto SpacetimeDB-backed state-plane
- frontend can choose the best file relay and TURN relay by measured latency
- browser calls remain WebRTC with TURN fallback

What Wabi does not have today:

- multi-backend Socket.IO fanout
- shared socket ownership across backend nodes
- shared presence/typing/session coordination across nodes
- automatic backend failover when one node dies
- geo-aware backend selection for chat/api traffic

Important distinction:

- nearest backend helps chat/api latency somewhat
- nearest TURN/media node helps calls much more
- file relays are not backend failover

## 4) Target Architecture

### 4.1 Edge routing

- one public Wabi domain
- edge layer routes clients to a healthy backend region
- selection should prefer health first, then closeness

This can be done by:

- DNS + geo routing
- Cloudflare/LB routing
- or a Wabi-controlled regional entry layer later

### 4.2 Regional backend nodes

Each backend node keeps:

- HTTP/API contract
- Socket.IO realtime contract
- auth/session validation
- local hot caches only

Each backend node must stop being the sole owner of live coordination state.

### 4.3 Shared state plane

SpacetimeDB should own shared app coordination for meshing:

- backend instance registry
- instance heartbeats
- socket ownership leases
- user presence leases
- typing leases
- reconnect/rejoin leases
- call signaling session leases
- cross-node delivery queue or event stream
- relay and media node capability registry

This data should be:

- TTL-based where possible
- coarse and ephemeral
- enough for routing/failover, not enough for surveillance

### 4.4 Separate media plane

Calls should continue to use:

- WebRTC for browser media
- TURN for fallback and restrictive NATs
- optional media-gateway/SFU infrastructure for stronger routing later

Media packets do not belong in STDB.

## 5) Minimum STDB Additions Needed

These are the missing shared-coordination primitives for a true mesh.

### 5.1 Instance lease table

Tracks:

- instance id
- region
- role/capabilities
- heartbeat timestamp
- drain mode
- current load summary

Purpose:

- know which backend nodes are alive
- stop routing new users to draining or dead nodes

### 5.2 Socket ownership lease table

Tracks:

- stable user id
- current socket id
- owning instance id
- lease expiry

Purpose:

- any backend can determine where a user currently lives
- direct emits no longer rely on local process memory only

### 5.3 Presence and typing leases

Tracks:

- stable user id
- channel id where relevant
- lightweight state
- lease expiry

Purpose:

- presence and typing survive node boundaries
- stale data self-cleans without archival retention

### 5.4 Rejoin/session lease table

Tracks:

- auth/session or guest rejoin key
- owning user
- recent channel/call context
- expiry

Purpose:

- reconnect after node loss without losing all local runtime context

### 5.5 Cross-node delivery queue

Tracks:

- target user or channel
- event type
- payload reference or compact payload
- created time
- delivery/ack state
- expiry

Purpose:

- backend A can enqueue an event for backend B's connected user
- prevents “user is online, but only on the other box” failures

### 5.6 Call coordination leases

Tracks:

- call id
- participants
- owning instance
- relay/media hints
- expiry

Purpose:

- call signaling can recover across node restarts
- handoff logic has a shared source of truth

## 6) Failover Behavior

### 6.1 Backend failure

Desired behavior:

1. edge detects backend unhealthy
2. new users stop landing there
3. existing clients reconnect to another healthy backend
4. new backend rebuilds live context from STDB leases
5. missed ephemeral events are replayed only from short-lived delivery state, not from long-term archives

### 6.2 Planned drain

Desired behavior:

1. mark instance as draining
2. no new connections land there
3. existing sockets reconnect away naturally or are nudged to reconnect
4. instance stops after active sessions clear

## 7) Regional Routing Rules

### 7.1 Chat/API

Use:

- nearest healthy backend region
- fallback to next healthy region when needed

Do not:

- store a permanent user location profile
- keep a historical movement map

Preferred input:

- current request edge metadata or short-lived client latency probes

### 7.2 Calls

Use:

- nearest healthy TURN node first
- nearest media-gateway/SFU when those paths are enabled

This matters more than chat-backend proximity for call quality.

### 7.3 Files

Use:

- current relay selector logic

This is already partly present and does not solve backend failover by itself.

## 8) Suggested Rollout Phases

### Phase A: Same-region failover first

Goal:

- two backend nodes in one region
- one edge entry
- shared STDB coordination

Success means:

- if one node dies, chat reconnects to the other
- no full-app outage from one backend crash

### Phase B: Cross-node realtime delivery

Goal:

- direct messages, channel events, presence, typing, and admin pushes work across nodes

Success means:

- user A on backend 1 can talk to user B on backend 2 with no special-case failure

### Phase C: Regional TURN/media routing

Goal:

- multiple TURN nodes by region
- media hints exposed through relay/media registry

Success means:

- calls choose closer relay/media infrastructure automatically

### Phase D: Regional backend routing

Goal:

- nearest healthy backend for chat/api
- reconnect/failover across regions

Success means:

- users usually land in the best region without manual server switching

### Phase E: Hardening

Goal:

- drills, metrics, and rollback paths

Success means:

- failover is tested, not theoretical

## 9) Observability Without Spying

Allowed metrics:

- instance health
- reconnect counts
- queue depth
- lease churn
- coarse RTT/latency buckets
- call relay selection outcomes

Avoid by default:

- storing raw IPs long-term
- exact user geo histories
- content analytics
- per-user long-term behavior trails

Retention guidance:

- coordination rows: TTL minutes, not months
- aggregated ops metrics: short retention unless explicitly needed

## 10) Immediate Next Steps

1. Finish moving all shared app-state slices that belong on STDB onto STDB.
2. Add STDB instance lease, socket lease, presence lease, and rejoin lease tables.
3. Replace local-only emit routing with STDB-backed cross-node delivery lookup.
4. Stand up two backend instances in one region behind one edge.
5. Prove same-region failover before touching geo-routing.
6. Add regional TURN/media registry and routing after core chat failover works.

## 11) Decision Summary

The right Wabi mesh shape is:

- STDB for shared app coordination
- Socket.IO backend nodes as edge-compatible realtime workers
- TURN/media infrastructure chosen by proximity
- minimal ephemeral coordination data only

The wrong shape is:

- storing media in the database
- using relays alone as pretend backend failover
- adding invasive user tracking to drive routing
