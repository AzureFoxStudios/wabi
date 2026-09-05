---
name: wabidb-core-capabilities
description: "Fact-checked reference for WabiDB's event-store architecture and API."
metadata:
  version: 0.3.0
  author: Hermes + review
  platforms: [linux, macos, windows]
  hermes:
    tags: [WabiDB, Architecture, EventStore, Storage]
---

# WabiDB Core Capabilities

Fact-checked reference for WabiDB's actual architecture — an encrypted event/command store with materialized projections. NOT a generic key-value or SQL database.

## When to Use

- Need an accurate architecture overview of WabiDB
- Understanding the event-command model vs. KV/SQL assumptions
- Debugging or extending the sequencer, storage, or projection layers
- Evaluating WabiDB for integration (it is an ordered event log, not a general-purpose DB)

## Prerequisites

- Access to WabiDB source code at `/var/home/Ronin/wabi`
- Rust toolchain
- Basic understanding of event sourcing and CQRS concepts

## How to Run

WabiDB is embedded as a library crate (`wabidb`) and wrapped by an Axum HTTP server (`wabi-server`). There is no standalone CLI.

## Quick Reference

| Component | File(s) | Purpose |
|-----------|---------|---------|
| Engine | `src/engine/mod.rs` | `WabiDbEngine` — top-level API, startup, recovery |
| Sequencer | `src/sequencer/mod.rs` | Single-threaded commit ordering, 5 crash points |
| Segment writer | `src/stream_log/segment_writer.rs` | Append-only `.wseg` files, per-stream |
| Commit index | `src/commit_index/` | `.widx` batcher with fsync durability |
| Projections | `src/projections/` | Materialized views via `crossbeam-skiplist::SkipMap` |
| Crypto | `src/crypto/` | Per-stream AES-256-GCM, double ratchet, X3DH |
| Replication | `src/replication/` + `wabi-server/src/` | `SyncTransport` trait, HTTP push/pull |
| WabiStore trait | `src/engine/wabi_store.rs` | Typed domain API (50+ methods) |
| Benchmarks | `benches/projection_read.rs` | 24 benchmarks across get/list/compact |

## Architecture

### Event/Command Model

WabiDB is not a key-value store. Clients submit structured `CommandCommit` messages containing typed events. The engine processes them through:

1. **Sequencer**: Single `tokio::sync::Semaphore(1)` permit. Assigns a monotonic `commit_seq` (never reused — "burned" on failure).
2. **Segment writes**: Each event is encrypted (AES-256-GCM) and appended to the owning stream's `.wseg` file.
3. **Commit index**: A `CommitIndexEntry` is built with all stream references and submitted to the batcher for fsync.
4. **Durability-await**: The batcher group-flushes and the caller waits for fsync.
5. **Whole-command dispatch**: Send a `DispatchCommit` and await all its projection handlers, in event order.
6. **Application acknowledgment**: Only the dispatcher advances the shared watch-backed barrier, once per fully applied commit. A failed handler halts the prefix and writer; it cannot roll back the durable log.
7. **Response**: Return the outcome only after durability AND application. Optional work can be rejected as busy at command admission, never after fsync. Reads after success need no projection polling; ordinary concurrent reads are not snapshot-isolated.

### Storage

- **Segment files** (`.wseg`): Append-only, max ~64 MiB each, named `00000001.wseg` etc. Each record: 48-byte `RecordHeader` + variable payload + 16-byte padding. Magic `b"WABI"`, CRC32C on header and payload.
- **Commit index** (`.widx`): Global ordering log, batcher with configurable batch size/age. Contains `StreamRef` entries mapping each event to its segment location.
- **Engine checkpoints** (`projections/snapshot.json`): Whole-commit JSON+hex snapshots, synchronized with application and atomically replaced after fsync. Binary `.wsnap` support is separate, not the engine checkpoint path.
- **Blobs** (`.bin` + `.meta`): BLAKE3-addressed large binary data.
- **Manifest**: `storage-manifest.json` tracking schema version, commit watermark, per-stream metadata.

### Security

- **Per-stream keys**: Each stream has a unique 32-byte key registered via `register_stream_key()`.
- **AES-256-GCM**: Event payloads encrypted with `commit_seq` as nonce; reject duplicate streams within one command before writing to avoid nonce reuse. Replay skips orphans even with an empty index, but their sequences still seed future nonce allocation.
- **Key exchange**: Double ratchet protocol with X3DH initial handshake.
- **Key destruction**: Cryptographic deletion for retention compliance.

### Testing

- **Unit**: 753+ tests across all modules.
- **Property**: Proptest-based round-trip tests for `RecordHeader`, `CommitIndexEntry`, projection records (messages, wiki, forum, incidents, users), key encoding injectivity (wiki, forum, incidents), and domain JSON round-trips (wiki, forum, incidents).
- **Integration**: Full command-commit-readback flows testing projection state consistency.
- **Fuzz**: 4 inline targets in `src/fuzz/mod.rs` (14 test cases) covering `RecordHeader`, `StreamRef`, `CommitIndexEntry`, and `parse_composite_key` with empty/truncated/garbage/max-size inputs.
- **Power-loss**: 5 physical subprocess crash tests (one per crash boundary) + 3 logical crash tests. Uses `crash_point!()` macro in the sequencer to simulate hard exits at strategic boundaries.

