# Card N3 — Reorganizable Channels (Discord-style)

**Created:** 2026-07-28
**Status:** IN PROGRESS
**Kanban:** TODO

---

## Summary

Make channels fully reorganizable like Discord. Users can reorder channels via drag-and-drop, mix channel types freely (text, voice, forum, wiki, gallery, notes, DM), and positions persist via the WabiDB event system.

---

## What has been done (backend)

### 1. Fixed `channel_to_response` to use real data
- `channels.rs:24-34` — now returns actual `position`, `parent_id`, `description` instead of hardcoded zeros/nones

### 2. Sort `list_channels` by `position`
- `channels.rs:64-74` — added `channels.sort_by_key(|c| c.position)` so channels are returned in order

### 3. Added `PATCH /api/channels/{id}` endpoint
- New `UpdateChannelRequest` struct and `update_channel` handler
- Accepts `name`, `description`, `position`, `force_spoiler` as partial update
- Admin-only auth check
- Emits `channel_updated` event via WDB (same path as the existing socket handler)

## What needs to be done (frontend)

### 4. Drag-and-drop reorder in ChannelSidebar
- Add `draggable` attribute to channel items
- Track drag source and drop target
- On drop: calculate new position, call PATCH API

### 5. Frontend type for `position`
- `ChannelResponse` type in `socket-types.ts` needs `position: i32` field

### 6. Visual feedback
- Drop indicator line (Discord-style)
- Smooth reorder animation

## DO NOT touch
- WabiDB engine internals (event log, commit seq)
- auth/session middleware
- any Rust type definitions that aren't `position`-related
- existing forum/wiki/gallery API routes

## Verification
- `cargo check` and `cargo test` pass
- `bun run check` passes in frontend
- Drag reorder works across channel types
- Reorder persists across page reloads