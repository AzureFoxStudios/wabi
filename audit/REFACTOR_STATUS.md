# Refactor Status — Block A-D Local Work (ironin/Iyoku machine)

## Blocks Completed Elsewhere
- E, I (Phases 1-4), J, K done on Iyoku — deployed to VPS ironin@100.80.172.12

## Blocks In Progress (this machine)

### Block A: Composer & chat-level deduplication
- A1 Chat.svelte user lookup imports: DONE (verified from $lib/socket store)
- A2 Extract search logic: DONE → chatSearch.ts (~90 lines removed from Chat.svelte)
- A3 Extract composer commands: STUB CREATED chatCommands.ts (needs full implementation)
- A4 Extract composer component: PENDING (deeply coupled to 20+ local vars — better as deliberate design)
- A5 Extract message input component: PENDING (same coupling issue)

### Block B: MessageList deduplication
- B2 Remove dead Maps/functions, wire store helpers: DONE (~70 lines removed)
- B3 Dedup PinnedMessagesModal.svelte: PENDING
- B4-B6 Extract message subcomponents: PENDING (renderer, reactions, attachments)
- B7 Style welcome empty state CSS: PENDING
- B8 Migrate inline status colors to status-system.css: PENDING

## Structural Debt Discovered

### socket-manager.ts re-export layer (Iyoku Block I)
- socket.ts tries to re-export ~15 symbols from socket-manager.ts that were lost during split:
  sendMessage, retryDecryptLoadedDmMessages, loadOlderMessages, updateProfile,
  createDM, deleteDM, getDMChannelIdForUser, uploadEmote, deleteEmote,
  uploadEmoji, deleteEmoji, dmPanelSignal, syncProgress
- These never got migrated into messageStore / presenceStore / channelStore / typingStore / socketConnection
- socket-manager.ts is now only 148 lines of re-exports — needs the missing functions added or socket.ts must be updated

### api/*.ts import paths (Iyoku Block I)
- Fixed: all api/*.ts files had wrong depth (../../../ → ../../../../) and .js → .ts extension
- 7 files patched: admin.ts, albums.ts, auth.ts, config.ts, dictionary.ts, paymentCheckout.ts, paymentHistory.ts, paymentDonations.ts

### calling.ts re-export layer (Iyoku Block K)
- calling.ts is still 3810 lines (NOT reduced to 218-line re-export layer as claimed)
- New modules callingTypes.ts, callingStateStores.ts, audioCapture.ts, audioMonitoring.ts, livekitToken.ts, calling_impl.ts exist but calling.ts doesn't import from them
- Need: rewrite calling.ts as re-export layer OR sync actual file from Iyoku

## Files Touched This Session
- frontend/src/lib/chatSearch.ts (NEW)
- frontend/src/lib/chatCommands.ts (NEW stub)
- frontend/src/lib/components/Chat.svelte (search removed)
- frontend/src/lib/components/MessageList.svelte (dead Maps/functions removed)
- frontend/src/lib/userLookupStore.ts (getReactionUsername added)
- frontend/src/lib/api/*.ts (import paths fixed)

## Next Steps
1. Grab working calling.ts re-export layer from Iyoku (or reconstruct here)
2. Fix missing socket-manager re-exports
3. Resume B3-B8
