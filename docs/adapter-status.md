# WdbAdapter Status — 2026-06-26

## Location

`core/crates/wabi-server/src/adapter/mod.rs`

## Architecture

The `WdbAdapter` replaces the old `StdbClient` (HTTP-to-SpacetimeDB) with direct
calls into the embedded `WabiDbEngine`. `AppState` holds `wdb: Arc<WdbAdapter>`,
and handlers call typed methods directly.

## Methods implemented (35 total)

### Writes — wired to engine (14)

These call `self.run()` → `engine.run_command()` → encrypt → commit log.

| Method | Stream | Event type | Stream kind |
|---|---|---|---|
| `send_message` | `channel_id` | `message_created` | 1 (channel) |
| `create_user` | `users` | `user_registered` | 6 (other) |
| `create_channel` | `channels` | `channel_created` | 6 |
| `add_reaction` | `reactions:{message_id}` | `reaction_added` | 6 |
| `add_channel_member` | `channel_members:{channel_id}` | `channel_member_added` | 1 |
| `remove_channel_member` | `channel_members:{channel_id}` | `channel_member_removed` | 1 |
| `ban_user` | `bans:{channel_id}` | `ban_added` | 1 |
| `unban_user` | `bans:{channel_id}` | `ban_removed` | 1 |
| `touch_user` | `user:{user_id}` | `user_touched` | 6 |
| `mute_user` | `mutes:{channel_id}:{user_id}` | `user_muted` | 1 |
| `unmute_user` | `mutes:{channel_id}:{user_id}` | `user_unmuted` | 1 |
| `deafen_user` | `deafens:{channel_id}:{user_id}` | `user_deafened` | 1 |
| `undeafen_user` | `deafens:{channel_id}:{user_id}` | `user_undeafened` | 1 |
| `upsert_member_role` | `member_roles:{channel_id}` | `member_role_upserted` | 6 |

### Writes — wired to typed wabidb commands (5)

These use the dedicated `wabidb::commands::*` module directly.

| Method | Command module |
|---|---|
| `create_call_session` | `call_session_create` |
| `join_call_session` | `call_session_join` |
| `leave_call_session` | `call_session_leave` |
| `end_call_session` | `call_session_end` |
| `emit_call_signal` | `call_signal_emit` |

### Generic event ingest — `ingest_event` routing table

Routes old STDB `(entity, op, payload)` funnel to stream log entries.

| `(entity, op)` | Stream | Event type |
|---|---|---|
| `(rbac, assign_role)` | `rbac:{workspace_id}` | `role_assigned` (also maintains `rbac_roles` index) |
| `(rbac, remove_role)` | `rbac:{workspace_id}` | `role_removed` (reverts `rbac_roles` to Member) |
| `(channel, update_settings)` | `channel_settings:{channel_id}` | `channel_settings_updated` |
| `(payment, *)` | `payments` | `payment_{op}` |
| `(*)` | — | logged at debug, not persisted |

All `ingest_event` writes go through the engine's stream log durably. Projection
handlers for RBAC (`role_assigned`/`role_removed` → `AuditProjection`, which also
maintains a `rbac_roles` index read by `WabiStore::get_user_role`) and channel
settings exist; payments are stored in the generic `events` index. Replay from
the stream log picks up all of these.

### Reads — wired to projection state (14)

These query the in-memory `ProjectionState` SkipMaps.

| Method | Index queried |
|---|---|
| `list_streams` | `streams` |
| `get_message_typed` | `messages` (keyed by message_id) |
| `list_messages_typed` | `messages` (filtered by channel_id, sorted by time) |
| `get_message` | delegates to `get_message_typed` + serialize |
| `list_messages` | delegates to `list_messages_typed` + extract IDs |
| `get_user` | `users` (keyed by user_id as big-endian bytes) |
| `get_user_by_username` | `users` (full scan, case-insensitive match) |
| `list_users` | `users` (full scan) |
| `get_channel` | `channels` (keyed by channel_id bytes) |
| `list_channels` | `channels` (+ `channel_members` for member filter) |
| `list_channel_members` | `channel_members` (filtered by channel_id) |
| `list_reactions` | `reactions` (filtered by message_id) |
| `list_bans` | `bans` (filtered by channel_id) |
| `list_role_definitions` | `role_definitions` (filtered by channel_id) |

