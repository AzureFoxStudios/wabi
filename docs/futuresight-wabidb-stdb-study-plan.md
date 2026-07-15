# Futuresight: WabiDB / SpacetimeDB Study Plan

Date: 2026-06-18
Status: planning / research-first

## Short verdict

Yes: before building a Wabi-native DB/runtime, we should first study SpacetimeDB carefully and legally, write down what makes it shine, then design WabiDB from Wabi's needs rather than from panic or hype.

The goal is not to clone SpacetimeDB.

The goal is to understand the architectural lessons Wabi genuinely wants to keep:

- reducer-like command execution
- colocated state + logic
- transactional mutation
- live subscriptions
- typed schemas / generated bindings where useful
- simple self-host deployment
- retention/deletion as structural behavior
- minimal infrastructure
- fast collaborative state

Then we translate those lessons into a smaller, Wabi-native shape.

## Legal / ethical boundary

SpacetimeDB is source-available under BSL 1.1 today, with a change license to AGPL v3 + linking exception on its change date.

For WabiDB work, we should be conservative:

Allowed / safe:

- Read public documentation.
- Read public source to understand high-level architecture.
- Take conceptual notes in our own words.
- Record public API behavior and external semantics.
- Compare tradeoffs against Wabi's needs.
- Implement Wabi-native ideas independently.
- Use standard database/server patterns that are not unique expression from STDB.

Avoid:

- Copying STDB source code.
- Translating STDB source line-by-line into Wabi.
- Copying private/internal algorithms verbatim.
- Reusing STDB test fixtures or implementation details directly.
- Building a “SpacetimeDB clone” as the goal.
- Depending on uncertain license interpretations.

Best framing:

> Study the product and architecture. Preserve the lessons. Rebuild only the Wabi-shaped subset from first principles.

## Why this step matters

Wabi originally chose STDB because it looked revolutionary: database + server + reducers + live sync. That instinct was not wrong. The problem is that Wabi's long-term values are:

- self-hosted
- open-source-aligned
- average-joe deployable
- privacy-first
- retention-aware
- small enough to own
- not dependent on a BSL core forever

So before replacing STDB, we need to understand what Wabi actually depends on.

Do not jump from:

> STDB has a business license, therefore rip it out immediately.

Instead:

> STDB revealed a good architecture. Now identify the Wabi-sized subset and build toward it deliberately.

## Study questions

### 1. What exactly makes STDB shine?

Document:

- What does STDB do better than a normal app server + database?
- Which parts are essential to Wabi?
- Which parts are general database-product scope that Wabi does not need?
- Which parts are just performance wins, and which parts are architectural wins?
- Which parts affect developer experience?
- Which parts affect user trust/privacy?

Likely shine points:

- Client subscriptions to live state.
- Reducers as transactional state mutations.
- Application logic close to state.
- Less API boilerplate.
- Simple deployment compared to app server + DB + cache + pubsub.
- Strong mental model: call command, state changes, subscribed clients update.
- High throughput from in-memory state + commitlog durability.
- Real-time collaboration fits naturally.

### 2. What does Wabi actually use today?

Current observed Wabi shape:

- Rust `wabi-server` talks to STDB over HTTP.
- `StdbClient` calls SQL endpoint and reducer endpoint.
- Main reducer path is `ingest_wabi_event`.
- STDB module acts as a projection bridge.
- Many tables store structured fields plus `row_json`.
- Call state bridge is small: sessions, participants, call signals.

Important implication:

Wabi is not deeply using arbitrary STDB modules from the frontend as the whole app runtime. Wabi already has a Rust server boundary. That makes a future replacement much more plausible.

### 3. What should WabiDB be?

Candidate definition:

> WabiDB is a small embedded real-time room/object state engine for Wabi-owned collaborative state, not a general-purpose programmable database for arbitrary server-owner logic.

It should support:

- durable committed state
- ephemeral live state
- room-scoped subscriptions
- reducer-like Rust commands
- object-level permissions
- object-level retention
- import/export
- backup/restore
- migration from STDB-backed state

It should not support by default:

- arbitrary user-defined database schemas
- arbitrary server-owner reducers
- arbitrary backend scripts/plugins
- full deterministic game simulation
- competitive real-time game servers
- addons reading raw DMs/server state
- database-as-a-service behavior

### 4. What is WabiDB's “max power”?

WabiDB should comfortably support:

- whiteboards
- D&D/tabletop maps
- tokens on a board
- shared notes
- turn trackers
- dice logs
- polls
- timers
- lightweight inventories
- albums
- room-specific shared objects
- collaborative documents
- presence
- typing indicators
- call state/signaling

This is rough max power:

> Flexible collaborative room state.

Not max power:

- 60 FPS authoritative simulation
- physics engines
- rollback netcode
- anti-cheat game servers
- arbitrary MMO backend logic

Short boundary:

> WabiDB can host the table, not the whole physics engine.

