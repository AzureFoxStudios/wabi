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
| message_by_id_v1 | length-prefixed message ID + composite primary key → primary key | bounded ID-prefix lookup |
| wiki_pages | `encode_key(channel_id, page_id)` | by channel_id |
| forum_posts | `encode_key(channel_id, thread_id, post_id)` | by channel_id then thread_id |
| incidents | `encode_key(channel_id, incident_id)` | by channel_id |
| albums | `encode_key(scope_type, scope_id, album_id)` | by scope |
| album_by_id | raw `album_id` bytes → composite `albums` key | exact ID lookup |
| dm_messages | `encode_key(dm_id, message_id)` | by dm_id |
| reactions | `composite_key(message_id, user_id, emoji)` | by message_id |

## All registered projections

| Index | Handler | Event Types |
|-------|---------|-------------|
| messages, message_by_id_v1 | MessagesProjection | message_created, message_edited, message_deleted, channel_messages_cleared |
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
| albums, album_by_id | AlbumProjection | album_created, album_updated, album_deleted |
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

Albums maintain `album_by_id` alongside their primary scope-keyed record. The
lookup stores only the composite primary key, uses the sequence-assigned ID,
and is removed when a deleted album is compacted. `get_album_by_id` lets access
checks and room-owner admission resolve the persisted parent without scanning
all albums. Older snapshots lack this derived index: engine startup rebuilds
and saves it before starting the dispatcher, preserving postcard record bytes
and the applied commit watermark. Rebuild rejects conflicting IDs or scope
keys. A read-only scan fallback is retained for manually constructed projection
states; normal engine startup completes the migration first.

Messages maintain `message_by_id_v1` pointers alongside the primary record.
An ID-prefix lookup reads at most two pointers, releases the scan lock and then
resolves the primary row. Two matches are an explicit ambiguity error; legacy
duplicate IDs remain readable through their room-scoped primary keys. Engine
startup validates all primary keys and existing pointers before inserting
missing pointers from older snapshots, then saves a migrated snapshot without
advancing its applied watermark. This requires a full startup scan and temporary
memory proportional to retained rows, not a scan per normal ID lookup. No
durable record/event layout changes. Compaction removes the pointer and every
historical time-index version for each removed message, preventing an older
live version from reappearing. See [operator guidance](../deployment/MESSAGE_ID_LOOKUP.md).

Messages registers `MessagesByChannelIndex` and `MessagesByAuthorIndex`. Applied after successful primary apply so replay rebuilds indexes.

**Value encoding**: on `message_created`, primary retains a writer-stamped ID
and falls back to `format!("msg_{:x}", commit_seq)` for a blank legacy ID.
Secondary values and new-command admission must use the same fallback.

**Query ordering**: `prefix_scan` returns lexicographic key order. After decode + filter, sort by parsed numeric commit_seq, THEN apply limit. Without this, mixed-width ids misorder.

**`with_index` read-lock fast path**: existing index → read lock; missing → write lock + create. The hot apply path must NOT contend on a write lock.

## Message parent admission

`room_writes::preflight_command` checks six new local event types before the
sequencer prepares their durable bytes: message create/edit/delete, channel
clear, reaction add/remove. It validates the event stream/kind, resolves the
stored message parent and requires any owner condition to match that parent.
Placed rooms reject missing conditions; unplaced rooms retain the existing
single-Authority compatibility path. Pending parents from successful earlier
preparations in the same fsync group are visible to later commands; rejected
commands and preparation failures contribute no binding. A message ID cannot
be rebound to a different room. The sequencer's existing placement check
validates the observed epoch/owner. Placement changes and these mutations
require separate commands, so a later write sees applied ownership.

Historic projection replay is unchanged. Other event types, Live/session work,
authenticated node enrollment and distributed writer leases remain outside
this guard. The sequencer additionally requires every provided owner condition
to equal its immutable local runtime node ID, selected at engine open; a
caller cannot claim a remote placement's identity. See the
[runtime identity contract](../deployment/NODE_RUNTIME_IDENTITY.md). This is
not a second room owner or a regional routing protocol.

## Workspace parent admission

`workspace_writes::preflight_command` covers the 22 event types registered by
Wiki/revisions, Forum, incidents, gallery/feedback and project tasks/runs. Its public
`is_room_event` catalog also selects the adapter's owner condition. Preflight
uses the same full-record decoders as replay to extract the actual channel,
requires Event/stream-kind-6 and a matching stream/condition, and rejects an
absent condition for a placed room. A mixed placement/workspace command is
refused; an isolated earlier placement must apply before the next write sees
its epoch. One invalid event refuses the whole command before preparation.

