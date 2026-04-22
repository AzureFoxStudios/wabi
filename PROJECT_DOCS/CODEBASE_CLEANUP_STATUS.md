# Wabi Codebase Cleanup Status

Status snapshot: 2026-04-18

This document is the cleanup ledger for the Wabi codebase. The structural cleanup campaign is complete. It records what was cleaned up and what follow-on work is now normal engineering rather than cleanup debt.

## Current State

- Cleanup campaign status: complete
- Backend verification passes: `npm --prefix backend run build`
- Backend tests pass: `npm --prefix backend test`
- Frontend verification passes: `npm --prefix frontend run check`
- Frontend check status: `0 errors`, `0 warnings`
- `backend/src/server.ts` is down to `4703` lines
- The main frontend business-store runtime cycle has been removed
- Shared business entity/contracts now back both frontend business types and backend business validation
- The backend plugin contract surface now uses bounded structural types instead of `any` across context, storage, routes, and socket payloads
- Business data now passes through shared sanitizers before frontend localStorage restore/manual import/server pull application and before backend sync acceptance/disk reload
- The live server request surface now has bounded JSON-object parsing across business sync/resource writes, plugin/admin policy writes, telemetry, resumable upload metadata, guest-code verification, and business private-mode updates
- `backend/src/server.ts` now delegates request-body parsing, HTTP text compression, and upload/resumable/whiteboard-file support to dedicated helper modules instead of carrying that machinery inline
- `backend/src/server.ts` now delegates role lookup/role-definition derivation to a dedicated helper module instead of carrying that RBAC read/transform block inline
- `backend/src/server.ts` now delegates whiteboard socket collaboration and whiteboard request-access policy to dedicated helper modules instead of carrying that subsystem inline
- `backend/src/server.ts` now delegates mesh/presence delivery, distributed-user snapshot shaping, and socket-delivery bookkeeping to a dedicated runtime module instead of carrying that subsystem inline
- `backend/src/server.ts` now delegates per-socket channel/role guard logic to a dedicated helper module instead of carrying those permission predicates inline
- `backend/src/server.ts` now delegates message auto-delete/delete lifecycle handling to a dedicated helper module instead of carrying timer state and deletion side effects inline
- `backend/src/server.ts` now delegates upload file response shaping and guarded external HTTP fetch validation to dedicated helper modules instead of carrying duplicated HTTP asset/proxy helpers inline
- `backend/src/server.ts` now delegates voice recording presence state and recording-activation handling to a dedicated helper module instead of carrying direct/group/channel recording state inline
- `backend/src/server.ts` now delegates voice channel membership/subscription state, audience/state fanout, peer-link bookkeeping, and breakout move helpers to a dedicated helper module instead of carrying that runtime inline
- `backend/src/server.ts` now delegates group-call session lifecycle, invite cleanup, participant join/leave notifications, and idle-session cleanup to a dedicated helper module instead of carrying that runtime inline
- `backend/src/server.ts` now delegates direct one-to-one call initiation/answer/reject/cancel/end handling and disconnect teardown to a dedicated helper module instead of duplicating direct-call cleanup inline
- `backend/src/server.ts` now delegates call offer/SDP/ICE relay routing to a dedicated helper module instead of carrying that transport relay inline
- `backend/src/server.ts` now delegates screen-share/WebRTC/p2p relay handlers to a dedicated helper module instead of carrying that peer-relay block inline
- `backend/src/server.ts` now delegates voice-channel socket handlers and recording-activation handler wiring to a dedicated helper module instead of carrying that socket boilerplate inline
- `backend/src/server.ts` now delegates group-call initiation/answer/reject/cancel/stop-ringing/leave lifecycle handling to a dedicated helper module instead of carrying those group-call branches inline
- `backend/src/server.ts` now delegates voice breakout create/close/move handlers to a dedicated helper module instead of carrying that breakout-management block inline
- `backend/src/server.ts` now delegates channel create/thread create/channel delete/channel settings update handlers to a dedicated helper module instead of carrying that channel-mutation block inline
- `backend/src/server.ts` now delegates DM/group conversation membership and avatar mutation handlers to a dedicated helper module instead of carrying that conversation block inline
- `backend/src/server.ts` now delegates role assignment/removal, ban-user, role-definition display-name, and emoji-role-rule admin handlers to a dedicated helper module instead of carrying that moderation block inline
- `backend/src/server.ts` now delegates session rejoin, profile update, and channel-entry message preload handlers to a dedicated helper module instead of carrying that user-session block inline
- `backend/src/server.ts` now delegates message pinning, channel pinning, emoji reactions, and typing-indicator handlers to a dedicated helper module instead of carrying that interaction block inline
- `backend/src/server.ts` now delegates registered/guest join initialization, session resume/new guest-session bootstrap, and initial user payload assembly to a dedicated helper module instead of carrying that join monolith inline
- `backend/src/server.ts` now delegates history pagination, core message send/edit/delete/retry handlers, DM first-message delivery, and message-created persistence side effects to a dedicated helper module instead of carrying that message pipeline inline
- `backend/src/server.ts` now delegates disconnect teardown, emoji/emote asset handlers, and thin call lifecycle socket wrappers to dedicated helper modules instead of carrying those remaining socket handlers inline
- `backend/src/server.ts` now delegates offline message delivery and user-channel hydration/enrichment helpers to dedicated modules instead of carrying those data-shaping helpers inline
- `backend/src/server.ts` now delegates the plugin/admin/runtime HTTP block to a dedicated route module instead of carrying that request family inline
- `backend/src/server.ts` now delegates the upload/resumable/telemetry HTTP block to a dedicated route module instead of carrying that request family inline
- `backend/src/server.ts` now delegates single-session enforcement, per-socket rate limiting, and role/emoji runtime support to dedicated helper modules instead of carrying that connection-shell logic inline
- `backend/src/server.ts` no longer contains inline `socket.on(...)` handler implementations; socket behavior is now registered through extracted modules
- launch-page branding contracts now live in one shared file instead of separate frontend/backend copies
- media runtime, TURN, LiveKit token, and media-gateway session contracts now live in one shared file instead of separate frontend/backend copies
- auth/session responses, user-settings/follow payloads, relay admin-node metadata, and payment user-block contracts now live in shared files instead of separate frontend/backend copies
- album upload limit defaults/sanitization now live in one backend helper instead of being duplicated in `server.ts` and `albumRoutes.ts`
- `backend/src/server.ts` now uses shared request auth/admin guard helpers across repeated HTTP route branches instead of repeating the same inline authorization checks
- shared request-body parsing now backs the main backend route layer instead of each route family carrying its own JSON-object reader/error boilerplate
- backend now has a real test entrypoint and coverage for shared request-body parsing, album upload limit sanitization, and business-data/resource sanitizers

