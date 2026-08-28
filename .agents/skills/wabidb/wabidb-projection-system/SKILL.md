---
name: wabidb-projection-system
description: "Learn WabiDB's projection engine: materialized views, the Projection trait, compaction, and all 20+ registered index handlers."
---

# WabiDB Projection System

This skill covers WabiDB's in-memory materialized view system — how events are applied to projection state, how records are encoded and queried, and how tombstone compaction works.

## When to Use

- Implementing a new projection handler for a new event type
- Understanding how projection state is organized (SkipMap indexes)
- Debugging projection consistency or read-after-write issues
- Working with tombstone compaction (soft-delete + compact flow)
- Extending the WabiStore trait to expose new projection data

## Prerequisites

- Access to WabiDB source code at `/var/home/Ronin/wabi`
- Understanding of event sourcing basics (commands → events → materialized views)
- Familiarity with WabiDB's sequencer commit flow

## Architecture Overview

```
Event committed → ProjectionDispatcher → Handler lookup by event_type
    → Handler.apply(event, state) → mutate SkipMap index
    → advance watermark → linearizability barrier
```

- **Handlers** are sync (no async) because projection state is in-memory
- **Dispatch** is single-threaded per the lock ordering rule in `engine::locks`
- **State** is partitioned into named indexes (one `crossbeam-skiplist::SkipMap` per index)
- **Snapshots** serialize all indexes to JSON (hex-encoded keys/values) for fast recovery

## Key Files

| File | Purpose |
|------|---------|
| `src/projections/handler.rs` | `Projection` trait, `DurableEvent`, dispatch table |
| `src/projections/registry.rs` | `TypeRegistry`, `ProjectionRegistration` |
| `src/projections/codec.rs` | `RecordCodec` trait (default postcard encoding) |
| `src/projections/barrier.rs` | `LinearizabilityBarrier` — read-after-write consistency |
| `src/engine/locks.rs` | `ProjectionState` — SkipMap storage, `insert`, `get`, `for_each`, `prefix_scan`, `remove`, `compact_index` |
| `src/engine/mod.rs` | `build_type_registry()` — all 22 registrations |
| `src/projections/*.rs` | Individual projection handlers |

## ProjectionState API

`ProjectionState` holds a `RwLock<HashMap<String, SkipMap<Vec<u8>, Vec<u8>>>>` — one SkipMap per named index.

| Method | Description |
|--------|-------------|
| `insert(index, key, value, commit_seq)` | Insert or update a record |
| `get(index, key) -> Option<Vec<u8>>` | Lookup by exact key |
| `for_each(index, fn)` | Iterate all entries in an index |
| `prefix_scan(index, prefix, fn)` | Iterate entries whose key starts with a prefix |
| `remove(index, key) -> bool` | Remove a single entry |
| `compact_index(index, predicate) -> usize` | Two-pass remove-all-matching (collect then delete) |
| `snapshot()` / `load_snapshot()` | Persist/restore all indexes to/from JSON |

All read operations hold only a read lock. `insert` and `remove` hold a write lock briefly (SkipMap operations are lock-free internally).

## Projection Trait

```rust
pub trait Projection: Send + Sync {
    fn event_type(&self) -> &str;
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()>;
}
```

- `event_type()` returns the dispatch key (e.g. `"message_created"`)
- `apply()` decodes the event payload, constructs/updates a record, and calls `state.insert()`
- A single projection struct can handle multiple event types (e.g., `MessagesProjection` handles `message_created`, `message_edited`, `message_deleted`)

## Registration Pattern

In `engine/mod.rs::build_type_registry()`:

```rust
ProjectionRegistration {
    event_types: &["message_created", "message_edited", "message_deleted"],
    handler: Arc::new(MessagesProjection),
    index_name: "messages",
    record_type_name: "wabidb::projections::messages::MessageRecord",
}
```

Each registration declares the event types it handles, the handler instance, the SkipMap index name, and the record type for schema tracking.

## Record Encoding

Most projections use `postcard` binary encoding via the `RecordCodec` trait:

```rust
pub trait RecordCodec: Serialize + DeserializeOwned {
    fn codec_name() -> &'static str;
    fn encode(&self) -> Vec<u8];       // postcard::to_allocvec
    fn decode(buf: &[u8]) -> Result<Self>;  // postcard::from_bytes
}
```

