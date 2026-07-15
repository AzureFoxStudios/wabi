# Futuresight: WabiDB Proposal

Date: 2026-06-18
Status: proposal / parking-lot doc, not a commitment

This is the doc that comes after the STDB study (`docs/research/stdb-architecture-study.md`) and the study plan (`docs/futuresight-wabidb-stdb-study-plan.md`). It picks a shape for WabiDB and names a first concrete thing to build.

This is **not** an implementation plan. It is a design proposal. You can stop reading at any section and say "no" and we are no worse off than we were before you opened the file.

## What this doc is

- A concrete shape for a Wabi-native state engine.
- A list of what it is and is not.
- A migration path from current STDB usage.
- A first concrete prototype to build, scoped to one weekend of focused work.
- A list of the things we know we don't know.

## What this doc is not

- A commitment to rip STDB out of Wabi this month.
- A "we are building a STDB clone" plan.
- A database engine product roadmap.
- An attempt to compete with Discord, Matrix, or Revolt on infrastructure scope.

## The shape, in one sentence

WabiDB is a small embedded real-time room/object state engine for Wabi-owned collaborative state, not a general-purpose programmable database for arbitrary server-owner logic.

That sentence is the line. Every decision below is judged against it.

## Why a shape, not a feature list

The reason we are not starting with "WabiDB should support: DMs, channels, whiteboards, D&D maps, presence, calls, voice notes, …" is that a feature list does not constrain a design. Two systems can both "support DMs" and have completely different shapes. The shape is the constraint that keeps us from accidentally building a STDB clone in Wabi's clothing.

The shape has three parts:

1. **A small set of object types** that the engine knows about.
2. **A command/transaction model** that mutates those objects.
3. **A topic-based live broadcaster** that pushes committed changes to subscribed clients.

Everything else is either an implementation detail of one of those three, or out of scope.

## The boundary (what WabiDB is NOT)

This list is as important as the shape. If you find yourself wanting to add any of these, that is a sign we are drifting.

WabiDB is NOT:

- A general-purpose database with a SQL interface. Average users can understand it; DBA-style ad-hoc query surfaces are out of scope.
- A game engine. WabiDB can host collaborative room state (whiteboards, D&D maps, turn trackers). It does not host 60Hz physics, deterministic rollback, or authoritative game simulation.
- A programmable app platform. Server owners do not upload arbitrary reducers. Server owners do not define arbitrary schemas. (This is the "Minecraft redstone, not arbitrary kernel modules" line.)
- A cross-server global state system. Per-server state only. No federation. No shared global registry.
- A multi-tenant database-as-a-service. Each Wabi instance is one server admin's server, full stop.
- A read-replica / distributed-system story. WabiDB is single-node. Helper-node / standby work, if any, comes later and is a separate doc.
- A user-installed-backend-code story. If we ever ship addons, they are frontend panels over the built-in object APIs with explicit capability manifests, not arbitrary server code.

If a future need pushes against this list, we revisit the list, not the shape.

## Core components

```
wabi-node
  ├─ wabi-state            (the engine itself)
  │   ├─ wabi-storage      (SQLite WAL embedded)
  │   ├─ wabi-commands     (reducer-like Rust functions)
  │   ├─ wabi-rooms        (built-in room/object types)
  │   ├─ wabi-blobs        (encrypted content-addressed blob store)
  │   └─ wabi-live         (topic-based WS broadcaster + outbox consumer)
  │
  ├─ wabi-server (the existing Rust HTTP/Socket.IO server)
  │
  └─ wabi-helpers (optional, future: thumbnails, transcode, search index)
```

The boundary is: `wabi-server` and the frontend talk to `wabi-state` through a single `WabiState` trait. Nothing inside `wabi-state` knows about HTTP, Socket.IO, Svelte, or the frontend. That trait boundary is the migration escape hatch — STDB becomes one implementation of it, the embedded engine becomes another.

## Component responsibilities

### `wabi-storage` (SQLite WAL)

