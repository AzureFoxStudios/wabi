---
name: wabidb-client-offline
description: "Client-side WabiDB offline persistence layer (frontend/src/lib/wabidb): outbound queue, scope registry, ALL emit sites wired for offline, SQLite stub retired. Use when touching the frontend WabiDB client, StorageSettings Offline & Storage UI, or any outbound action path."
version: 1.1.0
author: Hermes
platforms: [linux, macos, windows, web]
metadata:
  hermes:
    tags: [WabiDB, Frontend, Offline, IndexedDB, SvelteKit, Queue]
---

# WabiDB Client Offline Layer

The client-side WabiDB abstraction lives in `frontend/src/lib/wabidb/`. It is a v1
client-only surface (web uses IndexedDB only; SQLite stub has been retired). It provides
offline scopes, a comprehensive outbound action queue, and a settings UI. This skill
documents the verified state as of 2026-07-25 (after commits `e75fac5`, `a836cac`, `310a359`).

## When to Use

- Editing anything under `frontend/src/lib/wabidb/`
- Wiring a new outbound action through the offline queue
- Building/debugging the "Offline & Storage" screen in `StorageSettings.svelte`
- Any "queued action silently never sends" or "queue throws DataError" bug report

## File Map (verified present)

| File | Purpose |
|------|---------|
| `types.ts` | `WabiDB` interface, `OfflineScopeDescriptor`, `QueuedAction`, `QueueFilter`, `ScopeStatus`, `StorageReport` |
| `index.ts` | `WabiDBImpl` singleton + `openWabiDB()` / `getWabiDB()` factory |
| `scopes/registry.ts` | Scope registration, enable/disable, CoreChat + System bootstrap (localStorage-backed) |
| `scopes/corechat.ts`, `scopes/system.ts` | Scope descriptors (CoreChat opt-in; System always-on) |
| `queue/manager.ts` | `QueueManager` — enqueue/listQueue/markSynced/retryFailed + `markSyncedByClientId` |
| `queue/db.ts` | `QueueDB` — dedicated `outbound_queue` IndexedDB store (`wabi-queue` DB) |
| `backend/detect.ts` | Always returns `'indexeddb'` in v1 |
| `backend/sqlite.ts` | **DELETED** — was a dead stub (never selected, all methods threw) |
| `migration/legacy.ts` | Empty scaffold |
| `drain.ts` | `drainOutboundQueue()` — replays ALL pending actions on reconnect |
| `actions.ts` | `DRY_RUN`, `SEND_MESSAGE`, `EDIT_MESSAGE`, `DELETE_MESSAGE`, etc. (25 action type constants) |

## Completed Work (commits)

| Commit | What |
|--------|------|
| `e75fac5` | Fix keyPath bug, enforce 10k cap, build Offline & Storage UI |
| `a836cac` | Wire `sendMessage` through the queue (offline enqueue + drain) |
| `310a359` | **Full finish**: retire SQLite stub, wire ALL remaining emit sites (edit, delete, pin, reaction, profile, role, group, emoji, DM, channel) through the queue |

## Lifecycle & Wiring (verified)

- `+layout.svelte` `onMount`: `await openWabiDB()`; at boot and on window `'online'`,
  calls `db.retryFailed()` then `drainOutboundQueue()`. Removes the listener onDestroy.
- `StorageSettings.svelte`: renders the "Offline & Storage" section — scope list
  (always/opt-in/off badges + enable/disable), queue pending/failed/synced counts,
  Retry button, usage row. Uses `offline.*` i18n keys (en + es).
- `socketConnectionCore.ts`:
  - `'connect'` handler fires `drainOutboundQueue()` (fire-and-forget)
  - `'message-accepted'` handler calls `db.markSyncedByClientId(payload.clientMessageId)`
- `messageStore.ts` `sendMessage()`: if offline, enqueues and marks optimistic message
  `failed` with `deliveryError: 'Queued — will send when online'`. Returns without emitting.
