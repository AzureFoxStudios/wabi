ALL TASKS (Current Snapshot)

Completed
- C1: Add authz checks to channel create/delete — owner/admin/mod only (server.ts)
- C2: Add admin check to POST /api/clear-messages — owner/admin only (server.ts)
- C3: Add SSRF guards to proxyRoutes.ts — extracted to utils/urlGuards.ts
- C4: Add file type validation to emoji uploads — PNG/JPEG/GIF/WebP only (server.ts)
- H1: Fix duplicate plugin socket handler registration — removed duplicate io.on('connection') (loader.ts)
- H2: Add sender validation to WebRTC signaling — verifies sender/target share a channel (server.ts)
- H3: Fix ban bypass — added ban check for temp/guest sessions in middleware (server.ts)
- H4: Add multipart body size cap — 10GB default, configurable via WABI_MULTIPART_MAX_BYTES (server.ts)
- H5: Fix media stream leak on call failure — tracks stopped in catch block (calling.ts)
- H6: Fix audio track replacement — rollback if new track add fails (calling.ts)
- H7: Handle screen share audio failure on Linux — remove dead audio tracks (calling.ts)
- H8: Fix boardStore global singleton — converted to per-board keyed store map (boardStore.ts)
- H9: Fix showNotification receiving malformed Message object — added SimpleNotification union type (notifications.ts)
- M1: Fix dbUserIdToSocketId map not cleaned on disconnect — immediate cleanup in disconnect logic (server.ts)
- Schema: Fix resource_visibility FK referencing non-existent resources table — FK removed (schema.sql)
- boardSync: patch to snapshot handling (timers and save cadence)
- M2: Initial M2 patch to serialize business data sync (in-flight lock)
- M4: Improve flush timing for background tabs — force pending message flush on visibility regain (socket-manager.ts)
- M5: History load dedup protection — request-keyed dedup plus stale-response ignore (server.ts, socket-manager.ts)
- M6: Disconnect LiveKit SFU clearing ALL calls — corrected to only SFU state

Partially Landed / Next Patches
- M3: LiveKit token refresh for long calls — refresh scheduling, timer cleanup, and retry/backoff now exist, but the refresh path is still reconnect-based rather than seamless in-room renewal.
- SHARED-1: ImageViewer — shared component exists and is now used by DiaryView, but the richer chat/albums/right-rail viewers have not been consolidated yet.
- docs: Keep this file in sync with the branch instead of the older desktop backlog note.

Still Open
- MAPS-1..MAPS-5
- ALBUMS-1..ALBUMS-3
- ADDONS-1
- E2E: End-to-end encryption rotation
- Cleanup

Backlog (high-level plan)
- The backlog items from the build backlog (M4..M5.., Maps, Albums, Addons) live here for quick reference.

Notes
- Patches are incremental, one patch per major area, all on the same branch.
- Patch diffs and quick test plans will be provided after each patch.
