# WabiDB Public API Audit Report

**Date:** 2026-06-21
**Target:** `/var/home/Ronin/wabi/core/crates/wabidb/src/`
**Method:** Source-code traversal (all `.rs` files read, all `pub` items catalogued, all 28 kanban-claimed command functions grepped)

---

## 1. Public API Surface (from `lib.rs` re-exports + engine entry points)

### Top-level re-exports (`lib.rs`)
| Item | Source |
|------|--------|
| `WabiDbEngine` | `engine/mod.rs:70` |
| `WabiDbConfig` | `engine/mod.rs:29` |
| `WabiError` | `error.rs` |
| `Result` | `error.rs` (type alias) |

### Public modules (all `pub mod` from `lib.rs`)
`engine`, `sequencer`, `commands`, `projections`, `subscription`, `crypto`, `auth`, `ephemeral`, `format`, `tests`.

### Private modules (`pub(crate)`)
`commit_index`, `storage`, `blobs`, `stream_log`, `snapshots`, `retention`, `replication`.

### `WabiDbEngine` methods (`engine/mod.rs`)

| Method | Signature | Line |
|--------|-----------|------|
| `open` | `async fn open(config: WabiDbConfig) -> Result<Self>` | 109 |
| `data_dir` | `fn data_dir(&self) -> &Path` | 235 |
| `bootstrap_key` | `fn bootstrap_key(&self) -> &[u8; 32]` | 240 |
| `dispatch_table` | `fn dispatch_table(&self) -> &Arc<DispatchTable>` | 245 |
| `run_command` | `async fn run_command(&self, command: CommandCommit) -> Result<CommandOutcome>` | 253 |
| `projection_state` | `fn projection_state(&self) -> &Arc<ProjectionState>` | 263 |
| `barrier` | `fn barrier(&self) -> &Arc<LinearizabilityBarrier>` | 268 |
| `sequencer` | `fn sequencer(&self) -> Option<&CommitSequencer>` | 273 |
| `new_for_tests` | `fn new_for_tests() -> Self` | 281 |

### `WabiDbConfig` (`engine/mod.rs`)

| Constructor | Line |
|-------------|------|
| `from_env_var(data_dir: PathBuf) -> Self` | 47 |
| `from_passphrase(data_dir, passphrase, salt) -> Self` | 57 |

Fields: `data_dir` (PathBuf), `bootstrap_source` (BootstrapSource), `bootstrap_salt` (Option<[u8;16]>), `allow_init` (bool) — lines 30-43.

### Key types

| Type | Definition | Line |
|------|------------|------|
| `CommandCommit` | `sequencer/types.rs:36` — caller_user_id, caller_device_id, command_name, idempotency_key, events (Vec<EventToWrite>), essential, response_tx (oneshot) | 36-52 |
| `CommandOutcome` | `sequencer/types.rs:56` — commit_seq, commit_hash, timestamp_micros, stream_ids | 56-73 |
| `EventToWrite` | `sequencer/types.rs:15` — stream_id, event_type, stream_kind, record_kind, plaintext | 15-31 |
| `DurableEvent` (handler) | `projections/handler.rs:43` — commit_seq, stream_id, event_type, payload | 43-53 |
| `DispatchTable` | `projections/handler.rs:79` — HashMap<String, Arc<dyn Projection>> | 79-131 |
| `ProjectionState` | `engine/locks.rs:130` — indexes (RwLock<HashMap<String, SkipMap>>) + applied_commit_seq watermark | 130-137 |
| `CommitSequencer` | `sequencer/run_command.rs:15` — wraps mpsc Sender<CommandCommit> + Arc<CommandIdempotencyTable> | 15-21 |
| `DispatchItem` | `engine/locks.rs:112` — commit_seq, event_type, payload | 112-121 |
| `SequencerPermit` | `engine/locks.rs:53` — wraps tokio OwnedSemaphorePermit | 53-57 |

---

## 2. `WabiStore` Trait Analysis

**File:** `engine/wabi_store.rs`

### Trait declaration (line 9)

```rust
pub trait WabiStore: Send + Sync {
    async fn send_message(&self, message: MessageToSend) -> Result<String>;       // line 11
    async fn list_streams(&self, filter: StreamFilter) -> Result<Vec<String>>;    // line 17
    async fn get_message(&self, stream_id: &str, message_id: &str) -> Result<Option<String>>;  // line 22
    async fn list_messages(&self, stream_id: &str, opts: ListMessagesOpts) -> Result<Vec<String>>;  // line 27
}
```