- **All other emit sites now wired similarly** (presenceStore, channelStore, messageReactions,
  socket.ts, and 6 component files).

## Outbound Queue Action Types (25 total)

From `actions.ts`:
- `SEND_MESSAGE`, `EDIT_MESSAGE`, `DELETE_MESSAGE`, `TOGGLE_PIN`
- `ADD_REACTION`, `REMOVE_REACTION`
- `VOICE_CHANNEL_SUBSCRIBE`, `VOICE_CHANNEL_LEAVE`, `SET_VOICE_TRANSMIT_MODE`
- `ASSIGN_ROLE`, `REMOVE_ROLE`, `BAN_USER`
- `CREATE_GROUP`, `LEAVE_GROUP`, `KICK_GROUP_MEMBER`, `ADD_GROUP_MEMBER`, `UPDATE_GROUP_AVATAR`
- `PIN_CHANNEL`, `UNPIN_CHANNEL`
- `UPDATE_PROFILE`, `DELETE_DM`
- `MESSAGE` (for ForwardDialog/ShareToChannelModal/LiveChannelView)
- `DELETE_EMOJI`, `DELETE_EMOJI_ROLE_RULE`, `CLEAR_CHANNEL_MESSAGES`
- `DRY_RUN` (internal)

## Outbound Queue Data Model

`QueuedAction = { id, type, scopeId, status: 'pending'|'synced'|'failed', createdAt, payload, retriedAt?, error? }`.
The record persists to IndexedDB with an explicit `key: \`${scopeId}:${id}\`` field
(CRITICAL — see pitfalls). `payload` for each action type contains exactly what's needed to
re-emit (e.g., `send-message` → `{ channelId, text, type, clientMessageId, ...options }`).

## Pitfalls (load-bearing — costs real debugging time)

### 1. IndexedDB keyPath MUST match a real record field (BIT US)
`queue/db.ts` creates the store `{ keyPath: 'key' }`. IndexedDB then IGNORES the
explicit key passed to `store.put(value, key)` and instead reads `value.key`.
If the record has no `key` field, every `put()` throws `DataError`. The fix
(committed in `e75fac5`): `QueueManager._serialize()` stamps `key: \`${scopeId}:${id}\`` onto
the record. If you ever add a new queued-action type, ensure its serialized record carries `key`.

### 2. MAX_QUEUE_SIZE (10k) is enforced by count, not just age (BIT US)
`enqueue()` prunes by AGE (30d, `MAX_QUEUE_AGE_MS`) then, if still over the cap,
calls `QueueDB.trimToSize(MAX_QUEUE_SIZE - 1)` which deletes the oldest records by
`createdAt` (FIFO). Without this, >10k recent items would bypass the cap. Do not
"optimize" by removing trimToSize — it is the only real bound.

### 3. markSyncedByClientId is on the concrete class, NOT the WabiDB interface
`WabiDBImpl.markSyncedByClientId()` exists; the `WabiDB` interface does NOT declare it.
This is deliberate: adding it to the interface would force edits to the (deleted) SQLite stub.
Callers use `getWabiDB()` which returns `WabiDBImpl | null`, so the method is accessible.

## Verification

- `npm run check`: 2 pre-existing errors (VoiceChannelList 'announcement', LoreChannel string|number), 90 warnings — no new errors
- SQLite stub deleted: `ls frontend/src/lib/wabidb/backend/` shows only `detect.ts`, `index.ts`
- All emit sites now have offline handling: grep for `sock.emit` or `socket.emit` returns only read-only fetches (mark-as-read, load-history) or wired emit blocks

## Related

- `wabidb-core-capabilities` — server-side engine (event store, projections, sequencer)
- Plan docs: `docs/plans/2026-07-25-wabidb-client-finish.md`, `docs/plans/2026-07-25-wabidb-client-send-offline.md`, `docs/plans/2026-07-25-wabidb-client-full-finish.md`