## High-Confidence Work Already Landed

### Structural fixes

- Broke the frontend runtime cycle between `frontend/src/lib/business/store.ts` and `frontend/src/lib/business/sync.ts`
- Added `frontend/src/lib/business/state.ts` and moved raw business stores there
- Removed the dead unused route module `backend/src/api/businessRoutes.ts`
- Tightened a few weak types in:
  - `frontend/src/lib/api.ts`
  - `frontend/src/lib/components/Settings.svelte`
- Hardened backend plugin typing in:
  - `backend/src/plugins/types.ts`
  - `backend/src/plugins/loader.ts`
  - `backend/src/server.ts`
- Collapsed duplicated backend payment status/checkout-mode unions so plugin types reuse the repository contract
- Consolidated shared business contract types in:
  - `shared/businessContracts.ts`
  - `frontend/src/lib/business/types.ts`
  - `backend/src/business/validation.ts`
- Added reusable frontend business snapshot/validation helpers in:
  - `frontend/src/lib/business/snapshot.ts`
  - `frontend/src/lib/business/validation.ts`
- Replaced raw business JSON ingestion in:
  - `frontend/src/lib/business/store.ts`
  - `frontend/src/lib/business/sync.ts`
  - `frontend/src/routes/business/+page.svelte`
- Added reusable backend business validation in:
  - `backend/src/business/validation.ts`
- Replaced raw backend business JSON ingestion in:
  - `backend/src/server.ts` load/save workspace persistence
  - `backend/src/server.ts` `/api/business/sync`
- Tightened live backend write-route contracts in:
  - `backend/src/server.ts` business resource create/update endpoints
  - `backend/src/api/paymentRoutes.ts` create-payment and account-link request normalization
