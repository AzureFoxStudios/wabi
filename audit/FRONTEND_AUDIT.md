# Wabi Frontend Audit — 2026-07-08

> **Scope:** `frontend/` SvelteKit 5 + TypeScript + Tauri app. 561 `.svelte`/`.ts`/`.js` files (~110k LOC), plus `src-tauri` (Rust, light pass), `static/`, `scripts/`, and `package.json` dependency hygiene.
> **Method:** 13 parallel read-only explore agents, each owning a directory slice and returning `[Pn] file:line — category — fix` findings. Report-only pass — no changes applied.
> **Severity:** **P1** = bug / security / orphaned-dead-code that can never run; **P2** = should clean (debug logs, `any`, unused imports, `alert()`, stray files); **P3** = polish (hardcoded colors, oversized files, a11y, duplication).

---

## Executive Summary

**Status: Functional but carrying substantial cleanup debt. Safe to keep running for self-hosted use; address P1 items before any broader rollout.**

Three themes dominate:

1. **Orphaned / dead code is widespread.** ~25 top-level components and several whole modules are imported nowhere (e.g. `callState.ts`, `socketReconnection.ts`, `placeRegistry-unified.ts`, `audioSettingsHelpers.ts`, `albumPermissions.ts`, `youtubeWatchHelpers.ts`, 11 root components, and the entire `business/Overview` + `TodoList` trees). This is the single biggest cleanup win — pure deletion, no behavior change.
2. **Native `alert()` / `prompt()` / `confirm()` are used pervasively for error + confirmation UX** (100+ call sites, concentrated in `MessageList`, `LoreChannel`, `Settings`, chat, media-albums, plugins). Should be a toast/inline-UI migration.
3. **Two genuine security concerns beyond stylistic `any`:** unsanitized CSS injection in launch-page styles + admin accent color, and private keys persisted to `localStorage` in plaintext when no wrapping secret is set.

**Positive signals:** All 3 `{@html}` sinks are sanitized (DOMPurify in `markdown.ts` / `readerTabHelpers.ts`; `ContextMenu.svelte` SVG is a static map). No `debugger`, no `@ts-ignore`, no hardcoded secrets (all via `import.meta.env.VITE_*`), and the Rust `src-tauri` handlers have path-traversal guards with no `unsafe`/`unsafe` secrets.

---

## Phase 1 — Pre-Launch Critical (P1)