- One SQLite database file (with WAL mode) per Wabi server.
- Tables for the core state (users, sessions, channels, messages, DM conversations, DM messages, friend tiers, encryption key metadata, calls, settings, app settings).
- A `live_events` table acting as a transactional outbox. Every state-mutating command writes its outbox rows in the same DB transaction as the state changes.
- A `retention_policies` table or per-row `expires_at` column for TTL-based deletion.
- FTS5 virtual table for message search.
- File-based backup = `sqlite3 wabi.db .backup`.
- No custom index engine, no custom WAL, no custom page pool. Use what SQLite gives us.

### `wabi-commands`

A Rust function per command, each takes a `CommandCtx` (transaction handle, caller identity, timestamp, capabilities) and returns `Result<T, CommandError>`. Inside the function you can read and write tables, throw on permission errors, and return either a value or an error.

Example shape (illustrative, not final):

```rust
pub fn send_message(
    ctx: CommandCtx,
    input: SendMessageInput,
) -> Result<Message, CommandError> {
    ctx.tx(|tx| {
        require_channel_member(tx, &input.channel_id, ctx.caller_user_id)?;
        let msg = insert_message(tx, &input)?;
        enqueue_live_event(tx, LiveTopic::Channel(input.channel_id), &msg)?;
        Ok(msg)
    })
}
```

The transaction wrapper handles commit/rollback. The outbox rows are part of the same transaction. If the command fails, the state changes and the outbox rows both roll back. The broadcaster never sees partial state.

### `wabi-rooms` (built-in object types)

WabiDB is a room engine at heart. A "room" is a generic concept — a text channel is a room, a DM is a room, a call is a room, a D&D session is a room, a whiteboard is a room. The room carries:

- An object type (text_channel, dm, call, map_session, whiteboard, note, poll, timer, …)
- Members (who is in the room)
- Permissions (who can read, write, invite, kick)
- Retention policy (TTL or "until removed")
- A bag of typed children (messages, tokens, strokes, polls, etc.)
- A visibility scope (public to room, private to user, encrypted pair, server_admin_blind)

WabiDB has a **bounded set of object types** built in. Server owners cannot add new types. If a need arises, the type is added to WabiDB itself, not by a runtime mechanism. This is the Wabi-shaped version of STDB's "any reducer can be defined" — it is intentionally less flexible, in exchange for being safer and smaller.

Initial built-in object types (illustrative):

```
text_channel        — chat messages, attachments, pins
dm_conversation     — encrypted messages between two users
call_session        — voice call participants + ephemeral signal relay
map_session         — D&D map background, tokens, fog, drawing layer
whiteboard          — shared document CRDT
shared_note         — single shared document
poll                — single poll with options and votes
timer               — synchronized countdown/turn tracker
turn_tracker        — initiative order
dice_log            — append-only dice rolls
album               — shared media collection
album_item          — single media in an album
```

The Wabi-flavored list, not the "we can add anything" list.

### `wabi-blobs` (encrypted content-addressed blob store)

- BLAKE3 content addressing (same primitive STDB uses).
- Per-recipient encryption for DM payloads (X25519 + XSalsa20-Poly1305 or similar, design TBD).
- Stored on local disk as content-addressed files under a `blobs/` directory.
- Replicated only at the engine layer's discretion; the broadcaster never touches blob bytes.
- A blob's retention is independent of any room's retention: a voice note blob can outlive a DM thread, or vice versa, depending on policy.

### `wabi-live` (WebSocket broadcaster + outbox consumer)

This is the thing that makes Wabi feel real-time. The pattern is the same as STDB's SendWorker, simplified:

1. Command transaction commits with outbox rows.
2. Outbox consumer worker (Tokio task) reads committed outbox rows in order.
3. Worker groups events by topic (`channel:42`, `dm:user_a:user_b`, `room:abc`, `user:7:inbox`).
4. For each topic, the worker builds the per-subscriber payload (apply per-subscriber filters if any, e.g., redact mentions the subscriber cannot see).
5. Worker sends the payloads over the subscribers' WebSocket connections.
6. Worker marks outbox rows as broadcast (or deletes them after broadcast; TBD).

The "as low as we can go" sync question: yes, we can push latency low here, but only for the "live lane" — transient data like cursors, drag previews, speaking indicators. Committed state changes go through the durable transaction + outbox path, which has higher latency but is correct.