A few projections (channels, audit) use `serde_json` directly for JSON encoding.

Each projection module exports free functions:
- `encode_record(r) -> Vec<u8>` — postcard serialization
- `decode_record(buf) -> Result<T>` — postcard deserialization
- `encode_key(...) -> Vec<u8>` — composite key encoding (length-prefixed strings)

## Key Encoding Convention

Composite keys use length-prefixed components:

```rust
pub fn encode_key(a: &str, b: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(a.len() as u64).to_le_bytes());
    buf.extend_from_slice(a.as_bytes());
    buf.extend_from_slice(&(b.len() as u64).to_le_bytes());
    buf.extend_from_slice(b.as_bytes());
    buf
}
```

This allows prefix scans over the first component (e.g., all messages in a channel, all pages in a wiki).

| Projection | Key Pattern | Prefix Scan |
|------------|-------------|-------------|
| messages | `encode_key(channel_id, message_id)` | by channel_id |
| wiki_pages | `encode_key(channel_id, page_id)` | by channel_id |
| forum_posts | `encode_key(channel_id, thread_id, post_id)` | by channel_id then by thread_id |
| incidents | `encode_key(channel_id, incident_id)` | by channel_id |
| albums | `encode_key(scope_type, scope_id, album_id)` | by scope |
| album_items | `encode_key(album_id, item_id)` | by album_id |
| dm_messages | `encode_key(dm_id, message_id)` | by dm_id |
| dm_recipients | `encode_key(dm_id, message_id, user_id)` | by dm_id + message_id |
| reactions | `composite_key(message_id, user_id, emoji)` | by message_id |

## Tombstone Compaction

Six projections support soft-delete:

1. Add `is_deleted: bool` to the record struct
2. Handler sets `record.is_deleted = true` on delete events
3. `list_*` methods accept `include_deleted: bool`, filter out deleted when `false`
4. `compact()` static method calls `state.compact_index(index_name, |k, v| decode(v).is_deleted)` for the **primary** index. **If the projection also has secondary indexes, the compact method MUST purge those too** — secondary indexes are NOT auto-cleaned and deleted rows linger there until a full rebuild (2026-07-19 fix: `MessagesProjection::compact` also compacts `messages_by_channel` + `messages_by_author`, returning the summed count). When adding a secondary index to a soft-deletable projection, update `compact()` to remove matching rows from every index name.

```rust
pub fn compact(state: &ProjectionState) -> usize {
    state.compact_index("messages", |_key, value| {
        decode_record(value).map(|r| r.is_deleted).unwrap_or(false)
    })
}
```

## All Registered Projections

| Index | Handler | Event Types |
|-------|---------|-------------|
| messages | MessagesProjection | message_created, message_edited, message_deleted |
| reactions | ReactionsProjection | reaction_added |
| channel_members | ChannelMembersProjection | channel_member_added |
| users | UsersProjection | user_registered |
| emotes | EmotesProjection | emote_upserted |
| webhooks | WebhooksProjection | webhook_upserted |
| user_layouts | LayoutsProjection | user_layout_upserted |
| channels | ChannelProjection | channel_created |
| call_sessions | CallSessionsProjection | call_session_created, call_session_ended |
| call_participants | CallParticipantsProjection | call_participant_joined |
| call_signals | CallSignalsProjection | call_signal_emitted |
| wiki_pages | WikiProjection | wiki_page_created, wiki_page_edited, wiki_page_deleted |
| forum_posts | ForumProjection | forum_thread_created, forum_post_created, forum_post_edited, forum_post_deleted |
| incidents | IncidentProjection | incident_created, incident_updated, incident_resolved |
| albums | AlbumProjection | album_created, album_updated, album_deleted |
| album_items | AlbumItemsProjection | album_item_added, album_item_updated, album_item_removed |
| dm_messages | DmMessagesProjection | dm_message_created |
| dm_message_recipients | DmMessageRecipientsProjection | dm_message_recipient_added |
| audit | AuditProjection | role_assigned, role_removed, channel_settings_updated |
| (noop) | NoopProjection | reaction_removed, member_joined, member_left, channel_renamed |
| gallery_works | GalleryWorkProjection | gallery_work_uploaded, gallery_work_edited, gallery_work_deleted |
| gallery_feedback | GalleryFeedbackProjection | gallery_feedback_added, gallery_feedback_deleted |
| wiki_revisions | WikiRevisionProjection | wiki_revision_created |

