# Gallery channels: ChannelKind + upload surface (2026-07-23)

## Symptom
- Gallery channel "disappears on reload" (was in Gallery section, after refresh is gone or under Text).
- Double nest `Gallery > Gallery > name` in sidebar.
- Gallery view is browse-only: no drag-drop, no Upload button.
- Creating type=gallery via UI "works" until reload.

## Root cause — disappear
`ChannelKind` had no `Gallery` variant. `POST /api/channels` mapped unknown types
(including `"gallery"`) to `ChannelKind::Text`. Sidebar filters
`ch.type === 'gallery'`, so after socket re-init the channel becomes text and
leaves the Gallery section.

## Fix (domain + API + socket mapping)
```rust
// wabidb domain
ChannelKind::Gallery = 9

// create_channel match
"gallery" => ChannelKind::Gallery,

// get_channels_raw / socket init type string
ChannelKind::Gallery => "gallery",
```
REST `channel_to_response` uses `format!("{:?}", kind).to_lowercase()` → `"gallery"`
once the enum variant exists.

**No auto-migrate:** pre-fix galleries stored as Text stay text. Recreate as type gallery.

## Double nest
`ChannelSidebar.svelte` already has a "Gallery" section heading; `GalleryChannelList.svelte`
had a second heading. Remove the list's heading — section chrome lives only in ChannelSidebar.
Always show the Gallery section (with + create) even when count is 0.

## Upload / interaction
Gallery UI loads works from **channel-scoped media albums** (`listMediaAlbums` /
`listMediaAlbumItems`), not only `/api/gallery` works.

Ship:
- `uploadToGallery(channelId, files, channelName?)` in `galleryStore.ts`
  - ensure channel album exists (`createMediaAlbum` scopeType=channel)
  - `uploadAlbumFile` → `addMediaAlbumItem`
  - reload gallery
- Drag-drop + Upload button on `GalleryChannel.svelte`
- Normalize snake_case album API responses (`attachment_url` vs `attachmentUrl`);
  album ids may be string from backend — coerce for path segments.

## Verify
```bash
# create persists as gallery
curl -s -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -X POST https://wabi.chat/api/channels \
  -d '{"name":"showreel","channel_type":"gallery"}'
# list must show channel_type gallery after restart
curl -s -H "Authorization: Bearer $TOK" https://wabi.chat/api/channels | jq '.channels[]|select(.channel_type=="gallery")'
```
Ronin: hard refresh → Gallery section → create → still gallery after reload → drag image → appears.