- Replaced ad hoc server-side JSON parsing in:
  - `backend/src/server.ts` plugin signer trust route
  - `backend/src/server.ts` admin policy and upload-limit write routes
  - `backend/src/server.ts` mesh delivery ingress
  - `backend/src/server.ts` video-compression telemetry ingress
  - `backend/src/server.ts` resumable upload init/complete metadata routes
  - `backend/src/server.ts` guest-code verification
  - `backend/src/server.ts` business private-mode toggle
- Tightened smaller backend route modules in:
  - `backend/src/api/authRoutes.ts`
  - `backend/src/api/themeRoutes.ts`
  - `backend/src/api/dictionaryRoutes.ts`
  - `backend/src/api/webhookRoutes.ts`
  - `backend/src/api/relayRoutes.ts`
  - `backend/src/api/albumRoutes.ts`
  - `backend/src/api/proxyRoutes.ts`
- Replaced duplicated request-body readers in:
  - `backend/src/api/authRoutes.ts`
  - `backend/src/api/followRoutes.ts`
  - `backend/src/api/manualSettlementRoutes.ts`
  - `backend/src/api/mediaRoutes.ts`
  - `backend/src/api/themeRoutes.ts`
  - `backend/src/api/relayRoutes.ts`
  - `backend/src/api/dictionaryRoutes.ts`
  - `backend/src/api/webhookRoutes.ts`
  - `backend/src/api/albumRoutes.ts`
- Extracted `backend/src/server.ts` helper clusters into:
  - `backend/src/api/runtimeAdminRoutes.ts`
  - `backend/src/api/uploadRoutes.ts`
  - `backend/src/utils/requestBodies.ts`
  - `backend/src/utils/httpCompression.ts`
  - `backend/src/services/uploadSupport.ts`
  - `backend/src/services/roleLookup.ts`
  - `backend/src/services/offlineMessageDelivery.ts`
  - `backend/src/services/userChannelViews.ts`
  - `backend/src/services/registeredSocketSessions.ts`
  - `backend/src/services/socketRateLimit.ts`
  - `backend/src/services/roleRuntimeSupport.ts`
  - `backend/src/services/whiteboardSocketHandlers.ts`
  - `backend/src/services/whiteboardAccess.ts`
  - `backend/src/services/presenceMeshRuntime.ts`
  - `backend/src/services/socketChannelGuards.ts`
  - `backend/src/services/messageLifecycle.ts`
  - `backend/src/services/uploadFileServing.ts`
  - `backend/src/services/voiceRecordingRuntime.ts`
  - `backend/src/services/voiceChannelRuntime.ts`
  - `backend/src/services/groupCallRuntime.ts`
  - `backend/src/services/groupCallLifecycle.ts`
  - `backend/src/services/directCallLifecycle.ts`
  - `backend/src/services/callSignalRelayHandlers.ts`
  - `backend/src/services/peerRelayHandlers.ts`
  - `backend/src/services/voiceSocketHandlers.ts`
  - `backend/src/services/voiceBreakoutHandlers.ts`
  - `backend/src/services/channelMutationHandlers.ts`
  - `backend/src/services/conversationChannelHandlers.ts`
  - `backend/src/services/roleModerationHandlers.ts`
  - `backend/src/services/sessionProfileHandlers.ts`
  - `backend/src/services/messageInteractionHandlers.ts`
  - `backend/src/services/joinInitializationHandler.ts`
  - `backend/src/services/messagePipelineHandlers.ts`
  - `backend/src/services/disconnectCleanupHandler.ts`
  - `backend/src/services/socketAssetHandlers.ts`
  - `backend/src/services/callSocketHandlers.ts`
  - `backend/src/utils/safeExternalFetch.ts`
- Removed inline upload/storage/resumable token/path helpers, bounded request-body parsing helpers, HTTP text-compression helpers, whiteboard orphan-upload cleanup logic, role lookup/definition derivation helpers, whiteboard socket collaboration handlers, whiteboard request-access policy helpers, mesh/presence delivery helpers, socket/channel guard helpers, message auto-delete/delete helpers, upload file-serving helpers, voice recording presence helpers, voice channel runtime helpers, group-call session helpers, group-call lifecycle branches, direct-call lifecycle/teardown helpers, call-signal relay handlers, peer relay handlers, voice socket handler wiring, voice breakout handlers, channel-mutation handlers, conversation-channel handlers, role/moderation handlers, session/profile/channel-entry handlers, message-interaction handlers, join-initialization handlers, message-pipeline handlers, disconnect cleanup handlers, socket asset handlers, call socket wrappers, and external-fetch guard helpers from `backend/src/server.ts`
- Consolidated shared payment contract types in:
  - `shared/paymentContracts.ts`
  - `backend/src/db/repositories/paymentRepository.ts`
  - `backend/src/plugins/types.ts`
  - `frontend/src/lib/api.ts`
