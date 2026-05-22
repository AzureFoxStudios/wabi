# Wabi Component Fracture Plan
## Document Version: 2.0
## Purpose: Track exact fracture lines for God-component decomposition
## Last Updated: 2026-05-23

---

## Philosophy

Extract along natural UI boundaries (tabs, panels, modals, style blocks) rather than arbitrary line counts. Each extracted component owns its own state, handlers, and lifecycle. The parent shell keeps only shared state (current tab, open/close) and passes data via props.

---

## Repository

**Always work in `/var/home/Ronin/wabi/`** — the main repo. The old worktree at `~/Desktop/Wabi/dotronin-worktree/` was removed.

---

## Completed Phases

### Phase 1: Settings.svelte — DONE
- 8,033 lines → 430 lines (shell only)
- All tabs extracted to `src/lib/components/settings/`
- 11 tab components + 3 helper TS files

### Phase 2: ChannelSidebar.svelte — DONE
- 2,058 lines → 299 lines (shell only)
- Extracted to `src/lib/components/sidebar/`:
  - ChannelSettingsModal, ChannelTree, ChannelTreeItem, TextChannelList, VoiceChannelList, VoiceUserCard, ProfileCard, GalleryChannelList, CreateChannelForm
  - channelSidebarHelpers.ts

### Phase 5 (was 4): ServerSwitcherPanel + MessageList — DONE
- ServerSwitcherPanel: 1,921 → 1,020 lines (style extracted to `server-switcher.css`)
- MessageList: 3,334 → 2,381 lines
  - Extracted 13 components to `src/lib/components/message/`
  - MessageItem, MessageItemContent, MessageHeader, MessageContent, MessageFileContent, MessageLinkEmbeds, MessageItemActions, MessageReplyPreview, MessageReactions, MessageEditForm, MessagePersistenceRow, ImageLightbox, VideoLightbox
  - Extracted 2 utility files: messageItemUtils.ts, messageItemAnimation.ts

### calling.ts barrel split — DONE
- 3,810 lines → 218 lines (barrel)
- Split into: calling_impl.ts, calling_impl_core.ts, callingStateStores.ts, callingTypes.ts, callingAudioMonitors.ts, callingDiagnostics.ts, callingLivekitTokenRefresh.ts, callingSpatialRuntime.ts, callingWebrtcHelpers.ts

### Chat.svelte — DONE
- 3,500 → 518 lines
- Extracted to `src/lib/components/chat/`:
  - ChatComposer, ChatHeader, ChatMessagesPane, EditReplyStatus, FileUploadPreview, MentionSuggestions, VideoCompressionController, VideoCompressionDialog
  - Helper TS files: commandExecutor, fileHandlers, mentionSuggestions, messageSend, search, transitions, types, typing, uploadOrchestrator, uploadResumable

### api.ts barrel split — DONE
- 1,972 → 1,823 lines (still large — more split work possible)
- Extracted to `src/lib/api/`: admin.ts, albums.ts, auth.ts, config.ts, dictionary.ts, mediaAlbumScope.ts, paymentCheckout.ts, paymentDonations.ts, paymentHistory.ts, paymentSettlements.ts, utils.ts, index.ts

---

## Remaining Targets (1000+ lines)

### Priority 1: calling_impl_core.ts (2,762 lines)

The biggest remaining file. Dense reactive state machine with clear domain sections:

| Section | Lines | Extraction Target |
|---------|-------|-----------------|
| Private state (peer connections, LiveKit, StDB) | 168–217 | callingPeerState.ts |
| Media gateway (start/stop/poll/renew) | 218–359 | callingMediaGateway.ts |
| Performance guard | 360–420 | callingAudioMonitors.ts (already exists, merge) |
| ICE candidate queue | 421–432 | callingWebrtcHelpers.ts (already exists, merge) |
| Peer connection management | 433–653 | callingPeerState.ts |
| Remote stream/track handlers | 757–886 | callingWebrtcHelpers.ts |
| Spatial audio engine | 915–1118 | callingSpatialRuntime.ts (already exists, merge) |
| Transport resolution | 1122–1239 | callingTransport.ts |
| LiveKit SFU | 1240–1378 | callingLivekit.ts (new) |
| StDB call | 1379–1548 | callingStdb.ts (new) |
| Call lifecycle (join/leave/start/answer/end) | 1549–2182 | callingCallLifecycle.ts (new) |
| Audio/video controls | 2183–2315 | callingMediaControls.ts (new) |
| WebRTC signaling | 2316–2424 | callingWebrtcHelpers.ts |
| Screen share | 2425–2589 | callingScreenShare.ts (new) |
| Cleanup + utils | 2590–2762 | callingPeerState.ts |

