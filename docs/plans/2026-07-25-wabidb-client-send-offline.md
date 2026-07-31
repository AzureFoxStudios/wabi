# WabiDB Client v1 — Option 3: Real offline send-message enqueue + drain

**Goal:** Make the outbound queue actually used by the primary write path. When the socket
is offline, `sendMessage()` must enqueue the action locally (with optimistic UI + `failed`
state shown) instead of silently dropping it; when connectivity returns, the queue drains
in order by replaying `sock.emit('message', ...)`; each accepted message marks its queue
record `synced` so it never replays twice.

This is the first REAL caller of the queue we built + fixed in the prior commit (e75fac5).
Everything else (scopes UI, retry button) already exists.

---

## Load-bearing facts (verified by reading source)

- `frontend/src/lib/messageStore.ts`
  - `sendMessage(channelId, content, type, options)` at line 112. Builds an optimistic
    `Message` with `deliveryState: 'sending'` (line 136) and `clientMessageId` (line 124),
    calls `appendOptimisticMessage(channelId, optimisticMessage)` (line 140), then
    `sock.emit('message', { channelId, text, type, clientMessageId, ...options })` (line 141).
  - It early-returns if `!sock` (line 119). We must NOT lose the message when `sock` exists
    but is disconnected.
  - `_updateOptimisticMessage` exists (used by message-accepted) — keep using it.
- `frontend/src/lib/socketConnectionCore.ts`
  - `connected` writable store is set `true` on `'connect'` (line 366 / 114) and `false` on
    disconnect (line 353). It is re-exported via socket-manager → socket.ts as `connected`.
  - `'message-accepted'` handler (line 572) matches by `clientMessageId` and clears
    `deliveryState`/`deliveryError`. KEY: this is where we call `markSynced(actionId)` for
    the corresponding queued action.
- `frontend/src/lib/wabidb/index.ts` exposes `getWabiDB()` returning `WabiDBImpl | null`.
  Queue API: `enqueue(action)`, `listQueue(filter?)`, `markSynced(actionId)`, `retryFailed()`.
  A `QueuedAction` needs `{ scopeId, type, payload }` (id/status/createdAt added by enqueue).
- `frontend/src/routes/+layout.svelte` already calls `db.retryFailed()` on the window
  `'online'` event and at boot. `retryFailed()` flips `failed`→`pending`. We will ALSO add a
  replay step. Keep +layout as-is for the `online` trigger, but the replay loop itself should
  live in a shared module so both `+layout` boot and the socket `'connect'` event can call it.

---

## DESIGN (minimal, correct)

### 1. New module: `frontend/src/lib/wabidb/drain.ts`
Export `async function drainOutboundQueue(): Promise<void>`:
- `const db = getWabiDB(); if (!db) return;`
- `const sock = getSocket(); if (!sock || !get(connected)) return;` (guard: only drain when
  actually connected — `connected` store from `$lib/socket` or socket-manager).
- `const pending = (await db.listQueue({ status: 'pending' })).sort((a,b)=>a.createdAt-b.createdAt);`
- For each action: if `action.type === 'send-message'`, replay
  `sock.emit('message', action.payload)` (payload is exactly the object we queued). After a
  successful emit, `await db.markSynced(action.id)`. (Optimistic message already in UI; the
  server `message-accepted` will reconcile deliveryState.)
