# Message "new eats old" — full audit (2026-08-06)

## Symptom
Sending a text message appears to delete/replace the previous message. Not like this ~1 month ago.
Also saw `each_key_duplicate` and `SUBSCRIBE_FAIL` on the same surface (related identity bugs).

## Pipeline map

```
ChatComposer.handleSubmit
  → messageStore.sendMessage
      - creates clientMessageId = optimistic:{channel}:{ts}:{rand}
      - optimistic row: id = clientMessageId, deliveryState=sending
      - appendOptimisticMessage (push onto channelMessages[channelId])
      - sock.emit('message', { channelId, text, type, clientMessageId, ... })
  → server socketio/messages.rs handle_message
      - message_id = new_message_id(...) provisional
      - wdb.send_message → adapter returns id string
      - session_messages[channel].push(message_view)
      - emit message-accepted { messageId, clientMessageId }
      - emit message { channelId, message: message_view } to room
  → client socketConnectionCore
      - message-accepted → patch optimistic by clientMessageId (set id)
      - message → find duplicate by id OR clientMessageId → replace or append
  → Chat.svelte: messages = $channelMessages[$currentChannel]
  → MessageList visibleMessages keyed {#each}
```

History path on join:
```
presence.rs join-channel
  → session_messages if non-empty (dedupe by id, KEEP FIRST)
  → else WDB list_messages_typed → map to { id: message_id, ... } NO clientMessageId
  → emit channel-messages
  → client HARD REPLACE (HEAD) of channelMessages[channelId]
```

## Root-cause findings (ordered by severity)

### R1 — Message id space is commit_seq only (backend)
**Projection** (`wabidb/.../messages.rs:240`):
```rust
record.message_id = format!("msg_{:x}", event.commit_seq);
```
**Adapter HEAD** (deployed):
```rust
Ok(format!("msg_{:x}", seq))  // same as projection
```
**Adapter WIP** (other session, NOT shipped):
```rust
Ok(format!("msg_{:x}_{}", seq, uuid))  // comment: "new message eats old"
```

If two commits ever share a `commit_seq`, or client collapses on id while projection/session has dups:
- session push allows duplicates with same id
- join-channel filter keeps FIRST only (`seen.insert(id)`)
- client `message` handler replaces by `candidate.id === message.id`
→ **exactly "new content overwrites old row"**

Even with unique seq, any client keying/dedupe that collapses on a shared key reproduces the same UI.

**Fix:** Generate a UUID message id once, write it into the record BEFORE commit, return that same id from adapter, stop overwriting projection message_id from commit_seq (or use uuid as canonical id). Align session + WDB + wire.

### R2 — MessageList each key prefers clientMessageId (frontend, SHIPPED c242a88)
```svelte
{#each visibleMessages as message (message.clientMessageId || message.id || ...)}
```
Plus visibleMessages dedupe that **drops** later rows with the same key (keeps first).

When server payload spreads over optimistic:
```js
{ ...candidate, ...message }  // message.clientMessageId: null OVERWRITES
```
cmid becomes null → key flips to server id. If two rows briefly share an id (R1 or race before accept), second is **silently dropped** from visible list.

Key change was meant to prevent Svelte recycle ("new eats old") but combined with null-spread + id collision it can still eat rows, and causes `each_key_duplicate` when keys collide without prior dedupe.

**Fix:** Stable composite key; never null-out cmid; dedupe must prefer server id when present; keep LAST reconcile of same identity not drop different messages.

### R3 — channel-messages hard replace (frontend HEAD)
```js
[channelId]: sanitized  // wipe entire channel list
```
Rejoin/reconnect/tab focus can wipe in-flight optimistics and any messages not in the snapshot. WIP soft-merge exists but unshipped.

**Fix:** Merge snapshot + pending local sending/failed (WIP pattern).

### R4 — message-accepted patch can write undefined (frontend HEAD)
```js
{ id: payload.messageId, timestamp: payload.timestamp, ... }
```
If either missing, patches `id: undefined` → fails `isRenderableMessage` → row can vanish from filtered lists.

**Fix:** Only assign defined finite fields (WIP pattern).

### R5 — SUBSCRIBE_FAIL (frontend, FIXED 26b8c34)
MessageContent used `$displayEnhancementSettingsStore` on a plain prop snapshot.
Shipped. Not the eat-old bug but blocked chat after login.

### R6 — each_key_duplicate (frontend, partial fix c242a88)
Channel/category/message each keys. MessageList + sidebar keys fixed; if still firing after R1–R4, remaining lists need the same treatment (voice members, reactions, etc.).

### R7 — Default 24h auto-delete (backend, product)
Every non-forever channel schedules delete after 24h. Not "instant eat on send", but can look like disappearing history. Confirm channel retention labels if user expects forever.

### R8 — Session vs WDB identity gap
Live session messages carry `clientMessageId`; WDB history path does **not** map it back. After reload, only server id remains. OK if ids unique; deadly if not (R1).

### R9 — isRenderableMessage filters empty id
Any path that clears `id` drops the row from channel-messages sanitize and MessageList.

## What is NOT the primary cause
- CF beacon CORS / SRI — noise
- Composer draft-clear rewrite — keep-draft on dead socket only
- Design polish CSS — no message identity logic
- Lore (off-limits) — separate surface

## Recommended fix order (one concern each)
1. Backend: UUID-stable message ids end-to-end (record + projection + wire + list)
2. Frontend merge: preserve clientMessageId; conditional accept patch; soft channel-messages merge
3. MessageList: composite stable keys; dedupe by true identity (id OR cmid match), never collapse distinct ids
4. Ship + hard refresh; send A then B; reload; confirm both persist
5. Optional: retention UI clarity for 24h default

## Evidence to capture post-fix
- Two sends → two distinct `id`s in network `message` events
- `channelMessages[channel].map(m => m.id)` unique after 5 rapid sends
- Reload → same two ids from channel-messages
- No each_key_duplicate / SUBSCRIBE_FAIL