### 5. What latency model should it have?

WabiDB should still be very real-time.

But separate two lanes:

#### Commit lane

Correct, durable, transactional, permission-checked.

Examples:

- send message
- final token position
- dice roll
- turn advanced
- saved whiteboard patch
- note edit
- DM ciphertext append

#### Live lane

Fast, ephemeral, lossy-tolerant, room-scoped.

Examples:

- cursor position
- token currently being dragged
- brush preview
- measuring ruler preview
- typing indicator
- speaking indicator
- temporary call presence hints

This lets Wabi feel very real-time without forcing every transient pixel movement into durable storage/WAL.

### 6. What storage should WabiDB use first?

Likely first candidate: SQLite WAL mode.

Reasons:

- embedded
- boring
- one file
- mature
- easy backup
- FTS5 available
- easy inspection
- enough performance for Wabi-scale chat and collaboration
- average users understand a server folder with a DB file

Other candidates to evaluate:

- redb
- heed/lmdb
- rocksdb
- sled if maintained enough
- custom append-only logs for specific high-throughput event streams

But the first prototype should likely be SQLite unless a hard requirement disproves it.

### 7. How should subscriptions work?

Initial simple model:

- Commands run in DB transaction.
- Transaction writes state rows.
- Transaction also writes a `live_events` / transactional outbox row.
- After commit, server broadcasts events to sockets subscribed to matching topics.

Example topics:

- `server:{id}`
- `channel:{id}`
- `dm:{id}`
- `room:{id}`
- `user:{id}:inbox`
- `call:{id}`
- `object:{id}`

This is much simpler than general SQL subscriptions, but likely enough for Wabi.

### 8. How should addons work?

Early answer: do not allow arbitrary backend code.

Prefer:

- built-in shared object types
- declarative addon manifests
- frontend panels using safe object APIs
- capability-scoped access
- no raw DB access
- no DM access by default
- no network/filesystem access by default

Possible future addon manifest shape:

```toml
[addon]
id = "tabletop-lite"
name = "Tabletop Lite"

[capabilities]
rooms = ["read_members", "write_shared_objects"]
objects = ["map", "token", "dice_log", "turn_tracker"]
dm_access = false
network = false
filesystem = false
background_jobs = false
```

Principle:

> Minecraft redstone, not arbitrary kernel modules.

### 9. What should be learned from STDB but not copied?

Learn:

- reducer model
- subscription mental model
- colocated state/logic benefits
- schema-driven development
- simple deploy story
- in-memory hot state + durable log concept
- client update ergonomics

Do not copy directly:

- source code
- internal algorithms
- database product scope
- multi-language module runtime unless Wabi truly needs it
- arbitrary user modules
- cloud/database-service assumptions

### 10. What should the migration strategy be?

Do not rip STDB out immediately.

Recommended path:

1. Define `WabiState` trait / internal state boundary.
2. Make current STDB implementation one backend: `StdbState`.
3. Build experimental embedded backend: `EmbeddedWabiState`.
4. Start with low-risk state:
   - settings
   - layout/theme prefs
   - channels maybe
   - dev/mock state
5. Then messages.
6. Then DMs.
7. Then calls/media metadata.
8. Keep STDB until embedded backend is proven.

## Proposed document sequence

### Doc 1: STDB study notes

File idea:

`docs/research-spacetimedb-lessons-for-wabi.md`

Purpose:

- What STDB does well.
- What Wabi actually needs.
- What not to copy.
- Legal boundary.
- Verified claims with sources.

### Doc 2: WabiDB proposal

File idea:

`docs/futuresight-wabidb-proposal.md`

Purpose:

- WabiDB shape.
- Room/object model.
- Commit lane/live lane.
- Storage choice.
- Subscription model.
- Permissions/capabilities.
- Retention semantics.
- Migration path.

### Doc 3: WabiState migration plan

File idea:

`docs/wabistate-abstraction-migration-plan.md`

Purpose:

- Current STDB coupling points.
- Trait/API boundary.
- First implementation tasks.
- Test plan.
- Rollback plan.

## First concrete implementation target, after docs

Build a tiny prototype, not a full replacement.

Prototype should prove:

- SQLite WAL storage
- command transaction wrapper
- `send_message`
- `create_dm`
- `set_friend_tier`
- room/channel subscription broadcast
- transactional outbox
- TTL purge job
- import/export smoke test

If this prototype feels clean, WabiDB is real.

If it becomes messy immediately, keep STDB longer and refine the boundary.

## Final principle

Do not build WabiDB because SpacetimeDB is scary.

Build WabiDB only if it makes Wabi more itself:

- smaller
- more self-owned
- more privacy-first
- easier to self-host
- easier to reason about
- flexible enough for whiteboards/tabletop/session tools
- bounded enough to avoid becoming an unsafe general app platform

STDB gave Wabi the shape.

WabiDB should make that shape ours.
