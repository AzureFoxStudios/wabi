# Channels as a whole — zombie deletions + "ch #" name display (2026-08-27)

Scope: channel lifecycle in WabiDB (projection + adapter), the channels REST
API, the `reorder-channels` socket op, and the call/voice surfaces that
label channels. Follows the field report: deleted channels never truly go
away, and many channels display as their raw `ch_<hex>` id instead of their
name ("voice", "derek's speaking corner", …).

## Root causes found (all verified by code path, not speculation)

### 1. Zombie channels — deletion never emitted a durable event

- `WdbAdapter::delete_channel` was a **projection-only overwrite**
  (`is_active = false` written straight into the `channels` index, no
  event). Two independent failures:
  1. Event-log replay (crash / no snapshot / new replica) rebuilds the
     projection from events — the overwrite was never an event, so every
     replay **resurrected** the channel.
  2. Even when the tombstone stuck, `get_channels_raw()` (socket `init` =
     the sidebar on every page load) and `list_channels()` never filtered
     `is_active`, so tombstoned channels were re-served to all clients on
     every refresh. Deleted channels reappeared immediately — zombies.
- DM/group channels were even more broken: `create_dm_channel` /
  `upsert_group` write `channel_created` payloads with `channel_kind` as a
  repr-u8 NUMBER, which strict serde rejects for the enum — the projection
  dropped those events entirely. And `ChannelProjection::apply_created`
  unconditionally overwrote `channel_id` with `ch_{commit_seq}`, so even
  when decoded, the row was keyed under a phantom id, unreachable by the
  `dm-user-{a}-user-{b}` / `group-{uuid}` id every other subsystem uses.
  Duplicate-DM checks missed, and `delete_dm_channel` could never find the
  row → undeletable zombie DMs/groups.

### 2. "ch #" display — raw channel ids as labels (WO-5 unfinished)

- The smoke-remediation handoff (2026-08-26) scoped WO-5: call sessions
  register with `name: channelId` and nothing resolves it. The render-time
  resolvers landed (CallModal, CallsPanel, VoiceView), but:
  - `joinVoiceChannel` / `handleForcedVoiceMove` still stored
    `name: channelId` in `activeVoiceChannel`, `callSessionManager.register`
    and the "Joined voice: …" notice;
  - the approved hydration backfill (`callSessionManager.setName` when the
    channel list loads) was never wired;
  - any surface whose `$channels.find()` misses falls back to the raw id.
- Nameless ghost rows: `ChannelProjection::apply_updated` materialized a
  placeholder row (`Channel::new(id, "", 0)`) for any update event whose
  channel had no row yet — rendering bare "#" / raw-id rows.

### 3. Drive-by found while auditing: reorder positions never persisted

`on_reorder_channels` emitted `ingest_event("channel", "update_settings")`,
which the adapter translates to `channel_settings_updated` — an event type
only the AUDIT projection consumes (the DnD plan doc assumed both hit the
channels projection; they don't). Positions/folder moves silently reverted
on every page load.

## Changes

### wabidb (`core/crates/wabidb/src/projections/channels.rs`, `engine/mod.rs`)

- `ChannelProjection` now handles `channel_deleted`: removes the row from
  the `channels` index (registry event_types updated to match).
- `apply_created`: lenient payload decode (accepts repr-u8 numeric
  `channel_kind` for legacy DM/group events) and preserves a caller-assigned
  `channel_id` when it matches the event's stream id (DM/group write to
  their own stream; regular creates use the shared "channels" stream with an
  empty id and keep getting `ch_{commit_seq}`).
- `apply_updated`: no longer materializes NAMELESS ghost rows (update with
  no existing row is dropped unless the patch carries a usable name) and
  never blanks an existing name to empty.
- Tests: deletion removes rows; caller-id preservation; numeric-kind decode.

### adapter (`core/crates/wabi-server/src/adapter/mod.rs`)

- `delete_channel`: tombstones synchronously (read-your-writes) AND commits
  a durable `channel_deleted` event → deletions now survive replay,
  snapshots and replication. Idempotent for unknown/already-deleted ids.
- `get_channel` / `list_channels` / `get_channels_raw`: filter
  `is_active=false` tombstones and legacy nameless ghost rows (empty name +
  owner 0 + created_at 0 — only the old ghost path can produce that
  combination). This cleans up pre-existing zombie data on read.

### server

- `api/channels.rs`: doc/comment fixes ("archive" → real delete semantics).
- `socketio/channel_ops.rs`: reorder now persists via `wdb.update_channel`
  (`channel_updated` → channels projection) instead of the audit-only ingest.

### frontend (WO-5 completion)

- `callSessionManager.ts`: new `backfillCallSessionChannelNames()` — resolves
  real channel names onto live sessions (channel sessions always track the
  current name incl. renames; DM/group labels never clobbered).
- `socketConnectionCore.ts`: backfill runs on init hydration, channel
  upserts, and `channel-updated` renames.
- `calling_impl_core.ts`: join/move paths resolve the display name from the
  channels store for `activeVoiceChannel`, session registration, and the
  "Joined voice" notice (raw id only as a last-resort fallback).

## Tests

- `core/crates/wabi-server/tests/channel_lifecycle_contract.rs` (new):
  delete-is-gone-immediately (typed + raw init list), delete-survives-
  restart (reopen/replay), delete idempotent, DM + group caller-id
  lifecycle.
- `projections/channels.rs` unit tests: `channel_deleted` removal, DM id
  preservation + numeric kind mapping.
- `frontend/src/lib/callSessionManager.test.ts`: 5 new backfill cases.
- `svelte-check`: 0 errors. `bun test src/lib`: 176 pass (the single
  pre-existing `setAuthToken` failure predates this change, verified by
  re-running on the clean tree).