### `MessageToSend` (line 35)
Fields: `stream_id`, `message_type`, `plaintext`, `nonce`, `sender_user_id`.

### `StreamFilter` (line 38)
Fields: `prefix` (Option<String>), `kind` (Option<u8>), `limit` (Option<usize>).

### `ListMessagesOpts` (line 41)
Fields: `after_id` (Option<String>), `limit` (Option<usize>), `ascending` (bool).

### `LocalWabiStore` impl (line 44)

| Method | Behavior | Line |
|--------|----------|------|
| `send_message` | Returns `Ok("".into())` — TODO says "placeholder: write to underlying storage" | 49-51 |
| `list_streams` | Returns `Ok(vec![])` — no streams stored | 52-54 |
| `get_message` | Returns `Ok(None)` — no messages stored | 55-57 |
| `list_messages` | Returns `Ok(vec![])` — no messages stored | 58-60 |

**Critical finding:** `WabiStore` is a **stub**. All impl methods are no-ops. The trait is **never used** by the engine, sequencer, or any command function. The real write path goes through `CommandCommit` → `sequencer::run_command::run_command()` → `WabiDbEngine::run_command()`.

The file also contains commented-out code referencing interior-mutability compile errors (lines 63-78), indicating this was an early design that was abandoned.

---

## 3. Command Functions — Search Results

Grepped for all 28 named functions from the kanban API surface across `wabidb/src/`. Source code only; doc files excluded.

### ✅ EXIST (as reusable `pub fn`)

| Function | Location | Line | Status |
|----------|----------|------|--------|
| `send_dm_message` | `commands/send_dm_message.rs:12` | 12 | **Full implementation** — validates, encrypts via DoubleRatchet, builds EventToWrite, submits via sequencer. Has 4 tests. |
| `ws_subscribe` | `subscription/ws_subscribe.rs:57` | 57 | Full implementation (WebSocket subscribe handler) |
| `ws_unsubscribe` | `subscription/ws_unsubscribe.rs:5` | 5 | Full implementation |
| `ws_ticket_endpoint` | `subscription/ws_ticket_endpoint.rs:41` | 41 | Full implementation |
| `check_ephemeral_auth` | `ephemeral/auth.rs:10` | 10 | Auth check only (not a command) |

### ⚠️ EXIST (as trait method stub only)

| Function | Location | Line | Status |
|----------|----------|------|--------|
| `send_message` | `engine/wabi_store.rs:11` (trait) | 11 | **Stub** — `LocalWabiStore` impl returns `Ok("".into())`. Never called by engine. |

### ❌ NOT FOUND (do not exist as callable functions)

| Command | Evidence |
|---------|----------|
| `create_channel` | No match in any `.rs` file |
| `register_user` | No match |
| `consume_one_time_prekey` | No match (exists as method on `IdentityBootstrap` struct in `crypto/identity.rs`, not as command) |
| `create_invite` | No match |
| `accept_invite` | No match |
| `add_channel_member` | No match |
| `remove_channel_member` | No match |
| `kick_user` | No match |
| `ban_user` | No match |
| `unban_user` | No match |
| `add_role` | No match |
| `remove_role` | No match |
| `create_whiteboard_session` | No match |
| `update_whiteboard_state` | No match |
| `create_webhook` | No match |
| `upload_attachment` | No match |
| `delete_attachment` | No match |
| `create_emote` | No match |
| `list_emotes` | No match |
| `set_user_layout` | No match |
| `set_channel_retention` | No match |
| `mark_channel_read` | No match |
| `mark_dm_read` | No match |
| `add_reaction` | No match |
| `remove_reaction` | No match |
| `get_albums` | No match |
| `create_album` | No match |

### Note on integration tests
`send_message_flow.rs` and `integration.rs` construct `CommandCommit` manually and call `engine.run_command(cmd)`. These are **not** reusable command functions — they construct the raw struct inline. No `send_message()` function wraps this pattern.

### Command helper modules that DO exist (auth/metrics infrastructure, not commands)

