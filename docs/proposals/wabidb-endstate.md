# WabiDB: End-State Design Document

> **Status:** Proposal (revised after Arena LLM review and storage architecture correction, 2026-06-19)  
> **Date:** 2026-06-19  
> **Audience:** Senior Rust engineer implementing the Wabi database engine  
> **Scope:** The complete, production-ready WabiDB. Not the migration path. Not phased rollouts. Just what it is.
>
> **Current product status (2026-07-29):** This is a proposal. Current Wabi DMs are server-readable; the encryption boundaries in this document are targets and must not be presented as shipped guarantees.

---

## 1. What WabiDB Is

**WabiDB is a purpose-built, single-machine database engine and live-subscription service that Wabi-server talks to over a Rust API — not HTTP, not WASM, not RPC — to persist the entire state of a self-hosted Discord alternative and push real-time changes to browser clients over a WebSocket topic-subscription protocol.**

The problem it solves is specific. Wabi currently depends on SpacetimeDB (BSL 1.1 licensed) for state management, but STDB's architecture imposes hard constraints that are misaligned with Wabi's product: the "one instance per app" BSL restriction prohibits multi-database privacy compartmentalization; the generic database scope (SQL, ad-hoc queries, system tables, migration planner) adds complexity Wabi does not need; the full WASM/V8 module runtime (tens of thousands of lines) exists to run user-supplied code that Wabi will never run; there is no helper-node awareness built-in, so retooling for media/transcode/search nodes must be retrofitted; there is no encryption-at-rest or per-DM encryption model; the commitlog retains all event-table rows forever with no retention mechanism; and SQLite as a substrate — while adequate for the immediate scale target — does not natively model Wabi's per-stream retention, per-stream encryption keys, or topic-replay semantics.

WabiDB solves all of these at once by being a **focused engine** that does exactly what Wabi needs and nothing else. WabiDB **owns the storage format**. The engine is a per-stream log-structured Wabi object/event store with a global commit index, derived projections, retention-aware compaction, and a memory-only ephemeral bus. SQLite is not a substrate. Neither is redb, LMDB, or any other third-party database engine. The file format, the record framing, the recovery rules, the projection engine, the retention engine, and the storage CLI are all Wabi's own code.

**Non-goals, explicitly:**