### UsersProjection — full-roster query (2026-08-06)

`users` index is NOT just a single-user lookup. `UsersProjection::list(state, filter)` with `UsersFilter::default()` returns EVERY user row — registered accounts, guests, and bots — each with profile fields. This is the canonical "who exists on this server" read: `WdbAdapter::list_users()` (in `wabi-server/src/adapter/mod.rs`) feeds the socket `init` payload's `serverMembers`, which the frontend renders as the People panel's greyed-out "Offline — N" section (`offlineUsers = serverMembers − online`). Guest discriminator = empty `password_hash` (same check `auth.rs::handle_login` uses), exposed on the wire as `is_registered` (UserView). If `serverMembers` is empty, the offline roster silently vanishes — always route roster reads through `list_users()`, never a hardcoded `Vec::new()` stub.

## How to Add a New Projection

1. Define the record struct in a new `src/projections/my_projection.rs` with `RecordCodec`
2. Implement `encode_record`, `decode_record`, `encode_key` free functions
3. Implement `MyProjection` struct with `Projection` trait
4. Add typed query methods: `get_*`, `list_*`
5. Optionally add `is_deleted` field and `compact()` static method
6. Register in `engine/mod.rs::build_type_registry()`
7. Add `pub mod my_projection;` to `src/projections/mod.rs`
8. Add domain type + `From` impl in `src/domain/mod.rs`
9. Add methods to `WabiStore` trait in `src/engine/wabi_store.rs`
10. Implement in `WdbAdapter` in `wabi-server/src/adapter/mod.rs`
11. **Document the domain change (project governance).** If the new projection adds/modifies a domain type or `ChannelKind`, append a `## <card>: <projection> domain change` section to `docs/plans/2026-07-18-channel-types-follows-chat-refs.md` (or the active plan doc) recording the new record fields, event types, index names, and postcard-compat notes. Then update the relevant wabidb skill(s) if the change introduces a pattern not already covered. Do NOT halt to flag the user — implement + document + update skills autonomously (per Ronin's DB-change policy: "just want the change documented and skills handled, no need to flag me").

## Secondary indexes + typed queries (landed 2026-07-19 overnight)

### SecondaryIndex (`projections/secondary_index.rs`)

Messages registers `MessagesByChannelIndex` → `"messages_by_channel"` and `MessagesByAuthorIndex` → `"messages_by_author"`. `MessagesProjection::apply` calls `apply_secondary_indexes` after successful primary apply so replay rebuilds indexes. Use `ProjectionState::with_index` (do not Clone SkipMaps — deep copy).

**Value encoding:** on `message_created`, primary rewrites `message_id = format!("msg_{:x}", commit_seq)`. Secondary values must use the same rewrite (`reencoded_payload`); raw `event.payload` leaves empty ids and fails query tests.

**`with_index` read-lock fast path (2026-07-19):** `ProjectionState::with_index` was fixed so that if the index already exists it runs `f` under a **read** lock (SkipMap inserts are lock-free on `&self`); only the rare first-creation path takes the write lock. The hot apply path (every message insert hits the secondary index) must NOT cont vive on a write lock. If you change `with_index`, preserve this: existing index → read lock; missing → write lock + create.

**Query ordering (2026-07-19):** `QueryableProjection::query` collects from a secondary index `prefix_scan`, which returns results in **lexicographic key order** (`msg_{:x}` hex). After decode + filter, sort by parsed numeric commit_seq (`strip_prefix("msg_")` → `u64::from_str_radix(_,16)`), unknown formats → `u64::MAX` (sort last), THEN apply limit. Without this, mixed-width ids misorder (e.g. `msg_10` sorts before `msg_7`). Assert seq-monotonic order in query tests with deliberately mixed widths.

`query(state, filter) -> Vec<Record>` on messages/reactions/dm_messages/users/channels/wiki/forum/incidents. Channel/author message filters must use secondary-index prefixes, not full `for_each("messages")`. A7: 10k-msg channel query gate (&lt;50ms on dev HW). Adapter reads should call `projection.query` where filters exist.

### Maintenance (`wabidb::maintenance`)

`MaintenanceRule` + `MaintenanceScheduler` (60s ticks): retention markers, key-rotation due, wiki staleness, forum auto-archive.

## Common Pitfalls

- **`for_each` / `prefix_scan` closures must not call `state.get`/`state.insert` for a DIFFERENT index that may need a write lock.** Even a *read* `get` inside the read-locked `for_each` closure is unsafe vs a queued writer (re-entrancy deadlock family, same as the insert case). Collect (key, value) pairs inside the closure, drop the lock, THEN call `state.get` on the other index outside the loop (2026-07-19 fix in `maintenance.rs::ThreadAutoArchiver`).
- **Compaction must cover secondary indexes.** See Tombstone Compaction step 4 — if a soft-deletable projection has secondary indexes, purge them in `compact()` or deleted rows persist until full rebuild.
- **Secondary-index apply already rewrites `message_id`.** See SecondaryIndex value-encoding note — do not re-encode the payload without the `msg_{:x}` rewrite or query tests fail.
- **`engine/mod.rs` registration block is comma-sensitive.** New `ProjectionRegistration` entries go BEFORE the final `NoopProjection` entry. You MUST add a trailing comma to the entry that *precedes* your new one (the `LoreCommitProjection` entry has no trailing comma in the current source — add one), and your new entry needs a trailing comma too unless it sits directly before the closing `];`. The `record_type_name` string must be the fully-qualified path exactly as siblings use it (e.g. `"wabidb::projections::gallery::GalleryWorkRecord"`). Forgetting registration → events never apply → post-apply lookup tests fail.
- **3-component keys with no direct `get`.** A record keyed `(channel_id, work_id, feedback_id)` has no single-record `get_feedback` helper. Model single-record ops (delete) via `list_*_for_work(...) + .find()` against the work, consistent with the projection's key shape. Don't invent a get you didn't write.
- **`WabiStore` trait + `WdbAdapter` impl must match signatures exactly.** Every method added to `WdbAdapter` must also be declared on the `WabiStore` trait in `src/engine/wabi_store.rs` with an identical name/args/return type, or the build fails. Declare on the trait FIRST.
- **Adapter emit-shape divergence (load-bearing).** When you add a new event from the `WdbAdapter` (in `wabi-server/src/adapter/mod.rs`), the emit call is NOT uniform across modules. The **forum** adapter uses `self.wdb.emit(event).await?`; the **wiki** adapter uses `self.run(actor_user_id, "op_name", channel_id, "event_type", 6, payload, true, None).await?` (where `payload = encode_record(&record)` and the returned `seq` becomes the id, e.g. `format!("page_{:x}", seq)`). Always read the target module's EXISTING create method and paste its exact emit call into the delegate prompt — do not assume one shape. A wrong emit call either fails to compile or (worse) silently doesn't persist the event, so the post-apply projection lookup test fails.
- **Domain `From` impl + all `Record` literals.** When you add fields to a record, every `XxxRecord { ... }` struct literal in the module (including test modules) must include the new fields or it won't compile. Grep for `XxxRecord {` and update all sites (tests, benches, property_tests).
- **Emit-shape is adapter-specific, NOT projection-specific.** The projection module defines `apply()`; the actual event write happens in `WdbAdapter` (wabi-server) and the emit call differs per module (forum `self.wdb.emit(event).await?` vs wiki `self.run(actor_user_id, "op_name", channel_id, "event_type", 6, payload, true, None).await?`). See `wabidb-wabi-server-adapter` for the exact shapes — paste the TARGET MODULE's existing create-method emit into the delegate prompt. A wrong emit call either fails to compile or (worse) silently doesn't persist, so post-apply lookup tests fail.
- **Adding a SECOND projection to an existing module needs NO new `projections/mod.rs` entry.** Wiki's `WikiRevisionRecord` + `WikiRevisionProjection` live in the SAME `wiki.rs` as `WikiPageRecord`; both register in `engine/mod.rs` as separate `ProjectionRegistration` entries. Gallery did the same (`GalleryWorkRecord` + `GalleryFeedbackRecord` in `gallery.rs`). Reuse the module file when the projections are one surface — only add `pub mod` to `projections/mod.rs` for a genuinely new module.