| # | File | Issue | Fix |
|---|------|-------|-----|
| 1 | `src/lib/callState.ts` | 301 LOC of fully orphaned dead code (never imported; duplicates `callingStateStores.ts`) + 2 unused imports | Delete once confirmed unused |
| 2 | `src/lib/socketReconnection.ts` | Entire module orphaned (logic lives in `socketConnectionReconnect.ts`/`socketConnectionHeartbeat.ts`) | Delete |
| 3 | `src/lib/socket.ts:30-32` | Dead stub `export class socketManager` shadows the real singleton | Remove stub |
| 4 | `src/lib/placeRegistry-unified.ts` | Duplicate of `placeRegistry.ts`, imported nowhere | Delete / consolidate |
| 5 | `src/lib/encryption.ts:362` | `saveUserKeys()` persists raw private key to `localStorage` when `wrappingSecret` is null; `loadUserKeys()` returns plaintext fallback | Never store raw key; require/derive wrapping secret or keep in-memory only |
| 6 | `src/lib/storageEncryption.ts:16-17` + `storage-compression.ts:31` | Static hardcoded PBKDF2 salt `'wabi-storage-salt-v1'` is persisted but never read back (deriveKey hardcodes it) — identical salt per install, weak at-rest crypto | Persist a random per-install salt and feed it into `deriveKey` |
| 7 | `src/lib/components/loginHelpers.ts:86-88` | `buildLaunchPageStyles()` concatenates unsanitized `config.customCss`, `palette.*`, `backgroundImageUrl` into a `style="..."` string → CSS injection / data exfiltration | Validate/whitelist palette + image URL; treat `customCss` as admin-only or run through a CSS sanitizer |
| 8 | `src/lib/components/admin/FrontendMetadataPanel.svelte:143` | Admin `accentColor` injected unvalidated into `style` attribute (`style:--metadata-accent={...||'#2dd4bf'}`) → CSS injection via `;` | Validate hex/oklch/name before binding |
| 9 | `src/lib/components/chat/MentionSuggestions.svelte:12` | Keyed `{#each}` keyed on `suggestion.key` which is always `undefined` at runtime (items lack `key`) | Populate `key` per `MentionSuggestion` |
| 10 | `src/lib/components/chat/MentionSuggestions.svelte:26-32` | `suggestion.kind` always `undefined` → `special`/`place` branches never render; every entry shows "user" | Populate `kind`/`detail` |
| 11 | `src/lib/components/chat/mentionSuggestions.ts:15-33` | `computeMentionSuggestions` returns `{id,label,user}` (no `key`/`kind`/`detail`) and ignores `placeRegistry` → place/special mentions never produced; diverges from `types.ts` | Return `types.MentionSuggestion`; build place suggestions |
| 12 | `src/lib/components/chat/types.ts:9-17` | `MentionSuggestion` (and `FilePreview`) redefined with different shape than `mentionSuggestions.ts`/`fileHandlers.ts` — root cause of #9–11 | Single source of truth |
| 13 | `src/lib/components/chat/ChatComposer.svelte:282` | `suggestions={mentionSuggestions as any}` masks the type/runtime divergence above | Remove cast once #11 fixed |
| 14 | `src/lib/components/chat/uploadOrchestrator.ts:73` | DM E2EE hard-disabled: `const canEncrypt = requiresEncrypted && ... && false;` makes the encryption branch unreachable; `const encrypted = await null;` is nonsensical | Remove `&& false` and finish or delete the `dm-e2ee-v1` branch |
| 15 | `src/lib/components/chat/uploadOrchestrator.ts:71` | `dmPrivacyMode` is `null` in both ternary branches → `requiresEncrypted` always `channelType==='dm'`; dead expression | Simplify / remove |
| 16 | `src/lib/components/sidebar/VoiceChannelList.svelte:86-91` | `canDragVoiceMember()` always returns `true`; the `$currentUser`/self/`dbUserId` checks are unreachable → any member draggable | Return `false` in final branch or implement real check |
| 17 | `src/lib/components/settings/audioSettingsHelpers.ts` | Entire module orphaned (imported nowhere); functions re-implemented inline in `AudioSettingsTab.svelte` | Import & reuse, or delete module |
| 18 | `src/lib/components/settings/addonSettingsRegistry.ts:42` + `AddonSettingsTab.svelte:42,254` | `AddonSectionId`/`ADDON_SECTION_IDS`/`LOCAL_ADDON_CONTROL_META` still contain `'dms'`/`line_dm`/`pin_dms`, but `DmsSection` was removed; `activeAddonSection` defaults to `'dms'` so nothing renders | Remove `'dms'` + DM entries; set sane default |
| 19 | `src/lib/components/media-albums/albumPermissions.ts` | Orphaned dead module (imported nowhere); logic re-implemented inline in `MediaAlbumsTabImpl.svelte:183-211` | Delete or wire up |
| 20 | `src/lib/components/plugins/youtubeWatchHelpers.ts` | Orphaned dead module (imported nowhere); all types/helpers duplicated inline in `YouTubeWatchEmbed.svelte:7-122` | Delete or wire up |
| 21 | `src/lib/components/business/Overview.svelte`, `OverviewImpl.svelte`, `OverviewImpl.css`, `TodoList.svelte`, `TodoListImpl.svelte` | Fully orphaned dead tree (~1,150 LOC); never wired into `routes/business/+page.svelte` (only `calendar`/`journal`/`projects`/`kanban` are switched) | Delete all 5 files |
| 22 | `src/lib/components/ArtGraphSimple.svelte` | Orphan — never imported | Remove or wire into a graph view |
| 23 | `src/lib/components/CreateGroupModal.svelte` | Orphan + unused imports | Remove |
| 24 | `src/lib/components/DmSecondaryPanel.svelte` | Orphan | Remove |
| 25 | `src/lib/components/DockedCallBar.svelte` | Orphan | Remove |
| 26 | `src/lib/components/DrawingBoard.svelte` | Orphan | Remove |
| 27 | `src/lib/components/GroupSettingsPanel.svelte` | Orphan | Remove |
| 28 | `src/lib/components/KeepNotesView.svelte` | Orphan | Remove |
| 29 | `src/lib/components/MapLibreCanvas.svelte` | Orphan (also `any`/`as any`) | Remove |
| 30 | `src/lib/components/NotesDmToggle.svelte` | Orphan | Remove |
| 31 | `src/lib/components/PinnedChannelsSidebar.svelte` | Orphan | Remove |
| 32 | `src/lib/components/UserPanel.svelte` | Orphan + dead sidecars `userPanel.css`/`userPanelHelpers.ts` + 7 unused imports | Remove all |

