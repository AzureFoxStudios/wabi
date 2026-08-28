# Svelte `each_key_duplicate` (Wabi MessageList)

## Symptom

```
Uncaught Error: https://svelte.dev/e/each_key_duplicate
```

Often right after `[SocketManager] Init received` when `channel-messages` fills the list. Can fire 2× (multiple lists).

## Mechanism

Keyed `{#each items as item (key)}` requires unique, stable keys. Duplicate keys → runtime throw.

## Wabi root cause (2026-08-05)

`MessageList.svelte` originally:

```svelte
{#each visibleMessages as message, localIndex (message.id ?? message.clientNonce ?? `__missing_${localIndex}`)}
```

- `??` only substitutes for `null`/`undefined`.
- Server/WDB history can yield `id: ""` (empty string) for malformed rows.
- Empty string is **truthy for `??`** → key becomes `""` for every blank-id row → `each_key_duplicate`.

## Fixes (defense in depth)

### 1. Key expression: empty-string safe **and stable across accept**

```svelte
{#each visibleMessages as message, localIndex (
  message.clientMessageId || message.id || message.clientNonce || `__missing_${localIndex}`
)}
```

- Use `||` not `??` so `""` falls through.
- Prefer **`clientMessageId` first** so optimistic → `message-accepted` (id rewrite) does **not** change the key. Key flips recycle the wrong DOM row and look like "new message ate the old one" (see `message-send-path.md` §8).

### 2. Drop unrenderable / blank-id messages

`displayEnhancements.isRenderableMessage`:

```ts
if (!message.id || !String(message.id).trim()) return false;
```

### 3. Dedupe on `channel-messages` + live `message`

Stable key for collapse: `clientMessageId || id` (not `id || clientMessageId` for matching across different client sends).

```ts
function isSameMessageRow(candidate, incoming) {
  if (candidate.clientMessageId && incoming.clientMessageId
      && candidate.clientMessageId === incoming.clientMessageId) return true;
  if (candidate.id && incoming.id && candidate.id === incoming.id) {
    if (candidate.clientMessageId && incoming.clientMessageId
        && candidate.clientMessageId !== incoming.clientMessageId) return false;
    return true;
  }
  return false;
}
```

Preserve local `deliveryState === 'sending'|'failed'` optimistics not already in server snapshot.

### 4. Sidebar / category lists

Also harden channel each keys:

```svelte
{#each textChannels as channel, i (channel.id || `text-ch-${i}`)}
```

Dedupe category channels by id before `{#each cats as cat (cat.id)}`.

### 5. Server session dump

Before `channel-messages` emit, drop empty message ids and HashSet-dedupe by id (session buffer can double-push).

## Not this bug

- Non-keyed each blocks do not throw this error
- CF Insights beacon CORS is unrelated noise

## Verify

Hard refresh after deploy → Init with history → no `each_key_duplicate`. Send 3 messages → all three remain. Console clean through first channel open.
