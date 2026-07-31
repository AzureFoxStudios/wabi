# Card CH-NAV — Channel click does not navigate

Date: 2026-07-23
Status: shipped

## Root cause
Sidebar `handleChannelClick` called `joinChannel(id)` which only emits socket `join-channel` and never updates `currentChannel`. UI stayed on the previous channel.

`switchChannel` also gated on `getChannelById` — if the channel was briefly missing from the client registry, navigation no-op'd.

Forum/wiki types were filtered out of every sidebar section (`text` filter only allowed text/public/live).

## Fixes
- `channelStore.switchChannel`: always set `currentChannel`, always join room
- Sidebar + FollowingFeed + ModeTabs + AdminTab: navigate via `switchChannel`
- Socket init: normalize `id`/`channel_id` + `type`/`channel_type`; use `switchChannel` for default selection
- Sidebar: list forum/wiki/announcement/whiteboard under Text Channels

## Verify
Hard refresh → click any text/gallery/forum/wiki channel → main pane must change; gallery shows gallery surface.
