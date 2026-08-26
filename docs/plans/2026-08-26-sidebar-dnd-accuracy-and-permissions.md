# Sidebar channel DnD — accuracy pass + reorder permission gate (2026-08-26)

Scope: the unified channel sidebar (`ChannelSidebar.svelte` → `sidebar/UnifiedChannelList.svelte`)
and the `reorder-channels` socket op. No domain/projection/ChannelKind changes; the
`channels-reordered` wire contract is unchanged.

## Why

User-reported: drops "sometimes don't go where I want." Root causes found in the
per-row handler design:

1. Dead zones (voice rosters, thread lists, gaps between rows) had no drop
   targeting — the indicator kept a stale row lit and releases there were
   swallowed.
2. `.category-channels` reused the folder-header edge math on its own tall
   rect, so hovering a folder's upper area reported "before the whole folder".
3. Folder interior drops were append-only — no positional insert among
   children.
4. The drag-only tail zone mounted an 18px block mid-drag, shifting layout at
   dragstart so the first hover read the wrong element.
5. Voice rows silently rejected all channel drops (`preventDefault` only ran
   for member drags), contradicting the mixed-type folder model.
6. No auto-scroll: below-the-fold targets were unreachable mid-drag.

## What changed

### Frontend — single-coordinator DnD

- One `dragover`/`drop` pair on `.channel-list` owns all channel/folder
  targeting. Rows now only declare anchors (`data-drop-anchor`,
  `data-channel-id`, `data-parent-folder`, `data-folder-id`) and start/end
  drags. Per-row `drop-before/drop-after` pseudo-element indicators removed.
- Pure geometry extracted to `resolveDropGap()` in
  `sidebar/channelSidebarHelpers.ts` (unit-tested in
  `channelSidebarHelpers.test.ts`). Dead zones snap to the nearest surrounding
  gap, so the line never lies. Folder headers keep ±10px before/after bands;
  their middle band = become first child. Dragging a folder never targets
  inside another folder.
- Insertion line renders as ONE absolute overlay (`.drop-indicator-overlay`)
  in scroll-content coordinates with a 90ms position ease — immune to Gecko's
  eager child-boundary dragleave flicker.
- Positional inserts inside folders via `moveChannelIntoFolderGap()`;
  root-gap moves for loose channels AND folders via `moveItemToRootGap()`.
  Existing order emitters (`reorderChannels` payload) unchanged.
- rAF drag loop adds edge auto-scroll (36px bands) and drives dwell
  auto-expand of collapsed folders (still 400ms).
- Tail zone deleted (coordinator draws the root-end line; no layout shift).
- Search filter disables dragging and suppresses settle flips while active.
- Permission gate mirrors the server: `canReorderChannels` =
  owner/admin/mod (`highestRole`), gating `draggable`, grips, and the
  context-menu move entries. Denials surface via `reorder-channels-error`
  (added to the socket error toast list).
- Settle confirmation: `animate:flip` wrappers per keyed item at both list
  levels (`.mixed-root-item`, `.unified-channel-wrap`), 220ms cubicOut,
  instant under `prefers-reduced-motion`; section collapse animates via
  `slide`.

### Backend — `socketio/channel_ops.rs::on_reorder_channels`

- **Permission gate (new):** resolves caller role via
  `AppState::get_user_highest_role`; only Owner / Admin / Moderator proceed,
  everyone else gets `reorder-channels-error`. Previously any authenticated
  user could rearrange channels server-wide.
- **Write amplification fix:** collapsed the double
  `ingest_event("channel", …)` per entry to a single `update_settings`
  event. Both event types hit the identical projection merge
  (`wabidb/src/projections/channels.rs::apply_updated`); keeping
  `update_settings` preserves the audit-projection mapping. Halves event-store
  writes per drag.

## Verification

- `bun run check`: 0 errors.
- `bun test src/lib`: 174 pass (12 new resolveDropGap cases).
- `cargo check -p wabi-server`: clean.
- `STATIC_BUILD=1 bun run build`: succeeds.
- Interactive drag feel must be verified in a real browser (headless Chromium
  crashes per AGENTS.md golden rule #7): Zen (Gecko) AND one Chromium-based
  browser — the engines differ in dragenter/dragleave ordering, which this
  coordinator design specifically neutralizes.
