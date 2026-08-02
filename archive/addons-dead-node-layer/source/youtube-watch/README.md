# YouTube Watch

Synchronized channel watch-room state for YouTube with queue controls and moderation.

## Included
- `plugin.json` manifest
- Backend socket event handlers for room state, queue, play/pause/seek/skip
- Queue QoL controls: play now/next, reorder, remove, clear
- Control modes: `open`, `presenter`, `vote`
- Queue moderation mode (presenter-controlled pending approval queue)
- Anti-spam guards on submissions:
  - submit cooldown (3s)
  - per-user queue cap (5)
  - duplicate-link blocking across current/queued/pending
- Sync ping/pong endpoint for server-time offset work
- Runtime route: `GET /api/plugins/runtime/youtube-watch/rooms`

## Still planned
- Adaptive jitter windowing
- Drift correction engine
- Advanced frame-step controls and tighter role-gated UX
