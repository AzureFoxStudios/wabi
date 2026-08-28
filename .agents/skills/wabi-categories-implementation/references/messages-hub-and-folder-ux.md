# Messages hub + folder UX (2026-08-08)

## Folder membership stickiness

Init path `get_channels_raw` must emit `position` + `parent_id`/`parentId`. Never map category parent into `parent_channel_id` (that is threads/breakouts). FE `normalizeChannel` keeps `parentId` and `parentChannelId` separate. `channels-reordered` always includes `parentId` (JSON null clears).

## Folder reorder

Category rows (`type === 'category'`) are draggable: grip, before/after indicators, drop on header or open body nests channels. Reorder categories with `parentId: null` + sequential position via `reorder-channels`. `sortByPosition` = `[...channels].sort(...)` (no in-place mutate).

## Messages hub

- Sticky under server header, above Channels (`personal-nav` / `.messages-hub-btn`)
- Label **Messages** + icon; compact = icon + badge; active when `activeView === 'dm'`
- Badge = dm/group unread only → DmHub (DMs | Notes) — one entry, no dual rail, no second Notes sidebar button
- Server channel-count chip default off (section header already counts)