### Projection Indexes

| Index Name | Projection Struct | Event Types | Record Type |
|------------|-------------------|-------------|-------------|
| `messages` | `MessagesProjection` | `message_created`, `message_edited`, `message_deleted` | `MessageRecord` |
| `reactions` | `ReactionsProjection` | `reaction_added` | `Reaction` |
| `channel_members` | `ChannelMembersProjection` | `channel_member_added` | `ChannelMemberRecord` |
| `users` | `UsersProjection` | `user_registered` | `UserRecord` |
| `emotes` | `EmotesProjection` | `emote_upserted` | `Emote` |
| `webhooks` | `WebhooksProjection` | `webhook_upserted` | `Webhook` |
| `user_layouts` | `LayoutsProjection` | `user_layout_upserted` | `UserLayout` |
| `channels` | `ChannelProjection` | `channel_created` | `Channel` (JSON) |
| `call_sessions` | `CallSessionsProjection` | `call_session_created`, `call_session_ended` | `CallSession` |
| `call_participants` | `CallParticipantsProjection` | `call_participant_joined` | `CallParticipant` |
| `call_signals` | `CallSignalsProjection` | `call_signal_emitted` | `CallSignal` |
| `wiki_pages` | `WikiProjection` | `wiki_page_created`, `wiki_page_edited`, `wiki_page_deleted` | `WikiPageRecord` |
| `forum_posts` | `ForumProjection` | `forum_thread_created`, `forum_post_created`, `forum_post_edited`, `forum_post_deleted` | `ForumPostRecord` |
| `gallery_works` | `GalleryWorkProjection` | `gallery_work_uploaded`, `gallery_work_edited`, `gallery_work_deleted` | `GalleryWorkRecord` |
| `gallery_feedback` | `GalleryFeedbackProjection` | `gallery_feedback_added`, `gallery_feedback_deleted` | `GalleryFeedbackRecord` |
| `wiki_revisions` | `WikiRevisionProjection` | `wiki_revision_created` | `WikiRevisionRecord` |
| `incidents` | `IncidentProjection` | `incident_created`, `incident_updated`, `incident_resolved` | `IncidentRecord` |
| `albums` | `AlbumProjection` | `album_created`, `album_updated`, `album_deleted` | `AlbumRecord` |
| `album_items` | `AlbumItemsProjection` | `album_item_added`, `album_item_updated`, `album_item_removed` | `AlbumItemRecord` |
| `dm_messages` | `DmMessagesProjection` | `dm_message_created` | `DmMessageRecord` |
| `dm_message_recipients` | `DmMessageRecipientsProjection` | `dm_message_recipient_added` | `DmRecipientRecord` |
| `audit` | `AuditProjection` | `role_assigned`, `role_removed`, `channel_settings_updated` | `AuditEntry` |

All projections are registered in `engine/mod.rs::build_type_registry()`.

**Drift audit 2026-08-21 (current registry = 31 registrations):** the table above is missing these newer entries — `dm_identities`, `server_meta`, `whiteboard_docs` (raw JSON board docs), lore ×4 (`lore_repos`, `lore_commits`, `lore_file_changes`, `lore_tokens`), and PaymentsProjection (one registration fanning EIGHT event types into four indexes: `payment_account_links,payment_intents,payment_policies,payment_user_blocks` — see `projections/payments`). Also newer engine frameworks not covered elsewhere: **SecondaryIndex** (A1, secondary indexes for messages), **QueryableProjection** (A2), replication interval + maintenance (A4/A5). `ChannelKind` now runs Text0→Gallery9, Category10, Lore11, Planning12, Reception13 — all append-only, never renumber.

### Tombstone Compaction

Six projections support soft-delete via an `is_deleted: bool` field and a `compact()` method:

- `MessagesProjection::compact()` — removes deleted messages
- `WikiProjection::compact()` — removes deleted wiki pages
- `ForumProjection::compact()` — removes deleted forum posts
- `IncidentProjection::compact()` — removes deleted incidents
- `AlbumProjection::compact()` — removes deleted albums
- `AlbumItemsProjection::compact()` — removes deleted album items

`compact()` calls `ProjectionState::compact_index()` which does a two-pass scan:
1. Collect matching keys under read lock
2. Remove collected keys under read lock

The `list_*` methods on each projection accept `include_deleted: bool` (default `false`).

### WabiStore Trait

`WabiStore` (`src/engine/wabi_store.rs`) is the typed domain API for reading/writing WabiDB data:

