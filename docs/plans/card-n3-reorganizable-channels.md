# Card N3 — Reorganizable Channels (Discord-style)

**Created:** 2026-07-28
**Status:** IN PROGRESS
**Kanban:** TODO

---

## Summary

Make channels fully reorganizable like Discord. Users can drag channels to any position, mix channel types freely (text, voice, forum, wiki, gallery, notes, DM), and reorder within groups or across groups. Positions persist via the WabiDB event system.

---

## What needs to happen

### Backend
1. **Sort `list_channels` by `position`** — `wabi_store.rs` `list_channels()` should return channels sorted by `position` ascending instead of HashMap iteration order.
2. **Expose `PATCH /api/channels/{id}`** — already handled by `channel_updated` event → `apply_updated` in channels.rs projection. Need to wire up the HTTP PATCH route in `wabi-server/src/api/channels.rs`.
3. **Include `position` in `channel_to_response`** — currently hardcoded to `position: 0` in `channel_to_response` (channels.rs:29).
4. **Include `position` in channel_created event payload** — set `position` = next_index when creating a channel.

### Frontend
5. **Add `position` to `ChannelResponse` type** — frontend needs `position: i32` field.
6. **Drag-and-drop reorder in ChannelSidebar** — implement HTML5 drag-and-drop (or pointer events) for channel items.
7. **Persist reorder** — on drop, send PATCH to update position.
8. **Mixed channel types in one list** — current code separates by type (textChannels, voiceChannels, etc.). For Discord-style, allow mixed or keep grouping but allow cross-group reorder.

### Design Decision
- Keep channel type groupings (visual separators) like Discord — but allow drag across groups.
- Position is a global integer; type groups are visual only.
- New channels get `position = max(position) + 1`.

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

## Channel types to support in the reorderable list
- text, public, live (text-like)
- voice
- dm, groupdm (DMs)
- forum
- wiki
- gallery
- notes
- announcement
- whiteboard
- incident
- category (grouping header, not draggable as a leaf)
