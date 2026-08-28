# Wabi text message send path (correctness)

## Happy path

1. `ChatComposer.handleSubmit` (Enter without Shift / send button)
2. Guards: empty, cooldown, files→upload branch, edit branch, `/` commands
3. `processOutgoingText` (trim; optional write-uppercase / unicode emoji expand)
4. `sendMessage(channelId, text, type, options)` in `messageStore.ts`
5. Optimistic append with `clientMessageId`, `deliveryState: 'sending'`
6. `sock.emit('message', { channelId, text, type, clientMessageId, …options })`
7. Server `on_message`: persist (unless live), emit `message-accepted`, room-broadcast `message`
8. Client: accept patches id/timestamp + clears deliveryState; `message` merges by **same row** rules below

Wire: `Chat.svelte` must pass `channelId={$currentChannel}` into `ChatComposer`.

## Bugs that make send "feel off" while "technically working"

### 1. Clear draft before send succeeds (critical)

Bad:

```ts
sendMessage(...); // if (!sock) return;  // silent
clearAfterSend(); // always wipes input
```

Good:

```ts
export type SendMessageResult =
  | { ok: true; clientMessageId: string; queuedOffline?: boolean }
  | { ok: false; reason: 'no_socket' | 'empty' | 'no_channel' };

// sendMessage returns SendMessageResult; composer:
const result = await sendMessage(...);
if (!result.ok) { showToast(...); return; } // keep draft + reply + spoiler
clearAfterSend();
```

Apply same discipline to GIF select and post-upload send.

### 2. `channel-messages` hard replace wipes optimistics

On join/reconnect server dumps full list. Handler must keep local `deliveryState === 'sending'|'failed'` rows not already present by server `id` / `clientMessageId`, else user sees flash disappear (or permanent loss if ack races poorly). Always `dedupeMessages` after merge.

### 3. Optimistic identity mismatch

Server messages use `userId: "user-{dbId}"`. Optimistic should prefer:

```ts
const stableId =
  (typeof me?.dbUserId === 'number' && me.dbUserId > 0 ? `user-${me.dbUserId}` : null)
  || me?.id || sock?.id || 'local';
```

Otherwise own-message styling / grouping can flicker when ack lands. `isOwnMessage` already matches username or `ownIdentityIds` (`id` + `user-${dbUserId}`).

### 4. `message-accepted` writing undefined

Only patch `id` / `timestamp` when present and finite. Writing `id: undefined` can break `isRenderableMessage` / keys.

### 5. Optimistic row pollution

Do not `...(options as Partial<Message>)`. Lift only: replyTo, isSpoiler, entities, gif/emoji/file fields, encryption/storage meta.

### 6. Spoiler sticky

After successful text/gif/upload send, `markAsSpoiler = false` unless `channel.forceSpoiler`.

### 7. Offline queue

If WabiDB queue + `!connected`: enqueue, mark optimistic `failed` with "Queued — will send when online", return ok with `queuedOffline: true`. Still clear draft (message is queued).

### 8. New messages literally eat old ones (critical — 2026-08-05)

Symptom: send #2 replaces #1 in the UI; history collapses to one bubble while emit "works".

**A. Wrong duplicate match**

```ts
// BAD — treats id and clientMessageId as interchangeable keys
const key = message.id || message.clientMessageId;

// GOOD
function isSameMessageRow(candidate, incoming) {
  if (candidate.clientMessageId && incoming.clientMessageId
      && candidate.clientMessageId === incoming.clientMessageId) return true;
  if (candidate.id && incoming.id && candidate.id === incoming.id) {
    // never collapse two different client sends onto one server id
    if (candidate.clientMessageId && incoming.clientMessageId
        && candidate.clientMessageId !== incoming.clientMessageId) return false;
    return true;
  }
  return false;
}
```

On merge, preserve `clientMessageId` if wire payload nulls it:

```ts
clientMessageId: message.clientMessageId || candidate.clientMessageId
```

**B. Keyed `{#each}` key (refined 2026-08-06)**

```ts
// Prefer stable server id once accepted; keep optimistic:/cmid only while local.
function messageRowKey(m, i = 0) {
  const id = String(m?.id ?? '').trim();
  if (id && !id.startsWith('optimistic:')) return id;
  return String(m?.clientMessageId || id || m?.clientNonce || '').trim() || `__missing_${i}`;
}
```

Dedupe visible list: keep **last** occurrence per key (reconcile wins).

**C. Server ids must be unique end-to-end (refined 2026-08-06)**

Stamp UUID into `MessageRecord` **before** commit; projection must **keep** non-empty writer id (do not overwrite with only `msg_{seq}`). Adapter returns that same id on the wire. Return-value-only UUID suffix while projection forces seq is insufficient.

## Server contract (quick)

- Client event: `message` with camelCase fields (`channelId`, `clientMessageId`, `isSpoiler`, `replyTo`, `entities`, …)
- Server → client: `message-accepted` then room `message` with `{ channelId, message }`
- History/join: `channel-messages` with full list (may lack clientMessageId on WDB fallback rows)
- Session history emit: drop empty ids + dedupe by id before `channel-messages`

## Verify

- Connected: type several texts → all remain visible; no row rewrite of previous text
- Disconnect socket: send → toast, draft remains
- Rapid reconnect during send: no permanent vanish of local pending rows
- Own messages stay right-aligned / own class through ack
- Spoiler checkbox resets after send on normal channels
- Hard refresh → Init history → send new → history still present
