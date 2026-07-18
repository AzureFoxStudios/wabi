# Chat Object Refs (`^`) Implementation Plan

> **For Hermes / hy3:** Implement task-by-task from the kanban board `wabi-chat-refs`.
> Design north star: Discord-grade `@`/`#` + one auto-sensing object caret `^` that also covers maps later.
> Channel UIs (forum/wiki/gallery) plug into this spine — they do not invent their own link languages.

**Goal:** Make live chat the connective tissue for users, channels, and first-class objects (forum posts, wiki pages, gallery works, map places) with typed mentions, durable entity spans, chip rendering, navigation, and reverse “Share to channel”.

**Architecture:** Extend the existing `MessageEntity` protocol (today only `place`) into a general ref system. Composer emits entity spans; renderer turns spans into chips; click opens a navigation contract; right-click Share inserts the same entity into a target channel. Typed grammar is display sugar; **entity id + kind is truth**.

**Tech Stack:** Rust `wabi-core` (ts-rs) → `packages/wabi-protocol`, SvelteKit frontend (`markdown.ts`, `ChatComposer`, `mentionSuggestions`), Socket.IO / REST message payload `entities[]`, later unfurl snapshot fields.

**Decisions locked (2026-07-18 Ronin):**
- Option A: single object trigger **`^`** (caret / “pointer”), auto-senses kind via registry + optional light namespace (`^f/`, `^w/`, `^g/`, `^m/`).
- Keep Discord muscle memory: **`@` users**, **`#` channels**.
- Drop `~` (slashing / approx / home-path collision). Drop free-floating `?` / `!` as primary grammar (may appear only as display aliases later if wanted).
- Gallery v1 can lean share/unfurl if typed slug is rare; still register gallery works in the `^` index.
- Reverse path is mandatory: right-click on wiki/forum/gallery → **Share to channel…** / **Copy link** / **Copy ref**.
- Maps merge later under the same `^` object system (existing `place` kind).

**Non-goals (this plan):**
- Building full forum/wiki/gallery product UIs (separate workstream after spine).
- Server-side notification spam for object refs (optional later).
- Opening the whole keyboard as a glyph zoo.

---

## 1. Grammar (product contract)

| Trigger | Kind | Example display | Notes |
|---------|------|-----------------|-------|
| `@` | user / special | `@ronin`, `@everyone` | Existing autocomplete path |
| `#` | channel | `#general`, `#art` | Any channel type |
| `^` | object (auto) | `^ux_1151`, `^parallel_universe`, `^skyline` | Resolves against object index |
| `^f/` | forum post (forced) | `^f/ux_1151` | Disambiguation |
| `^w/` | wiki page (forced) | `^w/parallel_universe` | |
| `^g/` | gallery work (forced) | `^g/skyline` | |
| `^m/` | map place (forced) | `^m/spawn` | Alias of existing place entities |

**Resolution rules:**
1. Autocomplete-picked refs always emit a structured entity (preferred).
2. Free-typed `^slug` resolves on send if unique match in object index; if ambiguous, force picker or fail soft (leave plain text + toast).
3. Unknown `^slug` stays plain text (no broken chip).
4. Entity always stores durable `targetId` + `kind`; `label` / `displayText` can update when object is renamed.
5. Token boundaries: start-of-string or whitespace/punctuation before trigger; slug = `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`.

**Deep link URL form (for Copy link / paste unfurl):**
```
https://wabi.chat/c/{channelId}?ref={kind}:{targetId}
# or app-relative
/c/{channelId}?ref={kind}:{targetId}
```
Paste of this URL into chat should hydrate an entity + optional unfurl card.

---

## 2. Protocol shape

### Today (broken for multi-kind)

`crates/wabi-core/src/message/mod.rs`:

```rust
pub struct MessageEntity {
    pub kind: MessageEntityKind, // only Place
    pub start: u32,
    pub end: u32,
    pub place_id: String,        // place-specific field name
    pub layer_id: Option<String>,
    pub poi_id: Option<String>,
    pub label: String,
    pub display_text: Option<String>,
}
```

### Target (backward compatible)