---

## Phase 2 — Should Clean (P2)

### 2.1 Native `alert()` / `prompt()` / `confirm()` UX (replace with toast/inline UI)
Concentrated call sites (batch-migrate behind a toast helper):
- `MessageList.svelte:737,755,776,779,932,938,974,977,1095,1393,1400,1508,1515` (13×)
- `LoreChannel.svelte:263,294,314,332,360,376,390` (7×)
- `Settings.svelte:124,133,166,206,253,255,259` (7×)
- `UsernameFontCustomizer.svelte:30,55,78,82,89` (5×)
- `UserPopoutImpl.svelte:314`; `UserPanel.svelte:105`; `StorageSettings.svelte:132,134,142,152,154,163,165,169` (8×); `ThemeCustomizer.svelte:100,119,166` (3×)
- `chat/ChatComposer.svelte:187,188,197,248,249,258,260,261` (8×)
- `message/messageAttachmentActions.ts:43,52` (`prompt()`+`alert()`)
- `settings/`: `AddonSettingsTab.svelte:138,151,158,187`; `AdminSettingsTab.svelte:106,124,164,169,174,180,183,190,195`; `AppearanceSettingsTab.svelte:124,221,232`; `AudioSettingsTab.svelte:119`; `EmojiSettingsTab.svelte:29,34,49,96,108,120,126,157,163,217,220`; `NotificationsSettingsTab.svelte:244,249,269,282,296,335,343,348`; `ProfileSettingsTab.svelte:100,104,144,148,152,158,169,171,186,195`; `AdminSettingsCommunityNodes.svelte:199,216`; `AdminSettingsPayments.svelte:197,210,212,222,227,232,250,252,262,268,275,277,287,292,299,300`; `SearchSection.svelte:53`
- `plugins/ArtAssetsOverlay.svelte:154,156,174` (`window.prompt`); `MediaAlbumsTabImpl.svelte:634,681` (`window.confirm`); `map/mapDraftHelpers.ts:44,99` (`window.confirm`); `plugins/YouTubeWatchEmbed.svelte:86` (`window.confirm`)
- `src/lib/storage.ts:240,264`; `calling_impl_core.ts:1983,1985,1987,1989`; `routes/+page.svelte:451,455`; `routes/business/businessPageHelpers.ts:107,110`; `src/lib/storage/chat.ts:494,518`