- **Read methods**: `get_user`, `get_channel`, `get_message_typed`, `list_messages_typed`, `list_channels`, `list_channel_members`, `list_reactions`, `list_bans`, `list_role_definitions`, `get_emotes`, `get_webhooks`, `get_user_layout`, `get_channel_retention`, `list_albums`, `get_album`, `list_items`, `list_wiki_pages`, `get_wiki_page`, `list_forum_threads`, `list_forum_posts`, `get_forum_post`, `list_incidents`, `get_incident`, `get_dm_message`, `list_dm_messages`, `list_dm_recipients`
- **Write methods**: `send_message`, `create_user`, `create_channel`, `add_reaction`, `remove_reaction`, `add_channel_member`, `remove_channel_member`, `ban_user`, `unban_user`, `touch_user`, `create_album`, `delete_album`, `add_item`, `delete_item`, `create_wiki_page`, `update_wiki_page`, `delete_wiki_page`, `create_forum_thread`, `create_forum_post`, `update_forum_post`, `delete_forum_post`, `create_incident`, `update_incident`, `resolve_incident`, `send_dm_message`

Two implementations:
- **`WdbAdapter`** (wabi-server) — backed by the real engine, writes events via `self.run()`
- **`LocalWabiStore`** (wabidb) — HashMap-backed in-memory store for testing

### Performance Benchmarks

`benches/projection_read.rs` contains 24 benchmarks across three groups:

| Group | Benchmarks | Description |
|-------|-----------|-------------|
| `projection_get` | 10 | Single-record lookups (messages, members, dm, recipients, reactions, wiki, forum, incidents, albums, items) |
| `projection_list` | 13 | Range scans with optional deleted filtering |
| `projection_compact` | 1 | Compaction of 10% deleted records |

Each benchmark populates 10k records across 100 groups. Run with `cargo bench -p wabidb -- projection_read`.

### Replication

- `SyncTransport` trait with `pull()`, `push()`, `latest_seq()` methods.
- `ReqwestTransport` implementation using HTTP client.
- Server endpoints: `POST /api/v1/sync/pull`, `POST /api/v1/sync/push`, `GET /api/v1/sync/status`.
- Segment-shipping model: encrypted `.wseg` bytes transferred as base64, written to same path structure on replica.
- Enabled via `WABIDB_PEER_ENDPOINT` env var at server startup.

## Key Files

| Purpose | Path |
|---------|------|
| Engine + config + recovery | `src/engine/mod.rs` |
| Sequencer (commit logic) | `src/sequencer/mod.rs` |
| Segment writer | `src/stream_log/segment_writer.rs` |
| Commit index + batcher | `src/commit_index/` |
| Projections + barrier | `src/projections/` |
| Fuzz targets | `src/fuzz/mod.rs` |
| Power-loss tests | `src/tests/power_loss.rs` |
| Property tests | `src/tests/property_tests.rs` |
| Replication trait + config | `src/replication/` |
| WabiStore trait + LocalWabiStore | `src/engine/wabi_store.rs` |
| WdbAdapter (server-side impl) | `wabi-server/src/adapter/mod.rs` |
| HTTP server + sync endpoints | `wabi-server/src/` |
| Benchmarks | `benches/projection_read.rs` |

## Pitfalls

- **Not a KV store**: Do not expect `get(key)` / `put(key, value)`. The API is command/event-based.
- **No SQL**: WabiDB does not support SQL queries, MVCC, bloom filters, or WAL.
- **Single-threaded sequencer**: All writes go through one sequencer permit — write throughput is bounded by single-core commit processing.
- **Projections are in-memory**: Rebuilt from snapshots + commit journal on restart. Large datasets may have slow recovery.
- **Recovery must use the existing log**: Never clean the commit index to make a restart test pass. Startup must recover every indexed post-snapshot event in `(commit_seq, event_ref ordinal)` order or refuse readiness. Handler failures cannot be logged and skipped. Failed open releases its own engine lock.
- **DB-change policy**: Per AGENTS.md, implement + document + update relevant skills autonomously for domain/projection/ChannelKind changes. Preserve postcard compatibility; this policy does not authorize pushes or deployment.
- **Live-channel keying (2026-07-18): do NOT add a `live` `ChannelKind`/`Channel` domain field.** A struct-field change to the `Channel` domain type risks the **postcard replay-break** class of bug — old events fail to decode on replay (this is exactly what broke Tim's accounts). Instead key Live behavior off the EXISTING in-memory `channel_auto_delete_label` map using the sentinel string `"live"` (already used for timed-retention labels). The backend `update-channel-settings` handler already accepts `autoDeleteAfter: "live"`. Verified Live Rooms backend (in-memory reaper + per-message TTL + count cap + `message-deleted` emit + `live-buffer-snapshot`) lives in `wabi-server`; port recipe in `software-development/wabi-frontend-polish` → `references/live-rooms-architecture-and-port-recipe.md`.

## Verification

Confirm understanding by tracing through the commit path:

1. Find `run`, `prepare_command`, and `finalize_command` in `src/sequencer/mod.rs`.
2. Trace assignment → segment fsync → index group fsync → whole-command apply → barrier/ack → response.
3. Run `tests::write_completion` with `--features test-harness` for actual subprocess recovery at all five `crash_point()` boundaries. See `wabidb-transaction-system` for guarantee limits and the 2026-09-05 plan for evidence.
