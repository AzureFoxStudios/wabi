# Channel navigation deep-links (C1–C2)

Validated showcase-prep W3 C1–C2 (2026-08-01). Complements `channel-type-surfaces.md` and `lore-asset-storage-e2e.md`.

## C1 — clickable `#channel` mentions

### Pipeline order (load-bearing)

In `parseMessage` (`frontend/src/lib/markdown.ts`):

1. Protect code regions
2. Extract math placeholders
3. **Run `@mention` and `#channel` rewrites while code is still protected**
4. Restore code regions
5. Spoilers / marked / DOMPurify / KaTeX inject

If `#channel` runs **after** `restoreCodeRegions`, fences and backticks get false positives (`#general` inside `` `#general` `` or ``` fences).

### Regex / HTML shape

```ts
// Word char immediately after # → not an ATX header ("# Title" has a space)
/(^|[\s(])#([a-zA-Z][a-zA-Z0-9._-]{0,31})\b/g
→
<span class="mention-token mention-token-channel"
  data-ref-kind="channel"
  data-ref-id="{name}"
  data-ref-label="#{name}">#{name}</span>
```

- Keep markdown free of `channelStore` imports (cycle risk). Name→id resolve lives in `navigateToRef.resolveChannelId`.
- MessageList already routes `[data-ref-kind]` → `navigateToRef` (channel arm uses `refId` as channel name or `ch_*`).
- DOMPurify already allows `data-ref-kind` / `data-ref-id` / `data-ref-label`.

### Cases

| Input | Expected |
|-------|----------|
| `see #general` | channel mention |
| `` `#general` `` / fenced `#general` | plain code, no mention |
| `# Title` (space after #) | markdown header, no mention |
| `#general is open` | channel mention (Discord-style bare line) |

## C2 — pendingNav deep-link handoff

### Problem

`navigateToRef` switches channels async. Forum/Wiki/Gallery need to open a specific item **after** channel data loads. A one-shot store bridges the gap.

### Module split (avoid cycles)

- `frontend/src/lib/pendingNav.ts` — owns `NavRef` type + `setPendingNav` / `peekPendingNav` / `takePendingNav` / `clearPendingNav`
- `frontend/src/lib/navigateToRef.ts` — imports type + `setPendingNav`; re-exports `type { NavRef }`

Do **not** put `NavRef` only in `navigateToRef` and import it from `pendingNav` (circular).

### set → peek → take

```
navigateToRef(forum_post|wiki_page|gallery_work)
  → setPendingNav({ ...ref, channelId })
  → switchChannel(channelId)

Forum/Wiki/Gallery after data load:
  → pending = peekPendingNav()          // non-destructive
  → if kind+channel match AND item exists:
       takePendingNav(kind, channelId)  // consume once
       selectThread / selectPage / openLightbox
  → else leave pending (wrong channel or data not ready yet)
```

**Why peek-then-take:** calling `take` first on a miss (empty list / wrong channel) **drops** the deep-link forever. Peek first; take only on confirmed hit.

### Consumer sketch

```ts
$: if ($currentChannel && allItems.length > 0) {
  const pending = peekPendingNav();
  if (
    pending?.kind === 'gallery_work' &&
    (!pending.channelId || pending.channelId === $currentChannel)
  ) {
    const idx = allItems.findIndex((i) => i.id === pending.workId);
    if (idx >= 0) {
      takePendingNav('gallery_work', $currentChannel);
      openLightbox(idx, allItems);
    }
  }
}
```

Same shape for Forum (`post_id` / `thread_id`) and Wiki (`pageId`).

### Residual risk

Gallery store ids are often `album-${albumId}-item-${id}`. Deep-link only works if `workId` matches that store `item.id` (objectRef registry must register the same id).

Name→id for `#channel` needs the channels store loaded; unknown names no-op switch.

## Verify

```bash
# happy-dom stub for DOMPurify if needed
bun /tmp/c1c2-smoke.mjs   # fence/header + pendingNav gates → SMOKE_OK

test -f frontend/src/lib/pendingNav.ts
rg -n 'mention-token-channel|Mentions while code is still protected' frontend/src/lib/markdown.ts
rg -n 'peekPendingNav|setPendingNav' frontend/src/lib/navigateToRef.ts frontend/src/lib/pendingNav.ts \
  frontend/src/lib/components/ForumChannel.svelte \
  frontend/src/lib/components/WikiChannel.svelte \
  frontend/src/lib/components/GalleryChannel.svelte

cd frontend && bun run check
# ignore unchanged pre-existing bun:test module errors; Wiki href="#" warn is pre-existing
```

Final UI: Ronin real browser — type `#channel-name` in chat, click, land on channel; share forum/wiki/gallery ref and confirm surface opens.