### 2.2 Leftover `console.log` / `console.debug` (debug noise — gate behind flag or remove)
`lib-root`: `relaySelector.ts:168`; `wabidbMediaRelay.ts:78,199`; `notificationDisplay.ts:81,95,104,122,127,223,228`; `tauri-migration.ts:15,23,27,49,65,72,76,159,167,176`; `tauri-storage.ts:19,33,59,86,100,115,133,159,167`; `turnConfig.ts:150,218`; `serverUrl.ts:126`; `audioMonitoring.ts:229`
`calling`: `calling_impl_core.ts:313,341,367,389,399,405,410,486`; `callingWabidb.ts:94,105,140`; `callingLivekit.ts:253`; `callingAudioMonitors.ts:243,269`; `callingWebrtcHelpers.ts:35,49`
`storage/socket`: `storageEncryption.ts:22,29`; `storage-compression.ts:75,118,183`; `storage.ts:141`; `storageDb.ts:112,137`; `storageMessages.ts:73-75`; `storageArchive.ts:66,105,118,134`; `storageSettings.ts:49,54`; `socketConnectionCore.ts:83,86,141,150,183,197,202,207,230,251,264,285,308,324,343,352,403` (~17); `socketConnectionHeartbeat.ts:30`; `socketConnectionReconnect.ts:112,135`; `layoutStoreSync.ts:23,66,83`; `placeStore.ts:42`
`components`: `PureRefViewer.svelte:17,24,30,35`; `UniformFontMode.svelte:48,50,59,68`; `Login.svelte:108`; `ImageLightbox.svelte:99,115`; `UserPopoutImpl.svelte:294,304`; `UserPanel.svelte:83,94`; `Chat.svelte:209,214`; `plugins/ArtAssetsOverlay.svelte:74`; `emoji/GifPicker.svelte:22,38,56`
`settings`: `addonDetection.ts:89`; `AdminSettingsCommunityNodes.svelte:70,86,103`; `AdminSettingsPayments.svelte:136,155,171,187`; `NotificationsSettingsTab.svelte:98`; `ProfileSettingsTab.svelte:92`; `AppearanceSettingsTab.svelte:108,123,189`; `AudioSettingsTab.svelte:119`; `EmojiSettingsTab.svelte:100,197,208,219`
`other lib`: `addons/loader.ts:24,28,77,96+`; `addons/settings.ts:192`; `business/sync.ts:22`; `dm/run-crypto-tests.ts:22,26,30,35` (test-only); `routes/+layout.svelte:83,108,115,120,145`

### 2.3 `any` / `as any` type-safety escapes (systemic — introduce shared typed contracts)
- **`src/lib/api/*.ts`** — `as Record<string, any>` ~54× (admin.ts, albums.ts, auth.ts, dictionary.ts, paymentCheckout.ts, paymentDonations.ts, paymentHistory.ts, paymentSettlements.ts) + `lore.ts` 15× `(err as any).error`. Add a `getErrMessage(res)` / shared `Json`/`ApiError` helper; `lore.ts` should use `safeJsonParse` like the rest.
- **`calling`**: `callingWabidb.ts:25`; `callRecordingTypes.ts:22,35,36,52,60,83,93,101,102` (9×); `callRecordingSession.ts:74,128,135,150,251`; `callingStorefwd.ts:111` (unsafe `btoa` spread on large buffers).
- **`socket`**: `socketConnectionCore.ts:314,387,399,520,525,646`; `socketConnectionState.ts:31` (`writable<any>`); `socket.ts:52`.
- **`components`**: `MessageItem.svelte:4` (`$$props as any`); `MessageItemContent.svelte:35-110` (many `any` props); `MapLibreCanvas.svelte`; `ArtGraphSimple.svelte` (15+); `ModeTabsDrawer.svelte:23,24`; `StorageSettings.svelte:34`; `ZipPreviewPanel.svelte:63`; `AdminTab.svelte:648,661,677`; `LinkPreview.svelte:7`; `MessageList.svelte:530,1769`; `RightPanel.svelte:48,83`; `message/*` (`MessageContent`, `MessageFileContent`, `MessageHeader`, `MessageItemActions`, `MessageLinkEmbeds`, `MessageListOverlays` — many `any` props).
- **`business`**: `CalendarImpl.svelte:270`; `business/store.ts:366`; `business/storage.ts` (typing).
- **`plugins`/`nodes`/`emoji`**: `ModelViewer3D.svelte` (~50×); `modelViewerHelpers.ts`; `model-loader.worker.ts:24,62`; `YouTubeWatchEmbed.svelte:23,71,76,111,116,117,118,128,133`; `GifPicker.svelte:8,10,61`; `nodes/ResourceNodeComponent.svelte:2`; `nodes/TagNodeComponent.svelte:2`.
- **`whiteboard`**: `boardRenderer.ts:177,228,248,268`; `boardSync.ts:59,201-204`; `tools.ts:50,122,154,155,325,328`; `whiteboardCanvasHelpers.ts:430,443`.
- **`misc lib`**: `livekitSfu.ts:2`; `relaySelector.ts:141`; `markdown.ts:84,106,304`; `notificationAudio.ts:224`; `audioCapture.ts:50`; `serverUrl.ts:188`; `accessibility.ts:103-116`; `channelStore.ts:137`; `addonInventory.ts:14-18`; `typed-array-utils.ts:104,128,145,152,154,156,166,176,178`; `localMockSocket.ts`; `p2pFileTransfer.ts:126,152,161,403,706`; `tauri-storage.ts:9`; `wabidbMediaRelay.ts:13,25,70`.
- **`settings`**: `AdminSettingsTab.svelte:221,222`; `AdminSettingsCommunityNodes.svelte:158` (`as unknown as` — hides real type mismatch pushing username strings into `allowedUsers` that expects `{userId,username}`); `audioSettingsHelpers.ts:87,97`; `ProfileSettingsTab.svelte:47` (`let x = null` under strictNullChecks).

