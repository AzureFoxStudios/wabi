---
name: wabidb-wabi-server-adapter
version: 0.1.0
author: Hermes
description: "Learn WabiDB integration patterns for wabi-server adapter."
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Integration, WabiDB, Adapter, WabiServer]
---

# WabiDB Integration Patterns for wabi-server Adapter

This skill provides a structured approach to learning WabiDB's integration patterns specifically for the wabi-server adapter, focusing on the WabiStore trait implementation and adapter patterns.

## When to Use

- Integrating WabiDB with wabi-server
- Implementing the WabiStore trait for wabi-server
- Understanding adapter patterns for WabiDB
- Learning about WabiDB's storage API
- Implementing domain-specific storage methods
- Understanding WabiDB's integration points with wabi-server

## Prerequisites

- Access to WabiDB source code and wabi-server implementation
- Understanding of WabiDB's architecture
- Familiarity with Rust async programming
- Basic knowledge of database concepts
- Understanding of WabiDB's domain model

## How to Run

Use these commands to explore WabiDB integration patterns:

```bash
# View WabiStore trait implementation
read_file /var/home/Ronin/wabi/core/crates/wabidb/src/engine/wabi_store.rs

# View adapter implementation
read_file /var/home/Ronin/wabi/core/crates/wabidb/src/adapter/mod.rs

# Run integration tests
cargo test -p wabidb --test wabi_store
cargo test -p wabidb --test adapter
```

## Quick Reference

| Component | Key Files | Key Methods | Purpose |
|-----------|-----------|------------|---------|
| WabiStore | `wabi_store.rs` | `send_message`, `create_user`, `get_message` | Define storage API |
| Adapter | `adapter/mod.rs` | `WdbAdapter`, `WabiStore` | Implement adapter |
| LocalStore | `wabi_store.rs` | `LocalWabiStore` | In-memory implementation |
| Domain | `domain.rs` | `Message`, `User`, `Channel` | Define domain model |

## Procedure

### 1. Understanding WabiStore Trait

**Pattern**: The WabiStore trait defines the storage API for WabiDB.

**Key Components**:
- `send_message`: Persist a message in a channel
- `create_user`: Create a new user
- `create_channel`: Create a new channel
- `add_reaction`: Add or update a reaction on a message
- `add_channel_member`: Add a user to a channel
- `get_message`: Retrieve a single message by ID
- `get_user`: Look up a user by ID
- `get_channel`: Look up a channel by ID

**Example Implementation**:
```rust
pub trait WabiStore: Send + Sync {
    async fn send_message(
        &self,
        channel_id: &str,
        user_id: u64,
        content: &str,
    ) -> Result<String>;

    async fn create_user(
        &self,
        username: &str,
        handle: Option<&str>,
        password_hash: &str,
    ) -> Result<u64>;

    async fn create_channel(
        &self,
        name: &str,
        channel_kind: crate::domain::ChannelKind,
        owner_user_id: u64,
    ) -> Result<String>;

    async fn get_message(&self, message_id: &str) -> Result<Option<String>>;
}
```

### 2. Implementing WabiStore for wabi-server

**Pattern**: Implement the WabiStore trait for wabi-server.

**Key Components**:
- `WdbAdapter`: The main adapter implementation
- `LocalWabiStore`: In-memory implementation for testing
- `WabiDbEngine`: The core engine implementation
- `WabiStore`: The trait definition

**Example Implementation**:
```rust
pub struct WdbAdapter {
    engine: Arc<WabiDbEngine>,
}

impl WabiStore for WdbAdapter {
    async fn send_message(
        &self,
        channel_id: &str,
        user_id: u64,
        content: &str,
    ) -> Result<String> {
        let cmd = CommandCommit {
            caller_user_id: user_id,
            caller_device_id: "adapter".into(),
            command_name: "send_message".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: format!("channel:{}", channel_id),
                event_type: "message_sent".into(),
                stream_kind: 1,
                record_kind: RecordKind::Event,
                plaintext: content.as_bytes().to_vec(),
            }],
            essential: true,
            response_tx: oneshot::channel().0,
        };
        let outcome = self.engine.run_command(cmd).await?;
        Ok(format!("msg_{}", outcome.commit_seq))
    }
}
```

### 3. Adapter Patterns

**Pattern**: Implement adapter patterns for WabiDB.

**Key Components**:
- `WdbAdapter`: The main adapter implementation
- `WabiDbEngine`: The core engine implementation
- `WabiStore`: The trait definition
- `LocalWabiStore`: In-memory implementation for testing