- Consolidated shared admin/policy contract types in:
  - `shared/adminPolicyContracts.ts`
  - `backend/src/payments/accessPolicy.ts`
  - `backend/src/payments/donations.ts`
  - `backend/src/payments/accountLinks.ts`
  - `backend/src/frontendAppMetadata.ts`
  - `backend/src/communityNodeAnnouncements.ts`
  - `backend/src/communityNodeAccess.ts`
  - `frontend/src/lib/api.ts`
- Consolidated shared runtime/admin contract types in:
  - `shared/runtimeAdminContracts.ts`
  - `backend/src/server.ts`
  - `backend/src/api/runtimeAdminRoutes.ts`
  - `backend/src/api/relayRoutes.ts`
  - `backend/src/observability/runtimeGuardrails.ts`
  - `frontend/src/lib/api.ts`
- Consolidated shared launch-page contract types in:
  - `shared/launchPageContracts.ts`
  - `backend/src/api/launchPageRoutes.ts`
  - `frontend/src/lib/api.ts`
- Consolidated shared media contract types in:
  - `shared/mediaContracts.ts`
  - `backend/src/api/mediaRoutes.ts`
  - `backend/src/relay/boosterRelayMode.ts`
  - `frontend/src/lib/mediaRuntime.ts`
  - `frontend/src/lib/mediaGateway.ts`
  - `frontend/src/lib/turnConfig.ts`
- Consolidated shared user/session contract types in:
  - `shared/userContracts.ts`
  - `backend/src/api/authRoutes.ts`
  - `backend/src/api/followRoutes.ts`
  - `frontend/src/lib/api.ts`
- Consolidated shared relay admin metadata/types in:
  - `shared/relayContracts.ts`
  - `backend/src/relay/relayMetadata.ts`
  - `backend/src/api/relayRoutes.ts`
  - `frontend/src/lib/api.ts`
- Consolidated payment user-block contracts in:
  - `shared/paymentContracts.ts`
  - `backend/src/payments/userBlocks.ts`
  - `frontend/src/lib/api.ts`
- Consolidated album upload limit typing/defaults/sanitization in:
  - `backend/src/services/albumUploadLimits.ts`
  - `backend/src/server.ts`
  - `backend/src/api/albumRoutes.ts`

### Dead code and artifact removal

The obvious unreferenced or artifact-style files removed in this cleanup campaign include:

- `frontend/src/routes/simple-test/+page.svelte`
- `frontend/src/routes/business/+page.svelte.backup`
- `frontend/src/lib/components/DMListPanel.svelte.fix`
- `frontend/vite.config.ts.timestamp-1765859662847-4f2ab4308bb338.mjs`
- `frontend/src/lib/components/DMListPanel.svelte`
- `frontend/src/lib/encryptionSimple.ts`
- `frontend/src/lib/webrtc.ts`
- `frontend/src/lib/commands/ArtCommandRegistry.ts`
- `frontend/src/lib/components/GiphyPicker.svelte`
- `frontend/src/lib/components/ExportButton.svelte`
- `frontend/src/lib/components/HamburgerMenu.svelte`
- `frontend/src/lib/components/ScreenShareViewer.svelte`
- `frontend/src/lib/socket.test.ts`
- `frontend/src/lib/callLayoutManager.test.ts`
- `scripts/fix-line-endings.ps1`
- `backend/src/api/guestRoutes.ts`
- `backend/src/api/businessRoutes.ts`
- `backend/src/middleware/authMiddleware.ts`
- `backend/src/services/fileEncryptionService.ts`
- `backend/src/services/uploadTokenService.ts`
- `backend/src/services/messageExpiryService.ts`
- legacy `messages.json` server-side message persistence path inside `backend/src/server.ts`
- generated logs and stale build artifacts under the repo root/frontend

### Defensive-programming cleanup

Removed or reduced no-value error suppression in:

- `frontend/src/lib/components/Login.svelte`
- `frontend/src/lib/components/UserListTab.svelte`
- `frontend/src/lib/components/Chat.svelte`
- `backend/src/server.ts`

The current state is better about not silently swallowing failures without explanation.

### Documentation cleanup

- `PROJECT_DOCS/ARCHITECTURE.md` was updated to stop referencing deleted files and stale frontend structure
- `plugins/README.md` now matches the typed plugin context and route helper surface
- this cleanup ledger now reflects the runtime-validation pass on business data ingress

### Runtime validation cleanup

- localStorage restore for business data no longer trusts raw parsed JSON
- backend route-level JSON parsing now mostly flows through `backend/src/utils/requestBodies.ts` instead of repeated local readers
- backend test coverage now exists for:
  - `backend/src/utils/requestBodies.ts`
  - `backend/src/services/albumUploadLimits.ts`
  - `backend/src/business/validation.ts`
- manual business import now sanitizes imported data before replacing stores
- business sync pulls sanitize server payloads before applying them locally
- frontend business sync preserves local-only fields when the server omits them, instead of resetting them during sanitized pulls
- business export now uses the shared snapshot path, which keeps manual export/import aligned with persisted state and includes resources/tags/graph edges
- backend business workspace files are sanitized on reload and normalized before being written back to disk
- `/api/business/sync` no longer accepts raw parsed payloads directly into workspace state
- business resource create/update routes now sanitize payloads before persisting and return `400` for malformed JSON or invalid resource bodies
- plugin signer trust, admin policy writes, upload-limit writes, mesh delivery, telemetry, resumable upload init/complete, guest-code verification, and business private-mode updates now use bounded object parsing instead of ad hoc `JSON.parse`/string collectors
- payment create/account-link routes now use explicit normalized request contracts instead of rebuilding accepted fields ad hoc inside handlers
- payment status/mode/method/provider capability contracts no longer live in separate frontend/backend copies
- payment access, donation config, account-link, frontend app metadata, and community-node policy contracts no longer live in separate frontend/backend copies
- auth, theme, dictionary, webhook, relay, and album routes now use bounded JSON parsing instead of open-ended body readers
- proxy routes now use typed HTTP request/response signatures instead of `any`
- request-body parsing and multipart single-file parsing now live in one reusable backend utility instead of being defined inside `server.ts`
- HTTP text-response compression now lives in one reusable backend utility instead of being defined inside `server.ts`
- upload token signing, at-rest file encryption, upload compression, resumable-upload metadata persistence, upload path normalization, and whiteboard upload cleanup now live in one backend support module instead of being defined inside `server.ts`
- upload file response shaping for both `/uploads/*` and whiteboard attachment routes now lives in one backend file-serving module instead of existing in duplicated inline route code
- role lookup caching, role priority reads, and role definition shaping now live in one backend support module instead of being defined inside `server.ts`
- whiteboard room join/leave, snapshot/patch/cursor fanout, and whiteboard socket-side access/error handling now live in one backend runtime module instead of being defined inside `server.ts`
- whiteboard request-level board/channel access resolution now lives in one backend access module instead of being defined inside `server.ts`
- mesh delivery ID tracking, stable-user/socket resolution, mesh fanout, inbound mesh normalization, payment admin fanout, presence lease bookkeeping, and distributed-user snapshot shaping now live in one backend runtime module instead of being defined inside `server.ts`
- per-socket highest-role checks, channel access gating, and breakout-management permission helpers now live in one backend guard module instead of being defined inside `server.ts`
- message auto-delete timers, attachment cleanup on deletion, and the shared realtime message delete path now live in one backend lifecycle module instead of being defined inside `server.ts`
- SSRF/redirect/blocked-host validation for proxied external fetches now lives in one backend utility instead of being defined inside `server.ts`
- direct-call recording presence, group-call recording presence, voice-channel recording presence, and recording activation/deactivation rules now live in one backend voice runtime module instead of being defined inside `server.ts`
- voice channel participant tracking, voice-channel subscription tracking, audience socket fanout, voice state payload shaping, peer-link graph bookkeeping, and breakout move helpers now live in one backend runtime module instead of being defined inside `server.ts`
- group-call session state, invite cancellation fanout, participant join/leave fanout, and idle-session cleanup now live in one backend runtime module instead of being defined inside `server.ts`
- direct-call initiation/answer/reject/cancel handling, direct-call end cleanup, and disconnect-time peer/recording teardown now live in one backend lifecycle module instead of being defined inside `server.ts`
- call offer/answer-sdp/ice-candidate relay routing now lives in one backend signaling module instead of being defined inside `server.ts`
- screen-share relay, WebRTC screen-share signaling, and p2p file-transfer signaling now live in one backend peer-relay module instead of being defined inside `server.ts`
- voice-channel join/subscribe/leave/unsubscribe handling, voice peer link/unlink handling, and call-recording activation handler wiring now live in one backend voice socket-handler module instead of being defined inside `server.ts`
- group-call initiate/answer/reject/cancel/stop-ringing/leave handling now lives in one backend lifecycle module instead of being defined inline in `server.ts`
- breakout room creation/closure, breakout-member reassignment, and admin voice-member move handling now live in one backend breakout-handler module instead of being defined inline in `server.ts`
- channel creation, thread creation, channel deletion, and channel settings mutation handling now live in one backend channel-mutation module instead of being defined inline in `server.ts`
- DM creation/deletion, group creation/member add/member kick/member leave, and group avatar update handling now live in one backend conversation-channel module instead of being defined inline in `server.ts`
- role assignment/removal, ban-user, role-definition reads/display-name writes, and emoji-role-rule mutation handling now live in one backend moderation module instead of being defined inline in `server.ts`
- session rejoin, profile update, and join-channel message-preload handling now live in one backend session/profile module instead of being defined inline in `server.ts`
- message pin toggling, channel pinning, reaction add/remove handling, and typing-indicator fanout now live in one backend interaction module instead of being defined inline in `server.ts`
- registered-user join bootstrap, guest session resume/new guest bootstrap, and initial join payload shaping now live in one backend join-initialization module instead of being defined inline in `server.ts`
- history pagination, message send/edit/delete/retry handling, DM first-message delivery, and message-created persistence side effects now live in one backend message-pipeline module instead of being defined inline in `server.ts`
- disconnect-time presence/mesh cleanup, direct/group/voice teardown, and user-left fanout now live in one backend disconnect-cleanup module instead of being defined inline in `server.ts`
- emoji/emote asset handlers now live in one backend socket-asset module instead of being defined inline in `server.ts`
- thin call-initiate/answer/reject/cancel/leave/end socket wrappers now live in one backend call-socket module instead of being defined inline in `server.ts`