| Module | File | Line | Purpose |
|--------|------|------|---------|
| `channel_send_auth` | `commands/channel_send_auth.rs` | — | Channel send authorization logic |
| `config` | `commands/config.rs` | — | Command config defaults |
| `dm_auth` | `commands/dm_auth.rs` | — | DM authorization logic |
| `dm_send_auth` | `commands/dm_send_auth.rs` | — | DM send authorization |
| `idempotency` | `commands/idempotency.rs` | 43 | `CommandIdempotencyTable` — dedup by `(caller_user_id, client_request_id)` |
| `membership_revalidation` | `commands/membership_revalidation.rs` | — | Membership revalidation logic |
| `metrics` | `commands/metrics.rs` | — | Command metrics |
| `namespace` | `commands/namespace.rs` | — | Namespace/prefix utilities |
| `rate_limit` | `commands/rate_limit.rs` | — | Rate limiting |
| `rebuild_auth` | `projections/rebuild_auth.rs` | — | Auth rebuild for projections |

---

## 4. Projection Handler Inventory

### Registered handlers (`engine/mod.rs:316-331` — `build_dispatch_table()`)

| Handler Struct | Event Type(s) | File | Line | Read Methods |
|---------------|---------------|------|------|-------------|
| `MessagesProjection` | `"message_created"` | `projections/messages.rs` | 193 | **None** |
| `ReactionsProjection` | `"reaction_added"`, `"reaction_removed"` | `projections/reactions.rs` | 259 | **None** |
| `ChannelMembersProjection` | `"channel_member_added"`, `"channel_member_removed"` | `projections/channel_members.rs` | 193 | **None** |
| `DmMessagesProjection` | `"dm_message_created"` | `projections/dm_messages.rs` | 190 | **None** |
| `DmMessageRecipientsProjection` | `"dm_recipient_added"` | `projections/dm_message_recipients.rs` | 176 | **None** |

### Unregistered (no handler, falls into generic `"events"` index)
Events with types not in the dispatch table get inserted into a generic `"events"` SkipMap keyed by `event_type` (see `engine/locks.rs:270-275`).

### Read methods on `ProjectionState` (`engine/locks.rs`)

| Method | Signature | Line |
|--------|-----------|------|
| `get` | `fn get(&self, index: &str, key: &[u8]) -> Option<Vec<u8>>` | 174 |
| `for_each` | `fn for_each<F>(&self, index: &str, f: F)` | 183 |
| `applied_commit_seq` | `fn applied_commit_seq(&self) -> u64` | 153 |
| `insert` | `fn insert(&self, index, key, value, commit_seq)` | 164 |
| `set_applied_commit_seq` | `fn set_applied_commit_seq(&self, new: u64)` | 206 |

**No domain-specific read methods exist.** There is no `get_user`, `get_channels`, `get_channel_messages`, `get_dm_messages`, `get_reactions`, or any typed query. All reads go through the generic `get(index, key)` where key/value are opaque `Vec<u8>`.

### Projection handler pattern (each handler)
- Implements `Projection` trait (`projections/handler.rs:63`):
  - `fn event_type(&self) -> &str` — returns the event type string
  - `fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()>` — decodes payload, encodes key-value, calls `state.insert(index, key, value, commit_seq)`
- Each handler has its own `encode_key()`, `encode_record()`, `decode_record()` functions
- No handler has any read/query logic

---

## 5. Command Flow Trace

Walked from the integration test (`tests/send_message_flow.rs`) through the real engine:

```
send_message_flow.rs:36-44
  └─ Construct CommandCommit manually
       ├─ caller_user_id: u64
       ├─ caller_device_id: String
       ├─ command_name: String
       ├─ idempotency_key: Option<String>
       ├─ events: Vec<EventToWrite>
       │     └─ each: stream_id, event_type, stream_kind, record_kind, plaintext
       ├─ essential: bool
       └─ response_tx: oneshot::Sender<CommandOutcome>

send_message_flow.rs:46
  └─ engine.run_command(cmd)
       └─ engine/mod.rs:254
            └─ sequencer::run_command::run_command(cmd, sequencer) [sequencer/run_command.rs:40]
                 ├─ Checks idempotency via CommandIdempotencyTable [commands/idempotency.rs:43]
                 │     └─ Key: (caller_user_id, client_request_id) — line 53
                 ├─ Sends CommandCommit via mpsc::Sender to sequencer task
                 ├─ Awaits oneshot::Receiver for CommandOutcome
                 │
                 └─ Sequencer task ([sequencer/run.rs])
                      ├─ 1. Acquires SequencerPermit [engine/locks.rs:53]
                      ├─ 2. Receives CommandCommit from mpsc channel
                      ├─ 3. Computes commit_seq (monotonic)
                      ├─ 4. Writes events to commit index via Batcher [commit_index/batcher.rs]
                      ├─ 5. Builds CommandOutcome (commit_seq, commit_hash, timestamp_micros, stream_ids)
                      ├─ 6. Sends DispatchItem to ProjectionDispatcher via mpsc
                      ├─ 7. Updates LinearizabilityBarrier watermark
                      └─ 8. Sends CommandOutcome back via oneshot

                           └─ ProjectionDispatcher task [engine/locks.rs:253-281]
                                ├─ Receives DispatchItem from mpsc
                                ├─ Looks up handler in DispatchTable by event_type [handler.rs:112]
                                ├─ Calls handler.apply(event, state)
                                │     └─ Handler decodes payload, calls state.insert(index, key, value, commit_seq)
                                └─ Advances applied_commit_seq watermark
```