**Example Adapter**:
```rust
pub struct WdbAdapter {
    engine: Arc<WabiDbEngine>,
}

impl WdbAdapter {
    pub fn new(engine: Arc<WabiDbEngine>) -> Self {
        Self { engine }
    }
}

impl WabiStore for WdbAdapter {
    async fn send_message(
        &self,
        channel_id: &str,
        user_id: u64,
        content: &str,
    ) -> Result<String> {
        let cmd = CommandCommit {
            caller_user_id: user_id,
            caller_device_id: "adapter".into(),
            command_name: "send_message".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: format!("channel:{}", channel_id),
                event_type: "message_sent".into(),
                stream_kind: 1,
                record_kind: RecordKind::Event,
                plaintext: content.as_bytes().to_vec(),
            }],
            essential: true,
            response_tx: oneshot::channel().0,
        };
        let outcome = self.engine.run_command(cmd).await?;
        Ok(format!("msg_{}", outcome.commit_seq))
    }
}
```

### 4. Domain Model Integration

**Pattern**: Integrate WabiDB's domain model with wabi-server.

**Key Components**:
- `Message`: Domain model for messages
- `User`: Domain model for users
- `Channel`: Domain model for channels
- `Reaction`: Domain model for reactions

**Example Domain Model**:
```rust
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub user_id: u64,
    pub content: String,
    pub created_at_micros: i64,
}

pub struct User {
    pub id: u64,
    pub username: String,
    pub handle: Option<String>,
    pub password_hash: String,
}

pub struct Channel {
    pub id: String,
    pub name: String,
    pub channel_kind: ChannelKind,
    pub owner_user_id: u64,
}
```

### 5. Testing and Verification

**Pattern**: Comprehensive tests validate the integration.

**Key Test Cases**:
- Message creation and retrieval
- User creation and lookup
- Channel creation and membership
- Reaction addition and listing
- Domain model validation

**Example Test**:
```rust
#[tokio::test]
async fn test_send_message() {
    let engine = Arc::new(WabiDbEngine::open(config).await.unwrap());
    let adapter = WdbAdapter::new(engine);
    let message_id = adapter.send_message("ch_test", 1, "Hello, world!").await.unwrap();
    let message = adapter.get_message(&message_id).await.unwrap().unwrap();
    assert_eq!(message.content, "Hello, world!");
}
```

## Message Storage Classes (live / timed / forever) — schema-safe pattern

Wabi's public/text chat has three storage classes, resolved in the send path BEFORE any durable write:

- **live** — session only. Skip `wdb.send_message` entirely; assign a `live_<uuid>` id, push to the in-memory `session_messages` cache, emit the socket `message` event, and SKIP the TTL-delete spawn. Gone on process restart. Operator-readable while live (NOT E2EE — never market it as private).
- **timed** (product default) — `wdb.send_message` + schedule delete after `DEFAULT_CHANNEL_AUTO_DELETE_MS` (24h) unless an explicit map/policy overrides.
- **forever** — `wdb.send_message`, no TTL spawn. Explicit opt-in.

