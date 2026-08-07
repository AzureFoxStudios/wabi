# WabiDB Projections — Materialized Views

Projections are in-memory SkipMap indexes updated by events. They are the read model — all queries hit projections, never raw segments.

## Flow

```
Event committed → ProjectionDispatcher → Handler lookup by event_type
    → Handler.apply(event, state) → mutate SkipMap index
    → advance watermark → linearizability barrier
```

- Handlers are sync (no async) — projection state is in-memory
- Dispatch is single-threaded per the lock ordering rule in `engine::locks`
- Snapshots serialize all indexes to JSON (hex-encoded keys/values) for fast recovery

## ProjectionState API

`ProjectionState` holds a `RwLock<HashMap<String, SkipMap<Vec<u8>, Vec<u8>>>>` — one SkipMap per named index.

| Method | Description |
|--------|-------------|
| `insert(index, key, value, commit_seq)` | Insert or update a record |
| `get(index, key) -> Option<Vec<u8>>` | Lookup by exact key |
| `for_each(index, fn)` | Iterate all entries |
| `prefix_scan(index, prefix, fn)` | Iterate entries whose key starts with a prefix |
| `remove(index, key) -> bool` | Remove a single entry |
| `compact_index(index, predicate) -> usize` | Two-pass remove-all-matching (collect then delete) |
| `snapshot()` / `load_snapshot()` | Persist/restore all indexes to/from JSON |

Read operations hold only a read lock. `insert` and `remove` hold a write lock briefly (SkipMap operations are lock-free internally).

## Projection trait

```rust
pub trait Projection: Send + Sync {
    fn event_type(&self) -> &str;
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()>;
}
```

A single projection struct can handle multiple event types (e.g., `MessagesProjection` handles `message_created`, `message_edited`, `message_deleted`).

## Record encoding

Most projections use `postcard` binary encoding via the `RecordCodec` trait. A few (channels, audit) use `serde_json` directly.

Each projection module exports:
- `encode_record(r) -> Vec<u8>` — postcard serialization
- `decode_record(buf) -> Result<T>` — postcard deserialization
- `encode_key(...) -> Vec<u8>` — composite key encoding (length-prefixed strings)

## Key encoding

Composite keys use length-prefixed components (u64 length + bytes), enabling prefix scans:

| Projection | Key Pattern | Prefix Scan |
|------------|-------------|-------------|
| messages | `encode_key(channel_id, message_id)` | by channel_id |
| wiki_pages | `encode_key(channel_id, page_id)` | by channel_id |
| forum_posts | `encode_key(channel_id, thread_id, post_id)` | by channel_id then thread_id |
| incidents | `encode_key(channel_id, incident_id)` | by channel_id |
| albums | `encode_key(scope_type, scope_id, album_id)` | by scope |
| dm_messages | `encode_key(dm_id, message_id)` | by dm_id |
| reactions | `composite_key(message_id, user_id, emoji)` | by message_id |

## All registered projections

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
| wiki_revisions | WikiRevisionProjection | wiki_revision_created |
| forum_posts | ForumProjection | forum_thread_created, forum_post_created, forum_post_edited, forum_post_deleted |
| incidents | IncidentProjection | incident_created, incident_updated, incident_resolved |
| gallery_works | GalleryWorkProjection | gallery_work_uploaded, gallery_work_edited, gallery_work_deleted |
| gallery_feedback | GalleryFeedbackProjection | gallery_feedback_added, gallery_feedback_deleted |
| albums | AlbumProjection | album_created, album_updated, album_deleted |
| album_items | AlbumItemsProjection | album_item_added, album_item_updated, album_item_removed |
| dm_messages | DmMessagesProjection | dm_message_created |
| dm_message_recipients | DmMessageRecipientsProjection | dm_message_recipient_added |
| audit | AuditProjection | role_assigned, role_removed, channel_settings_updated |
| (noop) | NoopProjection | reaction_removed, member_joined, member_left, channel_renamed |

All projections registered in `engine/mod.rs::build_type_registry()`.

## Tombstone compaction

Six projections support soft-delete via `is_deleted: bool` and a `compact()` method:
- MessagesProjection, WikiProjection, ForumProjection, IncidentProjection, AlbumProjection, AlbumItemsProjection

`compact()` calls `ProjectionState::compact_index()` — two-pass scan: collect matching keys under read lock, then remove them.

**If the projection has secondary indexes, `compact()` MUST purge those too** — secondary indexes are NOT auto-cleaned.

## Secondary indexes

Messages registers `MessagesByChannelIndex` and `MessagesByAuthorIndex`. Applied after successful primary apply so replay rebuilds indexes.

**Value encoding**: on `message_created`, primary rewrites `message_id = format!("msg_{:x}", commit_seq)`. Secondary values must use the same rewrite; raw `event.payload` leaves empty ids.

**Query ordering**: `prefix_scan` returns lexicographic key order. After decode + filter, sort by parsed numeric commit_seq, THEN apply limit. Without this, mixed-width ids misorder.

**`with_index` read-lock fast path**: existing index → read lock; missing → write lock + create. The hot apply path must NOT contend on a write lock.

## How to add a new projection

1. Define record struct in `src/projections/my_projection.rs` with `RecordCodec`
2. Implement `encode_record`, `decode_record`, `encode_key` free functions
3. Implement `MyProjection` struct with `Projection` trait
4. Add typed query methods: `get_*`, `list_*`
5. Optionally add `is_deleted` field and `compact()` static method
6. Register in `engine/mod.rs::build_type_registry()` (BEFORE NoopProjection, with trailing comma)
7. Add `pub mod my_projection;` to `src/projections/mod.rs` (only for genuinely new modules; reuse existing module when projections share a surface)
8. Add domain type + `From` impl in `src/domain/mod.rs`
9. Add methods to `WabiStore` trait, implement in `WdbAdapter`

## Common pitfalls

- **`for_each` / `prefix_scan` closures must not call `state.get`/`state.insert` for a DIFFERENT index** — even a read `get` inside the read-locked closure is unsafe vs a queued writer. Collect pairs, drop the lock, then call the other index.
- **Compaction must cover secondary indexes** — deleted rows persist until full rebuild otherwise.
- **Registration block is comma-sensitive** — new entries go BEFORE NoopProjection with trailing commas. Missing registration → events never apply.
- **`WabiStore` trait + `WdbAdapter` impl must match signatures exactly** — declare on the trait FIRST.
- **Adapter emit-shape is NOT uniform** — forum uses `self.wdb.emit(event)`, wiki uses `self.run(actor, "op", channel_id, "event_type", 6, payload, true, None)`. Always copy the TARGET module's existing create method.