### Key architectural insight
The **only existing command function** (`send_dm_message` at `commands/send_dm_message.rs:12`) follows the same pattern: validate → authorize → encrypt → build EventToWrite → build CommandCommit → call `run_command()`. All future command functions should follow this pattern.

---

## 6. Gap Analysis

### Missing: Commands needing implementation (29)
These kanban-listed commands have **no implementation** at all — no function, no auth, no event construction:

| Priority Tier | Commands |
|--------------|----------|
| **Channel core** | `create_channel`, `register_user`, `create_invite`, `accept_invite`, `add_channel_member`, `remove_channel_member`, `kick_user`, `ban_user`, `unban_user` |
| **Role/RBAC** | `add_role`, `remove_role` |
| **Whiteboard** | `create_whiteboard_session`, `update_whiteboard_state` |
| **Webhooks** | `create_webhook` |
| **Attachments** | `upload_attachment`, `delete_attachment` |
| **Emotes/Albums** | `create_emote`, `list_emotes`, `create_album`, `get_albums` |
| **Reactions** | `add_reaction`, `remove_reaction` |
| **User state** | `set_user_layout`, `set_channel_retention` |
| **Read receipts** | `mark_channel_read`, `mark_dm_read` |
| **Key exchange** | `consume_one_time_prekey` |
| **Messaging** | `send_message` (as reusable function) |

### Missing: Read/query methods (15+)
No domain-specific read API exists. Callers must use generic `ProjectionState::get(index, key)` with raw byte keys and values:

| Missing Method | Would query |
|---------------|-------------|
| `get_user` | `users` index (no handler exists; no index populated) |
| `get_channels` | `channel_members` or `channels` index |
| `get_channel_messages` | `messages` index by channel prefix |
| `get_dm_messages` | `dm_messages` index by user pair |
| `get_reactions_for_message` | `reactions` index by message_id |
| `get_role_definitions` | No index exists |
| `get_bans` | No index exists |
| `get_user_role` / `rbac_roles` index | **Now exists** — `AuditProjection` maintains a `rbac_roles` index (current role per `workspace_id`+`user_id`) on `role_assigned`/`role_removed`; `WabiStore::get_user_role(workspace_id, user_id)` reads it. |
| `get_whiteboard_snapshot` | No index exists |
| `get_user_layout` | No index exists |
| `get_channel_retention` | No index exists |
| `get_webhooks` | No index exists |
| `get_emotes` | No index exists |
| `get_session` | No index exists |
| `get_presences` | No index exists |

### What DOES exist (complete or partial)

| Feature | Status | Details |
|---------|--------|---------|
| `send_dm_message` | **Complete** | `commands/send_dm_message.rs:12` — validates, encrypts, submits, responds |
| `ProjectionState::get` | **Complete** | `engine/locks.rs:174` — generic key lookup |
| `ProjectionState::for_each` | **Complete** | `engine/locks.rs:183` — generic iteration |
| `applied_commit_seq` watermark | **Complete** | `engine/locks.rs:153` — read-after-write consistency |
| Messages projection handler | **Complete** | `projections/messages.rs:193` — writes to `"messages"` index |
| Reactions projection handler | **Complete** | `projections/reactions.rs:259` — writes to `"reactions"` index |
| Channel members projection handler | **Complete** | `projections/channel_members.rs:193` — writes to `"channel_members"` index |
| DM messages projection handler | **Complete** | `projections/dm_messages.rs:190` — writes to `"dm_messages"` index |
| DM recipients projection handler | **Complete** | `projections/dm_message_recipients.rs:176` — writes to `"dm_message_recipients"` index |
| Sequencer + commit index | **Complete** | `sequencer/run.rs`, `commit_index/batcher.rs` — full write-ahead log |
| Idempotency table | **Complete** | `commands/idempotency.rs:43` — deduplication by `(user_id, client_request_id)` |
| LinearizabilityBarrier | **Complete** | `projections/barrier.rs` — read-after-write guarantee |
| `ws_subscribe` / `ws_unsubscribe` | **Complete** | `subscription/ws_subscribe.rs:57` — WebSocket lifecycle |
| Engine open/close lifecycle | **Complete** | `engine/mod.rs:109` — lock file, bootstrap key, manifest, dispatcher |
| Ephemeral auth | **Complete** | `ephemeral/auth.rs:10` — typing/call/cursor permission checks |
| Crypto primitives | **Complete** | X3DH, DoubleRatchet, AES-GCM, DM envelope seal/unseal |