### Frontend warning cleanup completed

The warning count was reduced across several passes:

- `162 -> 141 -> 126 -> 119 -> 111 -> 103 -> 95 -> 47 -> 11 -> 0`

Important cleanup targets in those passes included:

- `frontend/src/lib/components/business/ProjectsView.svelte`
- `frontend/src/lib/components/business/KanbanBoard.svelte`
- `frontend/src/lib/components/business/Calendar.svelte`
- `frontend/src/lib/components/business/DiaryView.svelte`
- `frontend/src/lib/components/business/TodoList.svelte`
- `frontend/src/lib/components/ChannelQuickTabs.svelte`
- `frontend/src/lib/components/ChannelSidebar.svelte`
- `frontend/src/lib/components/AudioRecorder.svelte`
- `frontend/src/lib/components/CameraCapture.svelte`
- `frontend/src/lib/components/CreateDMModal.svelte`
- `frontend/src/lib/components/ImageViewer.svelte`
- `frontend/src/lib/components/ThemeCustomizer.svelte`
- `frontend/src/lib/components/MainLayout.svelte`
- `frontend/src/lib/components/PinnedChannelsSidebar.svelte`
- `frontend/src/lib/components/UserPanel.svelte`
- `frontend/src/lib/components/UserPopout.svelte`
- `frontend/src/lib/components/docking/DockContainer.svelte`
- `frontend/src/lib/components/plugins/ArtAssetsOverlay.svelte`
- `frontend/src/lib/components/plugins/BlendImportSettingsModal.svelte`
- `frontend/src/lib/components/plugins/ModelViewer3D.svelte`

The drag-first kanban/todo surfaces were kept intentional: the final pass used explicit `svelte-ignore` annotations where a fake keyboard surface would have been less honest than documenting the interaction model.

## Post-Cleanup Work

The cleanup mission is no longer blocked by structural debt. What remains is ordinary follow-on work:

- add more targeted tests around extracted runtime/socket modules where behavior risk is highest
- share any remaining DTOs only when a concrete duplicate turns up during feature work
- keep deleting legacy paths only when active behavior proves they are dead
- do optional orchestration polish only if a future change directly benefits from it

None of the above is required to consider the cleanup campaign unfinished.

## Original Audit Track Outcome

### 1. DRY / deduplication

- completed at the structural level
- any further DRY work should be opportunistic and feature-driven

### 2. Shared types

- materially improved
- payment status/mode/capability contracts are now shared
- payment/admin policy contracts are now shared
- business entity/contracts are now shared
- any remaining DTO sharing should be done only where real duplication still appears

### 3. Unused code

- the obvious file-level dead code was already removed
- the dead-CSS warning backlog was removed
- the dead legacy server-side `messages.json` persistence path is now also removed
- any further unused-code removal should be evidence-driven, not speculative

### 4. Circular dependencies

- the real frontend runtime cycle was fixed
- no meaningful runtime cycle remains as a cleanup blocker

### 5. Weak types

- materially improved
- plugin loader/plugin interfaces no longer rely on `any` for their public boundary surface
- runtime data validation is now in place for frontend business ingress, the live backend business sync/persistence path, business resource mutation writes, several server-side admin/plugin metadata routes, and the theme/dictionary route bodies, but still missing in several other backend ingress paths
- the medium-size auth/theme/dictionary/webhook/relay/album route modules now have bounded request parsing
- `server.ts` no longer carries its own ad hoc request-body parsing, multipart parsing, or upload metadata helpers
- `server.ts` no longer carries its own plugin/admin/runtime HTTP route family or upload/resumable/telemetry HTTP route family
- `server.ts` no longer carries its own single-session enforcement, per-socket rate limiter, or role/emoji runtime support helpers
- `server.ts` no longer carries its own whiteboard socket collaboration or whiteboard request-access policy helpers
- `server.ts` no longer carries its own mesh/presence delivery or distributed-user snapshot helpers
- `server.ts` no longer carries its own per-socket channel/role guard predicates
- the former high-risk weak-type surfaces are no longer the bottleneck

### 6. Defensive programming / silent failure

- completed for the obvious low-value cases
- any further changes should be made while touching specific behavior, not as blind cleanup

### 7. Legacy / fallback cleanup

- obvious compatibility leftovers were removed
- remaining migration-related paths should be handled cautiously during normal maintenance

### 8. AI slop / stubs / comment cleanup

- backup files, demo routes, and obvious stub-style leftovers were removed
- further comment cleanup is optional polish, not a structural need

## Best Next Order

1. Return to feature work
2. Add targeted tests when touching extracted runtime/socket modules
3. Consolidate any remaining DTOs opportunistically when real duplication appears
4. Review migration/fallback code paths only when a product change puts them in scope
5. Do comment/doc polish only where it helps active work

## Resume Here

If a future cleanup pass needs a starting point, start with:

- `PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md`
- `PROJECT_DOCS/ARCHITECTURE.md`
- `shared/businessContracts.ts`
- `frontend/src/lib/business/validation.ts`
- `frontend/src/lib/business/snapshot.ts`
- `backend/src/business/validation.ts`
- `backend/src/utils/requestBodies.ts`
- `backend/src/utils/httpCompression.ts`
- `backend/src/api/runtimeAdminRoutes.ts`
- `backend/src/api/uploadRoutes.ts`
- `shared/runtimeAdminContracts.ts`
- `backend/src/services/uploadSupport.ts`
- `backend/src/services/roleLookup.ts`
- `backend/src/services/offlineMessageDelivery.ts`
- `backend/src/services/userChannelViews.ts`
- `backend/src/services/registeredSocketSessions.ts`
- `backend/src/services/socketRateLimit.ts`
- `backend/src/services/roleRuntimeSupport.ts`
- `backend/src/services/whiteboardSocketHandlers.ts`
- `backend/src/services/whiteboardAccess.ts`
- `backend/src/services/presenceMeshRuntime.ts`
- `backend/src/services/socketChannelGuards.ts`
- `backend/src/server.ts`
- `backend/src/plugins/types.ts`
- `backend/src/plugins/loader.ts`

The current codebase is in a stable verified state. Further work should be driven by product needs and normal maintenance, not by an unfinished cleanup campaign.