The two-lane split:

```
commit lane:
  correct, durable, transactional, permission-checked
  examples: send message, save token position, dice roll, turn advanced, note edit

live lane:
  fast, ephemeral, lossy-tolerant, room-scoped
  examples: cursor position, dragging preview, hover, typing indicator, speaking
```

The live lane does not write to the durable database. The live lane is in-memory only, broadcast through `wabi-live`'s ephemeral relay. If a live-lane message is lost, the next one replaces it.

This two-lane design is what lets us answer "can we have low-latency real-time?" with yes without bloating the durable DB with every pixel movement. It also fixes the STDB event-table commitlog gotcha that the study doc flagged: in WabiDB, ephemeral data simply never hits the durable store. If the server restarts, in-flight live-lane messages are lost, and that's fine — they were never supposed to persist.

## The command/transaction model

Wabi's commands are server-defined Rust functions. They are not user-defined. They are not uploadable. They live in the `wabi-commands` crate as compiled Rust.

This is the Wabi-shaped version of STDB's reducer system. We keep:

- Transactional semantics.
- Permission checks beside mutation.
- Caller identity in the context.
- A typed input and a typed output.
- The ability to throw on validation failure.
- The ability to enqueue a live event in the same transaction as the state change.

We drop:

- The arbitrary WASM module runtime.
- The fuel/energy budget (we can add per-command timeouts later, but we don't need fuel metering for our own code).
- The general-purpose SQL planner.
- The V8/TypeScript runtime.
- The C# runtime.
- The migration planner (we'll do schema migrations with `sqlx::migrate!` or similar).

Why drop the module runtime: it's a tar pit. It's tens of thousands of lines of code, and we don't need it because we are not running untrusted user code. If we ever need addons, they are frontend panels over the built-in object APIs with explicit capability manifests, not arbitrary server code.

## The subscription/broadcast model

WabiDB's subscription system is **not** SQL. It is **topic-based pub/sub** with bounded filter expressions.

A client subscribes to a topic like:

- `channel:42` — all messages in channel 42
- `dm:7:9` — the DM conversation between users 7 and 9 (the user must be one of those)
- `room:abc` — all events in room abc
- `user:7:inbox` — events that affect user 7 (DMs, mentions, call invites)

A topic can have a filter:

- `channel:42?since=2026-06-18T00:00:00Z` — backfill from a timestamp
- `channel:42?types=message,reaction` — only message and reaction events

Filters are **closed**: a fixed set of operations the engine knows how to apply to its topic keys. We do not parse arbitrary boolean expressions. The frontend cannot construct "channel:42 AND user_id != 7" — that's not a thing the engine understands. If a frontend needs a more selective view, it filters client-side after receiving the broadcast.

This is the right shape because:

- It maps cleanly to the "subscribe to a room" mental model.
- It cannot accidentally expose "SELECT * FROM private_table WHERE condition".
- It is implementable in a few hundred lines of Rust, not 15,000.
- It does not need a query compiler or plan optimizer.
- It is auditable — a server admin can read the topic grammar and understand every possible subscription.

The trade-off: clients that need cross-table joins (e.g., "show me all messages from user X across all channels I am in") have to do it client-side by subscribing to multiple topics and merging. That's fine; the engine stays simple and the client gets a reasonable view.

## The room/object model

This is the "max power" boundary, and we have to draw it deliberately.

WabiDB can comfortably support:

- Whiteboards (shared document state, CRDT or append-only)
- D&D/tabletop maps (token positions, fog of war, layers, turn order, dice log)
- Shared notes
- Polls
- Timers
- Lightweight inventories
- Albums
- Per-room shared objects (any of the above)
- Collaborative document edits

WabiDB explicitly does NOT support:

- 60 FPS authoritative simulation
- Physics
- Rollback netcode
- Anti-cheat-authoritative game worlds
- Arbitrary MMO backend logic

The boundary is: **WabiDB can host the table, not the whole physics engine.**

If someone later wants to host a real-time action game on top of Wabi, they can use Wabi as the social/community layer and bring their own game-server backend. That's the right separation.

## The privacy model

This is the part the BSL/concerns most directly motivate. WabiDB's privacy model is:

1. **Two lanes.** Commit lane writes to durable storage with retention. Live lane is in-memory only. There is no event-table-with-commitlog gotcha in WabiDB because the live lane never touches the durable store.

2. **Server stores only metadata minimized.** A DM message in WabiDB is stored as `{conversation_id, sender, ciphertext, nonce, expires_at?}`. The server cannot decrypt it. Period.

3. **Encryption keys are per-user, not per-server.** A user's identity keypair is generated on their device, never touches the server. Public keys are stored in WabiDB; private keys are not. Conversation keys are derived per-recipient-pair and rotated.

4. **Per-recipient encryption for DMs.** Each DM message is encrypted N times (once per recipient). The server stores N ciphertexts. This is more storage but matches Signal's pattern and keeps the trust model simple.

5. **TTL is structural, not policy.** Each object type declares its retention class (ephemeral, session, durable, archive). The engine enforces TTL on a scheduled reaper task. The reaper is a command, not a sidecar script.

6. **No black hole.** When a user leaves a room or a channel is deleted, the associated state is deleted from the durable store. When a user revokes a device, the encryption keys for that device are deleted. The reaper does not just "stop logging"; it actively erases.

7. **No telemetry that phones home.** WabiDB does not call home to Clockwork, to Wabi, to anyone. The only network traffic is the local server's traffic.

8. **Encryption at rest is operator-side, not engine-side.** WabiDB does not have a built-in "encrypt the DB" feature, because that adds a passphrase UX problem we don't need to solve. The operator uses OS-level disk encryption, full-disk encryption, or a LUKS-encrypted volume. We document this in the deploy guide.

9. **No snapshot linkability.** STDB's snapshots are content-addressed and BLAKE3-deduplicated across snapshots. That's a feature for storage, but for a privacy-first platform, it means two snapshots taken at different times can be linked by identical BLAKE3 page hashes. WabiDB either (a) does not cross-deduplicate snapshots, or (b) encrypts each snapshot with a different key. (a) is simpler; (b) is safer. Decision: defer until we have a snapshot feature.

## The storage choice

**SQLite WAL mode.** Reasons:

- Embedded, single file, no extra process.
- Battle-tested, mature, ubiquitous.
- WAL mode gives us durable + reader concurrency.
- FTS5 gives us full-text search without a second service.
- Easy backup: `sqlite3 wabi.db .backup` produces a consistent snapshot.
- Average users can understand a Wabi server as "a folder with a database file in it."
- Not BSL. Not enterprise. Not a startup that might pivot license terms.

Other options we considered and rejected:

- **redb.** Embedded, pure Rust, BSL-friendly, but less mature, smaller community, FTS not built in. A reasonable second choice if SQLite hits a wall.
- **sled.** Embedded, pure Rust, but unmaintained as of last check.
- **LMDB / heed.** Mature, fast, but no FTS, no SQL.
- **Postgres.** Requires a separate process, separate admin knowledge, more deployment friction. Wrong shape.
- **MySQL/MariaDB.** Same. Plus we don't need its feature set.
- **Custom BTree/page pool.** STDB already proved this works, but it is ~15,000 lines of code and not the right Wabi shape.

If SQLite's write throughput becomes a bottleneck, we add a small in-memory cache layer for hot topics, but we don't replace SQLite. The "all in RAM" model that STDB uses is unnecessary for Wabi's data volume.

## The migration path from STDB

Wabi currently uses STDB v2.0.2 in two Rust crates: `spacetimedb/wabi_state_bridge` and `spacetimedb/wabi_call_state_bridge`. The Rust `wabi-server` talks to STDB over HTTP via `StdbClient`. The bridge crates define ~30 tables that act as STDB projections of the Wabi app's state.

The migration is **not** a "burn the bridges" event. It is a phased move. The `WabiState` trait is the boundary that makes this possible.

**Phase 0: Define the trait boundary.** Add a `WabiState` Rust trait in `wabi-core` that exposes every operation the `wabi-server` currently performs on STDB: `send_message`, `edit_message`, `create_dm`, `set_friend_tier`, `join_call`, `publish_call_signal`, etc. Implement it as a facade that calls the existing `StdbClient` methods. The rest of `wabi-server` doesn't change. **Done when `svelte-check` is clean and dev mode still works.** No new features, no schema changes. Just a trait.

**Phase 1: Build an experimental `EmbeddedWabiState` implementation.** In a separate worktree or branch, build a minimal `wabi-state` crate that:
- Uses SQLite WAL.
- Implements a subset of `WabiState` (just `send_message` and `get_messages`).
- Has a `live_events` outbox table.
- Has a Tokio task that reads the outbox and broadcasts to a simple in-memory subscriber registry.
- Has tests that prove send → broadcast works.

This is the "first concrete thing to build" below. **Goal: prove the architecture, not ship a feature.**

**Phase 2: Move low-risk state.** When Phase 1 is solid, move theme prefs, layout prefs, app settings, and channel list to the embedded engine. STDB is still the source of truth for messages, DMs, and calls. The `EmbeddedWabiState` is gaining features but still partial.

**Phase 3: Move messages.** When Phase 2 is solid, move the message table. This is the biggest single table; success here means the architecture is real.

**Phase 4: Move DMs.** Move DM conversations and DM messages, preserving E2E encryption semantics. The server still only sees ciphertext.

**Phase 5: Move calls/metadata.** Move call sessions, call participants. Live audio still doesn't touch the durable DB.

**Phase 6: STDB becomes optional.** At this point, STDB can be removed from the production binary. The `StdbClient` becomes an alternative backend (for users who want a STDB-backed Wabi for some reason). The default is `EmbeddedWabiState`.

**Phase 7: STDB bridges become archive-only.** The STDB bridge crates stay in the repo as legacy code, but no new development happens there.

**The escape hatch:** if at any point Phase 1, 2, or 3 reveals that the embedded approach is wrong, we stop. We don't move to Phase 2. We keep STDB. The trait boundary from Phase 0 makes this cheap. No sunk-cost trap.

## The first concrete thing to build

This is the part where we stop planning and start coding. **A separate branch / worktree.** Do not touch the main branch. Do not commit to the main branch. Do not advertise it.

The first concrete artifact is a Rust crate `wabi-state` with:

1. A `Cargo.toml` depending on `rusqlite` (or `sqlx` if you want async), `tokio`, `serde`.
2. A `wabi.db` SQLite file created on first run with the schema:
   - `users(id INTEGER PRIMARY KEY, name TEXT, ...)`
   - `channels(id INTEGER PRIMARY KEY, name TEXT, ...)`
   - `messages(id INTEGER PRIMARY KEY, channel_id INTEGER, sender_id INTEGER, content TEXT, created_at INTEGER, ...)`
   - `live_events(id INTEGER PRIMARY KEY, topic TEXT, payload BLOB, created_at INTEGER, broadcast INTEGER DEFAULT 0)`
   - FTS5 virtual table for messages.
3. Two commands:
   - `send_message(ctx, channel_id, sender_id, content) -> Message`
   - `get_messages(ctx, channel_id, since_id) -> Vec<Message>`
4. A `LiveBroadcaster` struct with a Tokio task that:
   - Polls `live_events WHERE broadcast = 0` every N ms.
   - Groups events by topic.
   - Calls registered subscribers (in-memory `HashMap<Topic, Vec<Subscriber>>`).
   - Marks events as broadcast.
5. A test that:
   - Creates a `wabi-state` instance.
   - Subscribes to `channel:42`.
   - Calls `send_message` for channel 42.
   - Asserts the subscriber receives a notification within 100ms.
6. A `Cargo test` that runs the test and passes.

**Effort estimate:** one focused weekend for someone who knows Rust and SQLite basics. Probably 400-800 lines of Rust including tests.

**Stop condition:** if the test passes, the architecture is real. If the test fails or the implementation gets messy immediately, we have learned something and we stop. We do not push past the stop condition. We do not "just fix one more thing." The trait boundary from Phase 0 is our safety net.

## Risks and unknowns

I am stating these explicitly so we are not surprised by them later.

1. **SQLite write throughput.** SQLite WAL is fast, but it is not STDB-fast. For a single Wabi server with maybe 100-500 users, this is fine. For 10,000 users in a hot room, we may need an in-memory cache. Decision: do not pre-optimize. Build the SQLite version, measure, decide later.

2. **E2E encryption key escrow design.** This is unsolved. We need a concrete design for: identity keypair generation (client-side), public key distribution, conversation key derivation, key rotation, multi-device sync. This is a separate doc, probably 2-3 pages, and it should be written before we move DMs in Phase 4. Do not let me hand-wave this.

3. **Replication and backup.** SQLite makes backup easy (`.backup`), but the encrypted-blob store and the SQLite file need to be backed up together. The warm-standby doc (`docs/futuresight-multi-anchor-helper-nodes.md`) has thoughts on this; we re-derive the answer when we get there.

4. **Migrations.** SQLite + `sqlx::migrate!` or `refinery` gives us a migrations path. Migrations are NOT a free lunch; they need to be tested. Phase 1 includes a basic migration setup; we harden it in Phase 2.

5. **BSL exposure during migration.** While STDB and `EmbeddedWabiState` are both shipped, we are exposed to STDB's BSL. This is not new (we have it today) and is not worse than the status quo. We move on.

6. **Frontend coupling.** The current frontend talks to STDB via `stdb_bindings/` generated code. We will need to remove or rewrite that. This is a frontend task, not a backend task. It happens in Phase 2-3.

7. **Skill unknowns.** I have not yet read the Wabi `PROJECT_DOCS/archive/2026-04-stdb-migration/SPACETIMEDB_WABI_STATE_PLAN.md` end-to-end in this session. The Phase 0 trait boundary should be cross-checked against whatever that doc promises. If it contradicts, the futuresight doc wins; we update the plan doc.

8. **"WASM-like isolation for any future addon system" trade-off.** If we ever want to run user addons, we are giving up the WASM sandbox that STDB gives us. The Wabi-shaped answer is: addons are frontend-only, and any backend-touching extension must go through a small set of built-in object APIs with explicit capability tokens. This is a known trade-off, not a hidden one.

## What we are NOT committing to

- We are not committing to a timeline.
- We are not committing to rip out STDB by date X.
- We are not committing to a public roadmap statement.
- We are not committing to the trait names, function signatures, or schema names in this doc. Those are illustrative.
- We are not committing to SQLite forever. We are committing to "try SQLite first" because it is the most boring choice.

## What we ARE committing to (if we go forward)

- Phase 0 is a one-day refactor that adds a `WabiState` trait with zero new features. Low risk.
- Phase 1 is a one-weekend prototype in a separate branch. Zero risk to main.
- We stop at any phase that doesn't prove itself.
- We do not advertise Phase 1 work publicly. It is internal exploration.
- We write a short follow-up doc after Phase 1 that says: did it work, what we learned, what changes.

## How to read this

Read it top to bottom once. Then ask me one question. Then we decide.

The most likely questions are:

- "Why not redb instead of SQLite?" — answered above; SQLite is more boring, FTS5 is built in, average users can understand it.
- "Can we keep STDB and just write the trait boundary?" — yes, that is Phase 0. We can stop after Phase 0 and be no worse off.
- "What if the prototype doesn't work?" — we stop, we keep STDB, we write a doc that says what we learned, we move on.
- "What if WabiDB is too slow?" — we measure in Phase 1, decide in Phase 2, do not pre-optimize.

## Final word

You said you were a bit nervous to do this. That's the right feeling. It is a big architectural decision, and big decisions deserve nervous energy. The good news is: Phase 0 is one day, Phase 1 is one weekend, and we can stop at any phase boundary. The trait boundary from Phase 0 is the safety net. As long as the trait boundary exists, nothing about the Wabi app's behavior changes. We can take this slow.

If you want to read this and say "I like the shape but not the storage choice, what about redb?" — we can have that conversation. If you want to say "let's not even do Phase 0, let's just keep STDB" — that is also a valid answer and we lose nothing. If you want to say "let's do Phase 0 and Phase 1 next week" — that is also a valid answer.

There is no wrong answer here. There is only "do we want to be more in control of Wabi's data layer, or do we want to stay with the STDB product?" Both are real choices. This proposal is for the first one.
