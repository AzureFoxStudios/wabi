---
name: wabidb-store-trait
description: "Learn the WabiStore trait — WabiDB's typed domain API with 50+ read/write methods, and its two implementations: WdbAdapter and LocalWabiStore."
---

# WabiDB Store Trait

This skill covers the `WabiStore` trait — the typed domain API that sits between the wabi-server handlers and the WabiDB engine. It maps event-based projection data to clean domain types.

## When to Use

- Wiring a new domain feature through WabiDB (projection → trait → adapter → API)
- Understanding how wabi-server handlers interact with the database
- Adding a new read or write method to the storage API
- Implementing tests with `LocalWabiStore`

## Prerequisites

- Understanding of WabiDB projections (see wabidb-projection-system skill)
- Familiarity with Rust async traits

## Key Files

| File | Purpose |
|------|---------|
| `wabidb/src/engine/wabi_store.rs` | `WabiStore` trait + `LocalWabiStore` impl |
| `wabidb/src/domain/mod.rs` | Domain types (`User`, `Channel`, `Message`, `WikiPage`, etc.) |
| `wabi-server/src/adapter/mod.rs` | `WdbAdapter` — real engine-backed impl |

## Trait Architecture

`WabiStore` is `Send + Sync` so it can be shared across async tasks via `Arc<dyn WabiStore>`:

```rust
#[allow(async_fn_in_trait)]
pub trait WabiStore: Send + Sync {
    // writes
    async fn send_message(&self, channel_id: &str, user_id: u64, content: &str) -> Result<String>;
    async fn create_user(&self, username: &str, handle: Option<&str>, password_hash: &str) -> Result<u64>;
    // ... 50+ methods total

    // reads return domain types
    async fn get_message_typed(&self, message_id: &str) -> Result<Option<Message>>;
    async fn list_wiki_pages(&self, channel_id: &str) -> Result<Vec<WikiPage>>;
    // ...
}
```

Every method has a default stub returning `Ok(None)` / `Ok(Vec::new())` / `Ok(String::new())` — so implementors only need to override the methods they support.

**Drift audit 2026-08-21:** the trait has grown to **~186 async fns** (count `async fn` in wabi_store.rs). Beyond the domains listed below it now carries: **payments** (`get_payment_policy`/`upsert_payment_policy`, `list_payment_account_links`, `upsert/delete_payment_account_link`, payment intent persistence + more under the `// --- payments ---` section), **whiteboard docs** (`get_whiteboard_doc`/`put_whiteboard_doc`, raw JSON by board id), plus dm-identity and server-meta reads. The "50+ methods" figure is historical.

## Domain Types

Domain types live in `wabidb/src/domain/mod.rs` and mirror the projection record types with `From` impls:

```rust
pub struct WikiPage {
    pub page_id: String,
    pub channel_id: String,
    pub parent_page_id: String,   // "" for top-level pages (page tree)
    pub title: String,
    pub slug: String,             // url-ish slug for ^w/slug chat-ref + deep links
    pub order_index: i64,         // sort order among siblings
    pub body: String,
    pub author_user_id: u64,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub is_deleted: bool,
}

impl From<WikiPageRecord> for WikiPage { ... }
```

`WikiRevision` captures one edit to a page (auto-created on every `update_wiki_page`):

```rust
pub struct WikiRevision {
    pub revision_id: String,
    pub page_id: String,
    pub channel_id: String,
    pub editor_user_id: u64,
    pub title: String,
    pub body: String,
    pub summary: String,          // edit summary (optional)
    pub created_at_micros: i64,
}

impl From<WikiRevisionRecord> for WikiRevision { ... }
```

Domain types use `serde_json` serialization (not postcard) since they cross the HTTP boundary.

## WdbAdapter (Real Implementation)

`WdbAdapter` wraps `WabiDbEngine` and implements every `WabiStore` method. There are two patterns:

### Read Pattern

```rust
async fn list_wiki_pages(&self, channel_id: &str) -> Result<Vec<WikiPage>> {
    use wabidb::projections::wiki;
    let state = self.engine.projection_state();
    let records = wiki::WikiProjection::list_pages(&state, channel_id, false)?;
    Ok(records.into_iter().map(WikiPage::from).collect())
}
```

