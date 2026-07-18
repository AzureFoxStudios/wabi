# Channel Types Follow Chat Refs (outline)

> Do not implement full Forum/Wiki/Gallery UIs until chatref-01…05 are usable.
> Link grammar is locked in `docs/plans/2026-07-18-chat-object-refs.md`.

## Grammar (do not re-litigate)
- `@` user
- `#` channel
- `^` object (auto-sense forum/wiki/gallery/place; namespaces `^f/` `^w/` `^g/` `^m/`)
- No `~`. No primary `?` / `!` prefixes.

## Required hooks for every non-chat surface
1. On load/list: `registerObjectRef({ kind, id, slug, title, channelId, … })`
2. Context menu / ⋯: Share to channel…, Copy link, Copy ref via `shareToChannel` helpers
3. Focus target for `navigateToRef({ kind, channelId, *Id })`

## North-star mocks (existing)
- `/var/home/Ronin/wabi-channel-specs/forum_mockup_v2.html` — 3-pane old-school boards
- `/var/home/Ronin/wabi-channel-specs/wiki_mockup_v2.html` — tree + editorial docs
- `/var/home/Ronin/wabi-channel-specs/gallery_mockup_v2.html` + `frontend/static/gallery-prototype.html` — Steam-style library

## Suggested later board (not seeded yet)
- gallery: add ChannelKind::Gallery + wire existing GalleryChannel.svelte
- wiki: surface over existing WikiPage projection
- forum: 3-pane UI + real forum_post persistence (stubs today)

Each product card must depend on chat ref spine (chatref-04 at minimum for chips/nav, chatref-05 for share).

## surf-forum-api: forum domain change

Implemented 2026-07-18 as part of the `surf-forum-api` kanban card.

### New ForumPostRecord fields (appended at end, postcard-safe)

- `title: String` — thread starter title; empty for replies
- `tags: Vec<String>` — e.g. `["bug"]`, `["feature"]`, `["discussion"]`
- `votes_up: u64`, `votes_down: u64` — aggregate counters
- `is_solution: bool` — accepted answer for a thread (only meaningful on replies)
- `category: Option<String>` — optional forum category

These fields are at the end of the struct, after `is_thread_starter`. Postcard zero-fills unknown fields on decode, so existing stored records remain compatible.

### New event types

| Event | Payload shape | Effect |
|-------|---------------|--------|
| `forum_post_voted` | `{post_id, thread_id, channel_id, direction, actor_user_id}` — postcard | Increments `votes_up` or `votes_down` on matching record |
| `forum_post_solution_set` | `{post_id, thread_id, channel_id, actor_user_id}` — postcard | Sets `is_solution=true` on target, clears on all other replies in thread |
| `forum_thread_meta_updated` | Full `ForumPostRecord` (postcard) | Replaces the stored record (adapter encodes completed record) |

### Files changed

- `core/crates/wabidb/src/projections/forum.rs` — struct fields, handlers, tests
- `core/crates/wabidb/src/domain/mod.rs` — `ForumPost` struct + `From` impl
- `core/crates/wabidb/src/engine/wabi_store.rs` — trait methods
- `core/crates/wabidb/src/tests/property_tests.rs` — prop test literals
- `core/crates/wabidb/benches/projection_read.rs` — bench literal
- `core/crates/wabi-server/src/adapter/mod.rs` — adapter impls
- `core/crates/wabi-server/src/api/forum.rs` — API routes + payloads
- `core/crates/wabi-server/src/socketio/channel_ops.rs` — caller update
- `core/crates/wabi-server/Cargo.toml` — added `postcard` dep

## surf-gallery-api: gallery domain change

Implemented 2026-07-18 as part of the `surf-gallery-api` kanban card.

### New projections

| Projection | Index | Event types |
|-----------|-------|-------------|
| `GalleryWorkProjection` | `gallery_works` | `gallery_work_uploaded`, `gallery_work_edited`, `gallery_work_deleted` |
| `GalleryFeedbackProjection` | `gallery_feedback` | `gallery_feedback_added`, `gallery_feedback_deleted` |

