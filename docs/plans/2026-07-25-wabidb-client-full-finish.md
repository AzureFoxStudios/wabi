# WabiDB Client v1 — Full Finish Plan (retire sqlite stub + complete offline queue wiring)

**Status:** planned, ready to delegate to OpenCode (deepseek-v4-flash-free)
**Author:** Hermes (review of commits e75fac5 + a836cac)
**Preceding work:** Option 3 already wired `sendMessage` through the queue. This pass completes the client by:
1. Retiring the dead SQLite backend stub (it's never selected, adds no value, and confuses the architecture)
2. Wiring every remaining `sock.emit()` call site through the queue when offline

---

## Load-bearing facts (verified)

### SQLite stub is already dead
- `frontend/src/lib/wabidb/backend/detect.ts` always returns `'indexeddb'`
- `SQLiteBackend` class exists in `backend/sqlite.ts` but is never imported anywhere
- `BackendKind = 'indexeddb' | 'sqlite'` in types.ts can be simplified to just `'indexeddb'` (or keep both for future v2 Tauri SQLite)
- The stub throws "not yet implemented in v1" on every method — it serves no runtime purpose

### Emit call sites that need offline handling (18 total, `sendMessage` already done)
From grep analysis, the following emit calls are NOT yet wired:

| Location | Event | Current behavior | Needs queue? |
|----------|-------|------------------|--------------|
| `messageStore.ts:89` | `mark-messages-as-read` | drops if offline | NO (read-only op, no server ack needed) |
| `messageStore.ts:102` | `mark-channel-as-read` | drops if offline | NO (read-only) |
| `messageStore.ts:110` | `retry-message` | drops if offline | NO (internal, server-side) |
| `messageStore.ts:159` | `edit-message` | drops if offline | **YES** |
| `messageStore.ts:187` | `delete-message` | drops if offline | **YES** |
| `messageStore.ts:193` | `toggle-pin-message` | drops if offline | **YES** |
| `messageReactions.ts:15` | `add-emoji-reaction` | drops if offline | **YES** |
| `messageReactions.ts:21` | `remove-emoji-reaction` | drops if offline | **YES** |
| `presenceStore.ts:85` | `voice-channel-subscribe` | drops if offline | **YES** |
| `presenceStore.ts:91` | `voice-channel-leave` | drops if offline | **YES** |
| `presenceStore.ts:97` | `set-voice-transmit-mode` | drops if offline | **YES** |
| `presenceStore.ts:115` | `assign-role` | drops if offline | **YES** |
| `presenceStore.ts:123` | `remove-role` | drops if offline | **YES** |
| `presenceStore.ts:135` | `ban-user` | drops if offline | **YES** |
| `presenceStore.ts:145` | `create-group` | drops if offline | **YES** |
| `presenceStore.ts:151` | `leave-group` | drops if offline | **YES** |
| `presenceStore.ts:157` | `kick-group-member` | drops if offline | **YES** |
| `presenceStore.ts:163` | `add-group-member` | drops if offline | **YES** |
| `presenceStore.ts:169` | `update-group-avatar` | drops if offline | **YES** |
| `channelStore.ts:144` | `pin-channel` | drops if offline | **YES** |
| `channelStore.ts:150` | `unpin-channel` | drops if offline | **YES** |
| `socket.ts:66` | `update-profile` | drops if offline | **YES** |
| `socket.ts:78` | `delete-dm` | drops if offline | **YES** |
| `StatusPopup.svelte:14` | `update-profile` | drops if offline | **YES** |
| `ForwardDialog.svelte:13` | `message` | drops if offline | **YES** |
| `ShareToChannelModal.svelte:12` | `message` | drops if offline | **YES** |
| `LiveChannelView.svelte:157` | `message` | drops if offline | **YES** |
| `AdminWorkspace.svelte:334` | `delete-emoji-role-rule` | drops if offline | **YES** |
| `EmojiSettingsTab.svelte:110` | `delete-emoji` | drops if offline | **YES** |
| `ChannelSettingsModal.svelte:38` | `clear-channel-messages` | drops if offline | **YES** |
| `UsernameFontCustomizer.svelte:80` | `update-profile` | drops if offline | **YES** |
| `messagePagination.ts:85` | `load-history` | drops if offline | **NO** (fetch, not write) |
| `messagePagination.ts:101` | `sync-newer` | drops if offline | **NO** (fetch, not write) |

### Queue action types needed
Current `QueuedAction.type` is a generic string. For v1, we need these action types:
- `send-message` (exists)
- `edit-message`
- `delete-message`
- `toggle-pin-message`
- `add-reaction`
- `remove-reaction`
- `voice-channel-subscribe`
- `voice-channel-leave`
- `set-voice-transmit-mode`
- `assign-role`
- `remove-role`
- `ban-user`
- `create-group`
- `leave-group`
- `kick-group-member`
- `add-group-member`
- `update-group-avatar`
- `pin-channel`
- `unpin-channel`
- `update-profile`
- `delete-dm`
- `message` (for ForwardDialog/ShareToChannelModal/LiveChannelView)
- `delete-emoji`
- `delete-emoji-role-rule`
- `clear-channel-messages`

Each needs a `payload` that contains everything needed to re-emit. For `sock.emit(event, payload)`, the payload is exactly the object we need to store.

### Server-side behavior
Most of these events have server-side handlers that:
- Acknowledge via `message-accepted` (for message types) or implicit success
- Some have explicit error events (`edit-error`, `delete-error`, etc.)
- The queue should drain in order; on error, stop and retry later (existing `try/catch` in drain.ts)

---

## DESIGN

### Phase 1: Retire SQLite stub (safe, no behavior change)
1. Remove `frontend/src/lib/wabidb/backend/sqlite.ts` entirely.
2. Update `frontend/src/lib/wabidb/types.ts`: change `BackendKind = 'indexeddb' | 'sqlite'` to `BackendKind = 'indexeddb'` (or remove if unused).
3. Delete `frontend/src/lib/wabidb/backend/index.ts` exports for SQLite if any.
4. Update `detect.ts` to just `export function detectBackend(): 'indexeddb' { return 'indexeddb'; }` (already there).

### Phase 2: Add action type constants + generic enqueue helper
Create a new file `frontend/src/lib/wabidb/actions.ts` (or add to `types.ts`):
```typescript
export const QUEUE_ACTION = {
  SEND_MESSAGE: 'send-message',
  EDIT_MESSAGE: 'edit-message',
  DELETE_MESSAGE: 'delete-message',
  TOGGLE_PIN: 'toggle-pin-message',
  ADD_REACTION: 'add-reaction',
  REMOVE_REACTION: 'remove-reaction',
  // ... etc
} as const;
export type QueueAction = (typeof QUEUE_ACTION)[keyof typeof QUEUE_ACTION];
```

### Phase 3: Wire each emit site
For each emit site that needs offline handling:
1. Import `getWabiDB` from `$lib/wabidb` and `connected` from `$lib/socket` (or existing store).
2. Wrap the emit in: `const db = getWabiDB(); if (db && !get(connected)) { await db.enqueue({ scopeId: 'corechat', type: '<action-type>', payload: { ...theEmitArgs } }); return; }`
3. For message edits/deletes/pins, also update the optimistic UI state (e.g., set `deliveryState: 'failed'` with `deliveryError: 'Queued — will send when online'`).

### Phase 4: Update drainOutboundQueue
Extend `drain.ts` to handle all action types, not just `'send-message'`:
```typescript
for (const action of pending) {
  if (action.type === 'send-message') sock.emit('message', action.payload);
  else if (action.type === 'edit-message') sock.emit('edit-message', action.payload);
  // ... etc
  await db.markSynced(action.id);
}
```
Or use a dispatch table: `const handlers = { 'send-message': 'message', 'edit-message': 'edit-message', ... }` and `sock.emit(handlers[action.type], action.payload)`.

### Phase 5: message-accepted reconciliation
The existing `'message-accepted'` handler reconciles send-message. For other action types, the server may have different ack events (`edit-accepted`, `delete-accepted`, `reaction-added`, etc.). For v1, we can be conservative: only call `markSyncedByClientId` on `'message-accepted'`; other acks can leave the record pending and it will retry on next drain. This is safe but may cause duplicate acks if the server is idempotent (it should be).

---

## SCOPE GUARDS (strict)
ALLOWED:
- frontend/src/lib/wabidb/backend/sqlite.ts (DELETE)
- frontend/src/lib/wabidb/types.ts (remove sqlite from BackendKind)
- frontend/src/lib/wabidb/actions.ts (NEW — action type constants)
- frontend/src/lib/wabidb/drain.ts (extend for all action types)
- All messageStore.ts, presenceStore.ts, channelStore.ts, messageReactions.ts, socket.ts
- All component files with emit calls (ForwardDialog, ShareToChannelModal, LiveChannelView, StatusPopup, AdminWorkspace, EmojiSettingsTab, ChannelSettingsModal, UsernameFontCustomizer)
FORBIDDEN:
- Server Rust, docker, vite.config.ts
- Any file NOT listed above (the ~49 unrelated dirty files)
- Creating new scopes (Media/Maps/Knowledge) — that's v2/v3
- Encryption-at-rest, FTS, blob support

DO NOT COMMIT. Leave in working tree for review.

---

## VERIFICATION
1. `npm run check` — baseline 2 pre-existing errors, 90 warnings. No new errors.
2. Grep confirms every emit site either drops (read-only) or enqueues (write).
3. `npm run build` succeeds (no dead code from deleted sqlite.ts).
4. Runtime: offline → send/edit/delete/reaction → go online → verify queue drains and UI reconciles.

---

## FILES TO MODIFY (estimated ~12 files)
- DELETE: `frontend/src/lib/wabidb/backend/sqlite.ts`
- MODIFY: `types.ts`, `drain.ts`, `actions.ts` (new), `messageStore.ts`, `presenceStore.ts`, `channelStore.ts`, `messageReactions.ts`, `socket.ts`, `ForwardDialog.svelte`, `ShareToChannelModal.svelte`, `LiveChannelView.svelte`, `StatusPopup.svelte`, `AdminWorkspace.svelte`, `EmojiSettingsTab.svelte`, `ChannelSettingsModal.svelte`, `UsernameFontCustomizer.svelte`
- CREATE: `actions.ts`

Total: ~16 files, ~500-800 lines of changes.