### 2.4 Unused imports / exports / dead params (confirmed per-file)
- `callState.ts:4,5`; `layoutStore.ts:40`; `layoutStoreNav.ts:11`; `layoutStoreRightPanel.ts:37`; `layoutStoreStates.ts:36`; `placeDraft.ts:1`; `socket.ts:19`.
- `components`: `AdminCenterStage.svelte:3`; `ArtGraphSimple.svelte:2,9`; `CallModal.svelte:37`; `CallView.svelte:12,24`; `CameraCapture.svelte`; `Chat.svelte` (onDestroy/createDM/getDMChannelIdForUser/channelHasMoreHistory/Channel); `CreateGroupModal.svelte:2`; `DmConversationView.svelte:4`; `DmListPanel.svelte:5`; `MapWorkspace.svelte`; `MessageList.svelte` (~18 unused); `ModeTabsDrawer.svelte:8`; `PinnedMessages.svelte:2,3`; `PinnedMessagesModal.svelte:3`; `StorageSettings.svelte:2`; `ThemeCustomizer.svelte`; `UserListTabImpl.svelte`; `UserPopoutImpl.svelte`; `UsernameFontCustomizer.svelte`; `WhiteboardCanvas.svelte:8`; `sidebar/VoiceChannelList.svelte:6,12` (unused `allVoiceChannels` prop); `addons/ChatSection.svelte:3,4`; `addons/UtilitiesSection.svelte:3`; `AddonSettingsTab.svelte:5`; `addonSettingsRegistry.ts:18`; `media-albums/MediaAlbumsTabImpl.svelte:22,24`; `AlbumItemRow.svelte:9`; `map/MapViewportDetails.svelte:4`; `map/MapPlaceHeader.svelte:25,26`; `admin/FrontendMetadataPanel.svelte:102,109`.
- `misc lib`: `audioCapture.ts:6`; `galleryStore.ts:1,4,5`; `presenceStore.ts:13`; `savedServerStore.ts:10`; `savedServerUtils.ts:6,8`; `tauri-migration.ts:4`; `typingStore.ts:11`; `chat/messageSend.ts:1`; `whiteboard/boardElements.ts:5` (4 unused imports).
- **Dead exports**: `business/store.ts:365,375,433,441,450,547`; `business/projectStore.ts:34`; `userPanelHelpers.ts` (DM-era no-op stubs `formatBadgeStub` etc.); `modeTabsDrawerState.ts:83-85` (constant-`true` branch).