The Forum vote and solution payload decoders preserve their original postcard
field order and are shared with the handlers. Replay, record shapes and
projection semantics are unchanged. Unplaced legacy rooms keep compatibility.
This is local admission, not account authorization, an object-ID registry,
regional routing or a distributed lease. Other event families and session-only
work remain outside this module. See the
[workspace admission contract](../deployment/WORKSPACE_ROOM_ADMISSION.md).

## Call parent admission

For new local call writes, the sequencer calls
`call_sessions::preflight_room_writes` before durability. Each of the five call
event types must have a room owner condition, the expected event stream and a
matching persisted session parent. A new create declares its parent;
an existing session ID cannot be rebound to another room. Creation commands
run in isolated group-commit windows so subsequent preflight sees their applied
binding. This complements the owner/epoch check and changes no call record
encoding. Historic replay still uses the existing projection handlers, including
idempotent teardown of absent rows.

`call_sessions::direct_pair` is shared with API admission and preserves the
existing positive-i64, normalized, lexicographically ordered account grammar.
`placement_room_id(session_id, channel_id)` maps a canonical direct-call scope
to `call-dm-user-a-user-b`, requiring its stored parent to equal its public
session ID. Ordinary calls retain their actual Channel ID. The `call-dm-`
namespace is reserved for direct-call placements and is separate from DM chat
Channels. New/recreated unplaced direct calls append an epoch-one placement
after the call event in the same commit; preflight rejects omission, a wrong
initial owner, duplicate creation and existing Channel collisions. Recreation
of a placed call retains the placement epoch. The stopped backfill collects
legacy active/ended direct sessions as well as active Channels, checks the
complete set, then emits bounded placement batches. No call record fields,
replay encodings or snapshot watermark rules changed. These checks are not
distributed leases, live media admission, owner routing or regional delivery.

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

## Canonical session revocations (2026-09-28)

`auth_revocations_updated_v1` applies bounded JSON deltas on
`auth-revocations:v1` (kind 6) to `auth_revocations_v1`. Separate rows hold
global/account floors, token expirations, legacy user denials and the import
completion marker. The sequencer isolates these commands and preflights their
whole transition before preparation. Replay uses the same transition planner
before changing any row. Floors cannot decrease; token expiration cannot be
shortened; stale prune operations cannot delete updated entries. The Authority
imports legacy JSON in bounded batches before accepting users, then reads only
canonical state. These records change no existing postcard layouts. Matching
readers are required for rollback/replication; see
[session revocation operations](../deployment/SESSION_REVOCATION_RECOVERY.md).
This component marker does not certify a complete recovery checkpoint.

## Canonical recovery codes and compound account recovery (2026-09-28)

`recovery_codes_updated_v1` carries bounded JSON operations on
`recovery-codes:v1` (kind 6). `recovery_codes_v1` stores code digests,
account bindings, permanent consumed-code records and a migration completion
marker. The sequencer isolates and preflights the complete transition. New
issuance requires the canonical current owner; consumption requires an unused
code bound to the requested account. Imports retry identical entries before
initialization, while consumed digests cannot be reissued.

The single `Recover` operation validates the existing account and the advancing
global floor, then its handler publishes the consumed code, the existing
`server_meta` owner record and the existing `auth_revocations_v1` global
record at one commit sequence. All rows are validated/encoded before mutation.
Replay uses the same planner; this preserves one recovery boundary without
altering any postcard layouts. Ordinary reads still lack snapshot isolation.
The Authority's ordered owned-worker guards cover durable completion and
in-memory publication. Matching recovery readers are required. See
[account recovery operations](../deployment/ACCOUNT_RECOVERY_STATE.md).

## Coordinated local checkpoint boundary (2026-09-28)

The candidate `engine/checkpoint.rs` holds local commit windows and inbound
ingestion after application drain, checks indexed/applied prefix agreement and
retains the engine. The dispatcher can begin periodic snapshot writing after
its application acknowledgment. `ProjectionState::with_checkpoint_snapshot`
therefore holds the existing application/snapshot lock across snapshot save
and synchronous file copying; the server moves all guards into the blocking
task so caller cancellation cannot resume writers while copying continues.
The application gate vetoes preparation after an interrupted admitted task.
No projection record, snapshot JSON shape or durable event encoding changed.
This is an ordering component, not complete encrypted live export or promotion.
See [operator contract](../deployment/CHECKPOINT_BOUNDARY.md).