### Reads — wired to typed projection modules (4)

| Method | Projection module |
|---|---|
| `get_call_session` | `call_sessions` |
| `get_call_participants` | `call_participants` |
| `get_call_signals` | `call_signals` |
| `get_emotes` | `emotes` |

### Writes — soft-delete via projection state directly (3)

These bypass the engine and mutate the in-memory projection state directly.
This works for v1 because the data is already in the stream log from the
original write. The delete/edit is a projection-level soft-delete and is lost
on engine restart (no replay for these operations).

| Method | What it does |
|---|---|
| `delete_channel` | Sets `channel.is_active = false` in projection state |
| `delete_message` | Sets `message.is_deleted = true` in projection state |
| `edit_message` | Updates `message.content` in projection state |

### Soft-delete — wired to engine (3)

| Method | Stream | Event type |
|---|---|---|
| `delete_dm_channel` | delegates to `delete_channel` |
| `remove_reaction` | `reactions:{message_id}:{emote}:removed` | `reaction_removed` |
| `upsert_emote` | `emotes` | `emote_upserted` |

### No-ops — STDB-compat stubs (10)

These return defaults because the old STDB methods have no wabidb equivalent
yet. Implemented when the corresponding projection lands.

| Method | Returns |
|---|---|
| `upsert_webhook` | `Ok(())` |
| `get_webhooks` | `Ok(vec![])` |
| `get_emoji_role_rules` | `Ok(vec![])` |
| `upsert_user_layout` | `Ok(())` |
| `get_user_layout` | `Ok(None)` |
| `upsert_channel_retention` | `Ok(())` |
| `get_channel_retention` | `Ok(None)` |
| `is_user_banned` | `Ok(false)` |
| `is_user_muted` | `Ok(false)` |
| `is_user_deafened` | `Ok(false)` |

## Audit Projection

Registered in `projections/audit.rs` and wired into `build_dispatch_table()`
in `engine/mod.rs`. On by default (no toggle in v1).

| Event type | Storage index | Description |
|---|---|---|
| `role_assigned` | `audit_log` + `rbac_roles` | RBAC role assignment |
| `role_removed` | `audit_log` + `rbac_roles` | RBAC role removal (reverts to Member) |
| `channel_settings_updated` | `audit_log` | Channel config changes |
| `payment_*` | `events` (generic fallback) | Payment operations |

Payment events have no dedicated handler but are durably stored in the generic
`"events"` index by the dispatcher fallback.

## Subscription Bridge

Wired in `main.rs` as a `tokio::spawn` task after Socket.IO layer creation:

```
delivery_rx (broadcast<SubscriptionDelivery>)
    │
    ▼
tokio::spawn loop:
    recv() → deserialize payload as JSON
           → io.to(stream_id).emit(event_type, envelope)
           → io.to(consumer_id).emit(event_type, envelope)
```

The bridge waits for the `SocketIo` instance (delivered via `state.sio_broadcast_tx`),
then drains the engine's `delivery_tx` broadcast channel and emits to both the
stream room and the consumer socket. Non-JSON payloads are skipped with a debug
log (projection data like BLAKE3 hashes, binary blobs).

Fan-out path in `adapter::run()` calls `engine.deliver_event()` after each
successful commit, which matches the event against live subscriptions and pushes
matched deliveries onto the broadcast channel.

## Verified

- `cargo check -p wabi-server` passes (0 errors, only pre-existing doc warnings)
- `cargo test -p wabi-server` passes (44/44)
- `cargo check -p wabidb` passes
- `cargo test -p wabidb` passes (651/651)
