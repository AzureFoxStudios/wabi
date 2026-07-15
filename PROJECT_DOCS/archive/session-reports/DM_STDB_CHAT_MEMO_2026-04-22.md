# DM And STDB Chat Memo

Date: 2026-04-22 UTC
Worktree: `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi`

## What Was Done In This Chat

### 1. Audited and expanded the DM system

- Audited the DM send path, offline delivery path, and DM creation UI.
- Confirmed the original problem: offline registered users were not reliably receiving queued DM/group messages on reconnect.
- Confirmed the frontend DM picker only exposed online users even though offline members were already present in state.

### 2. Implemented offline DM and group delivery for offline registered users

Backend changes:

- Offline queue entries now store the full serialized client message payload instead of a lossy text/file subset.
- Message send side effects now queue DM/group messages for offline registered recipients.
- Offline replay now restores the real message shape on reconnect, including message IDs and richer payload data.

Primary files:

- `backend/src/server.ts`
- `backend/src/services/offlineMessageDelivery.ts`
- `backend/src/services/offlineMessageDelivery.test.ts`
- `backend/src/db/repositories/offlineMessageRepository.ts`
- `backend/src/db/schema.sql`
- `backend/src/db/database.ts`

### 3. Made DM creation surfaces offline-aware

Frontend changes:

- Added a shared DM user directory utility that merges online users and offline server members.
- Updated DM tab, create-DM modal, create-group modal, and `/dm` command lookup to use the merged directory.

Primary files:

- `frontend/src/lib/dmUserDirectory.ts`
- `frontend/src/lib/components/DMTab.svelte`
- `frontend/src/lib/components/CreateDMModal.svelte`
- `frontend/src/lib/components/CreateGroupModal.svelte`
- `frontend/src/lib/components/Chat.svelte`

### 4. Audited DM encryption and storage architecture

Findings captured during the chat:

- HTTPS and DM E2EE solve different problems.
- `open` disables DM E2EE.
- `sealed` and `private` currently follow the same encrypted send path in practice.
- Keeping E2EE for third-party self-hosters is reasonable.
- Any future toggle should be framed as an install-time simplicity choice, not a performance fix.

### 5. Removed several legacy embedded DB-backed shadow paths and switched them to STDB-only

Converted these repositories from legacy-first or mirror-write behavior to STDB-only:

- user settings
- theme preferences
- app policy
- user encryption keys
- dictionary entries
- relays

Behavior change:

- These paths now read and write STDB directly.
- Their runtime helpers now fail loudly if STDB is unavailable instead of silently falling back to legacy embedded DB.

Primary files:

- `backend/src/db/repositories/settingsRepository.ts`
- `backend/src/db/repositories/themeRepository.ts`
- `backend/src/db/repositories/appPolicyRepository.ts`
- `backend/src/db/repositories/encryptionKeyRepository.ts`
- `backend/src/db/repositories/dictionaryRepository.ts`
- `backend/src/db/repositories/relayRepository.ts`
- `backend/src/db/repositories/stdbPreferenceRuntime.ts`
- `backend/src/db/repositories/stdbAppPolicyRuntime.ts`
- `backend/src/db/repositories/stdbEncryptionRuntime.ts`
- `backend/src/db/repositories/stdbDictionaryRuntime.ts`
- `backend/src/db/repositories/stdbRelayRuntime.ts`

### 6. Removed obsolete legacy embedded DB schema definitions for STDB-migrated support stores

Removed legacy embedded DB schema blocks for:

- `user_settings`
- `app_settings`
- `theme_preferences`
- `user_encryption_keys`
- `dictionary_entries`
- `relays`

Primary file:

- `backend/src/db/schema.sql`

### 7. Verification completed

Earlier DM/offline delivery pass:

- `npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend test`
- `npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend run build`
- `npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend run check`

After the STDB-only repository cutover:

- `npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend run build`
- `npm --prefix /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/backend test`

## What Is Still Left To Do

### 1. Remove the legacy embedded DB offline DM queue

This is still the main legacy embedded DB dependency for the DM work itself.

Current remaining files:

- `backend/src/db/repositories/offlineMessageRepository.ts`
- `backend/src/db/schema.sql` (`offline_messages`)
- `backend/src/db/database.ts` (`offline_messages` migration)
- `backend/src/server.ts` admin/debug stats still count `offline_messages`

Recommended direction:

- Replace the separate `offline_messages` queue with STDB-backed missed-message catch-up from persisted message history.
- Use a cursor or last-seen model instead of maintaining a second delivery store in legacy embedded DB.

### 2. Finish whiteboard migration before removing legacy embedded DB whiteboard code

Whiteboards are not actually ready for STDB-only yet.

Current issue:

- The backend has a whiteboard STDB wrapper, but the bridge/runtime still behaves as legacy embedded DB fallback.
- The whiteboard repository still reads and writes legacy embedded DB.
- Whiteboard legacy embedded DB schema and migrations are still active.

Current remaining files:

- `backend/src/db/repositories/whiteboardRepository.ts`
- `backend/src/db/repositories/stdbWhiteboardRuntime.ts`
- `backend/src/db/schema.sql`
- `backend/src/db/database.ts`
- `spacetimedb/wabi_state_bridge/src/lib.rs` still needs real whiteboard state table and reducers

### 3. Finish payments STDB migration

Payments still advertise legacy embedded DB fallback behavior and were intentionally left out of this pass.

Current remaining file to start from:

- `backend/src/payments/stdbRuntime.ts`

This likely needs a broader migration review rather than another small shadow-write removal.

### 4. Do a final legacy embedded DB residue sweep after the above

Once offline DM queue, whiteboards, and payments are migrated:

- remove any leftover legacy embedded DB-only schema blocks tied to those features
- remove any leftover legacy embedded DB debug/admin reads that assume those tables still exist
- rerun backend build/tests and frontend check

## Recommended Next Step

The next highest-value task is:

1. Replace `offline_messages` with STDB-backed DM catch-up.

That finishes the DM/offline part of this chat and removes the last legacy embedded DB dependency directly tied to DMs.