### 2.5 Duplicate / diverged logic (consolidate)
- **`*Impl` container pairs**: `business/Calendar.svelte` + `CalendarImpl.svelte`; `KanbanBoard.svelte` + `KanbanBoardImpl.svelte`; `ReaderTab.svelte` + `ReaderTabImpl.svelte` — thin passthrough wrappers; merge into the Impl.
- **`chat`**: `messageSend.ts` duplicates `fileHandlers.ts` (`formatFileMb`, `isAlbumEligibleFile`, `buildDefaultUploadAlbumName`, `getMediaAlbumScope`, `MediaAlbumScope`, `splitEntitiesForChunks`); `commandExecutor.ts:30` duplicates `$lib/commands` `getMatchingCommands`; `message/messageMediaUtils.ts` duplicates `messageItemUtils.ts` (`extractUrls`, `getMediaType`, `isYouTubeUrl`, `getFileIcon`, `isImage/Video/Audio`, `isModelFile`, `isBlendFile`, `isZipFile`); `message/messageItemAnimation.ts` duplicates `chat/transitions.ts` (`easeOutCubic/Quint/Back`, `getTransitionForPreset`).
- **`business`**: `getPriorityColor`/`formatDueDate`/`formatEstimateHours`/`isOverdue`/`getAssigneeName`/`getProjectName`/`getProjectColor` copied across `KanbanBoardImpl`/`TaskPanel`/`CalendarImpl`/`OverviewImpl`/`TodoListImpl`; `RegisteredUser` interface duplicated in 4 files. Standardize import source (`$lib/business` vs `$lib/business/store`).
- **`media-albums`**: `albumRowStatus` duplicates `AlbumCard.svelte:18-23`; `formatBytes` duplicated in `zipPreviewHelpers.ts` vs `storageSettingsHelpers.ts` (different rounding).
- **`admin`**: `formatBytes` duplicated in `RuntimeTuningPanel.svelte` + `CompressionPanel.svelte`; `userPanelHelpers.ts` vs `userListHelpers.ts` (`isCurrentUserEntry`); `audioRecorderEngine.ts:162-163` hardcoded brand gradient.
- **`api`**: `PaymentIntent/PaymentEvent` re-declared in `api/types.ts` AND `paymentCheckout.ts`; `MediaAlbumScopeType` in both `albums.ts` and `mediaAlbumScope.ts`; `paymentDonations.ts:16` `Extract<'succeeded'|'refunded', 'succeeded'|'refunded'>` is a no-op.
- **`map`/`place`**: `normalizeKey`/`matchesPoiExact` duplicated across `place-mentions.ts`/`placeNormalization.ts`/`placeSearch.ts`.

### 2.6 TODO / FIXME / HACK
`MessageList.svelte:253` (`TODO: Add emoji reactions`); `Login.svelte:214` (dead `forgot password` link); `wabidbMediaRelay.ts:134`; `gameScreenshotPipe.ts:459`. (`TODO_STATUSES`/`TODO_PRIORITIES` in `business/validation.ts` are identifiers, not TODOs.)

### 2.7 Stray non-code files inside `src`
- `src/lib/components/FRACTURE_PLAN.md` — move to `docs/` or delete
- `src/lib/components/HANDOFF.md` — move to `docs/` or delete
- `src/lib/REFACTORING_STATUS.md` — move to `docs/` or delete

---

## Phase 3 — Polish (P3)

