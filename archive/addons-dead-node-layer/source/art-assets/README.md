# Art Assets Overlay (Phase 1 Scaffold)

Movable overlay assets and scene presets for creator workflows.

## Included
- Per-channel overlay room state
- Presenter/open control mode
- Asset add/update/remove/reorder/lock/visibility events
- Scene save/load/delete events
- Runtime routes:
  - `GET /api/plugins/runtime/art-assets/rooms`
  - `GET /api/plugins/runtime/art-assets/room?channelId=<id>`

## Not included yet
- Visual overlay editor panel in frontend
- Drag handles/snapping/grid/safe-zones
- Asset upload pipeline (currently metadata/source driven)

## Next
- Frontend overlay editor
- Hotkeys and scene switching UX
- Optional integration hook into youtube-watch panel