Prefer **additive** fields + kind expansion. Do not rename `place_id` in a breaking way if old clients exist; either:

**Preferred (clean, if we can regenerate TS and own both ends):**

```rust
#[non_exhaustive]
pub enum MessageEntityKind {
    Place,
    User,
    Channel,
    ForumPost,
    WikiPage,
    GalleryWork,
    // future: Message, Role, …
}

pub struct MessageEntity {
    pub kind: MessageEntityKind,
    pub start: u32,
    pub end: u32,
    /// Durable target id for this kind (user id, channel id, post id, page id, work id, place id).
    pub target_id: String,
    pub label: String,
    pub display_text: Option<String>,
    // Place-only extras (ignored for other kinds)
    pub layer_id: Option<String>,
    pub poi_id: Option<String>,
    // Optional unfurl snapshot (filled by client or server)
    pub preview_title: Option<String>,
    pub preview_subtitle: Option<String>,
    pub preview_thumb_url: Option<String>,
    pub preview_status: Option<String>, // e.g. "solved", "wip"
}
```

**Compat shim:** When reading old payloads that only have `placeId`, map `placeId → targetId` and `kind = place`. When writing place entities, still accept both during transition if needed.

Regenerate TS:
```bash
cd /var/home/Ronin/wabi
# follow packages/wabi-protocol README / wabi-core ts feature
cargo test -p wabi-core --features ts
# ensure packages/wabi-protocol/src/generated/MessageEntity*.ts updated
```

---

## 3. Object index (auto-sensing for `^`)

Client-side (v1) registry store, e.g. `frontend/src/lib/objectRefRegistry.ts`:

```ts
export type ObjectRefKind = 'forum_post' | 'wiki_page' | 'gallery_work' | 'place';

export type ObjectRefRecord = {
  kind: ObjectRefKind;
  id: string;
  slug: string;          // human speakable
  title: string;
  channelId: string;     // home channel for navigation
  subtitle?: string;     // category / path / creator
  status?: string;
  thumbUrl?: string;
  updatedAt?: number;
};

// registerObjectRef(record) called by forum/wiki/gallery/map loaders
// searchObjectRefs(query) for ^ autocomplete
// resolveObjectRef(slug | namespaced) → unique | ambiguous | miss
```

Maps already have `placeRegistry` — wrap/import into the same index under kind `place`.

Server-side search endpoint can come later (`GET /api/refs/search?q=`). v1 client index is enough for single-server.

---

## 4. Navigation contract

Single function (store or module), e.g. `frontend/src/lib/navigateToRef.ts`:

```ts
export type NavRef =
  | { kind: 'user'; userId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'forum_post'; channelId: string; postId: string }
  | { kind: 'wiki_page'; channelId: string; pageId: string }
  | { kind: 'gallery_work'; channelId: string; workId: string }
  | { kind: 'place'; placeId: string; layerId?: string; poiId?: string };

export async function navigateToRef(ref: NavRef): Promise<void> {
  // 1. join/switch channel if needed
  // 2. set surface (messages | forum | wiki | gallery | map)
  // 3. focus object (scroll / open lightbox / open page)
}
```

Chips and Share-to-channel both call this. No ad-hoc `window.location` hacks in three places.

---

## 5. Composer

Files:
- `frontend/src/lib/components/chat/ChatComposer.svelte`
- `frontend/src/lib/components/chat/mentionSuggestions.ts`
- `frontend/src/lib/components/chat/MentionSuggestions.svelte`
- `frontend/src/lib/components/chat/types.ts`

Behavior:
1. Detect trigger at caret: `@` | `#` | `^` (and `^f/` `^w/` `^g/` `^m/` as query prefixes).
2. Unified suggestion model:

```ts
export type MentionSuggestion = {
  key: string;
  kind: 'user' | 'channel' | 'forum_post' | 'wiki_page' | 'gallery_work' | 'place' | 'special';
  label: string;       // inserted display slug
  detail?: string;     // secondary line
  targetId: string;
  channelId?: string;
  // existing place/user payloads as needed
};
```