### 3.1 Hardcoded hex / brand colors instead of theme tokens
Worst offenders (migrate to `--accent-*`/`--surface-*`/`--text-*`):
- `LoreChannel.svelte` — 72 hardcoded hex literals (incl. `#2d7d46`,`#854d0e`,`#ff4444` bare, no token)
- `ThemeCustomizer.svelte` — 37 hex (mostly intentional swatches; verify non-swatch uses)
- `AudioRecorder.svelte` (29), `DmListPanel.svelte` (25), `WhiteboardTab.svelte` (23), `WhiteboardToolbar.svelte` (21), `WhiteboardLayerPanel.svelte` (21), `GuestCodePrompt.svelte` (19), `CameraCapture.svelte` (18), `PinnedChannelsSidebar.svelte` (16), `PeoplePicker.svelte` (14), `CallControls.svelte` (14)
- `business/OverviewImpl.css` — uses undefined legacy `--surface-*` vars + raw hex (`#16213e`,`#5865f2`,`#2a2a4a`,`#1f2937`,`#888`,`#f97316`,`#ef4444`,`#aaa`) → never follows theme
- `business/GanttChart.svelte` (`getProgressColor` raw hex), `ProjectDetail.svelte` (SVG hex), `ProjectSidebar.svelte` (`getStatusColor` hex), `CalendarImpl.svelte` (`#5865f2` repeated)
- `nodes/ResourceNodeComponent.svelte` (`#2a2a2e`,`#6366f1`,`#10b981`,`#a855f7`), `nodes/TagNodeComponent.svelte` (`#6366f1`)
- `plugins/LineDm.css`, `plugins/YouTubeWatchEmbed.css` (`#5865f2` blurple fallbacks), `calling/presenterOverlay.ts`, `callRecording*` (canvas `fillStyle` hex), `audioRecorderEngine.ts`
- `login/LaunchPanel.svelte`, `login/LoginConnectionPrompt.svelte` (`#5865f2`/`#4752c4` blurple), `login/LoginQRModal.svelte`
- `sidebar/CreateChannelForm.svelte` dead union members; `admin/OverviewSection.svelte` (~40 inline `var(--token,#HEX)` fallbacks), `RoleBadge.svelte` (guest raw rgba), `StatusDot.svelte` (same pattern)
- `whiteboard/boardRenderer.ts`, `export.ts`, `imageImports.ts`, `elementTypes.ts:93` (`DEFAULT_STYLE.strokeColor='#1f2937'`)
- `messageStore.ts:132` (`'#98D8C8'` user-color fallback); `prism-theme.css` (syntax theme, low priority)

### 3.2 Oversized files (>700 LOC) — split candidates
`calling_impl_core.ts` (2025), `components/MessageList.svelte` (1880), `components/LoreChannel.svelte` (1697), `components/MapWorkspace.svelte` (1108), `components/MainLayout.svelte` (1027), `components/media-albums/MediaAlbumsTabImpl.svelte` (1023), `components/ServerSwitcherPanel.svelte` (1020), `components/CallModal.svelte` (973), `components/plugins/ModelViewer3D.svelte` (884), `lib/p2pFileTransfer.ts` (765), `components/AdminTab.svelte` (757), `socketConnectionCore.ts` (664), `business` containers.

### 3.3 Accessibility gaps
- `alert`/`prompt`/`confirm` (see 2.1) — replace for keyboard/screen-reader UX.
- `business` modals use `role="button"`+`on:keydown` divs instead of `role="dialog"` with focus mgmt (`CalendarEventModal`, `CalendarDayModal`, `ProjectModal`, `SprintModal`, `TodoTaskModal`, `KanbanTaskModal`).
- `sidebar/ChannelSettingsModal.svelte` — `role="button"`+`tabindex` on container; `handleModalKeydown` only `preventDefault`s.
- `settings/*` toggle buttons lack `role="switch"`/`aria-pressed` (only some `AppearanceSettingsTab` toggles set it); bare `<input type=range>` sliders lack `aria-label`/`aria-valuetext`.
- `message/MessageContent.svelte:207-245` — clickable `<div class="markdown-content" on:click>` with a11y suppressed, no keyboard handler.
- `login/LoginQRModal.svelte:75` — overlay `role="button"` closes on Space/Escape but not Enter.
- `nodes/ResourceNodeComponent.svelte:27-30` — duplicate/redundant `on:click`/`on:keydown` directives.
- `admin/RoleGatePanel.svelte:44` — typo `class="admin_empty"` (underscore) vs `admin-empty` → empty-state unstyled.