- Wrap in try/catch; on emit failure, leave status pending (will retry next drain). Keep it
  simple — no parallel fan-out, sequential replay preserves order (per proposal's "drain in order").

### 2. `sendMessage` (messageStore.ts) enqueue when offline
- After building `optimisticMessage`, BEFORE/instead of dropping: check connectivity.
- Get `const db = getWabiDB();` and `const online = get(connected);`
- If `db` exists AND `!online` (or `!sock`):
  - `await db.enqueue({ scopeId: 'corechat', type: 'send-message', payload: { channelId, text: trimmed, type, clientMessageId, ...options } });`
  - Keep the optimistic message in the UI but set its `deliveryState: 'failed'` (per
    `MessageItemContent.svelte` which renders `is-send-failed` + title on `failed`) so the
    user sees it's queued/unsent. Actually use a distinct visual cue: we can keep 'sending'
    but that implies in-flight. Better: set `deliveryState: 'failed'` with
    `deliveryError: 'Queued — will send when online'` so it shows as failed-but-recoverable.
    (MessageItemContent shows title=deliveryError on failed — good UX.)
  - Do NOT call `sock.emit` (we're offline).
  - Return early (skip emit).
- If online: existing behavior (emit immediately). No queue involved.

### 3. markSynced on accept
- In `socketConnectionCore.ts` `'message-accepted'` handler (line 572), after the existing
  `_updateOptimisticMessage(...)`, optionally call:
  `const db = getWabiDB(); if (db && payload.clientMessageId) { await db.markSyncedByClientId?.(...) }`
  PROBLEM: the queue record id is a UUID we generated at enqueue, NOT the clientMessageId.
  So we need to find the queued action by `clientMessageId` stored in payload. Options:
  - (a) Simpler: store `clientMessageId` inside the queue `payload` (we already do — payload
    includes clientMessageId), and on accept, `listQueue({status:'pending'})` then match
    `action.payload.clientMessageId === payload.clientMessageId` → `markSynced(action.id)`.
    Since clientMessageId is unique per message, this is safe.
  - Add a small helper in `WabiDBImpl`/`QueueManager`: `markSyncedByClientId(channelId, clientMessageId)`.
    Recommended: add `async markSyncedByClientId(clientMessageId: string)` to QueueManager that
    scans pending and matches `payload.clientMessageId`. Expose via `WabiDB` interface + index.ts.
- Only attempt this when `db` exists. Guard with try/catch so accept path never breaks if
  queue isn't initialized.

### 4. Wire drain to reconnect
- In `socketConnectionCore.ts` `'connect'` handler (line 366), after existing logic, call
  `drainOutboundQueue()` (fire-and-forget, no await blocking connect). Import it from
  `$lib/wabidb/drain`.
- Also keep `+layout.svelte`'s `'online'` → `retryFailed()` AND add `drainOutboundQueue()` so
  both triggers work. (Edit +layout: in the onlineHandler, after `db.retryFailed()`, also
  `void drainOutboundQueue()`.)

---

## SCOPE GUARDS (strict)
ALLOWED:
- frontend/src/lib/messageStore.ts (sendMessage enqueue branch)
- frontend/src/lib/socketConnectionCore.ts (message-accepted markSynced; connect → drain)
- frontend/src/lib/wabidb/index.ts (expose markSyncedByClientId)
- frontend/src/lib/wabidb/queue/manager.ts (add markSyncedByClientId)
- frontend/src/lib/wabidb/types.ts (QueuedAction already has payload:unknown — enough; no change needed unless you add a type union)
- frontend/src/lib/wabidb/drain.ts (NEW file)
- frontend/src/routes/+layout.svelte (add drain to onlineHandler — ONLY that one line)
FORBIDDEN: server Rust, docker, vite, all other ~49 dirty files, StorageSettings (already done),
backend/sqlite.ts, migration/legacy.ts, other send paths (ForwardDialog/ShareToChannelModal/
LiveChannelView) — those can follow later; keep this pass to the core `sendMessage` only.
DO NOT commit. Leave in working tree for review.
DO NOT implement encryption-at-rest, blobs, FTS, Media/Maps/Knowledge (v2/v3).

## VERIFICATION (Hermes runs after)
1. `cd /home/Ronin/wabi/frontend && npm run check` — no NEW errors vs baseline (2 pre-existing:
   VoiceChannelList 'announcement', LoreChannel string|number; 90 warnings).
2. grep: sendMessage references `getWabiDB`/`enqueue`; socketConnectionCore references
   `drainOutboundQueue` and `markSyncedByClientId`; +layout references `drainOutboundQueue`.
3. Confirm QueueManager.markSyncedByClientId matches on `payload.clientMessageId`.
4. Runtime proof (Ronin's real browser): go offline (devtools → offline), send a message →
   it appears with failed/queued state and a queue record exists (Inspector → Application →
   IndexedDB → wabi-queue → outbound_queue has 1 pending). Go back online → within a moment
   the message flips to sent (message-accepted) and the queue record becomes synced (0 pending).