3. On apply: insert display token (`@Alice `, `#general `, `^ux_1151 `) + push `MessageEntity` span covering the token (without trailing space).
4. On send: pass `entities` with message (already partially wired for places).
5. Reconcile entity offsets when user edits text mid-message (extend existing place reconcile helpers if present; otherwise implement span shift rules).

---

## 6. Renderer (chips + unfurl)

Files:
- `frontend/src/lib/markdown.ts`
- `frontend/src/styles/components/ml-markdown.css`
- message click handler (MessageItem / ChatMessagesPane)

Chips:
- Generalize `injectMessageEntityPlaceholders` beyond `kind === 'place'`.
- Emit `span.mention-token.mention-token-{kind}` with `data-ref-kind` + `data-ref-id` (+ channel id).
- DOMPurify allowlist: add data attrs for all kinds.
- Click → `navigateToRef`.

Unfurl (phase 2, same plan, later cards):
- If message has ≥1 object entity, render optional card under body for first object entity using preview_* fields or live registry lookup.
- Forum: title, tags/status, reply count.
- Wiki: title, breadcrumb excerpt.
- Gallery: thumb + creator.
- Place: existing map affordance.

---

## 7. Reverse path (Share to channel)

From any non-chat surface (forum post header, wiki page toolbar, gallery lightbox, map POI):

Context menu / ⋯ menu:
1. **Share to channel…** → channel picker modal → open or send message in target channel with pre-built entity + default text (`check this ^slug`).
2. **Copy link** → deep link URL.
3. **Copy ref** → `^slug` or namespaced form to clipboard.

Shared helper:
```ts
export function buildSharePayload(ref: ObjectRefRecord): {
  text: string;
  entities: MessageEntity[];
}
```

Do not invent a second “share message type”. It is a normal text message with entities.

---

## 8. Phased delivery (hy3-friendly)

### Phase 0 — Spec freeze
- This doc + kanban board `wabi-chat-refs`.

### Phase 1 — Protocol + registry skeleton
- Expand `MessageEntityKind` + `MessageEntity` fields.
- Regenerate protocol TS.
- `objectRefRegistry` with search/resolve; wrap places.

### Phase 2 — Composer multi-trigger
- `@` keep users; `#` channels; `^` object index.
- Entity emission + offset reconcile.

### Phase 3 — Renderer chips + navigation
- Multi-kind chips; click navigate (channel switch works even before forum/wiki UI exists — focus can no-op with toast if surface missing).

### Phase 4 — Reverse share
- Share modal + Copy link/ref helpers.
- Stub menus on placeholder surfaces if real UIs not ready.

### Phase 5 — Unfurl cards
- Compact cards under messages.

### Phase 6 — Hooks for channel workstreams
- Forum/wiki/gallery plans must call `registerObjectRef` on load and expose Share menu using the same helpers.
- Maps register under `^m/` / place kind.

---

## 9. File map (expected touch list)

| Area | Paths |
|------|--------|
| Protocol | `crates/wabi-core/src/message/mod.rs`, `crates/wabi-core/tests/message_types.rs`, `packages/wabi-protocol/src/generated/*` |
| Registry | `frontend/src/lib/objectRefRegistry.ts` (new), `frontend/src/lib/placeRegistry.ts` (adapt) |
| Nav | `frontend/src/lib/navigateToRef.ts` (new) |
| Composer | `frontend/src/lib/components/chat/ChatComposer.svelte`, `mentionSuggestions.ts`, `MentionSuggestions.svelte`, `types.ts` |
| Render | `frontend/src/lib/markdown.ts`, `ml-markdown.css`, message item click path |
| Share | `frontend/src/lib/shareToChannel.ts` (new), small modal component |
| Docs | this file; channel plans link here |

---

## 10. Verification gates

Protocol:
```bash
cd /var/home/Ronin/wabi && cargo test -p wabi-core --features ts
```

Frontend:
```bash
cd /var/home/Ronin/wabi/frontend && npm run check
```

Manual smoke:
1. Type `@` → user suggestions; send → chip; click → user popout or profile.
2. Type `#` → channel list; send → chip; click → switch channel.
3. Register fake object in registry; type `^` → suggestion; send → chip; click → navigate (or toast if surface missing).
4. Share helper builds entity-bearing draft into another channel.
5. Old messages with place-only entities still render.