**Blocker:** Same mutable-state trap as before — 30+ module-level `let` bindings. Must hoist state into a store object or use the same barrel pattern as calling.ts (re-export from sub-modules, keep `let` bindings in core barrel). The barrel pattern worked for calling.ts because the barrel just re-exports; the actual state can stay in one file if sub-modules import it.

**Approach:** Group functions by domain. Sub-modules import state from `calling_impl_core.ts` (or its replacement). Parent becomes thin barrel + state container. Each sub-module is pure functions that receive state as params, or they import the state module directly.

### Priority 2: MessageList.svelte (2,381 lines)

Already reduced from 3,334. Further extraction targets:
- Extract remaining style block → `ml-core.css` or component-scoped CSS
- Extract inline `<script>` reactive declarations into a `messageListState.ts` helper
- Extract event handlers (context menu, scroll management) into `messageListHandlers.ts`

### Priority 3: api.ts (1,823 lines)

Already barrel-split but the barrel itself is still huge. Reason: it contains 500+ lines of TypeScript interfaces (PaymentIntent, PaymentEvent, etc.) plus the remaining API functions that weren't extracted.

**Approach:** Move interfaces to `api/types.ts` or co-locate with their domain modules. The barrel should only re-export.

### Priority 4: CSS files (sidebar-core 1,529, settings-core 1,342)

These are already partials (post-split). They're large but they're pure CSS — no logic coupling. Can merge small partials, remove dead rules, or further split by concern. Lower priority than TS/Svelte.

### Priority 5: Svelte components (1000–1500 lines)

| Component | Lines | Primary Bloat | Strategy |
|-----------|-------|---------------|----------|
| PaymentSheet.svelte | 1,492 | Style block | Extract CSS → payment-sheet.css |
| MapWorkspace.svelte | 1,420 | Style + logic | Extract helpers → mapWorkspaceHelpers.ts, CSS → map-workspace.css |
| MediaAlbumsTabImpl.svelte | 1,375 | Markup + state | Extract album grid, upload logic |
| ModelViewer3D.svelte | 1,091 | Style block | Extract CSS → model-viewer-3d.css |
| ServerSwitcherPanel.svelte | 1,020 | Style + markup | Extract remaining style → server-switcher.css |
| CallModal.svelte | 1,007 | Style + helpers | Extract CSS → call-modal.css, helpers → callModalHelpers.ts |

### Future: Rust files

| File | Lines | Strategy |
|------|-------|----------|
| wabi_state_bridge/lib.rs | 3,775 | Domain module extraction |
| wabi-server/socketio.rs | 3,201 | Handler domain modules |
| wabi-tui/app.rs | 567 | Low priority |

---

## File Naming Conventions

- Tab components: `{Feature}{Noun}Tab.svelte` or `{Feature}SettingsTab.svelte`
- Panel components: `{Feature}Panel.svelte`
- Modal components: `{Feature}Modal.svelte`
- List components: `{Feature}List.svelte` or `{Feature}Tree.svelte`
- Sub-directories match parent: `settings/`, `sidebar/`, `chat/`, `message/`
- Helper TS: `{component}Helpers.ts` or `{component}State.ts`

---

## State Passing Patterns

1. **Svelte stores:** Tabs read `currentUser`, `channels`, etc. directly from stores. No prop drilling for global state.
2. **Props:** Shell passes `isOpen`, `onClose`, `activeTab` to tabs.
3. **Events:** Tabs dispatch `save`, `close`, `error` to shell. Shell dispatches to parent.
4. **Context:** Only for deeply nested shared state (rarely needed).
5. **TS barrel pattern:** Barrel re-exports from sub-modules. State stays in one file, sub-modules import it.

---

## Verification Checklist Per Extraction

- [ ] Extracted component compiles without errors
- [ ] Shell component compiles without errors
- [ ] All imports updated in shell
- [ ] No broken references to moved functions/state
- [ ] `bun run check` — no new errors beyond baseline (currently 5 errors, 19 warnings)
- [ ] `cargo check` — no new errors
- [ ] No visual regressions (styles still load)
- [ ] Backup checkpoint commit before each extraction phase