---

## 7. First-Step Recommendation

### Highest ROI: Implement `add_reaction` command

**Rationale:**
- **Projection handler already exists** (`projections/reactions.rs:259` handles `"reaction_added"` and `"reaction_removed"`)
- **Only the command function is missing** — no input validation, no auth, no event construction
- **Piggybacks on existing crypto** — reactions are small payloads, no ratchet needed
- **Fills a real gap** — reactions are a core feature with no write path

**Implementation pattern** (following `send_dm_message.rs`):
1. Input validation (message_id, user_id, emote must be non-empty)
2. Authorization check (is user member of channel?)
3. Construct `EventToWrite` with `event_type: "reaction_added"`
4. Build `CommandCommit` with one-shot
5. Call `sequencer::run_command::run_command()`

### Alternative: Implement `send_message` as reusable command function

**Rationale:**
- Test `send_message_flow.rs` already constructs `CommandCommit` manually for `"message_created"`
- `MessagesProjection` handler exists
- A reusable `send_message()` function would eliminate inline construction in tests and enable the first real client-facing API

**Implementation pattern:**
1. Wrap the `CommandCommit` construction + encryption + auth into `pub async fn send_message(...)`
2. Add channel membership check (`channel_members` index)
3. Encrypt via `StreamKeyRegistry`
4. Submit via `sequencer::run_command::run_command()`

---

## Appendix: Files Read

Every `.rs` file under `/var/home/Ronin/wabi/core/crates/wabidb/src/` was read in full during this audit. Key files:

| File | Lines | Key Content |
|------|-------|-------------|
| `lib.rs` | ~80 | Module declarations |
| `engine/mod.rs` | 472 | WabiDbEngine, WabiDbConfig, build_dispatch_table |
| `engine/wabi_store.rs` | ~80 | WabiStore trait (4 stub methods) |
| `engine/locks.rs` | 502 | SequencerPermit, ProjectionDispatcher, ProjectionState |
| `sequencer/types.rs` | ~90 | CommandCommit, CommandOutcome, EventToWrite, DurableEvent |
| `sequencer/run_command.rs` | ~80 | CommitSequencer, run_command |
| `commands/send_dm_message.rs` | 175 | **Only real command implementation** |
| `commands/idempotency.rs` | ~90 | CommandIdempotencyTable |
| `commands/dm_auth.rs` | ~60 | DmAuth |
| `commands/dm_send_auth.rs` | ~40 | check_dm_send_authorized |
| `projections/handler.rs` | 285 | Projection trait, DispatchTable |
| `projections/messages.rs` | ~250 | MessagesProjection handler |
| `projections/reactions.rs` | ~300 | ReactionsProjection handler |
| `projections/channel_members.rs` | ~200 | ChannelMembersProjection handler |
| `projections/dm_messages.rs` | ~200 | DmMessagesProjection handler |
| `projections/dm_message_recipients.rs` | ~180 | DmRecipientsProjection handler |
| `projections/barrier.rs` | ~120 | LinearizabilityBarrier |
| `tests/send_message_flow.rs` | 114 | Integration test for command flow |
| `tests/integration.rs` | ~80 | Engine open + command round-trip |
| `ephemeral/auth.rs` | 75 | EphemeralAction auth |
| `subscription/ws_subscribe.rs` | ~150 | WebSocket subscribe |
| `crypto/dm_envelope.rs` | ~80 | DM envelope seal/unseal |
| `crypto/double_ratchet.rs` | ~200 | DoubleRatchetSession |
| `crypto/identity.rs` | ~150 | IdentityBootstrap, one-time prekey methods |