- **Not a SQL database.** WabiDB has no SQL parser, no query planner, no ad-hoc query interface. State is read through typed Rust accessors, not `SELECT * FROM`.
- **Not a third-party database backend.** WabiDB does not depend on SQLite, redb, LMDB, RocksDB, or any other external database engine. Wabi owns the storage format end-to-end.
- **Not a generic embedded KV store.** WabiDB is not a generic key-value store with a query engine. It is a log-structured Wabi object/event store with derived projections and fixed access paths.
- **Not a game engine.** WabiDB does not run game logic, physics, or spatial queries.
- **Not a programmable app platform.** No WASM runtime, no V8 isolates, no user-supplied modules. Wabi-server itself is compiled into the binary alongside the engine; it calls Rust functions directly.
- **Not federation.** WabiDB is a single-server engine. Cross-server federation is handled at a higher layer (Wabi-server's existing Socket.IO relay and mesh infrastructure).
- **Not multi-tenant SaaS.** WabiDB is deployed one-per-server. Each instance holds exactly one logical database for one community.

**How it is shaped:** WabiDB is a Rust library crate (`wabidb`) that wabi-server imports and calls. The engine can be embedded directly in the wabi-node binary (the canonical deployment) or run as a sibling process that wabi-server connects to over Unix domain sockets (for operational isolation). It is single-machine v1. Helper-node awareness is designed in from v1, not retrofitted. The engine talks to the frontend over WebSocket through wabi-server, using a topic-subscription grammar with BSATN or JSON framing. There is no WASM, no V8, no module lifecycle, no energy metering, no SQL interface, no third-party database substrate, no generic "database server" posture. It is a custom state engine for a specific application, owning its storage format.

**Invariants this design commits to (all enforced in v1, no version splits):**

- Every committed mutation has exactly one entry in the global commit index.
- Every durable event is replayable until retention removes it.
- Ephemeral events are never written to disk; the `EmissionDurability` enum is a compile-time boundary.
- Clients deduplicate by event ID and recover by snapshot/resume.
- Every external command is idempotent by `(caller, client_request_id)`.
- Every topic has an explicit ACL and snapshot contract.
- Every table has canonical ID types and foreign keys.
- Every blob referenced by DB has been fsynced before DB commit.
- Migration rollback is only safe before WabiDB accepts exclusive writes, unless dual-write or reverse-delta replay is enabled.
- No v1/v2 splits on functionality: encryption, ACL, idempotency, snapshot barriers, retention, helper-node protocol, addon primitive — all in v1.

---

## 2. The Architecture Overview

The system is layered into eleven distinct components. Each component lives in a named Rust module and exposes a small set of public types. The top-to-bottom flow: a command arrives, gets sequenced, written to per-stream log segments, recorded in a global commit index, projected into materialized state, fanned out to subscribers, and bounded by retention. The boundary between components is a clean storage API surface; commands call domain methods, not segment files.

### 2.1 The Command Executor

**Crate:** `wabidb::commands`  
**Public types:** `Command`, `CommandCtx`, `CommandError`, `CommandRegistry`, `CommandCommit`

Commands are typed Rust functions. Each command receives a `CommandCtx` that provides:

```rust
pub struct CommandCtx<'a> {
    pub storage: &'a dyn WabiStore,        // domain-shaped storage API
    pub caller: CallerIdentity,            // who invoked this command
    pub timestamp: i64,                    // monotonic timestamp (micros since epoch)
    pub capabilities: CapabilitySet,       // what the caller is allowed to do
    pub idempotency_key: Option<String>,   // for retry-safe commands
    pub command_name: &'static str,
}
```

Each command returns `Result<CommandCommit, CommandError>`. The command produces a `CommandCommit` containing the events the command wants to publish. The commit sequencer (2.2) assigns a `commit_seq` and atomically persists the events to per-stream log segments and the global commit index. On failure, no commit occurs; on success, all events are durable before the command returns. This is the same atomicity model as STDB reducers, but without the WASM bridge overhead. The command registry is a `HashMap<&'static str, Box<dyn Fn(CommandCtx) -> Result<CommandCommit, CommandError>>>` populated at startup.

The command contract for every command:

- **Input schema** (typed Rust struct, validated at parse)
- **Auth rule** (capability check against `CallerIdentity`)
- **Idempotency** (via `command_idempotency` table keyed on `(caller_user_id, client_request_id)`)
- **DB mutations** (which tables, which streams)
- **Emitted events** (which topics, which payload)
- **Snapshot invalidation** (which subscriptions need a fresh snapshot)
- **Rate limits** (per caller, per command, per object)
- **Failure modes** (typed `CommandError` variants, retry-safe vs not)

### 2.2 The Commit Sequencer

**Crate:** `wabidb::sequencer`  
**Public types:** `CommitSequencer`, `CommitSeq`, `SequencerError`

The commit sequencer assigns a globally monotonic `commit_seq` to each `CommandCommit`. It is the single ordering point for all writes. Per-stream log segments (2.3) can be appended in parallel, but every committed event must obtain a `commit_seq` from this sequencer before the commit completes. The sequencer persists the assignment to the global commit index (2.4) atomically with the stream segment appends.

The sequencer protocol:

1. Receive a `CommandCommit` from a command.
2. Assign the next `commit_seq` (monotonic, no gaps in committed sequence).
3. Write each event payload to the correct stream segment via the stream log manager (2.3).
4. Append a global commit index entry referencing each stream record.
5. fsync the global commit index.
6. Return `commit_seq` to the caller.

If any step fails, the commit is rolled back: stream records written but not referenced by the commit index are orphans (ignored on recovery). The sequencer is the only component that may write to the global commit index.

### 2.3 The Stream Log Manager

**Crate:** `wabidb::stream_log`  
**Public types:** `StreamLog`, `StreamId`, `Segment`, `RecordHeader`, `StreamKeyRegistry`

The stream log manager owns per-stream payload segments. Each `StreamId` corresponds to one logical stream (a channel, a DM conversation, a whiteboard, etc.). Each stream has its own segment files on disk, its own encryption key, and its own retention boundary.

On-disk layout:

```
{data_dir}/
  global/
    commit-index/
      00000001.widx
      00000002.widx
  streams/
    channel/
      ch_01J.../
        events/
          00000001.wseg
          00000002.wseg
        snapshots/
          00000004.wsnap
    dm/
      dm_01J.../
        events/
          00000001.wseg
        snapshots/
          00000002.wsnap
    whiteboard/
      wb_01J.../
        patches/
          00000001.wseg
        snapshots/
          00000003.wsnap
  blobs/
    ab/
      abcd....bin
      abcd....meta
  manifests/
    storage-manifest.json
```

Stream segment record format:

```rust
struct RecordHeader {
    magic: [u8; 4],          // "WABI"
    format_version: u16,     // bump on incompatible format changes
    header_len: u16,         // length of this header
    record_kind: u16,        // event | snapshot | tombstone | checkpoint
    flags: u16,              // reserved
    commit_seq: u64,         // matches the global commit index entry
    stream_id_hash: [u8; 16], // BLAKE3 of stream_id, first 16 bytes
    payload_len: u32,        // length of payload
    header_crc32c: u32,      // CRC32C of header bytes
    payload_crc32c: u32,     // CRC32C of payload bytes
}
// followed by `payload_len` bytes of payload
```

The manager is responsible for: per-segment fsync ordering, segment rotation when a segment exceeds a size threshold (default 64 MiB), stream key management (key creation, rotation, destruction on retention), recovery (scan-and-truncate at first invalid record), and the per-stream encryption boundary.

A stream segment is **valid** iff its header magic matches, format version is supported, and both CRCs match. Recovery scans segments sequentially, truncates at the first invalid record, and resumes from the last valid offset.

### 2.4 The Global Commit Index

**Crate:** `wabidb::commit_index`  
**Public types:** `CommitIndex`, `CommitIndexEntry`, `StreamRef`

The global commit index is an append-only, fsync'd index that maps `commit_seq` to the stream records produced by that commit. It is the canonical ordering for subscriptions, replay, and recovery.

Schema (conceptually; the actual on-disk format is a sequence of records with CRCs):

```text
commit_index_entry:
  commit_seq:        u64
  timestamp:         i64
  caller:            CallerIdentityRef
  command_name:      string
  idempotency_key:   option<string>
  event_refs:        Vec<StreamRef>     // one per event in the commit
  payload_hashes:    Vec<[u8; 32]>      // BLAKE3 of each payload
```

Every `CommandCommit` produces exactly one `commit_index_entry` referencing every event in the commit. The index is the canonical stream of committed mutations. Replay reads the index and walks each `event_ref` to fetch the payload from the stream segment.

The recovery rule: **only records reachable from a valid global commit index entry are committed.** Orphaned stream records (no index entry) are ignored. Commit index entries pointing to missing or corrupt stream records are repairable from backup.

### 2.5 The Projection Engine

**Crate:** `wabidb::projections`  
**Public types:** `Projection`, `MaterializedState`, `ProjectionEngine`

The projection engine applies committed events to materialized state and maintains fixed access-path indexes. Materialized state is **derived**, never canonical. It can be rebuilt from snapshots plus post-snapshot commit index entries.

The projection model:

- An event arrives at the projection engine after the commit sequencer has recorded it.
- The engine looks up the projection handler for the event's `event_type`.
- The handler updates the relevant materialized state and indexes.
- The updated state is visible to subsequent reads.

Indexes are **named Wabi access paths**, not a query planner. Examples:

- `(channel_id, created_at) → message_id` for "last 50 messages in channel X"
- `(conversation_id, created_at) → dm_message_id`
- `(topic, commit_seq) → event_offset` for replay
- `(board_id, version) → patch_offset` for whiteboards
- `(user_id, commit_seq) → inbox_event_ref`
- `(blob_hash) → blob_metadata`

Each index is a small skiplist or B-tree, persisted as part of the materialized state. If a projection corrupts, the engine rebuilds from the last valid snapshot plus the post-snapshot commit index. The log is the source of truth; projections are disposable.

### 2.6 The Snapshot Manager

**Crate:** `wabidb::snapshots`  
**Public types:** `Snapshot`, `SnapshotManifest`, `SnapshotWriter`

The snapshot manager writes per-stream object snapshots that anchor the projection rebuild. A snapshot covers all events up to a specific `commit_seq`; replay resumes from `commit_seq + 1`.

Snapshot policy (default, configurable per stream):

- `channel_*` streams: snapshot every 10,000 events or every 24 hours, whichever comes first
- `dm_*` streams: snapshot every 1,000 events
- `whiteboard_*` streams: snapshot every 500 patches (whiteboards are patch-heavy)
- `kanban_*`, `notes_*`, `place_*` streams: snapshot every 5,000 events

A snapshot is itself a stream record (kind = `snapshot`) with a payload that contains the materialized state for the stream at the snapshot's `commit_seq`. Recovery loads the latest snapshot and replays events with `commit_seq > snapshot.commit_seq`.

### 2.7 The Retention/Compaction Engine

**Crate:** `wabidb::retention`  
**Public types:** `RetentionPolicy`, `RetentionClass`, `CompactionJob`, `StreamKeyRegistry`

The retention engine enforces per-stream retention policies and compacts segments. **Retention is per-stream, never per-global-segment.** This is the design that makes the privacy/deletion story work.

A retention policy is one of:

- `delete` — drop the stream's segments, destroy the stream's encryption key
- `redact` — keep the structure but zero out payload content (rare; usually `delete` is cleaner)
- `archive` — move segments to a colder storage tier (out of scope for v1)

When a stream's retention expires:

1. Drop all `events/*` segment files for the stream.
2. Drop all `snapshots/*` files older than the retention boundary.
3. Destroy the stream's encryption key from the `StreamKeyRegistry`.
4. Append a `tombstone` record to the stream's segment log (or to the global commit index) recording the destruction event for audit.
5. The commit index retains a tombstone entry that points to the destroyed stream; this entry is used by the storage CLI for `list-streams` and audit reporting.

The destructive semantics: even if disk bytes persist (filesystem caching, backup retention), key destruction makes the ciphertext unrecoverable. This is the cryptographic deletion primitive.

Compaction (separate from retention): periodically, the engine merges small segments within a stream into larger ones, removes no-longer-needed records, and rewrites the segment index. Compaction is internal to a stream; it does not cross stream boundaries.

### 2.8 The Subscription Engine

**Crate:** `wabidb::subscription`  
**Public types:** `SubscriptionManager`, `Subscriber`, `TopicFilter`, `SendWorker`, `ConsumerOffset`

The subscription engine delivers events to live subscribers (browser WebSocket clients) and to reliable consumers (helper nodes, search indexers, audit exporters). The two paths share the same event source (the global commit index) but have different delivery semantics.

**Live fanout (browsers):** in-memory, best-effort, resumable. Subscribers register a set of topic filters. When an event with a matching topic arrives, the engine enqueues it for delivery. A subscription includes a `snapshot_barrier: CommitSeq` (the `commit_seq` at the moment of subscription); only events with `commit_seq > barrier` are delivered. On reconnect, the client provides `resume_after: CommitSeq`; the engine replays matching events from the index. If the retention window has passed `resume_after`, the engine responds with `snapshot_required: true` and the client requests a fresh snapshot.

**Reliable consumers (helpers):** durable, replayable, checkpointed. Each consumer has a `(consumer_id, topic_pattern) → last_commit_seq` row in the `consumer_offsets` table. The consumer reads events with `commit_seq > last_commit_seq` in order, processes them, and updates its checkpoint transactionally with the work. If the helper is offline, the engine continues to commit events to the global commit index; on reconnect, the helper resumes from its checkpoint.

Every durable event appears in the global commit index exactly once. Replay uses the commit index, not the stream segments directly. The subscription engine owns the topic ACL (see Section 5) and the snapshot contract per topic (see Section 4.4).

### 2.9 The Ephemeral Bus

**Crate:** `wabidb::ephemeral`  
**Public types:** `EphemeralBus`, `EphemeralEvent`, `EmissionDurability`

The ephemeral bus carries events that are **never** written to disk. Call signals, typing indicators, cursor movement, voice presence, and any other event that must not survive a crash go through this bus.

The compile-time boundary is the `EmissionDurability` enum:

```rust
pub enum EmissionDurability {
    DurableEventLog,    // goes through the commit sequencer
    EphemeralMemoryOnly, // goes through the ephemeral bus only
}
```

The compiler prevents mixing the two. A command that produces `EmissionDurability::EphemeralMemoryOnly` events cannot include them in a `CommandCommit` (which is durable by definition). The runtime cannot route an `EphemeralMemoryOnly` event to the stream log manager; the type system rejects it.

**Ephemeral events are not replayable.** A client that reconnects after a crash does not see past ephemeral events. This is the contract: if you need replay, the event must be `DurableEventLog`. If you need "lost on crash, never persisted," the event is `EphemeralMemoryOnly`. There is no middle ground.

### 2.10 The Blob Store

**Crate:** `wabidb::blobs`  
**Public types:** `BlobStore`, `BlobHash`, `BlobRef`, `BlobMetadata`

The blob store holds content-addressed immutable files: file attachments, image thumbnails, audio clips, video frames, large whiteboard snapshots, CAD geometry. Blobs are stored under their BLAKE3 hash. The blob store is **not** a generic filesystem; it is a key-value store keyed by hash, with size, MIME type, ref count, and encryption key id as metadata.

Blob write ordering (the order that makes backups consistent):

1. Write the blob to a temp file in the staging directory.
2. `fsync` the temp file.
3. Rename the temp file to its final hash path (atomic on POSIX).
4. `fsync` the directory.
5. Insert the `blob_refs` row referencing the hash.
6. Commit the transaction.

If step 5 or 6 fails, the blob is orphaned. The retention engine detects orphaned blobs (ref count = 0) and reaps them. If step 4 is not `fsync`d before step 5, a crash can leave the DB referencing a blob that doesn't exist on disk; the manifest-based backup will catch this on restore.

### 2.11 The Storage CLI

**Crate:** `wabidb::cli` (binary: `wabidb`)  
**Public types:** N/A (operator-facing tools)

SQLite gives operators a CLI for inspection, backup, recovery, and schema queries. WabiDB's custom storage needs its own operator-facing tools, because a black-box storage layer is not acceptable for a self-hosted product. The CLI is a separate binary (`wabidb`) that operators run against the data directory.

Commands:

- `wabidb check` — verify the global commit index, all stream segments, all blob references. Reports inconsistencies. Does not modify.
- `wabidb dump-stream <stream_id>` — print all events in a stream, newest first, in BSATN or JSON.
- `wabidb inspect-commit <commit_seq>` — show the commit index entry, all event refs, payload hashes, and stream record locations.
- `wabidb rebuild-indexes` — drop and rebuild all projection indexes from snapshots + commit index. Used after a projection corruption.
- `wabidb compact <stream_id>` — force-compact a stream's segments.
- `wabidb verify-backup <manifest>` — verify a backup manifest against the live data directory.
- `wabidb recover` — replay the commit index, rebuild projections, validate all stream records, output a recovery report.
- `wabidb list-streams` — list all streams with their kind, key id, retention policy, and size.
- `wabidb export <stream_id> --format=json` — export a stream for migration or debugging.

The CLI is not optional. It is the operator interface to the storage layer and must be built in v1.

### 2.12 The Connection to Wabi-Server

**Crate:** `wabidb::server_api`  
**Public types:** `WabiState` trait (see Section 10), `ServerConnection`

Wabi-server embeds the engine as a crate dependency. It calls the `WabiState` trait methods directly — no HTTP, no RPC, no IPC in the embedded mode. In sibling-process mode, the same trait is exposed over a Unix domain socket using a BSATN-framed request/response protocol. The frontend never talks to the engine directly; it always goes through wabi-server, which translates WebSocket topic events into engine commands and engine events into WebSocket frames.

The `WabiState` trait is the boundary that keeps the engine's domain methods clean. Commands call `ctx.storage.append_commit(commit)`, `ctx.storage.get_channel_messages(channel_id, before, limit)`, `ctx.storage.get_whiteboard_snapshot(board_id)`, `ctx.storage.get_events_after(topic, seq, limit)`. They do not know about segment files, offsets, fsync, manifests, or index compaction. The storage layer is replaceable behind the trait; the engine is not.

---

## 3. The Data Model

This section enumerates every projection table in the durable committed state. Recall: the **canonical store is the per-stream event log + global commit index** (Section 2). The projection tables are derived state, rebuilt from the log. The schema here is the projection layout.

The schema is driven by the existing Wabi frontend code — if the frontend has a field, the projection has it. Each entry lists: table name, columns, indexes, relationships, retention class, encryption posture, and access control.

**Conventions used in this section:**

- **`user_id` is always `INTEGER REFERENCES users(id)`.** The previous design had a mix of INTEGER and TEXT for user IDs; the corrected design standardizes on INTEGER with `users.id` as the source of truth.
- **`{stream_id}` is always a ULID or UUIDv7 string with no colons.** Topic grammar uses `:` as a separator; colons in stream ids would break parsing. The storage layer rejects `StreamId` values containing colons.
- **`expires_at INTEGER` columns are added to all user-data tables** for per-row TTL via the retention engine. Indexed where the retention reaper queries them.
- **`created_by` is `INTEGER REFERENCES users(id)`** (not TEXT), to match the standard user id type.

### 3.1 Users, Sessions, Devices, Keys

**Table: `users`**

```sql
CREATE TABLE users (
    id              INTEGER PRIMARY KEY,                       -- monotonic, server-issued
    username        TEXT NOT NULL UNIQUE,
    username_lc     TEXT NOT NULL UNIQUE,                       -- lowercase for case-insensitive lookup
    handle          TEXT,                                        -- optional @handle
    handle_lc       TEXT UNIQUE,
    display_name    TEXT,
    avatar_url      TEXT,
    banner_url      TEXT,
    status          TEXT NOT NULL DEFAULT 'offline'
                    CHECK(status IN ('online','idle','dnd','offline')),
    active          INTEGER NOT NULL DEFAULT 1,
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER                                     -- for tombstoned users
);

CREATE INDEX idx_users_username_lc ON users(username_lc);
CREATE INDEX idx_users_handle_lc ON users(handle_lc) WHERE handle_lc IS NOT NULL;
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_expires ON users(expires_at) WHERE expires_at IS NOT NULL;
```

Retention: Durable. Encryption: none (usernames and handles are public within the server). Access: server admin creates; all members read; user self-updates.

Prior art: `StateUser` at `wabi_state_bridge/src/lib.rs:141-152` carries the same fields (username, username_lc, handle, handle_lc, active, deleted) plus a generic `row_json` blob. WabiDB replaces the blob with fixed columns.

**Table: `user_credentials`**

```sql
CREATE TABLE user_credentials (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash   TEXT NOT NULL,            -- Argon2id hash; never plaintext
    password_alg    TEXT NOT NULL,            -- 'argon2id-v1'
    updated_at      INTEGER NOT NULL
);
```

Required because the prior `register_user` command took `password_hash` but had no storage table. Argon2id parameters: t=3, m=64MB, p=1. The hash is the only thing stored; the password itself never touches the engine. The engine does not need to validate passwords (the wabi-server's auth layer does), but the engine persists the hash for durability.

**Table: `sessions`**

```sql
CREATE TABLE sessions (
    session_id           TEXT PRIMARY KEY,                       -- ULID
    user_id              INTEGER NOT NULL REFERENCES users(id),
    session_token_hash   BLOB NOT NULL UNIQUE,                  -- BLAKE3(raw_token); raw token never stored
    expires_at           INTEGER NOT NULL,                       -- 30 days default
    revoked_at           INTEGER,
    created_at           INTEGER NOT NULL,
    last_seen_at         INTEGER,
    user_agent           TEXT,                                    -- for security audit
    ip_address           TEXT
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at) WHERE expires_at IS NOT NULL;
```

Retention: Session. The raw session token is **never** stored; only its BLAKE3 hash. The token is shown to the user once at creation and at refresh. Sessions auto-expire (TTL reaper) or are explicitly revoked. The prior design stored `session_id` and `expires_at` only — the corrected design stores the token hash, not the token.

**Table: `ws_tickets`**

```sql
CREATE TABLE ws_tickets (
    ticket_hash        BLOB PRIMARY KEY,                         -- BLAKE3(raw_ticket)
    caller_user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at         INTEGER NOT NULL,                         -- 15 seconds
    used               INTEGER NOT NULL DEFAULT 0,
    used_at            INTEGER,
    created_at         INTEGER NOT NULL
);

CREATE INDEX idx_ws_tickets_expires ON ws_tickets(expires_at) WHERE used = 0;
```

One-time WebSocket tickets (Section 10.2). The raw ticket is sent to the client once; only the hash is stored. Redemption is atomic via `UPDATE ... WHERE used = 0 AND expires_at > ?` — single row affected or fail.

**Table: `devices`**

```sql
CREATE TABLE devices (
    device_id                TEXT PRIMARY KEY,                    -- ULID, server-issued
    user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name              TEXT,
    device_type              TEXT,                                 -- 'desktop', 'mobile', 'web'
    identity_key_public      BLOB NOT NULL,                        -- X25519, 32 bytes
    signed_prekey_public     BLOB NOT NULL,                        -- X25519, 32 bytes
    signed_prekey_id         INTEGER NOT NULL,                     -- monotonic, rotation increments
    signed_prekey_signature  BLOB NOT NULL,                        -- Ed25519 over signed_prekey
    one_time_prekey_count    INTEGER NOT NULL DEFAULT 0,           -- remaining OTPs in the pool
    last_seen_at             INTEGER,
    revoked_at               INTEGER,
    created_at               INTEGER NOT NULL
);

CREATE INDEX idx_devices_user_id ON devices(user_id);
```

Per-device key material. Identity key, signed prekey, and prekey signature are required (Section 6.1). The `one_time_prekey_count` tracks the remaining pool size; the engine tops up when it drops below 20. **Private keys are never stored** (P0-4 fix to the previous "server stores only public keys, never private keys" claim — the corrected design has the server hold the prekey signature for verification).

**Table: `device_pinned_keys`**

```sql
CREATE TABLE device_pinned_keys (
    user_id              INTEGER NOT NULL,
    device_id            TEXT NOT NULL,
    pinned_identity_key  BLOB NOT NULL,                            -- 32 bytes
    pinned_signed_prekey BLOB NOT NULL,                            -- 32 bytes + id
    pinned_at            INTEGER NOT NULL,
    verified_by_user     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, device_id)
);
```

Trust-on-first-use key pinning (Section 6.5). The client stores the peer's public keys on first contact; subsequent contacts verify the keys haven't changed. If they have, the client UI shows a "key change" warning.

**Table: `device_key_backup`**

```sql
CREATE TABLE device_key_backup (
    user_id              INTEGER NOT NULL,
    device_id            TEXT NOT NULL,
    wrapped_blob         BLOB NOT NULL,                            -- passphrase-encrypted identity private key
    salt                 BLOB NOT NULL,                            -- Argon2id salt
    kdf_params           TEXT NOT NULL,                            -- JSON: { t, m, p, version }
    wrap_alg             TEXT NOT NULL,                            -- 'aes-256-gcm'
    wrap_nonce           BLOB NOT NULL,
    created_at           INTEGER NOT NULL,
    rotated_from         TEXT,                                     -- previous device_id (for key rotation history)
    PRIMARY KEY (user_id, device_id)
);
```

Optional user-opt-in key escrow (Section 6.7). The wrapped blob is encrypted client-side with a passphrase-derived key; the server cannot unwrap it. If the user forgets the passphrase, the blob is unreadable.

**Table: `identity_keys`**

```sql
CREATE TABLE identity_keys (
    user_id             INTEGER PRIMARY KEY REFERENCES users(id),
    signing_key         BLOB NOT NULL,                             -- Ed25519 public key
    key_fingerprint     TEXT NOT NULL UNIQUE,
    rotated_at          INTEGER NOT NULL
);
```

Per-user identity signing key (Ed25519, separate from per-device X25519 identity keys). Used for signing operations that span devices. Retention: durable (even past user deletion for message verification).

### 3.2 Channels and Channel Members

**Table: `channels`**

```sql
CREATE TABLE channels (
    channel_id      TEXT PRIMARY KEY,                              -- ULID; not "text:general"
    channel_type    TEXT NOT NULL
                    CHECK(channel_type IN ('text','voice','forum','gallery','wiki','stage','announcement')),
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      INTEGER NOT NULL,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    archived        INTEGER NOT NULL DEFAULT 0,
    auto_delete_ms  INTEGER,                                       -- auto-delete messages older than this
    min_role        TEXT,                                            -- minimum role to read
    is_private      INTEGER NOT NULL DEFAULT 0,
    parent_id       TEXT,                                            -- for threads / breakout rooms
    sort_order      INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER                                         -- for deleted channels (tombstone)
);

CREATE INDEX idx_channels_type ON channels(channel_type);
CREATE INDEX idx_channels_parent ON channels(parent_id) WHERE parent_id IS NOT NULL;
```

**Critical fix:** `channel_id` is a ULID, not a string with colons like `"text:general"`. The previous design used human-readable channel names that broke topic grammar (the topic `channel:general:messages` is ambiguous with the channel id `text:general`). The corrected design uses opaque IDs and exposes `name` as a separate display field.

`created_by` is `INTEGER REFERENCES users(id)` (was `TEXT` in the previous design). The previous inconsistency — `users.id` is INTEGER but `channels.created_by` is TEXT — is corrected.

Retention: Durable. Encryption: none. Access: server admin creates/archives; members read.

Prior art: `StateChannel` at `wabi_state_bridge/src/lib.rs:112-123`.

**Table: `channel_members`**

```sql
CREATE TABLE channel_members (
    channel_id      TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member'
                    CHECK(role IN ('owner','admin','moderator','member')),
    joined_at       INTEGER NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_cm_user_id ON channel_members(user_id);
CREATE INDEX idx_cm_active ON channel_members(channel_id) WHERE active = 1;
```

Retention: Durable. Access: server admin manages; members read.

Prior art: `StateChannelMember` at `wabi_state_bridge/src/lib.rs:126-137`.

### 3.3 Messages and Reactions

**Table: `messages`**

```sql
CREATE TABLE messages (
    message_id          TEXT PRIMARY KEY,                          -- ULID
    channel_id          TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    sender_id           INTEGER NOT NULL REFERENCES users(id),
    content             TEXT NOT NULL,                              -- the message body (plain text or JSON for rich)
    content_alg         TEXT,                                        -- for future encrypted-channel support
    created_at          INTEGER NOT NULL,
    edited_at           INTEGER,
    deleted             INTEGER NOT NULL DEFAULT 0,
    deleted_at          INTEGER,
    reply_to            TEXT,                                        -- parent message id
    is_pinned           INTEGER NOT NULL DEFAULT 0,
    is_spoiler          INTEGER NOT NULL DEFAULT 0,
    expires_at          INTEGER,                                     -- per-channel auto-delete
    client_message_id   TEXT                                         -- idempotency key from client
);

CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_deleted ON messages(deleted) WHERE deleted = 1;
CREATE INDEX idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_messages_client_msg_id ON messages(channel_id, client_message_id)
    WHERE client_message_id IS NOT NULL;
```

**Critical fix:** `sender_id` is `INTEGER REFERENCES users(id)` (was `TEXT` in the previous design). The user-id type is now consistent.

**Critical fix:** `reactions_json` is removed. Reactions are stored in a canonical `reactions` table (below). The previous duplication — `messages.reactions_json` plus a `reactions` table — was a data integrity hazard. The corrected design has only the canonical `reactions` table; aggregations for the wire format are computed at read time.

**Critical fix:** `embed_url`, `gif_url`, `file_url`, `file_name`, `file_size`, `mime_type` are removed from `messages` and moved to a canonical `message_attachments` table (below). Attachments are content-addressed blobs with their own metadata.

**Critical fix:** FTS5 is removed. The previous design had a `messages_fts` virtual table. The corrected design uses the search helper node (Section 5.12) for full-text search, with engine-side fallback to a substring scan. The engine has no built-in FTS5 because the engine no longer uses SQLite.

Retention: Durable (or `auto_delete_ms` per channel). Encryption: none (channel messages are server-readable; DMs use separate tables). Access: channel members read; sender edits/deletes; server admin may delete any.

Prior art: `StateMessage` at `wabi_state_bridge/src/lib.rs:98-109`.

**Table: `message_attachments`**

```sql
CREATE TABLE message_attachments (
    attachment_id    TEXT PRIMARY KEY,                              -- ULID
    message_id       TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    blob_hash        BLOB NOT NULL,                                  -- BLAKE3, 32 bytes; references blob store
    file_name        TEXT,
    mime_type        TEXT,
    file_size        INTEGER NOT NULL,
    width            INTEGER,                                        -- for image/video
    height           INTEGER,
    duration_ms      INTEGER,                                        -- for audio/video
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
);

CREATE INDEX idx_message_attachments_message ON message_attachments(message_id);
CREATE INDEX idx_message_attachments_blob ON message_attachments(blob_hash);
```

The canonical attachments table. The blob bytes live in the content-addressed blob store (Section 11.6). The `blob_hash` is the foreign key to the blob store. The previous design had `messages.file_url` / `file_name` / `mime_type` etc. — these are removed and consolidated here.

**Table: `reactions`**

```sql
CREATE TABLE reactions (
    message_id      TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    emoji_id        TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji_id)
);

CREATE INDEX idx_reactions_message ON reactions(message_id);
CREATE INDEX idx_reactions_user ON reactions(user_id);
```

The canonical reactions table (replaces the previous `messages.reactions_json` duplicate). Aggregations for the wire format (e.g., `{"👍": [user_id, user_id, ...]}`) are computed at read time by the projection engine.

### 3.4 DM Conversations and DM Messages (Encrypted)

The DM schema is the v1 envelope encryption model (Section 6). Per-recipient ciphertexts are no longer in `dm_messages`; they're in `dm_message_recipients`, one row per (recipient user, recipient device).

**Table: `dm_conversations`**

```sql
CREATE TABLE dm_conversations (
    conversation_id TEXT PRIMARY KEY,                              -- ULID
    user_a          INTEGER NOT NULL REFERENCES users(id),         -- canonical: smaller user id first
    user_b          INTEGER NOT NULL REFERENCES users(id),         -- canonical: larger user id second
    created_at      INTEGER NOT NULL,
    last_message_at INTEGER,
    active          INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_a, user_b)
);

CREATE INDEX idx_dm_user_a ON dm_conversations(user_a);
CREATE INDEX idx_dm_user_b ON dm_conversations(user_b);
```

**Critical fix:** `conversation_id` is a ULID. The previous design used canonical `"{user_a}:{user_b}"` strings, which broke topic grammar. The corrected design uses opaque conversation ids and the `(user_a, user_b)` pair as the canonical key (with `user_a < user_b` to ensure a single ordering).

**Table: `dm_messages`**

```sql
CREATE TABLE dm_messages (
    message_id          TEXT PRIMARY KEY,                          -- ULID
    conversation_id     TEXT NOT NULL REFERENCES dm_conversations(conversation_id) ON DELETE CASCADE,
    sender_user_id      INTEGER NOT NULL REFERENCES users(id),
    sender_device_id    TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    expires_at          INTEGER,                                     -- union of per-user retention policies
    body_ciphertext     BLOB NOT NULL,                                -- AES-256-GCM with random message key
    body_nonce          BLOB NOT NULL,                                -- 12 bytes
    body_alg            TEXT NOT NULL,                                -- e.g., 'x3dh-aes-256-gcm-v1'
    deleted             INTEGER NOT NULL DEFAULT 0,
    deleted_at          INTEGER,
    client_message_id   TEXT                                         -- idempotency
);

CREATE INDEX idx_dm_msgs_conversation ON dm_messages(conversation_id, created_at DESC);
CREATE INDEX idx_dm_msgs_expires ON dm_messages(expires_at) WHERE expires_at IS NOT NULL;
```

**Critical fix:** The body is encrypted **once** with a random message key (not twice with per-user derived keys as in the previous design). The message key is then wrapped per-recipient-device in `dm_message_recipients`. This is the Sesame pattern (Section 6.4).

**Table: `dm_message_recipients`**

```sql
CREATE TABLE dm_message_recipients (
    message_id           TEXT NOT NULL REFERENCES dm_messages(message_id) ON DELETE CASCADE,
    user_id              INTEGER NOT NULL REFERENCES users(id),
    device_id            TEXT NOT NULL REFERENCES devices(device_id),
    wrapped_message_key  BLOB NOT NULL,                                -- encrypted with the ratchet session key for this device
    wrap_nonce           BLOB NOT NULL,                                -- 12 bytes
    wrap_alg             TEXT NOT NULL,                                -- e.g., 'ratchet-aes-256-gcm-v1'
    consumed             INTEGER NOT NULL DEFAULT 0,                    -- 1 if the device has read it
    consumed_at          INTEGER,
    PRIMARY KEY (message_id, user_id, device_id)
);

CREATE INDEX idx_dm_recipients_user ON dm_message_recipients(user_id, device_id);
```

The per-device wrapped message keys. For each authorized recipient device, the sender wraps the random message key with that device's Double Ratchet session key. The recipient device unwraps with its ratchet to recover the message key, then decrypts the body.

**Table: `friends`**

```sql
CREATE TABLE friends (
    friendship_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a          INTEGER NOT NULL REFERENCES users(id),
    user_b          INTEGER NOT NULL REFERENCES users(id),
    tier            TEXT NOT NULL DEFAULT 'friend'
                    CHECK(tier IN ('friend','close_friend','family','acquaintance')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','accepted','blocked')),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE(user_a, user_b)
);

CREATE INDEX idx_friends_user_a ON friends(user_a);
CREATE INDEX idx_friends_user_b ON friends(user_b);
```

**Table: `friend_requests`**

```sql
CREATE TABLE friend_requests (
    request_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user       INTEGER NOT NULL REFERENCES users(id),
    to_user         INTEGER NOT NULL REFERENCES users(id),
    message         TEXT,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER,                                         -- 14 days default
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','accepted','declined','expired'))
);

CREATE INDEX idx_friend_requests_to FROM friend_requests(to_user) WHERE status = 'pending';
CREATE INDEX idx_friend_requests_expires ON friend_requests(expires_at) WHERE expires_at IS NOT NULL;
```

### 3.5 Calls

**Table: `call_sessions`**

```sql
CREATE TABLE call_sessions (
    session_id          TEXT PRIMARY KEY,                              -- ULID
    channel_id          TEXT NOT NULL REFERENCES channels(channel_id),
    call_type           TEXT NOT NULL
                        CHECK(call_type IN ('voice','video','screen_share')),
    host_user_id        INTEGER NOT NULL REFERENCES users(id),
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    transport           TEXT NOT NULL DEFAULT 'webrtc'
                        CHECK(transport IN ('webrtc','sfu')),
    max_participants    INTEGER NOT NULL DEFAULT 0,                     -- 0 = unlimited
    active              INTEGER NOT NULL DEFAULT 1,
    expires_at          INTEGER                                         -- 24 hours after ended_at
);

CREATE INDEX idx_call_sessions_channel ON call_sessions(channel_id);
CREATE INDEX idx_call_sessions_expires ON call_sessions(expires_at) WHERE expires_at IS NOT NULL;
```

**Table: `call_participants`**

```sql
CREATE TABLE call_participants (
    participant_key TEXT PRIMARY KEY,                                  -- "{session_id}:{user_id}"
    session_id      TEXT NOT NULL REFERENCES call_sessions(session_id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    joined_at       INTEGER NOT NULL,
    left_at         INTEGER,
    is_host         INTEGER NOT NULL DEFAULT 0,
    muted           INTEGER NOT NULL DEFAULT 0,
    video_enabled   INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER                                             -- session class
);

CREATE INDEX idx_cp_session ON call_participants(session_id);
```

**Note on `call_signals`:** The previous design had a `call_signals` table for live SDP/ICE/DTLS signaling. The corrected design has no such table — call signals use `EmissionDurability::EphemeralMemoryOnly` (Section 2.9) and never touch the disk. The ephemeral bus handles SDP exchange, ICE candidates, codec negotiation, and DTLS handshakes.

### 3.6 Whiteboards

The whiteboard schema now has explicit source-of-truth versioning (P1-7 fix).

**Table: `whiteboards`**

```sql
CREATE TABLE whiteboards (
    board_id        TEXT PRIMARY KEY,                                  -- ULID
    scope_type      TEXT NOT NULL DEFAULT 'channel'
                    CHECK(scope_type IN ('channel')),
    scope_id        TEXT NOT NULL,                                     -- channel_id
    version         INTEGER NOT NULL DEFAULT 0,                         -- current authoritative version
    is_private      INTEGER NOT NULL DEFAULT 0,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    updated_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER
);

CREATE INDEX idx_whiteboards_scope ON whiteboards(scope_type, scope_id);
```

**Table: `whiteboard_layers`**

```sql
CREATE TABLE whiteboard_layers (
    layer_id        TEXT NOT NULL,
    board_id        TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL
                    CHECK(kind IN ('content','reference','background')),
    visible         INTEGER NOT NULL DEFAULT 1,
    locked          INTEGER NOT NULL DEFAULT 0,
    opacity         REAL NOT NULL DEFAULT 1.0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (board_id, layer_id)
);
```

**Table: `whiteboard_elements`**

```sql
CREATE TABLE whiteboard_elements (
    element_id      TEXT NOT NULL,
    board_id        TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
    layer_id        TEXT NOT NULL,
    type            TEXT NOT NULL
                    CHECK(type IN ('stroke','line','rect','ellipse','arrow','text','image')),
    x               REAL NOT NULL,
    y               REAL NOT NULL,
    width           REAL NOT NULL DEFAULT 0,
    height          REAL NOT NULL DEFAULT 0,
    rotation        REAL NOT NULL DEFAULT 0,
    z_index         INTEGER NOT NULL DEFAULT 0,
    opacity         REAL NOT NULL DEFAULT 1.0,
    stroke_color    TEXT,
    stroke_width    REAL NOT NULL DEFAULT 2,
    fill_color      TEXT,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    updated_at      INTEGER NOT NULL,
    locked          INTEGER NOT NULL DEFAULT 0,
    points_json     TEXT,                                                -- for stroke elements
    text            TEXT,                                                -- for text elements
    font_size       REAL,
    font_family     TEXT,
    text_align      TEXT,
    border_radius   REAL,
    arrow_head      TEXT,
    image_src       TEXT,
    image_asset_id  TEXT,
    image_mime      TEXT,
    image_natural_w INTEGER,
    image_natural_h INTEGER,
    PRIMARY KEY (board_id, element_id)
);
```

**Table: `whiteboard_patches` (append-only log with source-of-truth version)**

```sql
CREATE TABLE whiteboard_patches (
    patch_id        TEXT PRIMARY KEY,                                    -- ULID
    board_id        TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    op              TEXT NOT NULL,                                       -- 'create','update','delete','reorder','layer:*','replace'
    payload_json    TEXT NOT NULL,
    base_version    INTEGER NOT NULL,                                    -- view of the board when the patch was created
    result_version  INTEGER NOT NULL,                                    -- view after this patch is applied (base + 1)
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER,                                               -- per-stream patch retention
    client_request_id TEXT                                                -- idempotency
);

CREATE INDEX idx_wb_patches_board_created ON whiteboard_patches(board_id, created_at DESC);
CREATE INDEX idx_wb_patches_board_version ON whiteboard_patches(board_id, result_version);
CREATE UNIQUE INDEX idx_wb_patch_version ON whiteboard_patches(board_id, result_version);
CREATE INDEX idx_wb_patches_expires ON whiteboard_patches(expires_at) WHERE expires_at IS NOT NULL;
```

**Critical fix (P1-7):** The whiteboard now has explicit source-of-truth versioning. Every patch declares `base_version` (what the client thought the board looked like) and `result_version` (what it looks like after the patch). The unique index on `(board_id, result_version)` prevents version conflicts. If a client's `base_version` is older than the server's current version, the server rejects the patch with `CommandError::Conflict` (Section 4.3).

**Table: `whiteboard_snapshots`**

```sql
CREATE TABLE whiteboard_snapshots (
    board_id        TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    document_json   TEXT NOT NULL,                                       -- full serialized state
    covers_through_patch_id TEXT NOT NULL,                              -- last patch included in this snapshot
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (board_id, version)
);
```

The canonical snapshot of the whiteboard at `version`. The snapshot manager writes these periodically (every 10,000 events or 24 hours, whichever comes first). Subscribers that join after a snapshot receive the snapshot first, then any subsequent patches.

**Table: `whiteboard_history`**

```sql
CREATE TABLE whiteboard_history (
    history_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id        TEXT NOT NULL REFERENCES whiteboards(board_id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    document_json   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER                                              -- 1 year default
);

CREATE INDEX idx_wb_history_board ON whiteboard_history(board_id, created_at DESC);
```

Daily history snapshots for audit / rollback. Kept for 1 year by default.

### 3.7 Maps and Places

**Table: `places`**

```sql
CREATE TABLE places (
    place_id        TEXT PRIMARY KEY,                                    -- ULID
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    aliases_json    TEXT,
    building        TEXT,
    floor           TEXT,
    lat             REAL,
    lon             REAL,
    description     TEXT,
    model_url       TEXT,
    map_image_url   TEXT,                                                  -- NEW: from PlaceRecord.mapImageUrl
    map_rotation    REAL DEFAULT 0,                                       -- NEW: from PlaceRecord.mapRotation
    poi_theme_preset TEXT DEFAULT 'classic',
    tags_json       TEXT,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER
);

CREATE INDEX idx_places_slug ON places(slug);
```

**Critical fix (P0-5):** The previous `places` table was missing `map_image_url` and `map_rotation`, even though the frontend `PlaceRecord` at `placeRegistry.ts:17-34` had them. The corrected design includes both.

**Table: `place_layers`**

```sql
CREATE TABLE place_layers (
    layer_id        TEXT NOT NULL,
    place_id        TEXT NOT NULL REFERENCES places(place_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    floor           TEXT,
    image_url       TEXT NOT NULL,
    rotation        REAL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (place_id, layer_id)
);
```

**Table: `place_pois`**

```sql
CREATE TABLE place_pois (
    poi_id          TEXT NOT NULL,
    place_id        TEXT NOT NULL REFERENCES places(place_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    x               REAL NOT NULL,
    y               REAL NOT NULL,
    layer_id        TEXT,
    description     TEXT,
    render_mode     TEXT NOT NULL DEFAULT 'both',
    theme_preset    TEXT,
    icon_preset     TEXT DEFAULT 'pin',
    icon_glyph      TEXT,
    icon_color      TEXT,
    PRIMARY KEY (place_id, poi_id)
);
```

**Table: `place_drafts`**

```sql
CREATE TABLE place_drafts (
    draft_id        TEXT PRIMARY KEY,                                    -- ULID
    place_id        TEXT,
    draft_json      TEXT NOT NULL,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER                                              -- 7 days default
);
```

**Table: `place_assets`**

```sql
CREATE TABLE place_assets (
    asset_id        TEXT PRIMARY KEY,                                    -- ULID
    place_id        TEXT NOT NULL REFERENCES places(place_id) ON DELETE CASCADE,
    blob_hash       BLOB NOT NULL,                                       -- BLAKE3, references blob store
    file_name       TEXT,
    mime_type       TEXT,
    file_size       INTEGER,
    width           INTEGER,
    height          INTEGER,
    uploaded_by     INTEGER NOT NULL REFERENCES users(id),
    uploaded_at     INTEGER NOT NULL
);

CREATE INDEX idx_place_assets_place ON place_assets(place_id);
```

**Critical fix:** `url` is replaced with `blob_hash` (the BLAKE3 content-addressed blob reference). The previous `place_assets.url` was ambiguous about whether it was an external URL or a stored path; the corrected design uses the canonical blob store.

### 3.8 Notes

**Table: `notes`**

```sql
CREATE TABLE notes (
    note_id         TEXT PRIMARY KEY,                                    -- ULID
    owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type      TEXT NOT NULL
                    CHECK(scope_type IN ('keep','dm','scratchpad')),
    scope_id        TEXT,                                                -- dm channel id or null for keep
    text            TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER                                              -- for scratchpad scope
);

CREATE INDEX idx_notes_owner_scope ON notes(owner_id, scope_type, scope_id);
```

**Table: `note_versions`**

```sql
CREATE TABLE note_versions (
    version_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id         TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
    text            TEXT NOT NULL,
    saved_at        INTEGER NOT NULL,
    expires_at      INTEGER                                              -- keep last 50 versions
);

CREATE INDEX idx_nv_note ON note_versions(note_id, saved_at DESC);
```

### 3.9 Business: Kanban, Tasks, Projects, Sprints, Calendar, Diary

**Table: `kanban_boards`**

```sql
CREATE TABLE kanban_boards (
    board_id        TEXT PRIMARY KEY,                                    -- ULID
    name            TEXT NOT NULL,
    scope_type      TEXT NOT NULL,
    scope_id        TEXT NOT NULL,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER
);
```

**Table: `kanban_tasks`**

```sql
CREATE TABLE kanban_tasks (
    task_id         TEXT PRIMARY KEY,                                    -- ULID
    board_id        TEXT NOT NULL REFERENCES kanban_boards(board_id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'todo'
                    CHECK(status IN ('ideas','todo','in_progress','done','scrapped','archived')),
    priority        TEXT NOT NULL DEFAULT 'medium'
                    CHECK(priority IN ('low','medium','high','urgent')),
    estimated_min   INTEGER,
    due_date        INTEGER,
    tags_json       TEXT,                                                  -- NEW: from Todo.tags
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    assigned_to     INTEGER REFERENCES users(id),
    project_id      TEXT,
    completed_at    INTEGER,
    sort_order      INTEGER,
    expires_at      INTEGER
);

CREATE INDEX idx_kt_board_status ON kanban_tasks(board_id, status, sort_order);
CREATE INDEX idx_kt_assigned ON kanban_tasks(assigned_to);
```

**Critical fix (P0-5):** `tags_json` is added. The frontend `Todo` type at `shared/businessContracts.ts:27-44` has `tags: string[]`, but the previous design's `kanban_tasks` table was missing this field.

**Table: `kanban_columns`**

```sql
CREATE TABLE kanban_columns (
    board_id        TEXT NOT NULL REFERENCES kanban_boards(board_id) ON DELETE CASCADE,
    column_id       TEXT NOT NULL,
    label           TEXT NOT NULL,
    color           TEXT NOT NULL,
    visible         INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, column_id)
);
```

**Table: `projects`**

```sql
CREATE TABLE projects (
    project_id      TEXT PRIMARY KEY,                                    -- ULID
    name            TEXT NOT NULL,
    description     TEXT,
    color           TEXT NOT NULL DEFAULT '#6366f1',
    created_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    start_date      INTEGER,
    target_end_date INTEGER,
    status          TEXT NOT NULL DEFAULT 'planning'
                    CHECK(status IN ('planning','active','paused','completed','cancelled')),
    parent_id       TEXT,
    visibility      TEXT DEFAULT 'public',
    expires_at      INTEGER
);
```

**Table: `sprints`**

```sql
CREATE TABLE sprints (
    sprint_id       TEXT PRIMARY KEY,                                    -- ULID
    project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    start_date      INTEGER NOT NULL,
    end_date        INTEGER NOT NULL,
    goals_json      TEXT,
    status          TEXT NOT NULL DEFAULT 'planned'
                    CHECK(status IN ('planned','active','completed')),
    expires_at      INTEGER
);
```

**Table: `calendar_events`**

```sql
CREATE TABLE calendar_events (
    event_id            TEXT PRIMARY KEY,                                -- ULID
    title               TEXT NOT NULL,
    description         TEXT,
    start_date          INTEGER NOT NULL,
    end_date            INTEGER,
    all_day             INTEGER NOT NULL DEFAULT 0,
    color               TEXT,
    created_by          INTEGER NOT NULL REFERENCES users(id),
    recurring_json      TEXT,
    reminders_json      TEXT,
    cancelled_dates_json TEXT,
    visibility          TEXT DEFAULT 'public',
    expires_at          INTEGER
);
```

**Table: `diary_entries`**

```sql
CREATE TABLE diary_entries (
    entry_id        TEXT PRIMARY KEY,                                    -- ULID
    date            INTEGER NOT NULL,
    content         TEXT NOT NULL,
    mood            TEXT,
    images_json     TEXT,
    tags_json       TEXT,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    is_private      INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER
);
```

**Table: `business_resources`**

```sql
CREATE TABLE business_resources (
    resource_id     TEXT PRIMARY KEY,                                    -- ULID
    type            TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    storage_type    TEXT NOT NULL
                    CHECK(storage_type IN ('inline','upload','external')),
    content         TEXT,
    blob_hash       BLOB,                                                  -- NEW: blob store reference
    external_url    TEXT,
    file_size       INTEGER,
    mime_type       TEXT,
    preview         TEXT,
    tags_json       TEXT,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    is_encrypted    INTEGER NOT NULL DEFAULT 0,
    visibility_type TEXT DEFAULT 'public',
    min_role        TEXT,
    workspace_id    TEXT,
    expires_at      INTEGER
);
```

**Critical fix:** `file_url` is replaced with `blob_hash` (canonical blob store reference).

**Table: `business_tags`**

```sql
CREATE TABLE business_tags (
    tag_id          TEXT PRIMARY KEY,                                    -- ULID
    name            TEXT NOT NULL,
    color           TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);
```

**Table: `business_graph_edges`**

```sql
CREATE TABLE business_graph_edges (
    edge_id         TEXT PRIMARY KEY,                                    -- ULID
    source_id       TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    edge_type       TEXT NOT NULL,
    label           TEXT,
    weight          REAL,
    created_at      INTEGER NOT NULL,
    created_by      INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_bge_source ON business_graph_edges(source_id);
CREATE INDEX idx_bge_target ON business_graph_edges(target_id);
```

### 3.10 User Settings

**Table: `user_settings`**

```sql
CREATE TABLE user_settings (
    user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    offline_retention   TEXT NOT NULL DEFAULT 'forever'
                        CHECK(offline_retention IN ('forever','30_days','7_days','1_day')),
    allow_temp_messages INTEGER NOT NULL DEFAULT 0,
    business_private    INTEGER NOT NULL DEFAULT 0,
    home_experience     TEXT DEFAULT 'default',
    updated_at          INTEGER NOT NULL
);
```

**Table: `theme_preferences`**

```sql
CREATE TABLE theme_preferences (
    user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme_id            TEXT NOT NULL DEFAULT 'dark',
    custom_theme_json   TEXT,
    uniform_font        INTEGER NOT NULL DEFAULT 0,
    font_family         TEXT DEFAULT 'Inter',
    font_size           TEXT DEFAULT '16',
    font_weight         TEXT DEFAULT '400',
    font_style          TEXT DEFAULT 'normal'
);
```

**Table: `layout_preferences`**

```sql
CREATE TABLE layout_preferences (
    user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    layout_json         TEXT NOT NULL,
    updated_at          INTEGER NOT NULL
);
```

### 3.11 Server Settings

**Table: `app_settings`**

```sql
CREATE TABLE app_settings (
    setting_key         TEXT PRIMARY KEY,
    value               TEXT NOT NULL,
    updated_at          INTEGER NOT NULL,
    updated_by          INTEGER REFERENCES users(id)
);
```

### 3.12 RBAC

**Table: `role_definitions`**

```sql
CREATE TABLE role_definitions (
    role_key            TEXT PRIMARY KEY,                                -- "{scope}:{role_name}"
    scope               TEXT NOT NULL,                                   -- 'global' or workspace_id
    role_name           TEXT NOT NULL,
    display_name        TEXT,
    priority            INTEGER NOT NULL DEFAULT 0,
    color               TEXT,
    is_hoisted          INTEGER NOT NULL DEFAULT 0,
    capabilities_json   TEXT NOT NULL DEFAULT '[]',                       -- the role's granted capabilities
    active              INTEGER NOT NULL DEFAULT 1
);
```

**Critical addition:** `capabilities_json` is the role's granted capabilities. The previous design's roles were a name + color + priority; the corrected design includes the actual capabilities the role grants. This is the source of truth for ACL checks.

**Table: `rbac_assignments`**

```sql
CREATE TABLE rbac_assignments (
    assignment_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    scope               TEXT NOT NULL,
    user_id             INTEGER NOT NULL REFERENCES users(id),
    role_key            TEXT NOT NULL,
    assigned_by         INTEGER REFERENCES users(id),
    assigned_at         INTEGER NOT NULL,
    active              INTEGER NOT NULL DEFAULT 1,
    UNIQUE(scope, user_id, role_key)
);

CREATE INDEX idx_rbac_user ON rbac_assignments(user_id);
CREATE INDEX idx_rbac_scope ON rbac_assignments(scope);
```

### 3.13 Moderation (P0-5 fix)

The previous design referenced `ban_user` and `mute_user` commands but had no `bans` or `mutes` tables. The corrected design has them.

**Table: `bans`**

```sql
CREATE TABLE bans (
    ban_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    reason          TEXT,
    banned_by       INTEGER NOT NULL REFERENCES users(id),
    banned_at       INTEGER NOT NULL,
    expires_at      INTEGER,                                              -- null = permanent
    active          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_bans_user ON bans(user_id) WHERE active = 1;
CREATE INDEX idx_bans_expires ON bans(expires_at) WHERE active = 1;
```

**Table: `mutes`**

```sql
CREATE TABLE mutes (
    mute_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    channel_id      TEXT REFERENCES channels(channel_id),                -- null = server-wide
    reason          TEXT,
    muted_by        INTEGER NOT NULL REFERENCES users(id),
    muted_at        INTEGER NOT NULL,
    expires_at      INTEGER,
    active          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_mutes_user ON mutes(user_id) WHERE active = 1;
CREATE INDEX idx_mutes_channel ON mutes(channel_id, user_id) WHERE active = 1;
```

**Table: `audit_log`**

```sql
CREATE TABLE audit_log (
    audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id   INTEGER NOT NULL REFERENCES users(id),
    action          TEXT NOT NULL,                                       -- 'ban_user', 'unban_user', 'mute_user', 'unmute_user', 'set_retention_policy', 'trigger_backup', etc.
    target_type     TEXT,                                                  -- 'user', 'channel', 'stream', 'system'
    target_id       TEXT,
    details_json    TEXT,                                                  -- action-specific context
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER                                              -- 1 year default (archive class)
);

CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_expires ON audit_log(expires_at) WHERE expires_at IS NOT NULL;
```

Every admin action is logged. The audit log is the operator's record of who did what. The log is tamper-evident in the sense that any modification requires a custom migration; normal commands don't touch it.

**Table: `presence_sessions` (P0-5 fix)**

```sql
CREATE TABLE presence_sessions (
    connection_id    TEXT PRIMARY KEY,                                    -- ULID
    user_id          INTEGER NOT NULL REFERENCES users(id),
    device_id        TEXT REFERENCES devices(device_id),
    status           TEXT NOT NULL
                     CHECK(status IN ('online','idle','dnd','offline')),
    last_heartbeat_at INTEGER NOT NULL,
    connected_at     INTEGER NOT NULL,
    active           INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_presence_user ON presence_sessions(user_id) WHERE active = 1;
CREATE INDEX idx_presence_heartbeat ON presence_sessions(last_heartbeat_at) WHERE active = 1;
```

**Critical fix:** The previous design had `users.status` as the only presence state. The corrected design has a `presence_sessions` table that tracks per-device connections. `users.status` is a derived field (the most recent active connection's status, with fallback to 'offline' if no active connections).

Presence sessions auto-expire after 5 minutes of no heartbeat. The retention engine destroys the session row, and the user's `status` reverts to 'offline' when no active sessions remain.

### 3.14 Helper Nodes (P1-7 fix)

The previous design stored raw tokens in `pair_tokens.token` and `route_tokens.token`. The corrected design stores **hashes** (BLAKE3); raw tokens are never persisted.

**Table: `helper_nodes`**

```sql
CREATE TABLE helper_nodes (
    node_id             TEXT PRIMARY KEY,                                -- ULID
    node_kind           TEXT NOT NULL
                        CHECK(node_kind IN ('media','search','transcode','cache','anchor')),
    node_name           TEXT NOT NULL,
    public_key          BLOB NOT NULL,                                   -- Ed25519 for signed messages
    first_seen_at       INTEGER NOT NULL,
    last_heartbeat_at   INTEGER,
    last_status         TEXT,
    current_connections INTEGER,
    bandwidth_mbps      REAL,
    load_pct            REAL,
    active              INTEGER NOT NULL DEFAULT 1,
    revoked_at          INTEGER,
    revoked_reason      TEXT
);
```

**Table: `pair_tokens`**

```sql
CREATE TABLE pair_tokens (
    token_hash       BLOB PRIMARY KEY,                                   -- BLAKE3 of raw token; raw never stored
    node_kind        TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    issued_at        INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    redeemed         INTEGER NOT NULL DEFAULT 0,
    redeemed_at      INTEGER,
    redeemed_by_node TEXT,
    created_by       TEXT NOT NULL                                       -- operator user
);
```

**Critical fix:** `token_hash` is the BLAKE3 of the raw token. The raw token is shown to the operator once. If the database is dumped, the tokens cannot be redeemed.

**Table: `route_tokens`**

```sql
CREATE TABLE route_tokens (
    token_id          TEXT PRIMARY KEY,                                  -- ULID
    token_hash        BLOB NOT NULL UNIQUE,                              -- BLAKE3 of raw route token
    node_id           TEXT NOT NULL,
    node_kind         TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    issued_at         INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    revoked           INTEGER NOT NULL DEFAULT 0,
    revoked_at        INTEGER,
    revoked_reason    TEXT
);

CREATE INDEX idx_route_tokens_node ON route_tokens(node_id) WHERE revoked = 0;
```

**Critical fix:** `token_id` (ULID) and `token_hash` (BLAKE3 of raw) replace the previous `token TEXT NOT NULL`. The raw token is sent to the helper once. If the database is dumped, the tokens cannot be used.

### 3.15 Per-Scope Retention Policies (P0-2 fix)

The previous `retention_classes` table was per-object-type, but the actual retention rules are per-scope (channel, dm_user, object, addon, global). The corrected design is per-scope.

**Table: `retention_policies`**

```sql
CREATE TABLE retention_policies (
    policy_id    TEXT PRIMARY KEY,                                         -- ULID
    scope_type   TEXT NOT NULL
                 CHECK(scope_type IN ('global','channel','dm_user','object','addon')),
    scope_id     TEXT,                                                    -- NULL for global; specific id otherwise
    data_class   TEXT NOT NULL
                 CHECK(data_class IN ('message','dm_message','patch','audit','blob','event_log')),
    ttl_seconds  INTEGER,                                                 -- NULL = no TTL (durable)
    mode         TEXT NOT NULL
                 CHECK(mode IN ('delete','redact','archive')),
    updated_at   INTEGER NOT NULL,
    updated_by   INTEGER REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_retention_scope ON retention_policies(scope_type, scope_id, data_class);
```

The TTL reaper (Section 8.3) queries by `expires_at` columns (on individual rows), not by joining policies at reaper time. The `retention_policies` table is the source of truth for *what* to delete; the `expires_at` columns on each row are the source of truth for *when*.

**Table: `consumer_offsets` (engine-level table)**

```sql
CREATE TABLE consumer_offsets (
    consumer_id     TEXT NOT NULL,
    topic_pattern   TEXT NOT NULL,
    last_commit_seq INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (consumer_id, topic_pattern)
);
```

For reliable consumers (helper nodes, search indexers, audit exporters). The consumer reads events with `commit_seq > last_commit_seq` from the global commit index, processes them, and updates this row. (P0-1 fix.)

**Table: `command_idempotency` (engine-level table)**

```sql
CREATE TABLE command_idempotency (
    caller_user_id     INTEGER NOT NULL,
    client_request_id  TEXT NOT NULL,
    command_name       TEXT NOT NULL,
    result_blob        BLOB,                                                -- the cached command result
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER,                                             -- 24 hours default
    PRIMARY KEY (caller_user_id, client_request_id)
);

CREATE INDEX idx_idempotency_expires ON command_idempotency(expires_at) WHERE expires_at IS NOT NULL;
```

The `run_command` wrapper (Section 4.4) checks this table first. A retry with the same `(caller_user_id, client_request_id)` returns the cached result. The TTL reaper destroys old rows. (P1-6 fix.)

**Table: `ws_tickets`** (already in 3.1)

### 3.16 The On-Disk Storage Summary

The above tables are the **projection layer**. The canonical store is the per-stream event log + global commit index (Section 2.3 and 2.4). The relationship:

```
Per-stream event segment  ──┐
                            ├──▶  Projection engine  ──▶  Projection tables (above)
Global commit index        ──┘
```

Every projection table is rebuildable from the streams + commit index. If a projection table is corrupt, the engine drops the table and rebuilds it from the log. The log is canonical; the projections are disposable.

The exceptions are the engine-level tables (`consumer_offsets`, `command_idempotency`, `ws_tickets`, `helper_nodes`, `pair_tokens`, `route_tokens`, `retention_policies`, `audit_log`) which are not projections of events — they are operational state. They are durable in their own right, but they do not have a stream log; they are written directly by the engine's operational components.

### 3.17 Foreign Key Conventions

All foreign keys are enforced via `REFERENCES` clauses. The engine validates these at write time. Common FK patterns:

- `user_id INTEGER REFERENCES users(id)` — standard
- `user_id INTEGER REFERENCES users(id) ON DELETE CASCADE` — when the user is deleted, related rows are removed (e.g., `device_pinned_keys`, `user_settings`, `theme_preferences`)
- `user_id INTEGER REFERENCES users(id) ON DELETE SET NULL` — soft delete; the related row is preserved with `user_id = NULL` (rare; only for audit logs)
- `channel_id TEXT REFERENCES channels(channel_id) ON DELETE CASCADE` — when the channel is deleted, all related data is removed
- `stream_id TEXT NOT NULL` (no FK) — the stream layer is not a SQL table; this is a logical reference validated by the engine

### 3.18 ID Conventions

- **Server-issued IDs** (`user_id`, `device_id`, `session_id`, `message_id`, `board_id`, etc.) are **monotonically increasing integers** (where they need to be FK targets) or **ULIDs** (where they need to be stream ids or topic components).
- **Client-issued IDs** (`client_message_id`, `client_request_id`) are **UUIDv7** strings. The client generates them; the server stores them for idempotency.
- **`user_id` is always INTEGER.** TEXT user IDs are a bug.
- **`{stream_id}` never contains colons.** Topic grammar uses `:` as a separator; colons in stream ids are rejected at the storage layer.

### 3.19 What the Frontend Code Forces

The frontend's TypeScript types are the authoritative source for the schema. Section 15.1 lists the specific source files and the fields they define. Every column in this section is derived from a specific frontend type. The mapping is in `frontend/src/lib/types/` and the corresponding `wabi_state_bridge` tables. The WabiDB schema is the typed projection of the frontend's data shapes.

If the frontend adds a field, the projection table must add the column. If the frontend removes a field, the projection can be cleaned up in a migration. The schema is not authoritative on its own; it follows the frontend.

---

## 4. The Command/Reducer Model

### 4.1 How Commands Are Defined

Every state mutation in WabiDB goes through a typed Rust function. The shape is:

```rust
pub struct CommandCtx<'a> {
    pub storage: &'a dyn WabiStore,             // domain-shaped storage API
    pub caller: CallerIdentity,                  // who invoked this command
    pub timestamp: i64,                          // monotonic timestamp (micros since epoch)
    pub capabilities: CapabilitySet,             // what the caller is allowed to do
    pub idempotency_key: Option<String>,         // for retry-safe commands
    pub command_name: &'static str,
    pub args: &'a [u8],                          // BSATN-encoded input
}

pub enum CommandError {
    NotFound(String),
    Forbidden(String),
    Validation(String),
    Conflict(String),                            // e.g., duplicate idempotency key with different request
    RateLimited { retry_after_ms: u64 },
    EngineBusy { retry_after_ms: u64 },
    Internal(String),
}

pub trait Command<T>: Send + Sync {
    fn name(&self) -> &'static str;
    fn auth(&self, ctx: &CommandCtx) -> Result<(), CommandError>;  // capability check
    fn execute(&self, ctx: &mut CommandCtx) -> Result<CommandOutcome<T>, CommandError>;
}

pub struct CommandOutcome<T> {
    pub result: T,
    pub events: Vec<DurableEvent>,                // for the commit sequencer to write
}
```

The `CommandOutcome.events` is the list of durable events this command wants to commit. The `WabiStore` is the domain API. The `EmissionDurability` of each event is `DurableEventLog` (the default for `CommandOutcome.events`); ephemeral events are emitted via the `EphemeralBus` from the command body when the command needs them.

The transaction wrapper does:

```rust
async fn run_command<T>(
    cmd: &dyn Command<T>,
    caller: CallerIdentity,
    idempotency_key: Option<String>,
    args: &[u8],
) -> Result<T, CommandError> {
    // 1. Idempotency check: did this caller already run this client_request_id?
    if let Some(key) = &idempotency_key {
        if let Some(prior) = storage.check_idempotency(caller.user_id(), key).await? {
            return Ok(prior);  // replay the prior result
        }
    }
    
    // 2. Build context and run the command body
    let mut ctx = CommandCtx {
        storage: &storage,
        caller: caller.clone(),
        timestamp: now_micros(),
        capabilities: caller.capabilities(),
        idempotency_key: idempotency_key.clone(),
        command_name: cmd.name(),
        args,
    };
    cmd.auth(&ctx)?;  // capability check first
    let outcome = cmd.execute(&mut ctx).await?;
    
    // 3. Hand the events to the commit sequencer
    let commit_seq = sequencer.append_commit(CommandCommit {
        caller: caller.clone(),
        command_name: cmd.name(),
        idempotency_key: idempotency_key.clone(),
        events: outcome.events,
        timestamp: ctx.timestamp,
    }).await?;
    
    // 4. Cache the result for idempotency replay
    if let Some(key) = &idempotency_key {
        storage.store_idempotency_result(caller.user_id(), key, cmd.name(), &outcome.result).await?;
    }
    
    Ok(outcome.result)
}
```

This is the same atomicity guarantee as STDB reducers (`crates/core/src/host/module_host.rs`): the command either commits everything or rolls back everything, and the events are part of the same commit. The difference is that:
- The atomicity is enforced by the commit sequencer, not by a transaction object passed to the command.
- Idempotency is mandatory for any command with a non-`None` `idempotency_key`. A retry returns the prior result, not a fresh execution.
- Commands interact with the projection via `ctx.storage.get_*()` domain methods, not raw SQL.

### 4.2 Complete Command List

Below is every command the Wabi frontend requires, organized by domain. For each: name, input type, output type, who can call it, auth rule, idempotency requirement, what it emits. The "outbox" column is replaced with "events" (the events written to the commit index, with the stream id).

#### Messaging

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `send_message` | `channel_id, content, reply_to?, client_message_id?` | `MessageId` | authenticated | member of channel | yes (via `client_message_id`) | `streams/channel/{id}/events` + `streams/user/{sender}:inbox` (for unread count) |
| `edit_message` | `message_id, content` | `()` | message sender or mod | member of channel | yes (by message_id) | `streams/channel/{id}/events` |
| `delete_message` | `message_id, hard_delete?` | `()` | sender or mod | member of channel | yes (by message_id) | `streams/channel/{id}/events` |
| `pin_message` | `message_id, channel_id` | `()` | channel mod+ | member of channel | yes (by message_id + channel_id) | `streams/channel/{id}/events` |
| `add_reaction` | `message_id, emoji_id` | `()` | member of channel | member of channel | yes (by message_id + emoji_id + user_id) | `streams/channel/{id}/events` |
| `remove_reaction` | `message_id, emoji_id` | `()` | reaction owner | member of channel | yes (by message_id + emoji_id + user_id) | `streams/channel/{id}/events` |

#### Channels

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `create_channel` | `name, type, description?, ...` | `ChannelId` | server admin | server admin | yes (by name + parent) | `server:announcements` |
| `archive_channel` | `channel_id` | `()` | server admin | server admin | yes (by channel_id) | `streams/channel/{id}/events` |
| `delete_channel` | `channel_id` | `()` | server admin | server admin | yes (by channel_id) | `server:announcements` + per-stream tombstone |
| `update_channel_settings` | `channel_id, settings` | `()` | server admin | server admin | yes (by channel_id) | `streams/channel/{id}/events` |
| `add_channel_member` | `channel_id, user_id, role` | `()` | server admin | server admin | yes (by channel_id + user_id) | `streams/channel/{id}/events` |
| `remove_channel_member` | `channel_id, user_id` | `()` | server admin | server admin | yes (by channel_id + user_id) | `streams/channel/{id}/events` |

#### DMs (Encrypted)

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `create_dm_conversation` | `target_user_id` | `ConversationId` | authenticated | caller != target, both exist | yes (by caller + target) | `streams/user/{a}:inbox` + `streams/user/{b}:inbox` |
| `send_dm_message` | `conversation_id, body_ciphertext, body_nonce, body_alg, recipient_wraps[]` | `MessageId` | conversation member | member of conversation | yes (via `client_message_id`) | `streams/dm/{id}/events` |
| `delete_dm_message` | `message_id, hard_delete?` | `()` | sender | sender is caller | yes (by message_id) | `streams/dm/{id}/events` |
| `mark_dm_read` | `message_id, device_id` | `()` | recipient device | device is recipient | yes (by message_id + device_id) | `streams/dm/{id}/events` |
| `rotate_dm_prekey` | `signed_prekey_id, signed_prekey_public, signed_prekey_signature` | `()` | device owner | device is caller | yes (by signed_prekey_id) | `streams/user/{caller}:inbox` (for notifier) |

The `recipient_wraps[]` field is the list of per-device wrapped message keys (Section 6.4). Each entry has `(user_id, device_id, wrapped_message_key, wrap_nonce, wrap_alg)`. The server stores the wraps in `dm_message_recipients`; the client unwraps with its ratchet session.

#### Friends

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `send_friend_request` | `target_user_id, message?` | `RequestId` | authenticated | caller != target | yes (by caller + target) | `streams/user/{target}:inbox` |
| `accept_friend_request` | `request_id` | `()` | recipient | recipient is caller | yes (by request_id) | `streams/user/{sender}:inbox` |
| `decline_friend_request` | `request_id` | `()` | recipient | recipient is caller | yes (by request_id) | `streams/user/{sender}:inbox` |
| `set_friend_tier` | `user_id, tier` | `()` | friend | friend of user_id | yes (by caller + user_id) | `streams/user/{user_id}:inbox` |
| `remove_friend` | `user_id` | `()` | either | friend of user_id | yes (by caller + user_id) | `streams/user/{user_id}:inbox` |

#### Calls

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `create_call_session` | `channel_id, call_type, max_participants` | `SessionId` | channel member | member of channel | yes (by channel_id + call_type) | `streams/call/{id}/events` (durable) + ephemeral signaling to existing members |
| `join_call` | `session_id` | `()` | channel member | member of call's channel | yes (by session_id + caller) | `streams/call/{id}/events` |
| `leave_call` | `session_id` | `()` | participant | participant in call | yes (by session_id + caller) | `streams/call/{id}/events` |
| `end_call_session` | `session_id` | `()` | host | host of call | yes (by session_id) | `streams/call/{id}/events` |
| `mute_call_participant` | `session_id, target_user_id` | `()` | host | host of call | yes (by session_id + target) | `streams/call/{id}/events` |
| `kick_call_participant` | `session_id, target_user_id` | `()` | host | host of call | yes (by session_id + target) | `streams/call/{id}/events` |

Live call signaling (SDP, ICE, codec negotiation, DTLS) is **NOT** a command. It uses `EmissionDurability::EphemeralMemoryOnly` (Section 2.9) and the ephemeral bus. There is no `publish_call_signal` command because call signals are not durable.

#### Whiteboards

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `create_whiteboard` | `channel_id` | `BoardId` | channel member | member of channel | yes (by channel_id) | `streams/whiteboard/{id}/events` |
| `add_whiteboard_element` | `board_id, element` | `ElementId` | channel member | member of channel | yes (by element_id) | `streams/whiteboard/{id}/events` |
| `update_whiteboard_element` | `board_id, element_id, changes, base_version` | `()` | element creator | member of channel | yes (by element_id + base_version) | `streams/whiteboard/{id}/events` |
| `delete_whiteboard_element` | `board_id, element_ids[]` | `()` | element creator | member of channel | yes (by element_id) | `streams/whiteboard/{id}/events` |
| `add_whiteboard_layer` | `board_id, layer` | `LayerId` | channel member | member of channel | yes (by layer_id) | `streams/whiteboard/{id}/events` |
| `update_whiteboard_layer` | `board_id, layer_id, changes` | `()` | channel member | member of channel | yes (by layer_id) | `streams/whiteboard/{id}/events` |
| `delete_whiteboard_layer` | `board_id, layer_id` | `()` | channel member | member of channel | yes (by layer_id) | `streams/whiteboard/{id}/events` |
| `reorder_whiteboard_layer` | `board_id, layer_id, new_order` | `()` | channel member | member of channel | yes (by layer_id) | `streams/whiteboard/{id}/events` |
| `add_whiteboard_patch` | `board_id, op, payload, base_version` | `PatchId` | channel member | member of channel | yes (by client_request_id + base_version) | `streams/whiteboard/{id}/events` |
| `save_whiteboard_snapshot` | `board_id, document_json` | `SnapshotVersion` | channel member | member of channel | yes (by board_id) | `streams/whiteboard/{id}/snapshots` |

The frontend patch operations at `boardSync.ts:19-53` — `emitCreatePatch`, `emitUpdatePatch`, `emitDeletePatch`, `emitLayerCreatePatch`, `emitLayerUpdatePatch`, `emitLayerDeletePatch`, `emitLayerReorderPatch`, `emitLayerSelectPatch` — all map to `add_whiteboard_patch` with an `op` field. The `base_version` field on updates is the source-of-truth mechanism: if the client's view of the element is older than the server's current version, the server rejects the update with `CommandError::Conflict`. The client must re-fetch and retry with the new `base_version`.

#### Places

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `create_place` | `place_draft` | `PlaceId` | server admin | server admin | yes (by place name) | `server:announcements` |
| `update_place` | `place_id, changes` | `()` | server admin | server admin | yes (by place_id) | `streams/place/{id}/events` |
| `delete_place` | `place_id` | `()` | server admin | server admin | yes (by place_id) | `server:announcements` + per-stream tombstone |
| `save_place_draft` | `draft_json` | `DraftId` | authenticated | caller has any role | yes (by caller + place_id) | `streams/user/{caller}:inbox` |
| `create_poi` | `place_id, poi` | `PoiId` | server admin | server admin | yes (by poi_id) | `streams/place/{id}/events` |
| `update_poi` | `poi_id, changes` | `()` | server admin | server admin | yes (by poi_id) | `streams/place/{id}/events` |
| `delete_poi` | `poi_id` | `()` | server admin | server admin | yes (by poi_id) | `streams/place/{id}/events` |

#### Kanban / Business

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `create_kanban_board` | `name, scope` | `BoardId` | workspace member | workspace member | yes (by board name + scope) | `streams/kanban/{id}/events` |
| `add_kanban_task` | `board_id, task` | `TaskId` | board member | board member | yes (by task_id) | `streams/kanban/{id}/events` |
| `update_kanban_task` | `task_id, changes` | `()` | creator/assignee | creator/assignee or mod | yes (by task_id) | `streams/kanban/{id}/events` |
| `delete_kanban_task` | `task_id` | `()` | creator/admin | creator/admin | yes (by task_id) | `streams/kanban/{id}/events` |
| `move_kanban_task` | `task_id, new_status, sort_order` | `()` | board member | board member | yes (by task_id) | `streams/kanban/{id}/events` |
| `create_project` | `project` | `ProjectId` | workspace member | workspace member | yes (by project name) | `streams/project/{id}/events` |
| `update_project` | `project_id, changes` | `()` | creator | creator or mod | yes (by project_id) | `streams/project/{id}/events` |
| `create_calendar_event` | `event` | `EventId` | workspace member | workspace member | yes (by event_id) | `streams/user/{caller}:inbox` |
| `update_calendar_event` | `event_id, changes` | `()` | creator | creator or mod | yes (by event_id) | `streams/user/{caller}:inbox` |
| `create_diary_entry` | `entry` | `EntryId` | workspace member | workspace member | yes (by entry_id) | `streams/user/{caller}:inbox` |
| `update_diary_entry` | `entry_id, changes` | `()` | creator | creator or mod | yes (by entry_id) | `streams/user/{caller}:inbox` |

The kanban task schema (Section 3) includes `tags_json` because the frontend's `Todo` type at `shared/businessContracts.ts:27-44` has a `tags: string[]` field. The earlier doc missed this; the corrected design includes `tags_json` on `kanban_tasks`.

#### Users & Auth

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `register_user` | `username, password_hash, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekeys_public[]` | `UserId, DeviceId` | unauthenticated | n/a | yes (by username) | `server:announcements` |
| `update_profile` | `user_id, changes` | `()` | user | user is caller | yes (by user_id) | `streams/user/{id}:inbox` |
| `delete_user` | `user_id` | `()` | user or admin | user is caller or admin | yes (by user_id) | `server:announcements` + per-stream tombstones for all user streams |
| `register_device` | `device_name, device_type, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekeys_public[]` | `DeviceId` | user | user is caller | yes (by device_id) | `streams/user/{id}:inbox` |
| `rotate_signed_prekey` | `device_id, signed_prekey_id, signed_prekey_public, signed_prekey_signature` | `()` | device owner | device is caller | yes (by signed_prekey_id) | `streams/user/{id}:inbox` (for notifier) |
| `upload_one_time_prekeys` | `device_id, prekeys[]` | `Count` | device owner | device is caller | yes (by prekey_id) | none (silent top-up) |
| `consume_one_time_prekey` | `target_user_id, target_device_id` | `PrekeyId, PrekeyPublic` | peer device | peer is authenticated | yes (by prekey_id; consumed atomically) | `streams/user/{target}:inbox` (audit only) |

The `consume_one_time_prekey` is the X3DH step: peer A reads peer B's prekey bundle, consumes one prekey, and B marks it consumed. The atomic UPDATE pattern (Section 9.4) prevents double-consumption.

#### Settings

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `update_user_settings` | `settings` | `()` | user | user is caller | yes (by user_id) | `streams/user/{id}:inbox` |
| `update_theme` | `preferences` | `()` | user | user is caller | yes (by user_id) | `streams/user/{id}:inbox` |
| `update_layout` | `layout_json` | `()` | user | user is caller | yes (by user_id) | `streams/user/{id}:inbox` |
| `set_app_setting` | `key, value` | `()` | server admin | server admin | yes (by key) | `server:announcements` |

#### RBAC

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `assign_role` | `scope, user_id, role_key` | `()` | server admin | server admin | yes (by scope + user_id + role_key) | `server:announcements` |
| `remove_role` | `scope, user_id, role_key` | `()` | server admin | server admin | yes (by scope + user_id + role_key) | `server:announcements` |
| `define_role` | `role_key, name, color, priority, capabilities[]` | `()` | server admin | server admin | yes (by role_key) | `server:announcements` |

#### Moderation

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `ban_user` | `user_id, reason, expires_at?` | `BanId` | server admin | server admin | yes (by user_id + active=true) | `server:announcements` + `audit_log` |
| `unban_user` | `user_id` | `()` | server admin | server admin | yes (by user_id + active=true) | `server:announcements` + `audit_log` |
| `mute_user` | `user_id, channel_id?, expires_at?` | `MuteId` | server admin / channel mod | server admin or channel mod | yes (by user_id + channel_id + active=true) | `streams/channel/{id}/events` + `audit_log` |
| `unmute_user` | `user_id, channel_id?` | `()` | server admin / channel mod | server admin or channel mod | yes (by user_id + channel_id + active=true) | `streams/channel/{id}/events` + `audit_log` |

The previous design claimed `ban_user` and `mute_user` referenced tables that didn't exist (`bans`, `mutes`). The corrected design has them (Section 3 schema) with `audit_log` recording every moderation action.

#### Retention

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `set_retention_policy` | `scope_type, scope_id?, data_class, ttl_seconds?, mode` | `PolicyId` | server admin | server admin | yes (by scope + data_class) | `server:announcements` |
| `purge_expired` | (none; scheduled) | `PurgedCount` | internal | internal | n/a | per-stream tombstones (for destroyed streams) |

#### Helper Nodes

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `issue_pair_token` | `node_kind, capabilities[], ttl_seconds` | `Token` (raw, shown once) | server admin | server admin | yes (by node_kind + admin) | `audit_log` |
| `redeem_pair_token` | `token, node_id, public_key` | `RouteToken` (raw, returned once) | helper node | token valid, not redeemed, not expired | yes (atomic via UPDATE row count) | `audit_log` |
| `update_helper_heartbeat` | `node_id, status, current_connections, bandwidth_mbps, load_pct` | `RevocationList` | helper node | valid route token | yes (by node_id + timestamp) | none (silent) |
| `revoke_route_token` | `node_id, reason` | `()` | server admin | server admin | yes (by node_id) | `audit_log` |

#### Admin / Backup

| Command | Input | Output | Caller | Auth | Idempotent | Events emitted |
|---|---|---|---|---|---|---|
| `trigger_backup` | (none) | `BackupId, ManifestPath` | server admin | server admin | n/a (creates new backup) | `audit_log` |
| `verify_backup` | `manifest_path` | `VerificationReport` | server admin | server admin | yes | `audit_log` |
| `rebuild_indexes` | (none) | `RebuiltCount` | server admin | server admin | n/a | `audit_log` |
| `destroy_stream` | `stream_id, reason` | `()` | server admin | server admin | yes (by stream_id) | `streams/.../tombstone` + `audit_log` |

### 4.3 Example Commands in Rust

The code below is illustrative, showing the shape that the implementing engineer would fill in. These use the `WabiStore` domain API, not raw SQL.

```rust
// wabidb/src/commands/messages/send_message.rs
pub struct SendMessageCommand;

impl Command<MessageId> for SendMessageCommand {
    fn name(&self) -> &'static str { "send_message" }

    fn auth(&self, ctx: &CommandCtx) -> Result<(), CommandError> {
        if !ctx.capabilities.contains("can_send_messages") {
            return Err(CommandError::Forbidden("missing capability".into()));
        }
        Ok(())
    }

    fn execute(&self, ctx: &mut CommandCtx) -> Result<CommandOutcome<MessageId>, CommandError> {
        let args: SendMessageArgs = bsatn::from_bytes(ctx.args)?;

        // Validate channel membership via the projection
        let is_member = ctx.storage.is_channel_member(args.channel_id, ctx.caller.user_id())?;
        if !is_member {
            return Err(CommandError::Forbidden("not a member of this channel".into()));
        }

        let message_id = generate_ulid();
        let now = ctx.timestamp;

        // The command returns events to be committed
        let events = vec![
            DurableEvent::new(
                StreamId::channel(args.channel_id),
                Topic::ChannelMessages(args.channel_id.clone()),
                EventEnvelope {
                    event_id: generate_event_id(),
                    event_type: "message_created",
                    payload: encode_to_bsatn(&MessageCreated {
                        message_id,
                        channel_id: args.channel_id,
                        sender_id: ctx.caller.user_id(),
                        content: args.content,
                        reply_to: args.reply_to,
                        created_at: now,
                    }),
                    ..
                },
            ),
            DurableEvent::new(
                StreamId::user_inbox(ctx.caller.user_id()),
                Topic::UserInbox(ctx.caller.user_id()),
                EventEnvelope {
                    event_id: generate_event_id(),
                    event_type: "message_sent_confirmation",
                    payload: encode_to_bsatn(&MessageSentConfirmation {
                        message_id,
                        channel_id: args.channel_id,
                    }),
                    ..
                },
            ),
        ];

        Ok(CommandOutcome {
            result: message_id,
            events,
        })
    }
}
```

The `WabiStore` projection update happens automatically when the commit sequencer commits the events: the projection engine reads the events from the commit index, applies them to the materialized state, and updates the indexes. The command does not call `ctx.storage.insert_message(...)` directly — it returns events, and the engine handles the projection.

```rust
// wabidb/src/commands/whiteboards/add_whiteboard_patch.rs
pub struct AddWhiteboardPatchCommand;

impl Command<PatchId> for AddWhiteboardPatchCommand {
    fn name(&self) -> &'static str { "add_whiteboard_patch" }

    fn auth(&self, ctx: &CommandCtx) -> Result<(), CommandError> {
        if !ctx.capabilities.contains("can_edit_whiteboard") {
            return Err(CommandError::Forbidden("missing capability".into()));
        }
        Ok(())
    }

    fn execute(&self, ctx: &mut CommandCtx) -> Result<CommandOutcome<PatchId>, CommandError> {
        let args: WhiteboardPatchArgs = bsatn::from_bytes(ctx.args)?;
        let board_id = &args.board_id;

        // Check base_version to detect concurrent edits (source-of-truth enforcement)
        let current_version = ctx.storage.get_whiteboard_version(board_id)?;
        if let Some(expected) = args.base_version {
            if expected != current_version {
                return Err(CommandError::Conflict(format!(
                    "whiteboard version mismatch: client has {}, server has {}",
                    expected, current_version
                )));
            }
        }

        let patch_id = generate_ulid();
        let now = ctx.timestamp;

        let events = vec![
            DurableEvent::new(
                StreamId::whiteboard(board_id),
                Topic::Whiteboard(board_id.clone()),
                EventEnvelope {
                    event_id: generate_event_id(),
                    event_type: "whiteboard_patch",
                    payload: encode_to_bsatn(&WhiteboardPatchEvent {
                        patch_id,
                        board_id: board_id.clone(),
                        op: args.op,
                        payload: args.payload,
                        user_id: ctx.caller.user_id(),
                        base_version: current_version,
                        result_version: current_version + 1,
                        created_at: now,
                    }),
                    ..
                },
            ),
        ];

        Ok(CommandOutcome { result: patch_id, events })
    }
}
```

```rust
// wabidb/src/commands/dm/send_dm_message.rs
pub struct SendDmMessageCommand;

impl Command<MessageId> for SendDmMessageCommand {
    fn name(&self) -> &'static str { "send_dm_message" }

    fn auth(&self, ctx: &CommandCtx) -> Result<(), CommandError> {
        if !ctx.capabilities.contains("can_send_dm") {
            return Err(CommandError::Forbidden("missing capability".into()));
        }
        Ok(())
    }

    fn execute(&self, ctx: &mut CommandCtx) -> Result<CommandOutcome<MessageId>, CommandError> {
        let args: SendDmArgs = bsatn::from_bytes(ctx.args)?;
        let user_id = ctx.caller.user_id();
        let conversation_id = &args.conversation_id;

        // Verify caller is part of the conversation
        let participants = ctx.storage.get_dm_participants(conversation_id)?;
        if !participants.contains(&user_id) {
            return Err(CommandError::Forbidden("not a participant".into()));
        }

        // The wraps were created client-side: each recipient device got a wrapped message key
        // derived from its Double Ratchet session. The server stores them as-is.
        let message_id = generate_ulid();
        let now = ctx.timestamp;

        let events = vec![
            DurableEvent::new(
                StreamId::dm(conversation_id),
                Topic::DmConversation(conversation_id.clone()),
                EventEnvelope {
                    event_id: generate_event_id(),
                    event_type: "dm_message_created",
                    payload: encode_to_bsatn(&DmMessageCreated {
                        message_id,
                        conversation_id: conversation_id.clone(),
                        sender_user_id: user_id,
                        sender_device_id: ctx.caller.device_id(),
                        body_ciphertext: args.body_ciphertext,
                        body_nonce: args.body_nonce,
                        body_alg: args.body_alg,
                        wraps: args.recipient_wraps,  // stored in dm_message_recipients by the projection
                        created_at: now,
                    }),
                    ..
                },
            ),
        ];

        Ok(CommandOutcome { result: message_id, events })
    }
}
```

### 4.4 The Commit Sequencer Wrapper

The `run_command` function shown in 4.1 is the single entry point for all mutations. It guarantees:

1. The idempotency check runs first. A retry with the same `client_request_id` returns the cached result without re-executing the command.
2. The command's `auth` method runs. If the caller lacks the required capability, the command is rejected without any state change.
3. The command's `execute` method runs. It returns a `CommandOutcome` containing the events to commit.
4. The events are passed to the commit sequencer. The sequencer assigns a monotonic `commit_seq`, writes each event payload to the correct per-stream segment (Section 2.3), appends a global commit index entry (Section 2.4), and fsyncs. If the sequencer fails, the events are lost; the engine returns `CommandError::Internal` and the caller can retry.
5. On success, the projection engine consumes the new commit index entry and updates the materialized state and indexes. This happens asynchronously after the command returns; the caller doesn't wait for the projection.
6. The live subscription engine consumes the new commit index entry and delivers events to matching subscribers (Section 5.4).
7. The idempotency result is cached. Subsequent retries with the same `client_request_id` return the cached result.

If any step fails, no state mutation occurs and no events are emitted. The atomicity is guaranteed by the commit sequencer, not by a transaction object passed to the command. This is the load-bearing difference from STDB's reducer model: STDB's tx-and-outbox is replaced by a commit sequencer and a global commit index.

### 4.5 Per-Command Contract (Required for All Commands)

Every command in the registry must document:

1. **Input schema** (typed Rust struct, validated at parse)
2. **Auth rule** (capability check via `ctx.capabilities`)
3. **Idempotency** (the unique key by which retries are detected; usually `(caller, client_request_id)`)
4. **DB mutations** (which streams, which projection tables are affected)
5. **Emitted events** (which topics, which payload, which stream id)
6. **Snapshot invalidation** (which topics need a fresh snapshot if the projection rebuilds)
7. **Rate limits** (per caller, per command, per object)
8. **Failure modes** (typed `CommandError` variants; which are retry-safe and which are not)

The contract is checked at compile time via the `Command` trait's associated types. A command that emits no events must be marked `ReadOnly` so the commit sequencer skips it. A command that mutates state must declare its idempotency key requirement.

Commands that do not fit this contract (e.g., arbitrary long-running background work) are not allowed. Background work goes through helper nodes, not commands.

---

## 5. The Live Subscription Model

### 5.0 The Delivery Contract

WabiDB does not promise exactly-once delivery. Exactly-once is not implementable over a lossy network with crash-recovery. WabiDB promises:

- **Every committed mutation receives a monotonic `commit_seq`.**
- **Subscribers receive updates at-least-once when connected.**
- **Subscribers deduplicate by `commit_seq` and `event_id` client-side.**
- **On reconnect, subscribers resume from their last seen `commit_seq` or receive a fresh snapshot.**
- **The UI is eventually consistent with committed state; ordering within a topic is preserved; ordering across topics is preserved (because all events go through the same commit sequencer).**

This is implementable. The previous "exactly once" claim was a doc overclaim. The new model is honest.

There are two consumer classes:

- **Live fanout (browsers)**: in-memory, best-effort, resumable, snapshot-barriered. Drop on disconnect, resume on reconnect.
- **Reliable consumers (helper nodes, search indexers, audit exporters)**: durable, replayable, checkpointed via the `consumer_offsets` table.

Both share the same event source (the global commit index) but have different delivery semantics. The engine treats them differently.

### 5.1 Topic Grammar

The subscription grammar is a closed set of topic strings and filters. There is no SQL subset, no query compilation, no query hash indexing. Topics are defined as a Rust enum:

```rust
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub enum Topic {
    ChannelMessages(String),         // "channel:{channel_id}:messages"
    ChannelMeta(String),             // "channel:{channel_id}:meta"
    ChannelMembers(String),          // "channel:{channel_id}:members"
    ChannelReactions(String),        // "channel:{channel_id}:reactions"
    DmConversation(String),          // "dm:{conversation_id}"
    UserInbox(i64),                  // "user:{user_id}:inbox"
    Whiteboard(String),              // "whiteboard:{board_id}"
    Place(String),                   // "place:{place_id}"
    KanbanBoard(String),             // "kanban:{board_id}"
    Call(String),                    // "call:{session_id}"
    ServerAnnouncements,             // "server:announcements"
}
```

**Critical rule: `StreamId` values MUST NOT contain colons or other delimiters that conflict with topic grammar.** All `channel_id`, `board_id`, `place_id`, `conversation_id`, `board_id`, `call_id`, and `user_id` values are opaque IDs (ULID or UUIDv7 by default) that have no colons. Topics are constructed by string concatenation, but the segments are guaranteed to not contain the separator. This is enforced at the storage layer: any attempt to create a `StreamId` containing a colon is rejected.

The on-wire topic is the same string the enum produces. The wire format is BSATN for binary, JSON for debug. Both are versioned (see 5.7).

### 5.2 Filter Grammar

Filters are a closed set of operations, not arbitrary expressions:

```
filter          = include-clause | exclude-clause
include-clause  = "+" topic-pattern
exclude-clause  = "-" topic-pattern
topic-pattern   = topic (where topic-id may be "*" for wildcard)
```

Examples:
- `+channel:01J...:messages` — subscribe to messages in a specific channel
- `+channel:*:messages` — subscribe to messages in all channels
- `+whiteboard:01J...` — subscribe to whiteboard changes
- `-channel:01J...:messages` — unsubscribe from a specific noisy channel

### 5.3 The Topic ACL

Wildcard subscriptions are **not** wildcard-blind. Every topic has an ACL that gates both subscribe and receive:

```rust
pub trait TopicAcl {
    fn can_subscribe(&self, caller: &CallerIdentity, topic: &Topic) -> bool;
    fn can_receive_event(&self, caller: &CallerIdentity, event: &EventEnvelope) -> bool;
    fn on_membership_change(&self, topic: &Topic, before: &CallerIdentity, after: &CallerIdentity);
}
```

Wildcards are expanded only to topics the caller can access. When membership changes (user added to channel, role changed, banned), the subscription engine revalidates active subscriptions. The ACL is enforced on the server side; clients cannot subscribe to topics they cannot access, even if they know the topic string.

The default ACL is conservative:

- `channel:*:messages` — caller must be a member of the channel
- `dm:*` — caller must be a participant in the conversation
- `user:{user_id}:inbox` — caller must be `user_id` (or admin)
- `whiteboard:{id}` — caller must have whiteboard read access
- `place:{id}` — caller must have place read access
- `kanban:{id}` — caller must be a board member
- `call:{id}` — caller must be a call participant
- `server:announcements` — caller must be authenticated

### 5.4 The Durable Event Log

The durable event log is the global commit index's payload surface. The engine does not have a separate `outbox` table; the commit index itself is the log of committed events. Each commit index entry references one or more stream records, which are the actual event payloads.

```text
commit_index_entry:
  commit_seq:        u64
  timestamp:         i64
  caller:            CallerIdentityRef
  command_name:      string
  idempotency_key:   option<string>
  event_refs:        Vec<StreamRef>     // one per event in the commit
  payload_hashes:    Vec<[u8; 32]>      // BLAKE3 of each payload
```

Live fanout reads from the commit index in order. Replay reads from the commit index too. The commit index is fsync'd before the command returns, so committed events are durable.

A committed event is the unit of subscription. The engine guarantees:

- Events are delivered to all matching live subscribers.
- Replay from any `commit_seq` is possible (subject to retention).
- Two subscribers with overlapping filters both see the same event (no implicit filter shadowing).
- Events with no matching subscriber are still committed (durable), just not delivered.

### 5.5 Reliable Consumers and Consumer Offsets

Helper nodes, search indexers, and audit exporters are reliable consumers. They need durable, replayable, ordered delivery. The `consumer_offsets` table is the mechanism:

```sql
CREATE TABLE consumer_offsets (
    consumer_id     TEXT NOT NULL,
    topic_pattern   TEXT NOT NULL,
    last_commit_seq INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (consumer_id, topic_pattern)
);
```

A reliable consumer reads events with `commit_seq > last_commit_seq` from the commit index, processes them, and updates its offset in the same transaction as the work. The atomicity is the consumer's responsibility (the engine does not enforce it), but the pattern is well-defined.

The handler runs as a long-lived task per consumer. It subscribes to a topic pattern, processes events, commits work + offset, and catches up. If the consumer is offline, the engine continues to commit events; on reconnect, the consumer reads from its last offset.

Search helpers in particular use this pattern. They do not consume browser outbox rows; they consume from the global commit index via a dedicated consumer offset. The "stop enqueueing if helper is down" anti-pattern is rejected: the engine never stops committing, and the helper resumes from its last checkpoint.

### 5.6 Snapshot Barrier and Resume

Browser subscribers need snapshots. The flow:

1. Client opens WebSocket, authenticates via ticket (see Section 10).
2. Client sends `Subscribe` with filters and an optional `resume_after: Option<CommitSeq>`.
3. Server captures the current `commit_seq` as the `snapshot_barrier` for this subscription.
4. Server reads the snapshot for each topic, including the barrier in the response.
5. Server delivers only events with `commit_seq > barrier` to this subscriber.

Resume flow on reconnect:

1. Client sends `Subscribe` with filters and `resume_after: <last_seen_commit_seq>`.
2. Server looks up events with `commit_seq > resume_after` matching the filters.
3. If the retention window has passed `resume_after`, server responds with `{snapshot_required: true}` and the client requests a fresh snapshot.
4. Otherwise server replays the missed events.

Per-topic snapshot shape (the snapshot contract):

| Topic family | Snapshot shape |
|---|---|
| `channel:{id}:messages` | Last N messages (default 50) + cursor |
| `channel:{id}:members` | Full member list, paginated if large |
| `dm:{id}` | Last N encrypted messages + cursor |
| `whiteboard:{id}` | Latest snapshot + patches after snapshot version |
| `kanban:{id}` | Full board/task state |
| `place:{id}` | Latest place snapshot + draft changes |
| `call:{id}` | Current participants; no old signals |
| `user:{id}:inbox` | Unread notifications + cursor |

Snapshots are not a generic "all current state" dump. They are topic-specific. The engine knows the snapshot shape per topic family.

### 5.7 Event Envelope and Versioning

The wire format is versioned at two levels: protocol and schema.

```rust
pub struct EventEnvelope {
    pub protocol_version: u16,        // bumped on incompatible wire changes
    pub schema_version: u16,          // bumped on payload schema changes
    pub event_id: u64,                // unique per commit_seq
    pub commit_seq: u64,              // matches the global commit index entry
    pub topic: String,                // the topic string
    pub event_type: String,           // for payload deserialization
    pub created_at: i64,              // micros since epoch
    pub caller_user_id: Option<UserId>,
    pub idempotency_key: Option<String>,
    pub payload_encoding: PayloadEncoding,  // BSATN | JSON
    pub payload: Vec<u8>,             // encoded payload
}

pub enum PayloadEncoding {
    Bsatn,
    Json,
}
```

Old clients reject events with `protocol_version > max_supported`. They partially handle events with `schema_version > max_supported` (they can read what they understand, ignore the rest). The envelope is stable across WabiDB versions.

The primary wire format is BSATN. JSON is a debug option. Both are framed identically; the envelope tells the consumer which encoding the payload is in.

### 5.8 WebSocket Frame Format

```rust
enum ClientMessage {
    Auth { ticket: String },                              // one-time WebSocket ticket
    Subscribe { filters: Vec<String>, resume_after: Option<CommitSeq> },
    Unsubscribe { filters: Vec<String> },
    Command { name: String, args: Vec<u8>, client_request_id: String },
    Ack { last_commit_seq: CommitSeq },                    // for backpressure flow control
}

enum ServerMessage {
    AuthOk { caller: CallerIdentityRef, resume_token: String },
    AuthErr { reason: String },
    Subscribed {
        filters: Vec<String>,
        snapshot_seq: CommitSeq,                          // the snapshot_barrier
        snapshot: Vec<(Topic, Vec<u8>)>,
    },
    ResumeStarted { resume_from: CommitSeq },
    SnapshotRequired { topic: Topic, last_known_commit_seq: CommitSeq },
    Unsubscribed { filters: Vec<String> },
    Update { envelope: EventEnvelope },
    CommandResult { client_request_id: String, result: Result<Vec<u8>, CommandError> },
    Backpressure { control: ControlFrame },                // sent on a separate control channel
    Error { code: String, message: String },
}
```

The ticket auth (no JWT in query) is described in Section 10.

### 5.9 Per-Connection Task and Filtering

When a WebSocket connects:

1. Client sends `Auth { ticket }`. Server validates; on success, returns `AuthOk` with caller identity.
2. The connection handler spawns a per-connection task that reads `ClientMessage` frames from the WebSocket.
3. `Subscribe` updates the connection's `TopicFilter` set in the `SubscriptionManager`, captures the `snapshot_barrier`, fetches the snapshot per topic, and responds with `Subscribed`.
4. The `SubscriptionManager.deliver()` method iterates relevant subscribers via topic indexes (not O(N) scan of all subscribers), tests `topic_matches_filter(topic, filter)`, and if matched enqueues the payload on the subscriber's mpsc channel.
5. The per-connection task reads from its receiver and writes `Update` frames to the WebSocket.

For per-topic matching at scale, the engine uses topic indexes (not filter iteration):

```rust
exact_subscribers: HashMap<TopicKey, HashSet<SubscriberId>>
wildcard_subscribers: HashMap<TopicPatternKey, HashSet<SubscriberId>>
user_subscriptions: HashMap<SubscriberId, Vec<CompiledFilter>>
```

For each event, the engine:
1. Looks up the exact topic subscriber set.
2. Looks up relevant wildcard subscriber sets (e.g., `channel:*:messages` for any `channel:X:messages` event).
3. Unions and deduplicates.
4. Applies exclude filters.
5. Enqueues.

At 1k subscribers, both approaches work. At 100k, the topic indexes are required.

### 5.10 Adaptive Batching and Backpressure with Priority Lanes

The `SendWorker` (owned by the `SubscriptionManager`, not per-connection) aggregates updates per-client. The design uses **priority lanes** to handle backpressure:

```rust
control_tx // small, reserved, never blocked: backpressure, errors, pings, AuthOk
data_tx    // bounded, may block: live Update frames
```

The `control_tx` is a small dedicated channel that is never subject to backpressure. If the `data_tx` is full, the engine sends a `Backpressure` frame on `control_tx`. If the connection does not drain `data_tx` within 5 seconds, the engine closes the connection with `backpressure_timeout`.

Per-event backpressure behavior:

| Event type | Backpressure behavior |
|---|---|
| Messages | Must not drop; disconnect/resync |
| Reactions | Can batch/coalesce (multiple reactions → one frame) |
| Typing | Can drop (ephemeral, memory-only anyway) |
| Cursor movement | Latest-only (only most recent cursor position matters) |
| Presence | Latest-only (only current state matters) |
| Whiteboard patches | Must preserve order; disconnect/resync on overflow |

### 5.11 Compared to STDB

STDB's subscription system at `crates/core/src/subscription/module_subscription_manager.rs` is a sophisticated delta-evaluation engine: query compilation, query hash caching, `SearchArguments` indexing by `(TableId, ColId, Value)`, join edges, a `SendWorker` actor. WabiDB's system replaces all of this with the commit-index + topic-pattern + per-topic snapshot model. The cost is that WabiDB commands must explicitly emit events — they cannot do a "generic SELECT * subscription" on any table. The benefit is the elimination of ~15,000 lines of query engine code and the entire SQL compiler. For a known set of subscription patterns (channel messages, whiteboard patches, DM events, call signaling, presence), the commit-index model is sufficient and far simpler. The `WabiState` storage API (see Section 2.12) is the boundary that lets commands emit events without knowing the subscription engine internals.

### 5.12 FTS5 and Search Helper Integration

WabiDB does not use SQLite FTS5 (SQLite is no longer a substrate). For full-text search, WabiDB's search helper is the primary path:

- **Outbox topic**: the engine exposes a `search:updates` topic via the commit index. Every state change that affects a searchable table (messages, notes, kanban tasks, calendar events, etc.) emits a commit index entry with this topic.
- **Helper subscription**: the search helper node consumes from the commit index via a `consumer_offsets` row. It does not use a browser-style subscription.
- **Helper index**: the search helper maintains its own index (e.g., Meilisearch, Tantivy, or a custom Rust index). It applies each commit index entry to its index.
- **Search queries**: the frontend's search UI sends a query to the helper (via the helper's API, not via WabiDB). The helper returns ranked results. If the helper is down, the frontend falls back to a simpler text-search via the engine's projection engine (e.g., a case-insensitive substring scan over the materialized message state).

The tradeoff: there is a brief window (typically <500ms) where the helper's index lags behind the engine's committed state. For "search as I type" this is invisible. For "find me the message I just sent" the frontend can use the engine's fallback.

The helper's pattern is "always commit, helper resumes from checkpoint." The engine never stops committing; the helper catches up on reconnect. This eliminates the "stop enqueueing if helper is down" anti-pattern.

For addons that need search integration (e.g., the CAD addon's comment search), the addon declares a `search:addon:{addon_id}:updates` topic in its manifest. The engine routes changes to that topic. The search helper subscribes to all `search:addon:*` topics and indexes them.

---

## 6. The Encryption Model

### 6.0 Honest Naming

The previous version of this section called the design "Signal/Sesame-like." That was an overclaim. Static ECDH with long-term identity keys has **no forward secrecy**: a future key compromise decrypts all past messages. Signal's design is the Double Ratchet algorithm combined with the X3DH (Extended Triple Diffie-Hellman) handshake and the Sesame multi-device envelope pattern. The previous WabiDB design implemented only the static-ECDH part, which is the privacy primitive that Signal explicitly rejects.

This section defines the **v1 client-side envelope encryption with per-device recipients and Double Ratchet forward secrecy** for v1. No v1/v2 split on functionality: the full pattern is in v1. The naming is honest: this is v1 envelope + ratchet, not "Signal/Sesame" until we ship prekey bundles, the X3DH handshake, and the multi-device Sesame envelopes in their full form.

### 6.1 Identity and Device Keys

Every Wabi user has:

- **One identity keypair** (X25519 long-term). Generated on the user's first device. The private key never leaves that device. The public key is uploaded to the engine and stored in `identity_keys`.
- **One signed prekey** (X25519). Generated on the user's first device. Rotated weekly. The private key is stored only on the user's devices; the public key is uploaded to the engine. Used in X3DH initial handshakes.
- **One-time prekeys** (X25519). A pool of 100 prekeys generated on first device setup; the public keys are uploaded to the engine. Consumed one at a time during X3DH. The engine tops up the pool when it drops below 20.
- **Per-device session keys** (Double Ratchet root key + chain keys). Generated per device, per peer. Stored only on the device. Used to derive message keys.

For each device, the engine stores:

- `device_id` (ULID, server-issued on `register_device`)
- `device_name` (user-supplied label)
- `identity_key_public` (32 bytes)
- `signed_prekey_public` (32 bytes)
- `signed_prekey_signature` (Ed25519 signature of `signed_prekey_public` by `identity_key_private`; verified server-side)
- `signed_prekey_id` (monotonic; rotation increments)
- `one_time_prekey_ids_remaining` (count, decremented as consumed)
- `last_seen_at`, `created_at`, `revoked_at`

The private keys are never sent to the server. The server only holds public keys and signatures.

### 6.2 The X3DH Initial Handshake

When user A's device wants to send the first message to user B's device:

1. A fetches B's `identity_key_public`, `signed_prekey_public` (with id and signature), and a fresh `one_time_prekey_public` (with id) from the engine.
2. A verifies `signed_prekey_signature` against B's `identity_key_public` (offline, in the client). If verification fails, A aborts. This is the trust-on-first-use step.
3. A computes the X3DH shared secret:
   - `DH1 = DH(A.identity_private, B.signed_prekey_public)`
   - `DH2 = DH(A.ephemeral_private, B.identity_public)`
   - `DH3 = DH(A.ephemeral_private, B.signed_prekey_public)`
   - `DH4 = DH(A.ephemeral_private, B.one_time_prekey_public)` (if a one-time prekey is available)
   - `shared_secret = HKDF(DH1 || DH2 || DH3 || DH4)`
4. A derives the initial Double Ratchet root key from `shared_secret` and the message keys from there.
5. A encrypts the first message, marks the consumed `one_time_prekey_id` in the engine (the engine deletes it from the pool), and uploads the encrypted message.

When B's device receives the first message:

1. B fetches the consumed `one_time_prekey_id` from the message envelope.
2. B looks up its private `one_time_prekey` for that id, derives the same X3DH shared secret, and initializes the Double Ratchet.

The first message also includes the sender's `identity_key_public` and `ephemeral_public` (used in the X3DH). All subsequent messages use the Double Ratchet.

### 6.3 The Double Ratchet (Forward Secrecy)

Once the initial handshake completes, every message is encrypted with a key derived from the Double Ratchet:

- Each message has a unique message key derived from the ratchet's chain key.
- The chain key is ratcheted forward after each message.
- The ratchet "turns" (DH ratchet) every time a peer sends a message after receiving — this generates a new ephemeral DH key for the new chain.
- Compromise of the current state decrypts only the current chain, not past chains. **This is forward secrecy.**
- **Skipped key cache cap:** the Double Ratchet caches a key for any out-of-order message it receives, so it can be decrypted when the missing message arrives. This cache is bounded: `MAX_SKIPPED_KEYS = 1000` per session. If a message arrives and adding its key to the cache would exceed the cap, the message is rejected with a clear error and the client is expected to either wait for the missing messages or open a fresh session. Without this cap, a malicious peer (or a network replay attack) can exhaust server or client memory by sending thousands of out-of-order messages. The 64 KiB max plaintext size bounds the *size* of a single message but not the *number* of cached keys; this cap addresses the latter.

The per-message encryption is AES-256-GCM with a 96-bit random nonce. The AAD (additional authenticated data) includes:

```
message_id (u64)
conversation_id (string)
sender_user_id (u64)
sender_device_id (string)
recipient_user_id (u64)
recipient_device_id (string)
timestamp_micros (i64)
algorithm_version (u16)        // for forward-compatible algorithm upgrades
```

The AAD is part of the authenticated encryption. Any tampering with the metadata invalidates the ciphertext.

Algorithm versioning: every DM message stores its `body_alg` (e.g., `"x3dh-aes-256-gcm-v1"`, `"x3dh-aes-256-gcm-v2"` for a future variant). Clients reject messages with `body_alg` they don't support.

Max plaintext size: 64 KiB. Larger messages must be sent as blob attachments, not as inline DM bodies. This bounds the work a single message can do.

### 6.4 Per-Device Recipient Envelopes (Sesame Pattern)

For each DM message, the sender encrypts the body **once with a random message key**, then **wraps that message key for every authorized recipient device**.

```sql
CREATE TABLE dm_messages (
    message_id          TEXT PRIMARY KEY,         -- ULID
    conversation_id     TEXT NOT NULL,
    sender_user_id      INTEGER NOT NULL REFERENCES users(id),
    sender_device_id    TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    body_ciphertext     BLOB NOT NULL,            -- AES-256-GCM(message_key, plaintext)
    body_nonce          BLOB NOT NULL,            -- 12 bytes
    body_alg            TEXT NOT NULL,            -- e.g., "x3dh-aes-256-gcm-v1"
    deleted             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dm_message_recipients (
    message_id           TEXT NOT NULL REFERENCES dm_messages(message_id) ON DELETE CASCADE,
    user_id              INTEGER NOT NULL REFERENCES users(id),
    device_id            TEXT NOT NULL REFERENCES devices(device_id),
    wrapped_message_key  BLOB NOT NULL,            -- encrypted message key for this device
    wrap_nonce           BLOB NOT NULL,            -- 12 bytes
    wrap_alg             TEXT NOT NULL,            -- e.g., "ratchet-aes-256-gcm-v1"
    consumed             INTEGER NOT NULL DEFAULT 0,  -- 1 if the device has read it
    PRIMARY KEY (message_id, user_id, device_id)
);
```

For each authorized recipient device, the sender:
1. Has an established Double Ratchet session with that device.
2. Derives a session key from the ratchet.
3. Wraps the message key with that session key (AES-256-GCM).
4. Stores the wrapped key in `dm_message_recipients`.

When a recipient device reads the message:
1. Downloads the body and the per-device wrapped key.
2. Uses its ratchet session key to unwrap the message key.
3. Uses the message key to decrypt the body.

For users with 5 devices, each message has 1 body + 5 wrapped keys (one per recipient device, plus one for the sender's other devices if relevant). The storage overhead is small (~100 bytes per wrapped key). This is the Sesame pattern in its essence.

### 6.5 Trust-on-First-Use and Key Pinning

The server stores public keys. Without verification, a malicious server can swap keys and perform a MITM. WabiDB's design defends against this with **trust-on-first-use (TOFU) key pinning**.

For each user, each of the user's devices has a "pinned keys" record:

```sql
CREATE TABLE device_pinned_keys (
    user_id              INTEGER NOT NULL,
    device_id            TEXT NOT NULL,
    pinned_identity_key  BLOB NOT NULL,            -- 32 bytes
    pinned_signed_prekey BLOB NOT NULL,            -- 32 bytes + id
    pinned_at            INTEGER NOT NULL,
    verified_by_user     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, device_id)
);
```

When a client's first contact with a peer's device:
1. The client stores the peer's `identity_key_public` and `signed_prekey_public` in its local `device_pinned_keys`.
2. The client UI shows a "first contact with this device" warning.
3. The user can mark the device as `verified_by_user = 1` after a fingerprint comparison (see 6.6).

On subsequent contact:
1. The client fetches the peer's current public keys.
2. The client compares against the pinned keys.
3. If the keys have changed, the client shows a "key change" warning and requires explicit user confirmation before proceeding.
4. The new keys become the pinned keys after confirmation.

This is a server-side MITM mitigation. It does not protect against the user's own device being compromised. It does protect against the server (or a TLS terminator) silently swapping keys.

### 6.6 Safety Numbers (Fingerprint Comparison)

Each device pair has a "safety number" — a 60-digit decimal or QR-encoded fingerprint derived from both devices' identity keys:

```
safety_number = SHA-256(A.identity_public || B.identity_public)[:30]
                formatted as 12 groups of 5 digits
                (e.g., "12345 67890 12345 67890 ...")
```

The safety number is computed by both devices independently. If both devices show the same number, the keys are authentic. Users compare numbers in person or over a trusted channel (Signal's UX).

When a user marks a device pair as `verified_by_user = 1`, the engine records this. The UI shows a "verified" badge for that device pair.

This is in v1, not a future capability. The previous design deferred safety numbers as "future" — that's wrong. A privacy-first design requires key verification from day one.

### 6.7 Multi-Device Key Escrow (Optional)

For users with multiple devices, the previous design used an optional passphrase-based escrow for the identity key. This is **optional and user-opt-in** in v1:

- The user sets a passphrase on first device setup.
- The client derives a key from the passphrase using Argon2id (parameters: t=3, m=64MB, p=1).
- The client encrypts the identity private key with this key (AES-256-GCM).
- The wrapped blob is stored on the server in `device_key_backup`.
- On a new device, the user enters the passphrase, downloads the wrapped blob, unwraps it.

The server never sees the passphrase or the unwrapped key. If the user forgets the passphrase, the wrapped blob is unreadable, and existing DMs are inaccessible on new devices (but the user's old devices still work).

The UI must display the trade-off honestly: "Your passphrase is the only way to recover your encryption keys. Wabi cannot reset it. If you forget your passphrase, your existing DMs become unreadable on new devices."

### 6.8 Server-Side Storage

The server stores **public keys only**, never plaintext private keys:

- `identity_keys.identity_key_public` (32 bytes)
- `devices.identity_key_public` (32 bytes, may match user-level)
- `devices.signed_prekey_public` (32 bytes)
- `devices.one_time_prekey_ids` (list of consumed ids, plus remaining public keys)
- `device_pinned_keys.*` (pinned public keys, with `verified_by_user` flag)
- `dm_messages.body_ciphertext` (AES-GCM, server cannot decrypt)
- `dm_message_recipients.wrapped_message_key` (per-device wrapped, server cannot unwrap)
- `device_key_backup.wrapped_blob` (passphrase-encrypted, server cannot unwrap)

**The server never stores plaintext private keys.** It may store client-encrypted key backup blobs. The previous "server stores only public keys, never private keys" claim is corrected: the server stores public keys AND client-encrypted backup blobs. The private keys are never plaintext on the server.

### 6.9 Per-Stream Encryption (Storage Layer)

The storage layer (Section 11) encrypts each stream's segment files with that stream's own key, derived from a stream-level key registered in the `StreamKeyRegistry`. The encryption is at-rest: it protects against an attacker who gets the disk but does not have the key.

```rust
pub struct StreamKey {
    pub stream_id: StreamId,
    pub key_id: KeyId,                  // BLAKE3 of the key
    pub created_at: i64,
    pub rotated_from: Option<KeyId>,    // for rotation
    pub destroyed_at: Option<i64>,      // for retention
}
```

The key material is held only in process memory (not on disk in plaintext). The `StreamKeyRegistry` stores key ids and metadata, not keys themselves. On startup, the engine reads the registry and loads the key material from a bootstrap source (operator-supplied passphrase, OS keychain, or a sealed init blob).

The encryption boundary: every stream segment is encrypted with that stream's key before being written to disk. Decryption is on read. Key destruction (when retention expires) makes the ciphertext permanently unrecoverable.

### 6.10 Proposed Client-Only Material (Unshipped)

- Plaintext DM message content.
- Plaintext private identity keys.
- Plaintext session keys (Double Ratchet root key, chain keys).
- Plaintext message keys (only wrapped per-device copies are stored).
- Plaintext per-stream encryption keys (only key ids and metadata are stored).

### 6.11 Encryption Test Plan

The test suite for the encryption module (`wabidb::crypto` and `wabidb::stream_log::crypto`) must include:

1. **X3DH handshake roundtrip**: A and B generate identity and prekey pairs. A performs X3DH, derives initial ratchet state. B performs X3DH, derives the same state. Both produce the same root key.
2. **Double Ratchet forward secrecy**: A sends 100 messages to B. Compromise A's state at message 50. Verify messages 1-49 cannot be decrypted from the compromised state.
3. **Per-device recipient decryption**: A sends a message to B (5 devices). Each device decrypts only its own copy. Other devices' copies are not decryptable with that device's key.
4. **MITM via key swap is detectable**: A pins B's keys on first contact. Server swaps B's keys. A's client detects the change and shows a warning.
5. **Safety number consistency**: A and B both compute the safety number for the same device pair. Numbers match.
6. **Ciphertext integrity**: server-side stored ciphertext cannot be decrypted with any server-held key. Tampering with the AAD invalidates the ciphertext.
7. **Retention deletion**: when a stream's retention expires, the stream key is destroyed, and the segments are unrecoverable even with disk access.
8. **Algorithm version handling**: a v1 client rejects messages with `body_alg = "x3dh-aes-256-gcm-v2"` (future version). Both v1 and v2 messages are produced by v2 servers.
9. **Nonce uniqueness**: 96-bit random nonces are unique across all messages from a given ratchet state (the Double Ratchet guarantees this; tests verify).
10. **Max plaintext size**: messages exceeding 64 KiB are rejected by the client.

### 6.12 Call Metadata Encryption (Product Decision)

By default, call metadata (`call_sessions`, `call_participants`, `call_signals`) is stored unencrypted. The call_signals path is **ephemeral** (memory-only, never persisted). The `call_sessions` and `call_participants` durable records are stored in the clear.

For maximum-privacy servers, the engine supports an "encrypted at rest" mode where `call_sessions` and `call_participants` are encrypted with the server's at-rest key (see 6.9). The at-rest key is held in process memory while the engine runs, so live calls are still routable, but a disk dump is unreadable without the key.

Audio bytes are never stored in WabiDB. They flow through the media helper (or peer-to-peer) and are not persisted by the engine. The audio content is outside the engine's reach.

### 6.13 Client-Side Key Verification (in v1)

See 6.5 (TOFU pinning), 6.6 (safety numbers), and 6.5's "key change" warnings. All in v1, not future. The previous "future capability" framing was wrong: a privacy-first design requires key verification from day one.

## 7. The Room/Object Model

### 7.1 Bounded Set of Object Types

WabiDB defines exactly **16 core object types** in v1. This is a closed set — adding a new core type requires engine code changes. New object types beyond v1's 16 are not added to the core; they are implemented as **server addons** (Section 9.9) that use the addon primitive.

| # | Object Type | Stream + Projection Tables | Members | Permissions | Retention | Children |
|---|---|---|---|---|---|---|
| 1 | `text_channel` | `streams/channel/{id}/...` + `channels` (type=text) + `messages` + `reactions` + `message_attachments` | `channel_members` | read: member; write: member | Durable | messages, reactions, attachments |
| 2 | `voice_channel` | `streams/channel/{id}/...` + `channels` (type=voice) + `call_sessions` | `channel_members` | read: member; join: member | Session | call_sessions |
| 3 | `dm_conversation` | `streams/dm/{id}/...` + `dm_conversations` + `dm_messages` + `dm_message_recipients` | exactly 2 users | read: participant; write: participant | Durable (per-user policy) | dm_messages, recipients |
| 4 | `call_session` | `streams/call/{id}/...` (ephemeral) + `call_sessions` (durable) + `call_participants` (durable) | channel members | join: member | Session | participants, ephemeral signals |
| 5 | `whiteboard_session` | `streams/whiteboard/{id}/...` + `whiteboards` + `whiteboard_layers` + `whiteboard_elements` + `whiteboard_patches` + `whiteboard_snapshots` + `whiteboard_history` | channel members | read: member; edit: member | Durable (per-stream patch retention) | layers, elements, patches |
| 6 | `place` | `streams/place/{id}/...` + `places` + `place_layers` + `place_pois` + `place_drafts` + `place_assets` | all members | read: all; edit: admin | Durable | layers, pois, drafts, assets |
| 7 | `note` | `streams/note/{id}/...` + `notes` + `note_versions` | owner only | read/write: owner | Durable | versions |
| 8 | `kanban_board` | `streams/kanban/{id}/...` + `kanban_boards` + `kanban_tasks` + `kanban_columns` | workspace members | read: member; edit: member | Durable | tasks, columns |
| 9 | `project` | `streams/project/{id}/...` + `projects` + `sprints` | workspace members | read: member; edit: member | Durable | sprints |
| 10 | `task` | (reuses `kanban_tasks`) | board members | read: member; edit: assignee/creator | Durable | — |
| 11 | `calendar_event` | `streams/calendar/{id}/...` + `calendar_events` | workspace members | read: member; edit: owner | Durable | — |
| 12 | `album` | `streams/album/{id}/...` + `albums` + `album_items` | channel members | read: member; upload: member | Durable | items |
| 13 | `poll` | `streams/poll/{id}/...` + `polls` + `poll_votes` | scope-dependent | vote: member | Session | votes |
| 14 | `timer` | `streams/timer/{id}/...` + `timers` | scope-dependent | read: member | Session | — |
| 15 | `turn_tracker` | `streams/turn/{id}/...` + `turn_trackers` + `turn_log` | scope-dependent | move: member | Session | turn log |
| 16 | `dice_log` | `streams/dice/{id}/...` + `dice_logs` | scope-dependent | roll: member | Session | rolls |

**Object types deferred to addons (not in v1 core):** CAD, music sequencer, video editor, advanced D&D combat tracker, AI training room. These compose the core primitives; they are not core types.

**Object types not in v1 at all:** map_session (folded into place; the frontend uses OSM tiles + the `places` projection).

### 7.2 Generic Operations

Every object type supports these operations automatically, implemented as commands in the registry:

```rust
fn create_instance(ctx: CommandCtx, object_type: ObjectType, args: CreateArgs) -> Result<InstanceId, CommandError>;
fn list_instances(ctx: CommandCtx, object_type: ObjectType, scope: Scope) -> Result<Vec<InstanceSummary>, CommandError>;
fn get_instance(ctx: CommandCtx, object_type: ObjectType, instance_id: &StreamId) -> Result<InstanceDetail, CommandError>;
fn update_instance(ctx: CommandCtx, object_type: ObjectType, instance_id: &StreamId, changes: Value) -> Result<(), CommandError>;
fn delete_instance(ctx: CommandCtx, object_type: ObjectType, instance_id: &StreamId) -> Result<(), CommandError>;
```

**No SQL strings.** The generic operations dispatch through the `WabiStore` trait's domain methods. The `OBJECT_TYPES` static `HashMap` holds metadata (stream kind, primary key column, default permissions, retention class), not SQL.

The per-type handler is registered at startup:

```rust
inventory::submit! {
    ObjectTypeHandler {
        kind: ObjectType::TextChannel,
        on_create: text_channel::create,
        on_update: text_channel::update,
        on_delete: text_channel::delete,
        snapshot_shape: text_channel::snapshot,
    }
}
```

The generic operations are thin wrappers that call the registered handler. This avoids repeating CRUD for each type while keeping the implementation per-type (because the per-type logic differs).

### 7.3 Per-Type Operations

Beyond generic CRUD, each object type has type-specific commands:

- `text_channel`: `send_message`, `edit_message`, `delete_message`, `add_reaction`, `remove_reaction`, `pin_message`, `unpin_message`
- `voice_channel`: (no per-type ops beyond the generic ones; call_session is a separate type)
- `dm_conversation`: `send_dm_message`, `delete_dm_message`, `mark_dm_read`, `rotate_dm_key` (forward-secrecy rotation)
- `call_session`: `join_call`, `leave_call`, `end_call`, `mute_call_participant`, `kick_call_participant` (ephemeral signaling is not a command; it's `EmissionDurability::EphemeralMemoryOnly`)
- `whiteboard_session`: `add_whiteboard_layer`, `update_whiteboard_layer`, `delete_whiteboard_layer`, `reorder_whiteboard_layers`, `add_whiteboard_element`, `update_whiteboard_element`, `delete_whiteboard_element`, `add_whiteboard_patch`, `save_whiteboard_snapshot`
- `place`: `create_poi`, `update_poi`, `delete_poi`, `add_place_asset`, `update_place_asset`, `delete_place_asset`
- `note`: `update_note_content`, `revert_note_to_version`
- `kanban_board`: `add_kanban_task`, `update_kanban_task`, `delete_kanban_task`, `move_kanban_task`, `reorder_kanban_columns`, `update_kanban_column`
- `project`: `add_sprint`, `update_sprint`, `delete_sprint`
- `task`: (reuses `kanban_task` commands)
- `calendar_event`: `add_calendar_event`, `update_calendar_event`, `delete_calendar_event`
- `album`: `add_album_item`, `update_album_item`, `delete_album_item`
- `poll`: `add_poll_option`, `vote_poll`, `close_poll`
- `timer`: `start_timer`, `stop_timer`, `reset_timer`
- `turn_tracker`: `next_turn`, `pass_turn`
- `dice_log`: `roll_dice`

These are individually registered in the `CommandRegistry`. Each command has a typed input schema, auth rule, idempotency key requirement, DB mutations, emitted events, and failure modes (the per-command contract from Section 4).

### 7.4 The Stream-Topic Mapping

Each object type's stream id maps to one or more subscription topics:

| Object Type | Stream | Default Topics |
|---|---|---|
| `text_channel` | `streams/channel/{ulid}/events` | `channel:{ulid}:messages`, `channel:{ulid}:meta`, `channel:{ulid}:members`, `channel:{ulid}:reactions` |
| `voice_channel` | (same as text_channel) | `channel:{ulid}:call` |
| `dm_conversation` | `streams/dm/{ulid}/events` | `dm:{ulid}` |
| `call_session` | `streams/call/{ulid}/events` (ephemeral) | `call:{ulid}` |
| `whiteboard_session` | `streams/whiteboard/{ulid}/events` + `streams/whiteboard/{ulid}/snapshots` | `whiteboard:{ulid}` |
| `place` | `streams/place/{ulid}/events` | `place:{ulid}` |
| `note` | `streams/note/{ulid}/events` | `note:{ulid}` |
| `kanban_board` | `streams/kanban/{ulid}/events` | `kanban:{ulid}` |
| `project` | `streams/project/{ulid}/events` | `project:{ulid}` |
| `calendar_event` | `streams/calendar/{ulid}/events` | `calendar:{ulid}` |
| `album` | `streams/album/{ulid}/events` | `album:{ulid}` |
| `poll` | `streams/poll/{ulid}/events` | `poll:{ulid}` |
| `timer` | `streams/timer/{ulid}/events` | `timer:{ulid}` |
| `turn_tracker` | `streams/turn/{ulid}/events` | `turn:{ulid}` |
| `dice_log` | `streams/dice/{ulid}/events` | `dice:{ulid}` |

**`{ulid}` is a ULID** (or UUIDv7) — a 26-character string with no colons. The topic grammar uses `:` as a separator; if a stream id contained a colon, topic parsing would be ambiguous. The storage layer rejects any attempt to create a `StreamId` containing a colon. This is the rule from Section 5.1.

**User inbox** is its own topic family, not an object type:

| User Topic | Description |
|---|---|
| `user:{user_id}:inbox` | Friend requests, notifications, system messages for the user |

**Server-wide:**

| Server Topic | Description |
|---|---|
| `server:announcements` | Server-wide broadcasts (e.g., maintenance windows, version notices) |

### 7.5 Per-Object Type ACL

Each topic family has an `authorize_subscribe` and `authorize_receive_event` rule (Section 5.3). The default per-type ACL:

| Topic family | Default ACL |
|---|---|
| `channel:{id}:*` | caller must be a member of the channel |
| `dm:{id}` | caller must be a participant in the conversation |
| `user:{user_id}:inbox` | caller must be `user_id` (or admin) |
| `whiteboard:{id}` | caller must have whiteboard read access (channel member or explicit grant) |
| `place:{id}` | caller must have place read access |
| `kanban:{id}` | caller must be a board member |
| `project:{id}` | caller must be a workspace member |
| `calendar:{id}` | caller must have calendar access |
| `album:{id}` | caller must be a channel member |
| `poll:{id}` | depends on poll scope (channel, group, dm) |
| `call:{id}` | caller must be a call participant |
| `server:announcements` | caller must be authenticated |

The ACL is enforced server-side; clients cannot subscribe to topics they cannot access, even if they know the topic string.

### 7.6 Stream vs. Object Type

Every object type has exactly one **stream** that holds its event log (Section 2.3). The stream is the canonical record of mutations. The **projection tables** are derived state, rebuilt from the stream + snapshot. The mapping is one-to-one: one object instance = one stream id = one set of projection tables.

The stream's per-event record format (Section 11.2) is the same regardless of object type. The differences between types are:
- The `event_type` strings in the payload (e.g., `message_created`, `reaction_added`, `whiteboard_patch`).
- The `record_kind` (always `event` for object mutations; `snapshot` for snapshot records).
- The projection table layout (per object type).
- The retention class (per object type).
- The ACL (per object type).
- The topic grammar (per object type, Section 7.4).

### 7.7 The 16-Type Count is Stable

The previous design said "exactly 16 object types" in Section 7.1 but the list in some places had different counts or referenced future tables that didn't exist. The corrected design:

- 16 core types in v1, all with real tables and streams.
- `poll`, `timer`, `turn_tracker`, `dice_log` previously listed as "(Future table)" now have real tables.
- `map_session` removed (folded into `place`).
- `task` and `kanban_board` share the `kanban_tasks` table but are distinct object types.
- The count is 16, the list is 16, every type has a table.

If a v2 adds a 17th core type, the count changes and the doc is updated. Until then, **16 is the number.**

---

## 8. The Privacy and Retention Model

### 8.1 Two-Tier Data Lifecycle (Honest)

WabiDB has exactly two tiers, with a hard compile-time boundary:

1. **Durable tier**: events that go through the commit sequencer (Section 2.2) and are written to per-stream log segments + the global commit index. Survives restart. Backed up via manifest-based backup. This is the canonical source of truth. **These are `EmissionDurability::DurableEventLog`.**
2. **Ephemeral tier**: events that bypass the storage layer entirely and go through the in-memory ephemeral bus. Never written to disk. Never included in backups. Lost on crash. **These are `EmissionDurability::EphemeralMemoryOnly`.**

The previous design claimed "ephemeral" data was "written to outbox but not persisted to SQLite" — a contradiction. The new design fixes this: ephemeral events are **never** in the outbox, never in the commit index, never in any stream segment, never on disk. The `EmissionDurability` enum is a compile-time boundary enforced by the type system. A command cannot put an `EphemeralMemoryOnly` event into a `CommandCommit`. The runtime cannot route it to the stream log manager.

Per-event classification:

| Event | Tier | Storage path |
|---|---|---|
| `send_message` | Durable | Stream segment + commit index + projection |
| `add_reaction` | Durable | Stream segment + commit index + projection |
| `whiteboard_patch` | Durable | Stream segment + commit index + projection |
| `dm_message_send` | Durable | Per-recipient wrapped ciphertext in stream segment |
| `dm_message_received` | Durable | Per-recipient consumed marker in stream segment |
| `typing_start` / `typing_stop` | Ephemeral | In-memory mpsc, never written |
| `cursor_move` | Ephemeral | In-memory mpsc, never written |
| `call_signal` (SDP/ICE/renegotiation) | Ephemeral | In-memory mpsc, never written |
| `presence_heartbeat` | Durable (session class) | Stream segment + commit index, with `expires_at` |

Call signals (SDP, ICE, DTLS, codec negotiation) are **always** ephemeral. They describe the live state of a peer connection and are useless after the call ends. Persisting them would be a privacy regression.

### 8.2 Retention Classes

The retention engine operates on **stream-level** data, not table-level. Each stream has a `RetentionPolicy` describing when its segments and snapshots are eligible for destruction.

| Class | Behavior | Examples |
|---|---|---|
| `ephemeral` | Never persisted to disk. Memory-only. | Call signals, typing, cursor |
| `session` | Deleted when the originating session ends or TTL expires | Pair tokens, call participant records, presence sessions |
| `durable` | Kept until explicitly deleted by a user/admin command, or until a per-stream TTL | Messages, channels, whiteboards, user profiles, DM messages |
| `archive` | Kept until the operator purges. No user-triggered deletion. | Audit logs, deleted-message retention hold |

A stream's class is set at creation. Some streams can change class (e.g., a `durable` channel can be archived by an admin).

### 8.3 Per-Scope Retention Policies

Retention is **per-stream, never per-global-segment.** This is the design that makes the privacy/deletion story work.

```sql
CREATE TABLE retention_policies (
    policy_id    TEXT PRIMARY KEY,             -- ULID
    scope_type   TEXT NOT NULL,                -- global, channel, dm_user, object, addon
    scope_id     TEXT,                         -- NULL for global; specific id otherwise
    data_class   TEXT NOT NULL,                -- message, dm_message, patch, audit, blob
    ttl_seconds  INTEGER,                      -- NULL = no TTL (durable)
    mode         TEXT NOT NULL CHECK(mode IN ('delete', 'redact', 'archive')),
    updated_at   INTEGER NOT NULL
);
```

Examples:
- `scope_type=channel, scope_id=01J..., data_class=message, ttl_seconds=2592000, mode=delete` — channel messages auto-delete after 30 days.
- `scope_type=dm_user, scope_id=01J..., data_class=dm_message, ttl_seconds=604800, mode=delete` — user's DMs auto-delete after 7 days.
- `scope_type=addon, scope_id=wabi.cad, data_class=patch, ttl_seconds=7776000, mode=delete` — CAD patches auto-delete after 90 days.

Each expiring row stores an `expires_at` directly. The retention reaper queries by `expires_at` index, not by joining policies at reaper time. This is critical for performance: the reaper never scans large tables; it only scans the small `expires_at` index.

```sql
-- Example: messages
ALTER TABLE messages ADD COLUMN expires_at INTEGER;
CREATE INDEX idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
```

### 8.4 The Stream Retention Engine

The retention engine enforces per-stream policies. The destructive flow:

1. The engine identifies a stream whose retention has expired (or whose class is `ephemeral` and the originating session ended).
2. The engine drops all `events/*` segment files for the stream.
3. The engine drops all `snapshots/*` files older than the retention boundary.
4. The engine destroys the stream's encryption key from the `StreamKeyRegistry`.
5. The engine appends a `tombstone` record to the global commit index, recording the destruction event for audit.
6. The engine triggers a projection rebuild (the stream's indexes are cleared).

The destructive semantics: **even if disk bytes persist** (filesystem caching, backup retention, forensic recovery), key destruction makes the ciphertext permanently unrecoverable. This is the cryptographic deletion primitive.

A restore from backup that includes a destroyed stream's segments will fail decryption at the storage layer (no key to decrypt with). The backup tooling surfaces this as "stream is destroyed; cannot restore."

### 8.5 Encryption at Rest (Per-Stream Keys)

WabiDB's storage layer encrypts each stream's segment files with that stream's own key (see Section 6.9). The encryption is at-rest: it protects against an attacker who gets the disk but does not have the key.

The key material is held in process memory (not on disk in plaintext). On startup, the engine reads the `StreamKeyRegistry` (which holds key ids and metadata, not key material) and loads the keys from a bootstrap source:
- Operator-supplied passphrase (entered at startup)
- OS keychain (Linux: `secret-service`, macOS: Keychain, Windows: Credential Manager)
- A sealed init blob (encrypted with a TPM-derived key, when available)

The operator can rotate the bootstrap source. Key rotation is supported: the engine re-encrypts all stream segments with the new key, in the background, with read availability preserved.

For maximum-privacy deployments, the operator can require a passphrase on every engine startup. The engine refuses to start without it. The passphrase never touches disk.

### 8.6 No Telemetry That Phones Home

WabiDB has zero telemetry. No usage statistics, no crash reports, no analytics. Logs are written to local files only, controlled by the `RUST_LOG` environment variable. Crash reports, if enabled by the operator, are stored locally and only sent if the operator configures a remote sink.

### 8.7 DM Message Retention (Per-Stream)

DM messages live in `dm_*` streams, one per conversation. The retention engine applies the **union of per-user policies**: a message is retained as long as at least one participant's policy has not expired.

```sql
-- dm_messages (per the new schema in Section 6.4)
CREATE TABLE dm_messages (
    message_id          TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    sender_user_id      INTEGER NOT NULL,
    sender_device_id    TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    expires_at          INTEGER,                 -- union of per-user policies
    body_ciphertext     BLOB NOT NULL,
    body_nonce          BLOB NOT NULL,
    body_alg            TEXT NOT NULL,
    deleted             INTEGER NOT NULL DEFAULT 0
);
```

The `expires_at` is computed when the message is created, based on the per-user retention settings at that time. When a user changes their retention policy (e.g., from `forever` to `7_days`), the engine recomputes `expires_at` for messages they haven't yet hit the new policy on. When both participants' policies have expired, the engine sets `deleted = 1` and the projection engine filters the message out of reads. The actual segment bytes and key are destroyed on the next compaction cycle (or immediately, if the user explicitly requests "delete all my DMs").

The "delete all my DMs" command is **immediate** and **cryptographic**: it triggers key destruction for the affected conversation streams, regardless of any per-user policy.

### 8.8 No Cross-Snapshot Content-Addressing

WabiDB's manifest-based backup (Section 11.5) does not use content addressing or deduplication. Each backup is a complete, independent copy of the data directory + manifest. This eliminates cross-backup hash linkability, which is a privacy concern with STDB's snapshot hardlink deduplication.

### 8.9 Performance, Load-Shedding, and the Single-Writer Reality

The custom per-stream + global index architecture has a different performance profile than SQLite. Honest characterization:

- **Commit throughput**: limited by the global commit sequencer (single ordering point). Realistic sustained throughput is **5,000-10,000 commits/sec** on a modern NVMe with per-stream fsync, batched event writes, and the commit index fsync'd once per batch.
- **Per-stream parallelism**: appends to different stream segments can happen in parallel. The commit sequencer is the bottleneck for total commit throughput, not for per-stream bandwidth.
- **Reads**: bounded by the projection engine's index lookups. The custom indexes are skiplists/B-trees, not SQL; the read path is direct, not interpreted.
- **Memory**: the in-memory state is the projection engine + ephemeral bus + the cached active segment tails. A 10,000-message channel's projection fits in MB.
- **Disk I/O**: fsync per segment append, plus fsync of the commit index per batch. The commit index fsync is the main bottleneck.

For Wabi's expected scale (a single Wabi server with 100-1,000 concurrent users, ~10-50 active in any given room), this is comfortably within budget. The previous estimate of "~1,000 writes/sec on SQLite" is replaced by a different ceiling (5,000-10,000 commits/sec on per-stream + global index), with parallel per-stream appends as a structural win.

**Load-shedding strategy.** When the commit sequencer falls behind the producer:

1. **Per-subscriber backpressure** (Section 5.10): a slow subscriber's channel fills, gets a backpressure frame, and is dropped after 5 seconds.
2. **Commit backlog cap**: if the unprocessed commit queue exceeds a configured threshold (default 50,000), the engine enters degraded mode. Non-essential commands return `CommandError::EngineBusy` with a `retry_after_ms` hint. Essential commands (send_message, set_presence) continue to be accepted.
3. **Adaptive batching**: the commit sequencer's batch size grows with backlog to drain faster; with low backlog it shrinks to keep latency low.
4. **Search helper resilience**: the search helper uses `consumer_offsets` (Section 5.5). If the helper is down, the engine keeps committing. The helper resumes from its checkpoint on reconnect. There is no "stop enqueueing" path.
5. **Per-object write rate limit**: each object instance has a configurable write rate limit (e.g., 100 writes/sec on a single whiteboard). Excess writes are dropped with a warning.

**Future scaling options** (not v1):

- **Per-stream sharding** of the global commit index: if the sequencer becomes a bottleneck, the index can be sharded by hash(`stream_id`) modulo N, with multiple sequencers coordinated via a two-phase commit. This is a v2 architecture.
- **Helper-node write absorption**: helper nodes can absorb write traffic for high-frequency subsystems (e.g., the media helper absorbs call signaling, leaving the engine to handle only committed state).
- **Per-channel segment parallelism**: currently per-stream appends are parallel, but compaction is single-stream. A future v2 could parallelize compaction across segments within a stream.

The honest answer: for a small community server, none of this is needed. The per-stream + global index architecture scales further than SQLite did, but the load-shedding mechanisms are still needed for safety.

### 8.10 Whiteboard and CAD Patch Retention

Whiteboards and CAD sessions produce append-only patch logs. Without a trim policy, these grow unboundedly. The retention is per-stream and uses `expires_at`:

```sql
-- whiteboard_patches
ALTER TABLE whiteboard_patches ADD COLUMN expires_at INTEGER;
CREATE INDEX idx_wb_patches_expires ON whiteboard_patches(expires_at) WHERE expires_at IS NOT NULL;
```

Per-stream retention policy for whiteboards and CAD:

- `patch_retention_days` (default 30 for whiteboards, 90 for CAD)
- `max_patches` (default 100,000)
- `mode = delete`

The retention engine drops the stream's segments past `expires_at`. If the total patch count exceeds `max_patches`, the snapshot manager triggers a consolidation (see 8.11).

### 8.11 Snapshot Consolidation for Patch Logs

A scheduled engine task `consolidate_whiteboard_patches` (runs every 6 hours by default) does the following:

1. Counts the patches in each `whiteboard_*` and `cad_*` stream.
2. If a stream has more than `max_patches` patches, the snapshot manager computes a fresh snapshot (the current full state) and appends a `snapshot` record to the stream's segment log.
3. The retention engine then drops patches older than the most recent snapshot.
4. The projection engine rebuilds from the snapshot.

The snapshot is the canonical state; the remaining patches are the diff from the snapshot. Late-joiners receive the snapshot first, then any subsequent patches.

The trade-off: consolidation loses fine-grained history (you cannot replay the whiteboard state from 3 weeks ago). For audit or rollback needs, the engine keeps a separate `whiteboard_history` stream (configurable) that snapshots the full state every N hours. Default: daily history snapshot retained for 1 year.

### 8.12 Bounded Growth for Other Append-Only Logs

Other append-only structures:

- `dm_message_*` streams: per-stream encryption key destruction on retention expiry (Section 8.4).
- `audit_log` stream: archive class. Operator-purgeable only. Default retention 1 year.
- `call_sessions`, `call_participants` streams: session class. Cleared when the call ends.
- `call_signals` (if any survive to disk, which they should not): ephemeral, never persisted.
- `presence_sessions` stream: session class. TTL-driven, default 5 minutes after last heartbeat.
- `consumer_offsets` table: durable, but periodically pruned (offsets older than the retention window are deleted).

### 8.13 SQLite Hard Delete Is Not Forensic-Secure Deletion

This applies to the storage layer's reads, not the previous SQLite-based design. The custom storage layer's deletion is **cryptographic** (key destruction), not logical. Even a forensic recovery of the disk does not recover the plaintext once the key is destroyed. The engine documents this clearly: "Once a stream's retention has expired, the data is cryptographically erased. Backup retention may keep encrypted bytes, but they are unrecoverable without the destroyed key."

---

## 9. The Helper-Node Protocol

### 9.1 Protocol Surface

The helper-node protocol is not a full networking stack — it is a set of commands, data types, and expected behaviors that helper nodes use to pair, authenticate, and communicate with the WabiDB authority. The actual transport is TLS (mutual TLS for helper-to-authority communication, or a WebSocket upgrade if behind a load balancer).

### 9.2 Node Types

| Type | Purpose | Capabilities |
|---|---|---|
| `media` | Relay audio/video streams (SFU/TURN) | `relay:audio`, `relay:video`, `relay:screen` |
| `search` | Full-text search index (external Elasticsearch/Meilisearch) | `search:messages`, `search:channels` |
| `transcode` | Convert media between formats | `transcode:audio`, `transcode:video`, `transcode:image` |
| `cache` | CDN/caching layer for file attachments and avatars | `cache:static`, `cache:media` |
| `anchor` | Regional network anchor for latency reduction | `anchor:relay`, `anchor:turn` |

### 9.3 Pair-Token Issuance

The authority operator runs:

```
wabi-node helper pair --type media --capabilities '["relay:audio","relay:video"]' --ttl 3600
```

This generates a one-time `pair_token` (a random 32-byte secret). The engine stores the **BLAKE3 hash** of the token, not the raw token, plus metadata:

```sql
CREATE TABLE pair_tokens (
    token_hash       BLOB PRIMARY KEY,             -- BLAKE3 of the raw token
    node_kind        TEXT NOT NULL,                -- 'media' | 'search' | 'transcode' | 'cache' | 'anchor'
    capabilities     TEXT NOT NULL,                -- JSON array
    issued_at        INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,
    redeemed         INTEGER NOT NULL DEFAULT 0,
    redeemed_at      INTEGER,
    redeemed_by_node TEXT,                         -- the assigned node_id
    created_by       TEXT NOT NULL                 -- operator user
);
```

The raw token is printed to stdout once. The operator conveys it to the helper operator out-of-band. The engine never stores the raw token. If the database is dumped, the pair tokens cannot be redeemed.

### 9.4 Route Token Redemption (Atomic)

The helper connects to the authority and redeems the pair token. Redemption is **atomic**: the engine's UPDATE statement must affect exactly one row, otherwise the request is rejected:

```sql
UPDATE pair_tokens
SET redeemed = 1, redeemed_at = ?, redeemed_by_node = ?
WHERE token_hash = ? AND redeemed = 0 AND expires_at > ?;
```

If the affected row count is 0, redemption fails. This prevents double-redeem races and ensures each pair token is used at most once.

On successful redemption, the engine creates a `helper_nodes` row and a `route_token`. The route token is a signed payload (Ed25519) with the helper's identity, capabilities, and expiry. The engine returns the **raw** route token to the helper once. The engine stores the **hash** of the route token, not the raw:

```sql
CREATE TABLE route_tokens (
    token_id          TEXT PRIMARY KEY,            -- ULID
    token_hash        BLOB NOT NULL UNIQUE,        -- BLAKE3 of the raw route token
    node_id           TEXT NOT NULL,
    node_kind         TEXT NOT NULL,
    capabilities      TEXT NOT NULL,               -- JSON array
    issued_at         INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    revoked           INTEGER NOT NULL DEFAULT 0,
    revoked_at        INTEGER,
    revoked_reason    TEXT
);

CREATE TABLE helper_nodes (
    node_id           TEXT PRIMARY KEY,            -- ULID, server-issued
    node_kind         TEXT NOT NULL,
    node_name         TEXT NOT NULL,               -- human-readable label
    public_key        BLOB NOT NULL,               -- Ed25519 (for signed messages)
    first_seen_at     INTEGER NOT NULL,
    last_heartbeat_at INTEGER,
    last_status       TEXT,
    current_connections INTEGER,
    bandwidth_mbps    REAL,
    load_pct          REAL,
    active            INTEGER NOT NULL DEFAULT 1
);
```

The helper stores the raw route token and presents it on every subsequent request as a `Authorization: Bearer <token>` header. The engine validates the token by hashing the presented value and looking up the hash in `route_tokens`.

**No raw secrets are stored anywhere on the server.**

### 9.5 Route Token Shape

```json
{
  "iss": "wabi-authority",
  "sub": "media-01",
  "aud": "wabi-media-node",
  "iat": 1750000000,
  "exp": 1781536000,
  "capabilities": ["relay:audio", "relay:video"],
  "node_identity": "<public_key_fingerprint>"
}
```

Signed with the authority's Ed25519 key (stored in a config file, never in the database).

### 9.6 Heartbeat

Every 30 seconds, the helper sends:

```
POST /v1/helpers/heartbeat
{
  "node_id": "media-01",
  "status": "healthy",
  "current_connections": 42,
  "bandwidth_mbps": 850,
  "load_pct": 0.65
}
```

The authority updates the `helper_nodes` row's `last_heartbeat` and returns the current revocation list (empty unless there are revocations). If the authority receives no heartbeat for 90 seconds (3 intervals), the helper is marked `offline`.

### 9.7 Revocation

The authority operator runs:

```
wabi-node helper revoke --node-id media-01
```

This sets `route_tokens.revoked = 1` for the node's active token. On the next heartbeat, the authority includes this token ID in the revocation list. The helper sees the revocation and stops accepting work. The helper should also periodically check revocation independently (every 5 minutes, fetch the revocation list from the authority).

### 9.8 Why This Exists in v1

Retrofitting helper-node awareness into a database engine that assumed a single-process model is much harder than designing for it from the start. STDB has no helper concept — adding it would require modifying the core transaction pipeline, the WebSocket handler, and the binary interface. WabiDB's helper protocol is a thin layer of tables + commands + a clock-driven heartbeat checker, totaling fewer than 500 lines of engine code. The actual helper communication (media relay, search indexing, etc.) happens at the wabi-server level, not inside WabiDB.

### 9.9 The Addon Object Primitive

WabiDB has a fixed set of core object types (text_channel, dm_conversation, call_session, map_session, whiteboard_session, note, poll, timer, turn_tracker, dice_log, album, place, kanban_board, project, task, calendar_event — 16 types). But Wabi will want complex feature rooms that don't fit this fixed set: CAD, music sequencer, video editor, advanced D&D combat tracker, AI training room. The "Minecraft redstone, not arbitrary kernel modules" boundary forbids uploading arbitrary server code at runtime, so these need a different mechanism.

The mechanism is the **addon object primitive**: one new engine table, one manifest format, one build-time registration pattern. Addons compose engine primitives; they don't add new engine features.

#### The `addon_object` table

```sql
CREATE TABLE addon_object (
    id              INTEGER PRIMARY KEY,
    addon_id        TEXT NOT NULL,                -- e.g. "wabi.cad"
    room_id         INTEGER NOT NULL,             -- the room this object belongs to
    data_blob_hash  BLAKE3,                       -- actual data in the blob store
    data_schema_id  TEXT NOT NULL,                -- schema version for migration
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER,                      -- optional TTL
    created_by      INTEGER NOT NULL,             -- user id
    deleted_at      INTEGER
);

CREATE INDEX idx_addon_object_room ON addon_object(addon_id, room_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_addon_object_expires ON addon_object(expires_at)
    WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
```

The engine does not interpret `data_blob_hash`. The blob is the addon's data, in whatever format the addon defines. The engine stores it, indexes it by `(addon_id, room_id)`, and broadcasts changes through the outbox.

#### The build-time manifest

Each addon is a Rust crate compiled into the engine binary at build time. The crate exposes a manifest:

```rust
// cad_addon/src/lib.rs
pub struct CadAddon;

impl Addon for CadAddon {
    fn id() -> &'static str { "wabi.cad" }
    fn version() -> &'static str { "0.1.0" }

    fn manifest() -> AddonManifest {
        AddonManifest {
            id: "wabi.cad",
            version: "0.1.0",
            data_schemas: schemas![
                cad_session_schema,
                cad_part_schema,
                cad_dimension_schema,
                cad_constraint_schema,
                cad_layer_schema,
                cad_view_schema,
                cad_user_viewport_schema,
            ],
            commands: commands![
                create_cad_session,
                add_part,
                set_dimension,
                add_constraint,
                solve_constraints,
                save_view,
                set_viewport,
                select,
                add_comment,
            ],
            topics: topics![
                "cad:{session_id}:state",
                "cad:{session_id}:viewport:{user_id}",
                "cad:{session_id}:presence",
            ],
            required_capabilities: vec![
                "can_create_cad_session",
                "can_edit_cad",
                "can_view_cad",
            ],
        }
    }
}
```

At engine startup, the manifest is registered. The engine validates the manifest (no duplicate command names, no conflicting topic grammars, all declared capabilities are valid). The addon's commands become part of the command registry. The addon's topics become part of the topic grammar. The addon's data schemas become known to the migration tool.

#### Build-time linking, not runtime upload

Addons are linked at build time, not uploaded at runtime. There is no "install addon" operation on a running server. The server admin enables an addon by:

```
# Add the addon to Cargo.toml
[dependencies]
wabidb-cad = { path = ".../cad_addon" }

# Add the feature to wabi-server
wabi-server = { features = ["cad", "music"] }
```

Or, if addons are statically compiled into a single binary, by building with `--features=cad,music`. The server admin's choice is a deployment decision, not a runtime decision.

This is more conservative than a runtime plugin system. It is also simpler, more secure, and easier to reason about. The server admin knows exactly what code is in their server because it is all compiled together. There is no class of attack "attacker uploads malicious addon to the server."

If a future Wabi needs runtime addons, that is a different architecture (STDB's WASM model). WabiDB explicitly chose the build-time model because it fits the self-hosted trust model: you trust the code you compiled, period.

#### Capability model

Each command in an addon declares the capability required to invoke it. The engine checks the caller's capability set against the command's required capability before running the command. If the check fails, the command returns `CommandError::PermissionDenied` and no state mutation occurs.

Capabilities are mapped to roles by the server admin (via existing RBAC, see Section 3.15). A user with the `cad_user` role has the `can_create_cad_session` and `can_edit_cad` capabilities. A user without the role has neither, and the engine refuses their `add_part` command.

The frontend also uses capabilities to decide which UI to show. If a user lacks `can_edit_cad`, the CAD component renders in read-only mode.

#### What this gives addon authors

- **Typed commands**: addon commands have typed inputs and outputs, validated at compile time.
- **Transactional state**: addon commands participate in WabiDB's transaction model. If the command fails, the state mutation and the outbox rows roll back atomically.
- **Live subscriptions**: addon topics work the same as core topics. Subscribers receive initial snapshots and incremental updates.
- **Retention**: addon objects support all four retention classes (ephemeral, session, durable, archive).
- **Encryption at rest**: addon objects live in the same SQLite database, so operator-side disk encryption applies.
- **Migration: addon data schemas are versioned. When the addon's schema changes, the addon provides a migration file. The same migration tool (`refinery` or `sqlx-migrate`) handles it.
- **No engine features added**: the engine stays the same. The `addon_object` table is the only new core primitive. Everything else is addon code.

#### What this does NOT give addon authors

- **Hot-load addons**: you rebuild the binary to add an addon. The server does not load code at runtime.
- **Third-party addons from strangers**: you have to trust the source code you compile in. The engine does not sandbox addon code; it runs in the same process.
- **Custom SQL queries**: addons use the engine's typed accessors, not raw SQL. The data schemas are declared in Rust, validated at compile time.
- **Custom migration logic**: addon migrations are SQL files run by the same tool as core migrations.
- **Custom subscription topics beyond the declared grammar**: addons can declare new topics at build time, but cannot add new topic patterns at runtime.

#### The CAD example as a worked instance

A "wabi.cad" addon, as described above, would be roughly 3,000-5,000 lines of Rust in `wabidb-cad` plus 50,000-100,000 lines of frontend TypeScript. The Rust code provides: the data schemas (cad_session, cad_part, etc.), the commands (create_cad_session, add_part, etc.), and the topic grammar. The frontend code provides: the CAD component (Three.js, OpenCascade.js, IFC.js), the dimension UI, the layer panel, the comment system, the per-user viewport state.

The engine is unchanged. The frontend gains a new "CAD" tab for users with the `can_view_cad` capability. The data flows through the same outbox and subscription engine. The retention engine handles TTL. The encryption engine handles per-recipient DM messages (if CAD supports comments-as-DM).

Server admins who don't want CAD don't link the `wabidb-cad` crate. Their binary does not have the CAD commands, the CAD topics, or the CAD data schemas. The base Wabi experience is unchanged.

#### Why this is in v1, not v2

The decision to include the addon primitive in v1 (not retrofit later) is the same as the helper-node decision: a one-time cost now is much less than a retrofit cost later. The `addon_object` table is one table. The manifest is one struct. The registration is one function. Total: ~1,500-2,000 lines of engine code.

The cost of retrofitting later: every command, every subscription, every state read needs to think about whether it is core-only or addon-callable. Every test needs to cover both paths. Every migration needs to handle "what if an addon needs a new column on a core table." That retrofit is much more expensive than the v1 cost.

---

## 10. The API Surface

### 10.0 The Clean Boundary

The previous design was contradictory: it said "raw WebSocket, no Socket.IO," "frontend never talks to the engine directly," "frontend talks to wabi-server Socket.IO layer," and "engine validates JWT from query string." The corrected boundary is unambiguous:

```
Browser
  ↕ WebSocket (with ticket auth, no JWT in query)
Wabi-server (Socket.IO optional, or raw WS)
  ↕ direct Rust function calls (in-process) or Unix domain socket (sibling process)
WabiDB engine
  ↕ reads/writes
Custom per-stream + global index storage
  ↕ segment files on disk
```

The engine does not know about WebSockets, JWTs, or HTTP. Wabi-server handles all network concerns. The engine is a Rust library that exposes a `WabiStore` trait and a command registry.

### 10.1 Rust API: The WabiStore Trait and Command Registry

Wabi-server embeds the engine and calls it through a small surface:

```rust
pub trait WabiStore: Send + Sync {
    /// Append a commit: write events to per-stream segments and the global commit index.
    /// Returns the assigned commit_seq on success.
    fn append_commit(&self, commit: CommandCommit) -> Result<CommitSeq, StorageError>;

    /// Read events for a topic starting after a given commit_seq.
    fn get_events_after(&self, topic: &Topic, after: CommitSeq, limit: usize) -> Vec<EventEnvelope>;

    /// Read channel messages for a channel, before a timestamp.
    fn get_channel_messages(&self, channel_id: &str, before: i64, limit: usize) -> Vec<MessageRecord>;

    /// Read DM messages for a conversation.
    fn get_dm_messages(&self, conversation_id: &str, before: i64, limit: usize) -> Vec<DmMessageRecord>;

    /// Read whiteboard snapshot.
    fn get_whiteboard_snapshot(&self, board_id: &str) -> Option<WhiteboardSnapshot>;

    /// Read place snapshot.
    fn get_place_snapshot(&self, place_id: &str) -> Option<PlaceSnapshot>;

    /// Read kanban board state.
    fn get_kanban_state(&self, board_id: &str) -> Option<KanbanState>;

    /// Read user profile.
    fn get_user(&self, user_id: u64) -> Option<UserRecord>;

    /// Read channel members.
    fn get_channel_members(&self, channel_id: &str) -> Vec<ChannelMemberRecord>;

    /// Idempotency check: did this caller already execute this client_request_id?
    fn check_idempotency(&self, caller: u64, client_request_id: &str) -> Option<CommandResult>;

    /// Consumer offset operations for reliable consumers.
    fn get_consumer_offset(&self, consumer_id: &str, topic_pattern: &str) -> Option<u64>;
    fn commit_consumer_offset(&self, consumer_id: &str, topic_pattern: &str, last_seq: u64) -> Result<(), StorageError>;

    /// Per-stream storage operations.
    fn list_streams(&self) -> Vec<StreamSummary>;
    fn get_stream_key(&self, stream_id: &str) -> Option<StreamKey>;
    fn destroy_stream(&self, stream_id: &str) -> Result<(), StorageError>;
}
```

Plus a separate command registry:

```rust
pub trait CommandRegistry {
    fn register(&mut self, name: &'static str, handler: Box<dyn CommandHandler>);
    fn invoke(&self, name: &str, ctx: &CommandCtx) -> Result<CommandCommit, CommandError>;
    fn list(&self) -> Vec<(&'static str, &CommandMetadata)>;
}
```

**The `WabiStore` is a domain API, not a SQL wrapper.** Commands call `ctx.storage.get_channel_messages(channel_id, before, limit)`. They never see segment files, offsets, fsync, manifests, or index compaction. The storage layer is replaceable behind the trait.

**In embedded mode**, this is a direct function call in the same process:

```rust
let engine = WabiDbEngine::open("/var/lib/wabi/wabidb").await?;
let result = engine.invoke("send_message", &ctx).await?;
```

**In sibling-process mode**, the same `WabiStore` trait is exposed over a Unix domain socket using a BSATN-framed request/response protocol. The engine binary runs as a separate process; wabi-server connects via the socket. This mode exists for operational isolation but is not the primary deployment.

### 10.2 WebSocket Auth: No JWT in URL (P1-2)

The previous design put JWTs in the WebSocket URL: `wss://server/ws?token=<jwt>`. This is a security smell. OWASP specifically calls out sensitive tokens in URLs because they leak through:
- Web server access logs
- Browser history
- Referer headers
- TLS-terminator logs
- Reverse-proxy logs

**The new design uses a one-time WebSocket ticket.**

#### 10.2.1 Auth Flow

1. Client authenticates to the HTTP endpoint over HTTPS, using a session cookie or Authorization header.
2. Client requests a WebSocket ticket:

```
POST /v1/ws-ticket
Cookie: session=<session_cookie>
Authorization: Bearer <access_token>   // either works

→ 200 OK
{
  "ticket": "01J...",
  "expires_in": 15
}
```

The ticket is:
- 16 random bytes encoded as base64url
- Stored server-side with `expires_at = now + 15s`, `used = 0`, `caller_user_id = authenticated_user`
- One-time: redeeming it sets `used = 1` atomically (the same pattern as pair token redemption)

3. Client opens the WebSocket with the ticket:

```
wss://server/ws?ticket=01J...
```

4. Server validates the ticket: hash the presented value, look up the hash in the `ws_tickets` table, check `used = 0` AND `expires_at > now`. On success, mark `used = 1` and associate the connection with the ticket's caller identity.

5. After authentication, the WebSocket sends the same `ClientMessage` / `ServerMessage` flow described in Section 5.8.

#### 10.2.2 Why Not Just Use the Session Cookie?

WebSocket auth via cookie is supported by browsers, but cookies add:
- CSRF concerns (not relevant for WebSockets but applies if cookies are also used for HTTP)
- Cookie size limits
- Issues with WebSocket libraries that strip cookies

The ticket pattern keeps the WebSocket URL clean, makes the auth flow explicit, and gives a clean recovery story (just re-fetch a ticket).

#### 10.2.3 Limits

- Tickets are valid for 15 seconds.
- A ticket can be redeemed exactly once.
- A failed redemption (expired, used, not found) closes the WebSocket with code 4401.
- Unauthenticated WebSocket connections are rate-limited: max 5 per IP per minute. Excess are dropped.

#### 10.2.4 Refreshing Long-Lived Sessions

For long-lived sessions (a chat user staying connected for hours), the client periodically refetches a new ticket before the current one expires. The protocol is:

```
ServerMessage { AuthRefresh { new_ticket: "...", expires_in: 15 } }
```

The client receives this ~5 seconds before ticket expiry and uses the new ticket on the next reconnect. The WebSocket itself doesn't need to be reconnected; only the auth state is refreshed.

### 10.3 WebSocket Connection Lifecycle

1. Client opens `wss://server/ws?ticket=01J...`.
2. Server validates the ticket atomically. On success, sends `AuthOk { caller, resume_token }`. On failure, closes with 4401.
3. Client sends `Subscribe { filters, resume_after }`.
4. Server captures `snapshot_barrier`, fetches snapshots, sends `Subscribed`.
5. Bidirectional message exchange: `Update`, `Command`, `CommandResult`, `Backpressure` (on the control channel).
6. On disconnect, server removes the subscriber.

### 10.4 HTTP API (Browser to Wabi-Server)

The HTTP API is wabi-server's surface to the browser, not to the engine. It supports:

- `POST /v1/auth/login` — username/password → session cookie
- `POST /v1/auth/logout`
- `POST /v1/auth/register`
- `POST /v1/ws-ticket` — exchange session for WebSocket ticket (Section 10.2)
- `GET /v1/blobs/{hash}` — range-read blobs (Section 11.7)
- `GET /v1/users/{id}` — user profile
- `GET /v1/channels/{id}/messages` — paginated message history
- `POST /v1/uploads` — initiate file upload, returns upload URL
- `GET /v1/search?q=...` — text search (proxied to the search helper, or fallback to engine substring scan)

All browser-facing HTTP endpoints accept the session cookie OR an Authorization header with a session token. The session is server-side, stored in the engine with a `session_token_hash` (BLAKE3). The raw token is never stored.

### 10.5 HTTP Admin API (Local-Only by Default)

The admin API is for server operators, not users. It is bound to **127.0.0.1** by default (or a Unix socket). It does not bind to public interfaces unless the operator explicitly enables it.

- `POST /v1/admin/pair-token` — issue a helper pair token
- `POST /v1/admin/helpers/revoke` — revoke a helper route token
- `POST /v1/admin/retention` — set retention policy
- `GET /v1/admin/stats` — engine statistics
- `POST /v1/admin/backup` — trigger an immediate manifest-based backup
- `POST /v1/admin/restore` — restore from a backup (requires explicit confirmation; not idempotent)
- `GET /v1/admin/audit-log` — recent admin actions

The admin API requires an **admin API key** in the `Authorization: Bearer <admin_key>` header. The admin key is configured in the server config file (or a sealed init blob). The key is BLAKE3-hashed and stored; the raw value is not in the database. Every admin action is logged to `audit_log`.

If the operator needs to expose the admin API to a remote location (e.g., a dashboard), they should:
- Put a reverse proxy in front with mTLS or a stronger auth
- Bind to a non-default port
- Use the audit log to monitor access

The engine refuses to bind the admin API to a non-loopback address unless `WABIDB_ADMIN_ALLOW_REMOTE=true` is set in the environment, and even then, the operator is warned at startup.

### 10.6 Why No Socket.IO

The previous design kept Socket.IO for compatibility with the existing frontend. The new design says: use raw WebSocket, with the client message protocol described in Section 5.8. Socket.IO adds a translation layer for no architectural benefit:

- It does not improve security (ticket auth is the same).
- It does not improve performance (BSATN framing is faster than Socket.IO's JSON framing).
- It does not improve reliability (the WebSocket reconnect + resume protocol is sufficient).

If the frontend is already on Socket.IO, wabi-server can keep a Socket.IO adapter that translates Socket.IO frames to WabiDB client messages. But the engine speaks raw WebSocket.

---

## 11. The Storage Engine Detail

This section is the most important change in the corrected design. The previous version was a SQLite-wrapping design with WAL-mode journal, an SQL schema, refinery migrations, and an FTS5 virtual table. That design is replaced by a custom per-stream log-structured object/event store with a global commit index. There is no SQLite, no SQL, no SQL planner, no FTS5. The storage layer is Wabi's own code, on Wabi's file format, with Wabi's recovery rules.

### 11.1 Storage Architecture Overview

The storage layer is implemented as a Rust crate `wabidb::storage` and is the only component that touches disk. All other components interact with the storage layer through the `WabiStore` trait (Section 2.12) — they do not know about segment files, offsets, fsync, manifests, or index compaction.

**On-disk layout (Section 2.3).** The storage layer writes to a single data directory:

```
{data_dir}/
  global/
    commit-index/
      00000001.widx
      00000002.widx
  streams/
    channel/
      ch_01J.../
        events/
          00000001.wseg
          00000002.wseg
        snapshots/
          00000004.wsnap
    dm/
      dm_01J.../
        events/
          00000001.wseg
        snapshots/
          00000002.wsnap
    whiteboard/
      wb_01J.../
        patches/
          00000001.wseg
        snapshots/
          00000003.wsnap
  blobs/
    ab/
      abcd....bin
      abcd....meta
  manifests/
    storage-manifest.json
```

**Layered components.** The storage layer consists of:

- **Stream log manager** (`wabidb::stream_log`): appends per-stream segment records. fsync ordering. Segment rotation. Per-stream encryption.
- **Global commit index** (`wabidb::commit_index`): append-only index mapping `commit_seq` to event refs. The only writer is the commit sequencer.
- **Projection engine** (`wabidb::projections`): applies events to materialized state. Fixed skiplist/B-tree indexes. Rebuildable from log + snapshots.
- **Snapshot manager** (`wabidb::snapshots`): writes per-stream snapshots. Anchors projection rebuilds.
- **Retention/compaction** (`wabidb::retention`): per-stream policy enforcement, key destruction, segment compaction.
- **Blob store** (`wabidb::blobs`): content-addressed immutable files. BLAKE3 keyed. Range-read capable.

### 11.2 Stream Segment Record Format

Every record written to a stream segment has the same format:

```rust
struct RecordHeader {
    magic: [u8; 4],          // "WABI" (0x57414249)
    format_version: u16,     // current: 1
    header_len: u16,         // current: 36 bytes
    record_kind: u16,        // 1 = event, 2 = snapshot, 3 = tombstone, 4 = checkpoint
    flags: u16,              // reserved (0)
    commit_seq: u64,         // matches the global commit index entry
    stream_id_hash: [u8; 16], // BLAKE3 of stream_id, truncated
    payload_len: u32,        // length of payload in bytes (max 16 MiB per record)
    header_crc32c: u32,      // CRC32C of header bytes
    payload_crc32c: u32,     // CRC32C of payload bytes
}
// followed by `payload_len` bytes of payload
// followed by zero-pad to next 16-byte boundary
```

Total header: 36 bytes. Records are padded to 16-byte alignment. The magic, version, and CRCs let recovery truncate at the first invalid record.

A stream segment is **valid** iff:
- The header magic matches
- The format version is supported
- Both CRCs match the data

A stream segment is **invalid** otherwise. Recovery scans sequentially, truncates at the first invalid record, and resumes from the last valid offset. The committed events referenced by valid records are unaffected; the truncated tail is ignored.

### 11.3 The Global Commit Index

The commit index is an append-only sequence of records, each entry:

```rust
struct CommitIndexEntry {
    commit_seq: u64,                  // monotonic, no gaps in committed sequence
    timestamp_micros: i64,            // server time when the commit was assigned
    caller_user_id: u64,              // user_id, 0 = system
    caller_device_id_hash: [u8; 16],  // BLAKE3 of device_id
    command_name_hash: [u8; 16],      // BLAKE3 of command_name
    idempotency_key_hash: Option<[u8; 32]>,  // BLAKE3 of (caller, key)
    event_refs: Vec<StreamRef>,       // 1..N events in this commit
    payload_hashes: Vec<[u8; 32]>,    // BLAKE3 of each event payload
}

struct StreamRef {
    stream_id_hash: [u8; 16],         // BLAKE3 of stream_id
    stream_kind: u8,                  // 1=channel, 2=dm, 3=whiteboard, 4=place, 5=kanban, 6=other
    segment_id: u64,                  // which segment file
    offset: u64,                      // byte offset within the segment
    length: u32,                      // payload length
}
```

The commit index is stored as `.widx` files in the `global/commit-index/` directory. Each file holds up to 10,000 entries. Older files are sealed; new files are created. Recovery loads the latest file plus any in-progress append.

The commit index is **fsync'd once per batch** (default: 10 entries per batch, or 50ms, whichever comes first). Single-entry fsync per commit would be too slow; per-batch fsync is the right tradeoff for the durability guarantee. The full batch is durable before the command returns.

### 11.4 Per-Stream Encryption

Each stream's segments are encrypted with that stream's own key, derived from a `StreamKey` registered in the `StreamKeyRegistry` (Section 6.9). The encryption is AES-256-GCM with a 12-byte nonce, where the nonce is the record's `commit_seq` as a little-endian u64 padded to 12 bytes. The AAD is the `RecordHeader` itself.

This makes the encryption deterministic per record (the nonce is derived from `commit_seq`, which is unique), which means recovery can find and decrypt any record without storing a per-record nonce. It's also semantically meaningful: the `commit_seq` is part of the encrypted record's identity.

Key destruction (Section 8.4) makes the entire stream unrecoverable, even with disk access.

### 11.5 Manifest-Based Backup (P0-6 Fix)

The previous SQLite-based backup was inadequate. WabiDB's custom storage requires a manifest-based backup that captures the data directory as a coherent point-in-time snapshot. A backup is a manifest plus the files referenced in the manifest.

```json
{
  "backup_id": "2026-06-19T12:00:00Z",
  "schema_version": 17,
  "wabidb_format_version": 1,
  "highest_commit_seq": 123456,
  "created_at_micros": 1750334400000000,
  "engine_version": "0.1.0",
  "global_commit_index": {
    "files": [
      { "path": "global/commit-index/00000001.widx", "blake3": "abc...", "size": 67108864 }
    ]
  },
  "stream_segments": [
    { "stream_id": "ch_01J...", "path": "streams/channel/ch_01J.../events/00000001.wseg", "blake3": "...", "size": 67108864, "encrypted": true }
  ],
  "stream_snapshots": [
    { "stream_id": "ch_01J...", "path": "streams/channel/ch_01J.../snapshots/00000004.wsnap", "blake3": "...", "covers_through_commit_seq": 120000 }
  ],
  "blobs": [
    { "hash": "abcd...", "path": "blobs/ab/abcd....bin", "size": 1234567, "blake3": "..." }
  ],
  "tombstones": [
    { "stream_id": "dm_01J...", "destroyed_at_micros": 1750300000000000, "audit_record_hash": "..." }
  ]
}
```

**Backup procedure:**

1. The engine acquires a read lock on the global commit sequencer (writers wait).
2. The engine captures the current `highest_commit_seq`.
3. The engine walks the data directory and lists every file (segments, snapshots, blobs, commit-index files, manifest).
4. For each file, the engine computes the BLAKE3 hash.
5. The engine writes the manifest JSON.
6. The engine releases the read lock.
7. The backup tool copies the listed files to the backup destination.

The backup is a **consistent point-in-time snapshot** because step 2 captures the highest commit, and any subsequent writes that occur after step 1 are not included in the manifest. Files written after step 2 are not in the backup; files deleted after step 2 are still referenced (but the engine tracks deleted files via tombstones; the backup tool can resolve these).

**Restore procedure:**

1. Stop the engine.
2. Replace the data directory with the restored files.
3. Run `wabidb verify-backup <manifest>` to verify all referenced files are present and hashes match.
4. Start the engine.
5. The engine loads the manifest, validates `highest_commit_seq` against the commit index, and resumes.

**Blob consistency.** The manifest includes both the SQLite-side blob references (in the projection state) and the blob files in the data directory. A restore that has blob references but missing blob files fails verification. The storage CLI surfaces this as a clear error.

**PITR via the global commit index.** PITR is "restore from backup, then replay events from the commit index that aren't in the restored state." This is possible because:
- The commit index is the canonical event log.
- The backup captures a consistent `highest_commit_seq`.
- After restore, the engine can replay events with `commit_seq > backup.highest_commit_seq` if those segments are available.

For PITR to work, the operator must also archive the commit index files (and the segments) separately from the periodic backup, on a tighter schedule. The commit index is small (a few MB per 10,000 entries); archiving it every minute is cheap.

The previous "PITR via bespoke SQLite WAL frame replay tool" is replaced by this simpler approach: the commit index IS the event log, and replay is built into the engine's recovery pipeline. No bespoke WAL tool.

**No more "PITR via WAL archives" hand-waving.** PITR is a real procedure now, not a hope.

### 11.6 Blob Store

For file attachments (images, audio, files, large whiteboard snapshots, CAD geometry), WabiDB does not store file bytes inline. The blob store is content-addressed and immutable:

- Directory layout: `{data_dir}/blobs/{first_two_hex}/{blake3_hash}.bin`
- Sidecar metadata: `{blake3_hash}.meta` (JSON: `{size, mime, created_at, ref_count}`)
- Ref count maintained in the projection (`blobs.metadata.ref_count`)
- GC: a background task scans the `blobs` directory, queries the projection for ref_count = 0, and deletes orphans. Runs every 6 hours.

**Blob write ordering** (the order that makes backups consistent):

1. Write blob to a temp file in the staging directory.
2. `fsync` the temp file.
3. Rename to final hash path (atomic on POSIX).
4. `fsync` the directory.
5. Insert the `blobs.metadata` row referencing the hash.
6. Commit the projection update.

If step 5 or 6 fails, the blob is orphaned. The retention engine detects orphans (ref count = 0) and reaps them. If step 4 is skipped, a crash can leave the DB referencing a blob that doesn't exist on disk; the manifest-based backup catches this on restore.

### 11.7 Blob Store Range Reads

For large blobs (megabytes to gigabytes — common in CAD assemblies, video attachments, voice notes longer than a few minutes), the blob store supports range reads.

**Protocol.** Range reads are served over a dedicated HTTP endpoint:

```
GET /v1/blobs/{hash}?offset=1048576&length=4194304
Authorization: Bearer <session_token>

Response:
HTTP/1.1 206 Partial Content
Content-Range: bytes 1048576-5242879/{total}
Content-Type: {mime}
ETag: "{hash}"
```

The endpoint validates the token, looks up the blob by hash, decrypts (if encrypted), seeks to `offset`, and streams `length` bytes. The client can request multiple ranges in parallel (using HTTP/2 multiplexing or HTTP/1.1 range requests).

**Memory bounds.** The server uses `tokio::fs::File::seek` and a bounded `BufReader` (default 256 KB). It never loads the entire blob into memory. A 1 GB CAD mesh streams from disk to client at network speed without ever sitting in server RAM.

**Caching.** The `ETag` is the BLAKE3 hash. Clients that already have the blob send `If-None-Match: "{hash}"` and receive 304 Not Modified. The server does not need to read the file to respond to a 304.

**Lazy-load pattern for CAD.** The frontend does not request the entire assembly blob on connect. Instead:

1. The frontend requests the assembly metadata (a small JSON blob) via the normal subscription channel.
2. The metadata contains a list of part references, each with a blob hash and a bounding box.
3. The frontend renders the parts whose bounding boxes are in the current viewport, requesting their blobs via the range-read endpoint.
4. As the user pans/zooms, the frontend requests additional blobs and releases the ones no longer in view.
5. The same pattern works for whiteboard imports and albums.

### 11.8 Schema Migrations

Migrations are versioned Rust source files that describe the schema transformations:

```
wabidb/src/storage/migrations/
  V1__initial.rs
  V2__add_consumer_offsets.rs
  V3__per_stream_retention.rs
  ...
```

A migration is a Rust function that takes the engine state and applies a transformation:

```rust
pub fn migrate_v1_to_v2(state: &mut StorageState) -> Result<(), MigrationError> {
    // Add the consumer_offsets index
    state.add_index("consumer_offsets", "idx_consumer_id", ...)
}
```

Migrations run at engine startup, before any commands are accepted. Each migration is **idempotent**: if a migration has already been applied, it's a no-op. Migrations are also **forward-only by default**; backward compatibility requires a separate "downgrade" migration (rare; only used for staging rollback).

The migration system tracks the current schema version in the storage manifest. The version is checked at startup; if the engine binary's version is older than the manifest's version, the engine refuses to start (forcing a downgrade scenario).

### 11.9 Crash Recovery and Validation

When the engine starts:

1. Read the storage manifest. Get `highest_committed_seq`.
2. Load the latest commit index file. Verify CRC32Cs. Truncate at first invalid entry.
3. For each stream referenced in the commit index, find its latest valid segment. Scan-and-truncate at first invalid record.
4. Rebuild the projection engine from the latest snapshot per stream + the post-snapshot commit index entries.
5. Verify all referenced blobs exist (or are tombstones for destroyed streams).
6. If all checks pass, the engine starts accepting commands.
7. If any check fails, the engine refuses to start and emits a recovery report.

The recovery report identifies: invalid commit index entries, invalid stream segments, missing blobs, projection inconsistencies. The operator can use the storage CLI to investigate (`wabidb inspect-commit <seq>`, `wabidb dump-stream <stream_id>`, `wabidb recover`).

### 11.10 Performance Profile

The custom per-stream + global index architecture has a different performance profile than SQLite. Honest characterization:

- **Commit throughput**: limited by the global commit sequencer (single ordering point). Realistic sustained throughput is **5,000-10,000 commits/sec** on a modern NVMe with per-stream fsync, batched event writes, and the commit index fsync'd once per batch.
- **Per-stream parallelism**: appends to different stream segments can happen in parallel. The commit sequencer is the bottleneck for total commit throughput, not for per-stream bandwidth.
- **Reads**: bounded by the projection engine's index lookups. The custom indexes are skiplists/B-trees, not SQL; the read path is direct, not interpreted.
- **Memory**: the in-memory state is the projection engine + ephemeral bus + cached active segment tails. A 10,000-message channel's projection fits in MB.
- **Disk I/O**: fsync per segment append, plus fsync of the commit index per batch. The commit index fsync is the main bottleneck.

For Wabi's expected scale (a single Wabi server with 100-1,000 concurrent users, ~10-50 active in any given room), this is comfortably within budget. For a hypothetical 10,000+ concurrent users, the load-shedding mechanisms in Section 8.9 are the safety net.

### 11.11 Storage CLI

The storage CLI is described in Section 2.11. The full command list:

- `wabidb check` — verify manifest, commit index, all stream segments, all blob references.
- `wabidb dump-stream <stream_id>` — print all events in a stream.
- `wabidb inspect-commit <commit_seq>` — show commit index entry, event refs, payload hashes, stream record locations.
- `wabidb rebuild-indexes` — drop and rebuild projection indexes from snapshots + commit index.
- `wabidb compact <stream_id>` — force-compact a stream's segments.
- `wabidb verify-backup <manifest>` — verify a backup manifest against the live data directory.
- `wabidb recover` — replay commit index, rebuild projections, validate, output a recovery report.
- `wabidb list-streams` — list all streams with kind, key id, retention policy, size.
- `wabidb export <stream_id> --format=json` — export a stream for migration or debugging.
- `wabidb backup [--output path]` — generate a manifest-based backup.
- `wabidb restore [--manifest path]` — restore from a manifest-based backup.

The CLI is the operator's interface to the storage layer. It is not optional.

### 11.12 What's Not in v1 Storage

- **Hot-swap restore (Section 11.5 of the previous design)**: replaced by downtime-restore only. Hot-swap is a future capability requiring a load balancer and coordination protocol.
- **FTS5 message search**: replaced by the search helper node (Section 5.12). The engine does not have built-in full-text search; the search helper is the primary path, with engine fallback (substring scan) when the helper is down.
- **Bespoke SQLite WAL replay tool for PITR**: replaced by the simpler "replay from commit index" approach (Section 11.5). The commit index IS the event log.

### 11.13 What "Custom Storage" Does Not Mean

The custom storage layer does **not** re-implement:
- Cryptographic primitives (uses `aes-gcm`, `chacha20poly1305`, `blake3`, `x25519-dalek` crates)
- Compression (uses `lz4` or `zstd` crates if compression is needed for cold storage)
- TLS (handled at the network layer, not the storage layer)
- BLAKE3 hashing (uses the `blake3` crate)

The custom storage layer **does** own:
- The file format (record header, segment format, commit index format)
- The on-disk layout (per-stream segments, global commit index, blob store)
- The recovery rules (scan-and-truncate, manifest verification, projection rebuild)
- The retention engine (per-stream policy, key destruction)
- The snapshot manager (per-stream snapshots, anchor points)
- The backup format (manifest-based, including blob references)

The "Wabi owns the storage format" boundary is at the file format and recovery level. We use battle-tested Rust crates for crypto, hashing, and compression. We do not write our own crypto.

## 12. The Connection to Existing Wabi Code

### 12.1 Engine Fits into Wabi-Server

Wabi-server currently runs as a Rust binary with a Socket.IO server, connecting to SpacetimeDB as an external database. In the end state:

- The `wabidb` crate is added as a dependency to wabi-server's `Cargo.toml`.
- At startup, wabi-server calls `WabiDbEngine::open(config)` which opens the custom storage data directory, runs schema migrations, and returns an `Arc<dyn WabiStore>`.
- The existing Socket.IO event handlers that currently call `ingest_wabi_event` (via HTTP POST to STDB) are rewritten to call `engine.invoke(command_name, &ctx)` directly.
- The existing Socket.IO event handlers that push real-time updates to clients (e.g., `whiteboard:patch`, `channel:message`) are replaced by the subscription engine: the engine pushes events, and wabi-server's network layer translates them to WebSocket frames (and optionally Socket.IO events for backward compatibility with the existing frontend).
- The `stdb_bindings/` directory and the `wabi_state_bridge` and `wabi_call_state_bridge` crates are deleted. They become dead code.

### 12.2 Frontend Migration

The frontend currently uses the `spacetimedb` SDK via generated bindings (`stdb_bindings/index.ts`). The migration path:

1. A new `WabiClient` class is introduced in the frontend that speaks the WebSocket protocol described in Section 5.8.
2. The `WabiClient` class replaces the `spacetimedb` SDK's `DbConnection`.
3. Table subscriptions (e.g., `db.state_message! table().subscribe()`) are replaced by topic subscriptions (`wabiClient.subscribe({filters: ['+channel:general:messages']})`).
4. Reducer calls (e.g., `reducers.ingestWabiEvent(...)`) are replaced by command calls (`wabiClient.command('send_message', args, clientRequestId)`).
5. The migration can happen incrementally: the `WabiClient` can be introduced alongside the existing STDB client, and channels/features can be migrated one at a time.

The frontend also gets:
- Ticket-based WebSocket auth (Section 10.2): the `WabiClient` requests a ticket via `POST /v1/ws-ticket` before opening the WebSocket.
- Snapshot barrier + resume cursors: the client tracks `last_seen_commit_seq` per topic and reconnects with `resume_after`.
- Idempotent commands: the client generates `client_request_id` (UUID v4) for every command and retries with the same id on timeout.

### 12.3 End State

- The `stdb_bindings/` directory is deleted.
- The `wabi_state_bridge` and `wabi_call_state_bridge` crates are removed from the workspace.
- The `spacetimedb` dependency is removed from both server and frontend.
- The engine is the single source of truth for all persistent state.
- All frontend features that work today (whiteboard, map, notes, business, calling, channels, DMs, friends, settings, moderation) continue to work because their data model is preserved — it is simply stored in WabiDB streams instead of STDB tables.

### 12.4 Feature Preservation

Each frontend feature and its corresponding WabiDB streams and tables (the projection layer):

| Frontend Feature | WabiDB Streams / Tables | Key Frontend Source Files |
|---|---|---|
| Channel messages | streams/channel/{id}/events/*, messages, reactions, message_attachments, command_idempotency | `channelStore.ts`, `messageStore.ts` |
| Whiteboard | streams/whiteboard/{id}/events/* + snapshots/*, whiteboards, whiteboard_layers, whiteboard_elements, whiteboard_patches, whiteboard_snapshots, whiteboard_history | `whiteboard/` (all 18 files) |
| Map/Places | streams/place/{id}/events/*, places, place_layers, place_pois, place_drafts, place_assets | `mapWorkspace.ts`, `placeRegistry.ts`, `placeDraft.ts` |
| Notes | streams/note/{id}/events/*, notes, note_versions | `notesStore.ts`, `userNotes.ts` |
| Business Hub | streams/kanban/{id}/*, streams/project/{id}/*, kanban_boards, kanban_tasks, kanban_columns, projects, sprints, calendar_events, diary_entries, business_resources, business_tags, business_graph_edges | `business/` (all 13 files) |
| Calling | streams/call/{id}/events/* (ephemeral), call_sessions, call_participants (durable) | `callingStdb.ts`, `wabi_call_state_bridge/` |
| Users/Auth | users, sessions (with session_token_hash), devices, user_credentials, identity_keys, devices (with prekey pools), device_pinned_keys | `authStore.ts`, `authSession.ts`, `encryption.ts` |
| DMs (encrypted) | streams/dm/{id}/events/*, dm_conversations, dm_messages, dm_message_recipients | `encryption.ts`, `dmStore.ts` |
| Friends | friends, friend_requests | `peopleTracker.ts`, friend request UI |
| Moderation | bans, mutes, audit_log, moderation_actions, role_definitions, rbac_assignments, presence_sessions | `presenceStore.ts` |
| Addons (e.g. CAD) | addon_object (model A) OR addon-namespaced streams (model B) — per addon's manifest | (addon-specific) |

### 12.5 Migration Path from SpacetimeDB (P0-3 Honest)

The previous "fallback is config change" framing was dangerously wrong. The corrected migration strategy is one of three options, named explicitly:

**Option A: Downtime import, no rollback after writes start (recommended for first cutover).**

1. Stop Wabi writes (set a maintenance flag or take the server offline).
2. Export STDB: read every table via STDB's SQL query API or reducer subscriptions, transform rows to WabiDB's stream format, write to WabiDB's data directory.
3. Validate: for every STDB table, count rows before and after export. Hash a sample of rows to verify content matches.
4. Switch the wabi-server routing to WabiDB. From this point, **all new writes go to WabiDB.**
5. Keep the STDB backup read-only for a grace period (default 30 days). After that, STDB can be decommissioned.
6. **Rollback is only possible before step 4.** Once WabiDB accepts writes, switching back to STDB means losing the writes that happened in WabiDB. Rollback is not free; it requires re-importing WabiDB's deltas back into STDB.

**Option B: Dual-write shadow mode (harder, more confidence).**

1. Wabi-server writes every command to both STDB and WabiDB.
2. Reads still come from STDB.
3. A background task compares state continuously, surfaces drift.
4. After a confidence window (default 7 days), switch reads to WabiDB.
5. Keep dual-write for a rollback window (default 14 more days).
6. After the rollback window, stop STDB writes.

This requires idempotency keys, reconciliation tooling, and a clear "what happens on drift" answer. The complexity is real.

**Option C: Feature-by-feature cutover with explicit one-way gate.**

For each feature (channels, DMs, whiteboards, etc.):

1. Backfill the feature's data into WabiDB.
2. Validate counts and hashes against STDB.
3. Freeze writes for that feature briefly.
4. Replay the delta.
5. Switch the feature to WabiDB.
6. No rollback without replaying WabiDB's deltas back into STDB.

This is between A and B in complexity. It's the right choice for features that are too stateful to dual-write (e.g., whiteboard with high patch traffic).

**The end-state doc recommends Option A for the first cutover** (whole-engine downtime import), with the option to evolve to C for future per-feature rollouts if needed. Option B is a v2 consideration if the team wants the additional confidence.

The full migration plan is its own document (`docs/futuresight-wabidb-migration.md`, to be written). The plan must include:
- The exact STDB → WabiDB row transformations
- The validation script that hashes a sample of STDB rows and compares to the WabiDB equivalent
- The rollback procedure (which is "before WabiDB accepts writes" — explicit, not casual)
- The cutoff date and grace period policy

---

## 13. What This Is NOT

This section reaffirms the design boundary.

**Not a SQL database.** WabiDB has no SQL parser, no ad-hoc queries, no `SELECT *`, no `JOIN`, no `GROUP BY`, no `ORDER BY`, no subqueries, no aggregations. Data is read through command return values and the `WabiStore` domain API, not through SQL queries. The subscription system uses a fixed topic grammar, not SQL. If a future feature requires complex read-side queries, that query is either written as a specific Rust command or forwarded to a search helper node. The engine does not grow a general query planner.

**Not a third-party database backend.** WabiDB does not depend on SQLite, redb, LMDB, RocksDB, or any other external database engine. Wabi owns the storage format end-to-end (Section 11.2). The "WabiStore trait + multiple backends" pattern is **not** what we built. We built one substrate: the custom per-stream + global index store. Adding a new substrate later would require a separate architectural decision.

**Not a generic embedded KV store.** WabiDB is not a generic key-value store with a query engine. It is a log-structured Wabi object/event store with derived projections and fixed access paths. The "good self-built" path, not the "bad self-built" path.

**Not a runtime addon loader.** Addons are compiled into the engine binary at build time. There is no "install addon" operation on a running server. The bounded engine primitives (commands, topics, capabilities, streams) are the contract; addons compose them. See Section 9.9.

**Not a game engine.** No spatial queries. No physics. No game loop. No client-side prediction. No server-authoritative movement. Turn trackers and dice logs are simple projection tables, not game engine primitives.

**Not a programmable app platform.** No WASM. No V8. No module lifecycle. No `client_connected`/`client_disconnected` reducers. No user-uploaded logic. No syscall ABI. The engine runs exactly the code that is compiled into it. If someone wants to add a custom integration, they write a Rust command, recompile, and deploy.

**Not federation.** WabiDB runs one instance per Wabi server. Cross-server messaging is handled by wabi-server's existing relay infrastructure, not by the database engine.

**Not multi-tenant SaaS.** WabiDB is a single-tenant engine. There is no "database per tenant" abstraction at the engine level. If the product evolves to need per-community databases, that is implemented by running multiple wabi-node processes, each with its own WabiDB instance.

**Not user-installed-backend-code.** The end state has no equivalent of STDB's `#[spacetimedb::reducer]` attribute or the module WASM upload flow. All commands are compiled into the engine. If the product needs a plugin system later, that plugin system is a separate layer that calls `WabiState::execute()`, not a WASM runtime inside the engine.

**What happens when the boundary is pushed:** If a future requirement genuinely needs ad-hoc queries (unlikely for Wabi's use case), the boundary is revisited. But the response is not "make the engine more general." It is "build a query layer on top of the engine that reads from the projection state." The engine itself stays focused.

---

## 14. The End State in One Paragraph

WabiDB is a purpose-built Rust database engine and live-subscription service, embedded in wabi-server, that persists all Wabi state in a custom per-stream log-structured object/event store with a global commit index and derived projections, exposes atomic state mutations as typed Rust commands that go through a single commit sequencer and atomically write to per-stream segments + the commit index, pushes real-time changes to browser clients over a WebSocket topic-subscription protocol with snapshot barriers and resume cursors, encrypts DM content per-device with X3DH-derived Double Ratchet keys with explicit key pinning and safety numbers (forward secrecy from message 1, not just from key rotation), supports a bounded set of 16 core object types with a build-time addon primitive for complex feature rooms like CAD, enforces per-stream retention policies with cryptographic key destruction on expiry, manages helper nodes (media, search, transcode, cache, regional anchor) through a signed-token pairing protocol with token-hash storage and atomic redemption, owns its storage format end-to-end (no SQLite, no SQL, no FTS5, no third-party database engine, no runtime plugin system), and replaces the entirety of SpacetimeDB's role in Wabi — eliminating the BSL license constraint, the WASM module runtime, the SQL query engine, the in-memory-only committed state, the event-table commitlog gotcha, the generic database scope, and the lack of privacy/retention primitives — while preserving every feature the existing frontend implements, because the data model is derived directly from the frontend source.

---

## 15. Source Map and Verification

### 15.1 Frontend Sources Justifying Design Choices

**Whiteboard data model.** The `WhiteboardLayer` type at `frontend/src/lib/whiteboard/boardTypes.ts:11-21` defines `id, name, kind, visible, locked, opacity, order, createdAt, updatedAt`. The layer `kind` is `'content' | 'reference' | 'background'` (line 3). The `WhiteboardElement` shapes at `elementTypes.ts:36-76` define the full element schema with all property columns. The layer operation patch types at `boardLayerOps.ts:6` (`layer:create`, `layer:update`, `layer:delete`, `layer:reorder`) and element patch ops at `boardElements.ts:8` (`create`, `update`, `delete`, `reorder`) directly map to command names. These files are the authoritative source for the whiteboard schema — every column in the section 3.6 tables is derived from them.

**Map/places data model.** `PlaceRecord` at `frontend/src/lib/placeRegistry.ts:17-34` defines the full place schema with `aliases, building, floor, lat, lon, modelUrl, mapImageUrl, mapRotation, poiThemePreset, mapLayers, pois, tags`. `PlaceMapLayerRecord` at `placeRegistry.ts:40-46` and `PlacePoiRecord` at `placeRegistry.ts:48-60` define the child schemas. `PlaceDraft` at `placeDraft.ts:62-78` adds draft-specific fields. These justify the places schema in section 3.7.

**Business data model.** `shared/businessContracts.ts:27-44` defines `Todo` (kanban task) with `id, title, description, status, priority, estimatedMinutes, dueDate, createdBy, assignedTo, tags, projectId, completedAt`. `KanbanColumn` at `business/types.ts:33-38` defines `id, label, color, visible`. `CalendarEvent` at `businessContracts.ts:52-66` and `DiaryEntry` at `businessContracts.ts:68-80` define the calendar and diary schemas. `Project` at `businessContracts.ts:82-95` and `Sprint` at `businessContracts.ts:97-108` define the project/sprint schema. These justify the business tables in section 3.9.

**Call data model.** `wabi_call_state_bridge/src/lib.rs:4-43` defines the three call tables. The frontend call reducer calls at `frontend/src/lib/callingStdb.ts` and the STDB bindings at `stdb_bindings/call_session_*` files confirm the exact field set. These justify section 3.5.

**Encryption.** `frontend/src/lib/encryption.ts:10-39` (`generateKeyPair` using ECDH P-256), lines 44-91 (`deriveSharedKey`), and lines 164-182 (`encryptForUsers` with per-recipient keys) define the encryption pattern that section 6 codifies.

### 15.2 STDB Sources That Informed the Design

The following STDB sources were studied for conceptual inspiration. WabiDB does not copy STDB code; the inspiration is at the architectural level.

- **Reducer model** (`crates/core/src/host/module_host.rs`): the command/transaction pattern (open tx, run reducer, commit or rollback) is identical in spirit. WabiDB replaces the WASM bridge with a direct Rust function call, and replaces the tx-with-outbox model with a per-stream + global commit index model.
- **SendWorker** (`crates/core/src/subscription/module_subscription_manager.rs:1714`): the off-main-thread aggregation of per-client updates is directly adapted in WabiDB's subscription manager. The comment at lines 1385-1387 ("get this work off the main thread") is preserved as a design principle. WabiDB's SendWorker additionally has priority lanes (Section 5.10) to handle backpressure.
- **Event table** (`crates/lib/src/db/raw_def/v10.rs:279-284` and `crates/datastore/src/locking_tx_datastore/committed_state.rs:619-622`): the ephemeral (write-to-commitlog, don't-merge-to-state) pattern inspired the "ephemeral" retention class. WabiDB avoids STDB's commitlog persistence issue by simply not writing ephemeral rows to disk at all (the `EmissionDurability::EphemeralMemoryOnly` enum is a compile-time boundary).
- **Subscriptions by delta evaluation** (`crates/core/src/subscription/subscription.rs` and `crates/subscription/src/lib.rs`): the concept of evaluating what changed and pushing only deltas is preserved. WabiDB's implementation is the commit-index + topic-pattern model, not delta-evaluation against a query.
- **Blob store content addressing** (`crates/table/src/blob_store.rs`): the BLAKE3 content-addressed blob storage concept is adapted for file attachments, minus the cross-snapshot hardlinking.
- **Locking and transactions** (`crates/datastore/src/locking_tx_datastore/datastore.rs:64`): STDB's serialized-writer model (single `MutTxId` at a time) is preserved, but the implementation is delegated to WabiDB's commit sequencer (Section 2.2) — one ordering point, many readers.

### 15.3 Verification Notes

**Verified claims:**
- All frontend-derived schema claims are verified against the actual source files listed above.
- The STDB bridge tables at `wabi_state_bridge/src/lib.rs` (30+ tables) and `wabi_call_state_bridge/src/lib.rs` (3 tables) have been read in full.
- The whiteboard frontend code (18 files) has been read in full.
- The business frontend code (13 files) has been read in full.
- The map/places code (6 files) has been read in full.
- The 53 files in `stdb_bindings/` have been confirmed to match the bridge reducer signatures.
- The WabiDB end-state design is a coherent architectural proposal: 11 components with clear boundaries, 16 object types with stable counts, per-stream + global index storage with manifest-based backup, at-least-once delivery with snapshot barriers, X3DH + Double Ratchet encryption, build-time addon primitive.

**Architectural decisions verified against external sources:**
- Three independent research passes (training data + Grok + this doc's revisions) converged on the same SQLite-vs-custom storage trade-offs.
- Figma's production architecture (`figma.com/blog/how-figmas-multiplayer-technology-works/`) validates the in-memory-hot + durable-committed + WAL pattern.
- Signal's protocol (X3DH + Double Ratchet + Sesame) is the established standard for end-to-end encrypted messaging with forward secrecy and multi-device envelopes.
- BLAKE3's hash performance (3-15 GB/s) is overkill in the right way for content addressing.
- Tokio + tokio-tungstenite scales to 100k+ WebSocket connections; 1k is trivial.

**Aspirational claims (will be tuned during implementation):**
- Specific PRAGMA-equivalent values (segment size 64 MiB, commit index file 10k entries, fsync batch 10 entries or 50ms) are starting defaults.
- Per-event-type backpressure behaviors (Section 5.10) will be tuned under real load.
- The 16 object types are stable; if a v2 needs more, they're addons, not core.

**STDB-derived claims:**
- The conceptual derivations from STDB (SendWorker, reducer model, event tables, blob store) are verified against the cited source files.
- The specific line numbers cited are accurate as of STDB 2.6.0.
- No STDB source code has been copied into this document. Short excerpts (≤10 lines) have been attributed with file:line citations where load-bearing.

**Corrected error from the architecture study (already fixed in `stdb-architecture-study.md`):**
Section 10 of `stdb-architecture-study.md` originally claimed that event tables have a `private`/`sender` column and are V2-only. The actual STDB 2.6.0 source at `crates/datastore/src/system_tables.rs:1783-1785` shows `StEventTableRow` has only one field, `table_id`. There is no `private`, no `sender`, no V2-only gating. This document uses the corrected understanding: event tables are a write-only-not-committed tier, with no per-recipient privacy primitives. WabiDB's ephemeral tier does not depend on those features — it just doesn't write ephemeral rows to disk at all.

### 15.4 Testing Strategy

The engine's correctness depends on the following invariants holding at all times:

1. **Every committed mutation has exactly one entry in the global commit index.**
2. **Every durable event is replayable until retention removes it.**
3. **Ephemeral events are never written to disk** (the `EmissionDurability` enum boundary is enforced by the type system).
4. **Clients deduplicate by event ID and recover by snapshot/resume.**
5. **Every external command is idempotent by `(caller, client_request_id)`.**
6. **Every topic has an explicit ACL and snapshot contract.**
7. **Every table has canonical ID types and foreign keys.**
8. **Every blob referenced by DB has been fsynced before DB commit.**
9. **Migration rollback is only safe before WabiDB accepts exclusive writes.**

The test strategy targets these invariants with layered tests.

**Layer 1: Per-command unit tests.** Every command in the registry has at least one test. The test:
- Creates a fresh data directory in `/tmp/wabidb-test-{uuid}/`.
- Opens the engine.
- Runs the command with a fake `CallerIdentity`.
- Asserts the returned value.
- Asserts the resulting state in the projection.
- Asserts the events emitted match expectations.
- Asserts idempotency: a second call with the same `client_request_id` returns the same result without re-running the command.

Per-command tests catch logic bugs, permission bugs, validation bugs, and idempotency bugs.

**Layer 2: Transaction atomicity tests.** A set of tests specifically target the atomicity invariants:

- A test that runs a command which writes events to per-stream segments + commit index, then forces a failure halfway through (e.g., a panic in the projection handler). The test asserts that no commit index entry was written and no stream segment is reachable from a valid commit index.
- A test that runs two commands concurrently from different threads. The test asserts that the commit sequencer serializes them, one wins, the other gets a serialization error, and the projection is consistent.
- A test that runs a command which writes 100 events and crashes the engine mid-transaction. On restart, the test asserts that no commit index entry references the partial transaction, and the projection is consistent.
- A test that runs an ephemeral-emitting command and a durable-emitting command interleaved. The test asserts that the durable events land in the commit index, the ephemeral events do not, and the projection only sees the durable events.

**Layer 3: Subscription delivery tests.** A test harness simulates multiple WebSocket clients (per Section 5.6):

- The harness creates a fresh engine and connects N client stubs.
- Each client subscribes to a topic.
- The harness runs a command that emits events to the commit index.
- The harness asserts that all N clients receive the corresponding events within a timeout, in the correct order, with the correct payload.
- The harness runs a command that emits 1,000 events in quick succession. The harness asserts that all events are delivered (none lost, none duplicated client-side) and that the per-client batch boundaries are respected.
- The harness drops a client connection mid-stream. The harness asserts that the other clients are unaffected and the dropped client does not cause the engine to block.
- The harness forces the live fanout to fall behind (artificial sleep). The harness asserts that backpressure frames are sent on the control channel and that no client is starved indefinitely.
- The harness tests snapshot barriers: a client subscribes at commit_seq=100, then events 101-200 are emitted, then the client reconnects with `resume_after=100`. The harness asserts that the client receives 101-200 in order, no duplicates.
- The harness tests the snapshot-required path: a client's `resume_after` is older than the retention window. The harness asserts the server responds with `SnapshotRequired`, the client fetches a fresh snapshot, and the client state is consistent.

**Layer 4: Reliable consumer tests.** Tests for the helper-node pattern (Section 5.5):

- A test creates a search helper consumer. Events 1-100 are committed. The helper subscribes and reads 1-100. The test asserts the helper sees all 100 events in order, with no duplicates.
- A test simulates a helper going offline mid-stream. The helper's `consumer_offsets.last_commit_seq` is 50. Events 51-200 are committed while the helper is offline. The helper reconnects. The test asserts the helper reads 51-200 in order, no duplicates.
- A test simulates a retention window passing: events 1-50 are committed, retention removes them, a new helper subscribes. The test asserts the helper correctly identifies that its checkpoint is older than the retention and triggers a full reindex.

**Layer 5: End-to-end encryption tests.** (See Section 6.11.) The 10 tests listed in Section 6.11 cover X3DH handshake, Double Ratchet forward secrecy, per-device recipient decryption, MITM via key swap, safety number consistency, ciphertext integrity, retention deletion, algorithm version handling, nonce uniqueness, and max plaintext size. Property-based tests (using `proptest` or similar) generate random keypairs and random plaintext, run the encryption, run the decryption, and assert that the plaintext matches.

**Layer 6: Storage layer tests.** Tests for the per-stream + global index storage:

- A test creates a stream, appends 1000 events, fsyncs, then reads back all 1000 events. The test asserts no events are lost or duplicated.
- A test corrupts a stream segment by writing random bytes at the middle. The test asserts that recovery scans-and-truncates at the corrupt record, and that events before the corruption are recoverable.
- A test corrupts the global commit index. The test asserts that recovery truncates the commit index, the projection is rebuilt from the surviving commit index, and the engine starts.
- A test destroys a stream's encryption key (simulates retention). The test asserts that the stream's segments are unrecoverable, but other streams are unaffected.
- A test exercises the manifest-based backup: backup the data directory, then deliberately corrupt a stream segment, then restore. The test asserts that the backup verification catches the corruption, and the engine refuses to start with the bad backup.

**Layer 7: Migration tests.** Every schema migration is tested:

- A test creates the engine at the previous schema version (using a snapshot of the data directory from before the migration was written).
- The test runs the migration.
- The test asserts that all expected streams, projection tables, and indexes exist at the new schema version.
- The test asserts that no committed events were lost (count events before and after, verify stream_ids match).
- The test asserts that the projection rebuilds correctly from the post-migration commit index.

**Layer 8: Load tests.** A separate test suite (run manually or in CI nightly, not on every commit) measures:

- Sustained commit throughput: how many commands per second can the engine commit?
- Live fanout throughput: how many subscribers can receive updates without affecting commit throughput?
- Per-stream write bandwidth: how many stream segments can be appended in parallel?
- Consumer offset replay: how fast can a search helper catch up after a long offline period?
- Memory usage: what is the RSS at idle, at 1,000 subscribers, at 10,000 subscribers?
- Latency percentiles: p50, p95, p99 for command commit latency and for end-to-end subscription delivery latency.

The target numbers, derived from the per-stream + global index architecture in Section 8.9: 5,000-10,000 commits/sec sustained, <50ms p95 commit latency, <100ms p95 end-to-end delivery on LAN, <300ms on internet.

**Layer 9: Real-world test.** A test deployment on a real server (Ronin or similar) with real users (a small friend group) for at least one week before any production cutover. The test measures the same things as Layer 8 but in the wild. A real-world test catches things lab tests miss: slow client devices, weird network conditions, the timezone that wasn't tested, the Wabi user who runs 17 tabs.

If the real-world test reveals a fundamental issue — "WabiDB can't handle our actual usage," or "the latency is worse than STDB by an order of magnitude," or "the retention reaper is breaking something" — we revert. The trait boundary is preserved; the frontend dual-client pattern is preserved; the rollback is a config change (switch the WabiClient back to the STDB client).

**The test harness.** Layer 3 and Layer 4 require a multi-client test harness. The harness is a small Rust binary that:

- Spins up the engine in-process.
- Exposes a function `connect_client() -> ClientStub` that returns a struct simulating a WebSocket connection.
- Provides `ClientStub::subscribe`, `ClientStub::receive`, `ClientStub::send_command`, `ClientStub::resume_after`, `ClientStub::snapshot`.
- Allows assertions on the client's view of the world (received events, last seen snapshot, etc.).

The harness is a `#[cfg(test)]` module in the same crate as the engine. It is not shipped in production builds. It is the primary tool for catching the kind of bugs that are easy to introduce in subscription delivery: ordering, batching, loss, duplication, backpressure, and snapshot barrier correctness.

**Test isolation.** Each test runs against a fresh data directory in `/tmp/wabidb-test-{uuid}/`. Tests do not share state. The `WabiDbEngine::open` function takes a path argument, so tests can spin up as many engines as they need. CI runs the full test suite in parallel; each test is independent.

**Coverage target.** The goal is 80% line coverage for `wabidb::stream_log`, `wabidb::commit_index`, `wabidb::projections`, `wabidb::snapshots`, `wabidb::retention`, `wabidb::subscription`, `wabidb::commands`, and `wabidb::crypto`. These are the eight crates where bugs are most likely to corrupt data or break user-visible behavior. The remaining 20% is acceptable for code that is exercised only in unusual edge cases or in test-only modules.