This adds real WabiDB-backed storage for gallery works and their coordinate-pinned feedback comments (steam-style critique markers). Previously `galleryStore.ts` was a separate, non-WabiDB media system — gallery is now WabiDB-backed.

### New domain types

- `GalleryWork` (from `GalleryWorkRecord`) — work_id, channel_id, author_user_id, title, caption, attachment_url, mime_type, category, is_wip, timestamps, is_deleted
- `GalleryFeedback` (from `GalleryFeedbackRecord`) — feedback_id, work_id, channel_id, author_user_id, comment, x_percent, y_percent, created_at_micros, is_deleted

### Files changed

- `core/crates/wabidb/src/projections/gallery.rs` — new file: two projections + tests
- `core/crates/wabidb/src/projections/mod.rs` — added `pub mod gallery`
- `core/crates/wabidb/src/domain/mod.rs` — added `GalleryWork`, `GalleryFeedback` + `From` impls
- `core/crates/wabidb/src/engine/wabi_store.rs` — 8 new `WabiStore` trait methods + default no-op impls
- `core/crates/wabidb/src/engine/mod.rs` — registered both projections in `build_type_registry()`
- `core/crates/wabi-server/src/adapter/mod.rs` — 8 new `WdbAdapter` implementations (read from projection state, write via `self.run()`)
- `core/crates/wabi-server/src/api/gallery.rs` — new file: axum API routes
- `core/crates/wabi-server/src/api/mod.rs` — added `pub mod gallery`
- `core/crates/wabi-server/src/api/routes.rs` — mounted `/gallery` routes

## surf-wiki-api: wiki domain change

Implemented as part of the `surf-wiki-api` kanban card.

### New WikiPageRecord fields (appended at end, postcard-safe)

- `parent_page_id: String` — parent page for tree nesting; `""` for top-level
- `slug: String` — URL-friendly slug for `^w/slug` chat-refs; auto-derived from title if empty
- `order_index: i64` — sort order among siblings; default 0

These fields are at the end of the struct, after `is_deleted`. Postcard zero-fills unknown fields on decode, so existing stored records remain compatible.

### New projection: WikiRevisionProjection

| Projection | Index | Event types |
|-----------|-------|-------------|
| `WikiRevisionProjection` | `wiki_revisions` | `wiki_revision_created` |

Key format: `encode_revision_key(channel_id, page_id, revision_id)` — three-part length-prefixed composite key. Prefix scan by `(channel_id, page_id)` for listing revisions ordered by `created_at_micros`.

A `WikiRevisionRecord` captures one edit: `revision_id`, `page_id`, `channel_id`, `editor_user_id`, `title`, `body`, `summary` (edit summary), `created_at_micros`.

### Revision auto-creation

On page edit (adapter's `update_wiki_page`), the adapter reads the **pre-edit** state from the projection and emits a `wiki_revision_created` event via `self.run()` before the `wiki_page_edited` overwrite. The revision's `summary` is initially empty (the API can be extended later).

### New domain type

`WikiRevision` (from `WikiRevisionRecord`) — same fields minus key encoding.

### API routes

- `GET /wiki/{channel_id}/pages/{page_id}/revisions` — lists all revisions for a page
- `GET /wiki/{channel_id}/pages/{page_id}/revisions/{revision_id}` — get a single revision

### Files changed

- `core/crates/wabidb/src/projections/wiki.rs` — struct fields, new projection, revision codec, tests
- `core/crates/wabidb/src/domain/mod.rs` — `WikiPage` new fields, `WikiRevision` + `From` impl
- `core/crates/wabidb/src/engine/wabi_store.rs` — trait method signatures updated + new revision methods
- `core/crates/wabidb/src/engine/mod.rs` — registered `WikiRevisionProjection`
- `core/crates/wabidb/src/tests/property_tests.rs` — prop test literals updated
- `core/crates/wabidb/benches/projection_read.rs` — bench literal updated
- `core/crates/wabi-server/src/adapter/mod.rs` — adapter methods for wiki + revisions; revision auto-creation on edit; `slugify_title` helper
- `core/crates/wabi-server/src/api/wiki.rs` — API payloads extended with `parentPageId`/`slug`/`orderIndex`; revision routes added