Steps:
1. Import the projection module
2. Get `ProjectionState` from the engine
3. Call the projection's typed query method
4. Convert records to domain types with `.into_iter().map(T::from).collect()`

### Write Pattern

```rust
async fn create_wiki_page(&self, channel_id: &str, title: &str, body: &str, author_user_id: u64) -> Result<String> {
    use wabidb::projections::wiki::{encode_record, WikiPageRecord};
    let now = now_micros();
    let record = WikiPageRecord {
        page_id: String::new(),   // projection overrides from commit_seq
        channel_id: channel_id.to_string(),
        title: title.to_string(),
        body: body.to_string(),
        author_user_id,
        created_at_micros: now,
        updated_at_micros: now,
        is_deleted: false,
    };
    let payload = encode_record(&record);
    let seq = self.run(author_user_id, "create_wiki_page", channel_id, "wiki_page_created", 6, payload, true, None).await?;
    Ok(format!("page_{:x}", seq))
}
```

The `self.run()` method:
1. Registers a stream encryption key if needed
2. Creates a `CommandCommit` with one `EventToWrite`
3. Submits to the engine's sequencer
4. Returns the assigned `commit_seq`
5. The projection handler processes the event and inserts the record

### Event Types By Domain

| Adapter Method | Event Type | stream_kind |
|----------------|-----------|------------|
| send_message | message_created | 0 |
| create_user | user_registered | 1 |
| create_channel | channel_created | 1 |
| add_reaction | reaction_added | 0 |
| add_channel_member | channel_member_added | 1 |
| create_album | album_created | 6 |
| delete_album | album_deleted | 6 |
| create_wiki_page | wiki_page_created | 6 |
| update_wiki_page | wiki_page_edited | 6 |
| delete_wiki_page | wiki_page_deleted | 6 |
| create_forum_thread | forum_thread_created | 6 |
| create_forum_post | forum_post_created | 6 |
| update_forum_post | forum_post_edited | 6 |
| delete_forum_post | forum_post_deleted | 6 |
| create_incident | incident_created | 6 |
| update_incident | incident_updated | 6 |
| resolve_incident | incident_resolved | 6 |
| send_dm_message | dm_message_created | 2 |

### Users roster read (`list_users`)

`async fn list_users(&self) -> Result<Vec<User>>` is a read method on `WabiStore` (no event) implemented by `WdbAdapter` via `UsersProjection::list(state, UsersFilter::default())` — returns EVERY user row (registered + guests + bots), each with profile fields. Guest discriminator = empty `password_hash`, exposed as `is_registered` on the wire (UserView). Wires into the socket `init` payload as `serverMembers` (the People panel offline roster = `serverMembers − online`); the admin registry merges `$serverMembers` + `$users` keyed `dbUserId ?? id`. Do not stub it with `Vec::new()` — the offline section depends on it.

## LocalWabiStore (Test Implementation)

HashMap-backed in-memory store in `wabidb/src/engine/wabi_store.rs`. Uses `HashMap<u64, User>`, `HashMap<String, Channel>`, etc. All read methods return data from the maps. Most write methods are stubs (read-only for tests).

```rust
impl WabiStore for LocalWabiStore {
    async fn get_user(&self, user_id: u64) -> Result<Option<User>> {
        Ok(self.users.get(&user_id).cloned())
    }
    async fn list_channels(&self, member_user_id: Option<u64>) -> Result<Vec<Channel>> {
        // filters by member if user_id is provided
    }
    // ...
}
```

## How to Wire a New Projection Through the Store

1. **Domain type** in `src/domain/mod.rs` — struct + `From<Record>` impl
2. **Trait methods** in `WabiStore` — add with default stub
3. **WdbAdapter impl** — read from projection, write via `self.run()`
4. **LocalWabiStore impl** — add HashMap field + read methods
5. **Import** `use wabidb::engine::wabi_store::WabiStore;` in API handlers

### Import Convention

API handler files must import the trait to call methods:

```rust
use wabidb::engine::wabi_store::WabiStore;
```