**Load-bearing rule — do NOT add a class field to the `Channel` domain struct.** Adding a trailing field to a postcard-encoded record (`Channel`, `UserRecord`, `MessageRecord`, etc.) breaks replay of older on-disk events unless you also write a `RecordV0`/`V1` dual-decode fallback (the same bug class that dropped Tim's user accounts). For a per-channel feature flag that does NOT need to survive restart the same way message bodies do, key it off an existing in-memory map instead:

```rust
// live/forever sentinels live in the existing in-memory label map,
// NOT in the postcard-encoded Channel record.
pub async fn channel_is_live(app: &AppState, channel_id: &str) -> bool {
    app.channel_auto_delete_label      // Arc<RwLock<HashMap<String,String>>>
        .read().await
        .get(channel_id)
        .map(|s| s == "live")          // "forever" is another sentinel in the same map
        .unwrap_or(false)
}
```

Both live send paths must carry the gate: `socketio/messages.rs::on_message` (registered at `socketio/wiring.rs` via `socket.on("message", ...)` — the `#[allow(dead_code)]` on it is only lint suppression; it IS the live handler) AND the REST `api/messages.rs::send_message`. Fixing only the socket path leaves an HTTP persistence hole.

**Contract test must prove "never written," not "not listed after restart."** Use a `tempfile::TempDir` data dir, send a unique `LIVE-CANARY-<uuid>` body, then recursively scan every file under the data dir and assert the canary bytes are absent (and a control non-live channel's canary IS present, i.e. new `.wseg` segment appears). A test that only checks history-after-restart can pass even if the body was briefly written then deleted.

See `references/message-storage-classes.md` for the full send-path split, default-retention nesting, and the OpenCode-delegation verification notes from the 2026-07-17 live-rooms build.

### Users roster wiring (list_users → serverMembers, 2026-08-06)

`WdbAdapter::list_users()` reads `UsersProjection::list(state, UsersFilter::default())` — EVERY user row (registered + guests + bots), profile fields included. It feeds the socket `init` payload's `serverMembers` key (`socketio/presence.rs`); the frontend renders the People panel's greyed-out "Offline — N" section as `serverMembers − online`. Guest discriminator = empty `password_hash`, exposed as `is_registered` on the wire (UserView → generated `isRegistered?: boolean | null`). Admin UI merges `$serverMembers` + `$users` (online wins, keyed `dbUserId ?? id`). Never hardcode `serverMembers: Vec::new()` — the offline roster silently vanishes.

## Pitfalls

- **API surface drift (audited 2026-08-21):** `wabi-server/src/api/` now includes modules these skills never covered: `payments/` (dir), `jobs`, `mesh`, `nodes`, `standby`, `lan`, `push`, `operator`, `steam`, `whiteboard`, `calls`. When wiring anything new, read `routes.rs` for the current nest layout instead of assuming the older module list.

- **Trait Object Limitations**: Ensure the WabiStore trait is object-safe
- **Async Trait Implementation**: Properly handle async trait methods
- **Error Handling**: Implement comprehensive error handling
- **Domain Model Mismatches**: Ensure domain model compatibility
- **Adapter Initialization**: Properly initialize the adapter
- **Testing Limitations**: Use LocalWabiStore for testing
- **Adapter emit-shape is NOT uniform across modules (load-bearing).** When you add a new event from `WdbAdapter` (in `wabi-server/src/adapter/mod.rs`), the emit call differs by module. The **forum** adapter uses `self.wdb.emit(event).await?`; the **wiki** adapter uses `self.run(actor_user_id, "op_name", channel_id, "event_type", 6, payload, true, None).await?` (where `payload = encode_record(&record)` and the returned `seq` becomes the id, e.g. `format!("page_{:x}", seq)`). Always read the target module's EXISTING create method and paste its exact emit call into the delegate prompt — do not assume one shape. A wrong emit call either fails to compile or (worse) silently doesn't persist the event, so the post-apply projection lookup test fails. (Verified 2026-07-18 building gallery + wiki surfaces.)
- **Multi-projection surfaces.** A surface can need two projections (e.g. gallery: `GalleryWorkRecord` + `GalleryFeedbackRecord`; wiki: `WikiPageRecord` extended + `WikiRevisionRecord`). Register BOTH in `engine/mod.rs::build_type_registry()` as separate `ProjectionRegistration` entries with distinct `index_name`/`record_type_name`. For the second projection in an existing module (wiki), add the new record + `XxxProjection` to the SAME `wiki.rs` file — no new `projections/mod.rs` module entry needed.

## Practical Reset Procedure

When the server returns 500s (auth, user, theme, places) or `server_owner.json` is stale/missing after drift or test data, perform a data dir reset.

**Key lessons from sessions:**
- **Ports are separate by design**: 5173 = frontend Vite (`bun run dev`). 3001 = backend `wabi-server`. `serverUrl.ts` rewrites all backend URLs to :3001 when the page is on 5173 (source: 'dev_vite'). This is why users ask "why the swap" — there is no swap; they are two processes.
- After DB reset the most common cause of "infinite spinning on 5173" is stale browser localStorage holding an old "wabi" token/session. Clear storage or use incognito.
- Server **requires** `WABIDB_ROOT_KEY` (or equivalent from_passphrase). Missing it produces: `validation failed for load_bootstrap_key: env var WABIDB_ROOT_KEY not set`.
- Clean up stale `wabidb/.lock` before restart.

See `references/wabi-data-dir-reset.md` for the exact backup + `rm -rf wabidb server_owner.json` + restart steps using the active `--data-dir`.

This was the recovery path used when the live frontend hit 500 while connected as "wabi" (owner marker existed but state was inconsistent). First registration after a wipe creates the owner.

## Verification

Confirm your understanding by running these commands:

```bash
# Run WabiStore tests
cargo test -p wabidb --test wabi_store

# Run adapter tests
cargo test -p wabidb --test adapter

# Run domain model tests
cargo test -p wabidb --test domain
```

These tests should all pass, demonstrating the key aspects of WabiDB's integration patterns for the wabi-server adapter.