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

### TASK BLOCK G: FRONTEND POLISH — WHITEBOARD REVIVAL
- [x] G1: Token-sweep WhiteboardToolbar.svelte `<style>` (7 hardcoded colors, 1 typo)
- [x] G2: Token-sweep WhiteboardTab.svelte `<style>` (hardcoded beige/blue + old pattern)
- [x] G3: Token-sweep WhiteboardCanvas.css (hardcoded warm bg + blues + old pattern)
- [x] G4: Token-sweep WhiteboardLayerPanel.svelte `<style>` (old rgba pattern → color-mix)
- [x] G5: Add mobile breakpoints to whiteboard shell
- [x] G6: Add empty state when no channel selected
- [x] G7: Fix WhiteboardToolbar.svelte:276 typo (`#fff)ef9` → proper token)
- [x] G8: Run `bun run check` — verify 0 errors

### TASK BLOCK H: TOKEN SYSTEM HARDENING
- [x] H1: Fix `tokens.css` self-referential vars (~30 lines `var(X, var(X, fallback))` → `var(X, fallback)`)
- [ ] H1b: **REGRESSION** — H1 replaceAll left dangling `)` on ~35 lines (`var(--X, #hex));` should be `var(--X, #hex);`). Fix + fix 3 missed self-refs (L81-83).
- [x] H2: Add `*-rgb` vars to `themeManager.ts` SEMANTIC_MAP so rgb values track active theme
- [x] H3: Fix `todo-list.css` bare `#ef4444` hex leaks (lines 220, 307)
- [ ] H4: Optionally audit `#5865f2` Discord blurple fallbacks across 6 CSS files (low priority — fallbacks only)
- [x] H5: Run `bun run check` — verify 0 errors, no new warnings

### TASK BLOCK I: GENERAL POLISH
- [x] I1: Mobile accessibility pass — touch targets ≥44px, safe-area insets
- [x] I2: Continuation message hover spacing — `ml-core.css` hover bg needs vertical room
- [x] I3: Emoji picker — fix unbounded scaling at narrow widths
- [x] I4: Run `bun run check` — verify 0 errors

### TASK BLOCK K: SCOUR HUNT HOT FIXES (from scavenger)
- [x] K1: **CRITICAL** — tokens.css: fix ~35 dangling `))` from H1 regression + 3 missed self-refs (L81-83)
- [x] K2: Fix `sidebar-core-part2.css:27` dangling `1f2` outside var() (same typo class as G7)
- [x] K3: Fix `inputs.css:25` hot-pink accent (`var(--accent, #ff00ff)` → `var(--accent, #6366f1)`)
- [x] K4: Fix `ml-core.css` danger fallback (`#ff1493` → `#ef4444`)
- [x] K5: Token-sweep `call-view.css` — 12+ mismatched fallback hexes, self-refs, & dangling `beb`
- [x] K6: Token-sweep `windowing.css` — wrong color space → Wabi tokens & hexes
- [x] K7: Token-sweep `ModeTabsDrawer.css` — hardcoded dark palette → tokens
- [x] K8: Token-sweep 5 payment modals — bare hex status colors → `var(--color-*)`
- [x] K9: Fix `WhiteboardCanvas.css` surface fallbacks — paper-like bg hex & RGB defaults
- [x] K10: Fix 9 hardcoded z-index values (5000, 9000, 9999, 10000) → `var(--z-*)` tokens
- [x] K11: Fix `PureRefViewer.svelte:6` hardcoded localhost URL → empty string
- [x] K12: Run `bun run check` — 0 errors, 56 warnings (all pre-existing)

### TASK BLOCK L: AMBIENT EFFECTS SYSTEM (see docs/effects-system-architecture.md)
- [ ] L1: Create types.ts — AmbientEffect interface, EffectConfig, AmbientConfig
- [ ] L2: Create registry.ts — global effect registry (register, get, list, remove, load/save)
- [ ] L3: Add `ambient` field to BasePalette in buildTokens.ts, pass through in buildTheme()
- [ ] L4: Add `ambient` to Theme type in themeTypes.ts
- [ ] L5: Assign ambient config per palette in palettes.ts
- [ ] L6: Emit --bg-effect-* CSS vars in themeManager.ts applyTheme()
- [ ] L7: Add --bg-effect-* defaults to tokens.css
- [ ] L8: Upgrade body background in app.html to use --bg-effect-* for CSS glow layer
- [ ] L9: Build built-in/constellations.ts (Canvas 2D)
- [ ] L10: Build built-in/synapse.ts (Canvas 2D)
- [ ] L11: Build AmbientBackground.svelte (canvas host, registry integration, RAF loop)
- [ ] L12: Build EffectsTab.svelte (settings sub-section in Appearance)
- [ ] L13: Wire EffectsTab into Settings.svelte Appearance section
- [ ] L14: Custom effect import flow (file picker → validate → IndexedDB persistence)
- [ ] L15: Run bun run check — 0 regressions

### TASK BLOCK M: OFFLINE-FIRST / BOOT SURVIVAL (see docs/offline-first-architecture.md)
- [ ] M1: Add `wabi_has_logged_in` flag in Login.svelte (set on success)
- [ ] M2: Add retry/reconnect state + "Work Offline" button to boot shell in app.html
- [ ] M3: Modify auth check in +page.svelte — if hasLoggedInBefore && !hasSession → reconnect mode
- [ ] M4: Add retry logic (setInterval + window 'online' event listener)
- [ ] M5: Enter offline mode on "Work Offline" — dismiss boot shell, show MainLayout
- [ ] M6: Show offline banner in MainLayout when isOffline
- [ ] M7: Clear flag on explicit logout in Settings.svelte
- [ ] M8: Run bun run check — 0 regressions
