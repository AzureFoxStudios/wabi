# Wabi Refactoring Master Plan

Generated: 2026-05-12
Maintainer: Hermes Agent
Last updated: see git log

## Active Blocks (Being worked elsewhere)

### TASK BLOCK E: CALLING / VOICE EXTRACTIONS
- [ ] E1: Split calling.ts into callSignaling.ts
- [ ] E2: Split calling.ts into callMedia.ts
- [ ] E3: Split calling.ts into callState.ts
- [ ] E4: Split calling.ts into callActions.ts
- [ ] E5: Extract CallParticipantGrid.svelte from CallModal.svelte
- [ ] E6: Extract CallParticipantTile.svelte
- [ ] E7: Extract CallControls.svelte from CallModal
- [ ] E8: Extract CallScreenShareView.svelte
- [ ] E9: Extract CallPictureInPicture.svelte
- [ ] E10: Extract CallRecordingPanel.svelte from callRecording.ts

### TASK BLOCK I: TYPESCRIPT MODULE SPLITS
- [ ] I1: Split socket-manager.ts into socketConnection.ts
- [ ] I2: Split socket-manager.ts into channelStore.ts
- [ ] I3: Split socket-manager.ts into messageStore.ts
- [ ] I4: Split socket-manager.ts into typingStore.ts
- [ ] I5: Split socket-manager.ts into presenceStore.ts
- [ ] I6: Split api.ts into api/channels.ts
- [ ] I7: Split api.ts into api/messages.ts
- [ ] I8: Split api.ts into api/users.ts
- [ ] I9: Split api.ts into api/albums.ts
- [ ] I10: Split api.ts into api/payments.ts
- [ ] I11: Split api.ts into api/uploads.ts
- [ ] I12: Split storage.ts into storage/localStorage.ts
- [ ] I13: Split storage.ts into storage/chatStorage.ts
- [ ] I14: Split storage.ts into storage/cache.ts
- [ ] I15: Split placeRegistry.ts into placeSearch.ts and placeMentions.ts

### TASK BLOCK J: BACKEND CLEANUP
- [ ] J1: Extract payment addon types from dead backend/src/plugins/types into shared package
- [ ] J2: Update addons/payments-thailand/backend/src/index.ts to use new shared types
- [ ] J3: Update addons/payments-bitcoin/backend/src/index.ts to use new shared types
- [ ] J4: Update addons/payments-psp/backend/src/index.ts to use new shared types
- [x] J5: Delete /backend directory entirely
- [x] J6: Update root package.json scripts to remove backend references
- [x] J7: Update Docker compose if it references backend
- [x] J8: Verify cargo build -p wabi-server still works
- [x] J9: Verify bun run dev:backend:local still works (it uses cargo)

### TASK BLOCK K: REMAINING CLEANUP
- [ ] K1: Remove unused imports across all extracted components
- [ ] K2: Consolidate duplicate utilities (e.g., formatFileSize appears in multiple files)
- [ ] K3: Add minimal component tests to each extracted component
- [ ] K4: Run full build + type check
- [ ] K5: Deploy to wabi.chat and validate chat/DMs/calls/albums/settings

## Local Blocks (This machine)

### TASK BLOCK A: CHAT COMPONENT EXTRACTIONS / CLEANUP
- [ ] A1: Deduplicate user lookup functions in Chat.svelte (use userLookupStore)
- [ ] A2: Extract ChatInput / MessageComposer from inline Chat.svelte (~500 lines of composer logic)
- [ ] A3: Extract search/filter logic from Chat.svelte
- [ ] A4: Extract command parsing / execution from Chat.svelte
- [ ] A5: Extract payment command handling
- [ ] A6: --

### TASK BLOCK B: MESSAGELIST / MESSAGE SYSTEM CLEANUP
- [x] B1: Create userLookupStore.ts (centralized user lookup)
- [ ] B2: Finish deduplicating MessageList.svelte (remove dead Maps/functions, wire store helpers)
- [ ] B3: Dedup PinnedMessages.svelte (done) + PinnedMessagesModal.svelte (in progress)
- [ ] B4: Extract message rendering subcomponents from MessageList.svelte
- [ ] B5: Extract message reactions into standalone component
- [ ] B6: Extract message attachments / file handling
- [ ] B7: Style welcome empty state CSS (.welcome-empty-state, .welcome-orb, etc.)
- [ ] B8: Migrate inline status colors to status-system.css

### TASK BLOCK C: RIGHT PANEL / DM DECOMPOSITION
- [ ] C1: Extract DirectionsCard from DMMessageView (A2 from audit)
- [ ] C2: Extract DMConversationHeader from DMTab (D2 from audit)
- [ ] C3: Extract ConversationListItem from DMTab (D3 from audit)
- [ ] C4: Inline SVG cleanup (use shared Icon component)
- [ ] C5: Move privacy mode UI into shared sub-component
- [ ] C6: Extract inline composer from DMMessageView
- [ ] C7: --

### TASK BLOCK D: CSS THEME SYSTEM
- [x] D1: CSS token system + derivation engine
- [x] D2: Shared component CSS classes
- [x] D3: Semantic token migration
- [x] D4: Inline style migration to CSS custom properties
- [ ] D5: Status indicator migration (UserPanel, UserPopout, CreateDMModal, CreateGroupModal)
- [ ] D6: Welcome empty state styling

### TASK BLOCK F: DEPLOYMENT / BACKEND WIRING
- [ ] F1: SSH into Iyoku (100.104.166.42) and verify deployment
- [ ] F2: SSH into Tim (100.96.11.45) and verify deployment
- [ ] F3: Validate wabi.chat frontend/backend connectivity
- [ ] F4: Ensure cargo build -p wabi-server works on target machines
- [ ] F5: --

### TASK BLOCK G: TBD
### TASK BLOCK H: TBD