### 3.4 Inconsistencies / minor
- `chat/transitions.ts:43-53` — `channelPaneOutTransition` always returns `fade`, ignores `params.preset` (inconsistent with `in` transition).
- `payments/PaymentSheetImpl.svelte:153` — double `|| {}`; `PaymentIntentCard.svelte:35` — `status-light-{...}` class rendered but no matching CSS.
- `loginHelpers.ts:20` — inconsistent `{valid:true,error:undefined}` vs peers `{valid:true}`.
- `callingStdb.ts` — backwards-compat shim "slated for removal in F20"; track for deletion.
- `callingAudioMonitors.ts:156-162` — duplicate `AudioAnalyzer` interface (also `callingTypes.ts:126`); `callingTypes.ts:168` + `callingWebrtcHelpers.ts:8` — duplicate `ConnectionKeyType`.
- `userListHelpers.ts:128-181` — ~14 menu items are `onSelect: () => {}` no-ops.
- `business/storage.ts:157 saveCancelledDates` — Tauri branch writes via `chatStorage.setSetting` (not `invoke`), contradicting its "Send to Rust backend" comment; `loadCancelledDates` ignores Tauri branch (silent divergence bug, P2).

---

## Dependency Hygiene
- **Unused declared dependency:** `@giphy/js-components@5.13.0` — never imported; only `@giphy/js-fetch-api` is used. Remove from `dependencies`.
- **Redundant devDependency:** `@types/marked@5.0.2` — `marked@17` ships its own types; verify and remove.
- **No import-without-dependency found** — `marked`, `prismjs`, `dompurify`, `opus-recorder`, `motion`, `@xyflow/svelte`, `livekit-client`, `qrcode`, `socket.io-client`, `svelte-i18n`, `@tauri-apps/api` all genuinely used.
- **Note:** per-file unused-import verification was done by agents via in-file symbol search; a `svelte-kit sync && svelte-check` baseline run is recommended to catch any remaining cross-file unused imports automatically (prior baseline was 0 errors / ~55 warnings).

## Cross-cutting Positives
- All `{@html}` sinks sanitized (DOMPurify); `ContextMenu.svelte` SVG static.
- No `debugger`, no `@ts-ignore`/`@ts-nocheck`, no leaked secrets (all `import.meta.env.VITE_*`).
- `src-tauri` Rust handlers have path-traversal guards, no `unsafe`/secret leakage.
- DM ratchet crypto (`dmRatchet.ts`) verified correct against RFC 7748.

---

## Appendix — Worst offenders per area
1. **`MessageList.svelte`** (1880 LOC) — 13 `alert()` + `TODO` + ~18 unused imports + `$$props as any`; prime split target.
2. **`calling_impl_core.ts`** (2025 LOC) — 8 `console.log` + 4 `alert()` + oversized.
3. **`LoreChannel.svelte`** (1697 LOC) — 7 `alert()` + 72 hardcoded hex.
4. **`uploadOrchestrator.ts`** — DM E2EE permanently dead via `&& false`.
5. **`ModelViewer3D.svelte`** (884 LOC) — ~50 `any` + commented-out dead code.
6. **`encryption.ts`** — plaintext private-key-at-rest (only true crypto defect).
7. **Orphan clusters** — `callState.ts`, `socketReconnection.ts`, `placeRegistry-unified.ts`, `audioSettingsHelpers.ts`, `albumPermissions.ts`, `youtubeWatchHelpers.ts`, 11 root components, `business/Overview`+`TodoList` trees (~3k+ LOC deletable with zero behavior change).