---

## 11. Kanban board

Board slug: **`wabi-chat-refs`**

Card ids: `chatref-01` … (see companion card spec).

Dependency spine:
```
chatref-01 protocol
  → chatref-02 registry
  → chatref-03 composer
  → chatref-04 render+nav
  → chatref-05 reverse share
  → chatref-06 unfurl
  → chatref-07 surface hooks (docs + stubs)
```

---

## 12. Relationship to channel types work

Do **not** start full Forum/Wiki/Gallery product UIs until Phase 1–4 of this plan are green enough that those UIs can register refs and Share without inventing parallel link systems.

Channel-type plan should reference:
- `docs/plans/2026-07-18-chat-object-refs.md`
- mockups: `/var/home/Ronin/wabi-channel-specs/*_mockup_v2.html`
- gallery prototype: `frontend/static/gallery-prototype.html`

---

## 13. Open questions (do not block Phase 1–3)

1. Server-side entity validation on send (reject spoofed target ids)?
2. Persist preview snapshot server-side vs client re-resolve?
3. Notification policy when your post/page is referenced?
4. Exact deep-link host path once routing is finalized (`/c/` vs app shell state only)?

## chatref-07: surface integration contract

*Defines the boundary between the chat-ref spine and product surfaces (forum, wiki, gallery, map).*
*Surface implementors MUST follow these rules — do NOT invent new link grammar or entity types.*

### Gallery (`GalleryChannel.svelte`)
- **On load / list:** call `initObjectRefRegistry()` once (first call syncs map places; subsequent calls no-op).
  For each work, call:
  `registerObjectRef({ kind:'gallery_work', id:item.id, slug:slugify(item.attachmentName), title:item.attachmentName, channelId:$currentChannel, subtitle:item.creator?.username, thumbUrl:item.attachmentUrl, updatedAt:item.uploadedAt })`
- **On context menu / ⋯ of a work:** show **Share to channel…** → `openShareModal(record)`.
  **Copy link** → `buildShareLink(record)`. **Copy ref** → `buildShareRefText(record)`.
- **Chip click:** `navigateToRef` already handles `gallery_work` (chatref-04); no per-surface wiring.
- **Chat grammar:** `^g/slug` in chat (wired in chatref-02/03).

### Forum (placeholder — `ChannelModePlaceholder` mode `'forum'`)
- **On load / list (when real UI lands):** for each thread/post, call:
  `registerObjectRef({ kind:'forum_post', id:post.id, slug:slugify(post.title||post.id), title:post.title, channelId:channelId, subtitle:post.author?.username, status:post.status })`
- **On context menu / ⋯:** Share to channel… / Copy link / Copy ref — same pattern as gallery.
- **Chip click:** handled by `navigateToRef` (channel switch + surface switch to forum; if surface missing, shows toast).
- **Chat grammar:** `^f/slug`.

### Wiki (placeholder — `ChannelModePlaceholder` mode `'wiki'`)
- **On load / list (when real UI lands):** for each wiki page, call:
  `registerObjectRef({ kind:'wiki_page', id:page.id, slug:slugify(page.title||page.id), title:page.title, channelId:channelId, subtitle:page.updatedBy?.username, updatedAt:page.updatedAt })`
- **On context menu / ⋯:** Share to channel… / Copy link / Copy ref.
- **Chip click:** handled by `navigateToRef`.
- **Chat grammar:** `^w/slug`.

### Map (`^m/` — place kind)
- **Already wired:** `initObjectRefRegistry()` syncs `placeRegistry` → `place` refs on first call (chatref-02). Do NOT re-register.
- **Chip click:** `navigateToRef` handles `place` (existing, chatref-04).
- **Chat grammar:** `^m/slug` (or bare `^slug` for unique matches).

### Surface lifecycle note
Each surface SHOULD call `unregisterObjectRef(kind, id)` for its items when the component unmounts, to avoid stale refs in autocomplete. Gallery (v1) does NOT unregister — stale refs are harmless display-only. Future surfaces may adopt lifecycle cleanup.
