# Chat Object Refs — Kanban Card Spec

Source of truth design: `docs/plans/2026-07-18-chat-object-refs.md`
Board: `wabi-chat-refs`

### chatref-01: Expand MessageEntity protocol for multi-kind refs
- **Component:** Protocol
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** —
- **Scope:** Expand `MessageEntityKind` beyond Place; add `User`, `Channel`, `ForumPost`, `WikiPage`, `GalleryWork`. Generalize entity payload with `target_id` (compat: map legacy `place_id` → `target_id` for Place). Optional preview snapshot fields. Regenerate `packages/wabi-protocol` TS. Do not build UI.
- **Files:** `crates/wabi-core/src/message/mod.rs`, `crates/wabi-core/tests/message_types.rs`, `packages/wabi-protocol/src/generated/MessageEntity.ts`, `packages/wabi-protocol/src/generated/MessageEntityKind.ts`, `packages/wabi-protocol/src/index.ts`
- **Acceptance:** `MessageEntityKind` includes User/Channel/ForumPost/WikiPage/GalleryWork/Place. Round-trip serde + TS export green. Old place-only payloads still deserialize (compat path documented in code comment).
- **Verify:** `cd /var/home/Ronin/wabi && cargo test -p wabi-core --features ts 2>&1 | tail -40`
- **Notes:** Enum is `#[non_exhaustive]` already — additive variants are fine. Prefer clean `target_id` over forever-place-named fields. See plan §2.

### chatref-02: Object ref registry (auto-sense index for ^)
- **Component:** Frontend foundation
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** chatref-01
- **Scope:** Create `objectRefRegistry` store: register/search/resolve for forum_post, wiki_page, gallery_work, place. Wrap existing placeRegistry into place kind. Support bare slug resolve + forced namespaces `f/ w/ g/ m/`. No composer UI yet; unit-testable pure functions OK.
- **Files:** `frontend/src/lib/objectRefRegistry.ts` (new), `frontend/src/lib/placeRegistry.ts` (read/adapt only as needed), optional `frontend/src/lib/objectRefRegistry.test.ts` if project has vitest/bun tests
- **Acceptance:** `searchObjectRefs('par')` returns ranked matches; `resolveObjectRef('parallel_universe')` returns unique|ambiguous|miss; `resolveObjectRef('w/parallel_universe')` forces wiki; places appear under kind place.
- **Verify:** `cd /var/home/Ronin/wabi/frontend && npm run check 2>&1 | tail -20`
- **Notes:** Client-side index is enough for v1 single-server. Do not invent server search API in this card.

### chatref-03: Composer multi-trigger (@ # ^) + entity emission
- **Component:** Composer
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** chatref-01, chatref-02
- **Scope:** Extend mention autocomplete: `@` users/specials, `#` channels from channel store, `^` object registry (respect `^f/` etc). Apply inserts display token + MessageEntity span. Send path includes entities. Reconcile spans on edit. Unify MentionSuggestion type with kind + targetId.
- **Files:** `frontend/src/lib/components/chat/ChatComposer.svelte`, `frontend/src/lib/components/chat/mentionSuggestions.ts`, `frontend/src/lib/components/chat/MentionSuggestions.svelte`, `frontend/src/lib/components/chat/types.ts`, related entity reconcile helpers if present
- **Acceptance:** Typing `@` lists users; `#` lists channels with type badge; `^` lists registered objects; selecting a suggestion inserts chip-ready text and attaches entity with correct kind/targetId/start/end; send payload includes entities array.
- **Verify:** `cd /var/home/Ronin/wabi/frontend && npm run check 2>&1 | tail -20`
- **Notes:** There are TWO MentionSuggestion shapes today (chat/types.ts vs mentionSuggestions.ts) — consolidate carefully. Place path already partially works; do not break places.

### chatref-04: Chip renderer + navigateToRef
- **Component:** Render + navigation
- **Tag:** DAYTIME
- **Size:** L
- **Depends on:** chatref-01, chatref-03
- **Scope:** Generalize `markdown.ts` entity injection beyond place. Multi-kind CSS tokens. Click handler → `navigateToRef` (switch channel; for forum/wiki/gallery if surface missing, toast + still switch channel). DOMPurify allow new data attrs. Old place chips still work.
- **Files:** `frontend/src/lib/markdown.ts`, `frontend/src/styles/components/ml-markdown.css`, `frontend/src/lib/navigateToRef.ts` (new), message item / ChatMessagesPane click wiring
- **Acceptance:** Messages with user/channel/object entities render clickable chips; click on #channel switches channel; click on place keeps existing place behavior; unknown surface object navigates channel + non-fatal focus miss.
- **Verify:** `cd /var/home/Ronin/wabi/frontend && npm run check 2>&1 | tail -20`
- **Notes:** Navigation contract is load-bearing for later channel UIs. Do not hardcode three different click handlers.

### chatref-05: Reverse share (Share to channel / Copy link / Copy ref)
- **Component:** Share
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** chatref-01, chatref-02, chatref-03
- **Scope:** `shareToChannel.ts` builds text+entities payload. Channel picker modal (minimal). Context helpers: Share to channel…, Copy link (`?ref=kind:id` deep link form from plan), Copy ref (`^slug` or namespaced). Stub entry points callable from future forum/wiki/gallery menus; optional temporary dev entry if no surface exists.
- **Files:** `frontend/src/lib/shareToChannel.ts` (new), small Svelte modal under `frontend/src/lib/components/chat/` or `share/`, wiring hooks export
- **Acceptance:** `buildSharePayload(record)` returns display text containing `^slug` and entities[] with correct spans; Share to channel opens picker and sends or stages message; Copy ref puts `^slug` on clipboard; Copy link puts path with ref query.
- **Verify:** `cd /var/home/Ronin/wabi/frontend && npm run check 2>&1 | tail -20`
- **Notes:** Reverse path is half the product. Do not invent a special message type — normal text + entities.

### chatref-06: Unfurl cards under messages
- **Component:** Render
- **Tag:** DAYTIME
- **Size:** M
- **Depends on:** chatref-04
- **Scope:** For messages with object entities, render compact unfurl card for first object entity (title, subtitle, optional thumb, status). Use preview_* on entity or live registry lookup. No full embed browser.
- **Files:** `frontend/src/lib/components/` message body area (MessageItem / MessageItemContent / ChatMessagesPane — pick actual path), CSS for unfurl card
- **Acceptance:** Message containing a gallery/forum/wiki entity shows a card with title; click card uses navigateToRef; messages without object entities unchanged.
- **Verify:** `cd /var/home/Ronin/wabi/frontend && npm run check 2>&1 | tail -20`
- **Notes:** Phase 2 polish relative to chips. Keep card compact (Discord-ish embed height, not a wall).

### chatref-07: Surface hooks + plan cross-links (forum/wiki/gallery/map)
- **Component:** Integration docs + stubs
- **Tag:** MIXED
- **Size:** S
- **Depends on:** chatref-02, chatref-05
- **Scope:** Document required hooks for channel workstreams: on load call registerObjectRef; expose Share menu via shareToChannel helpers. Add short stubs/comments in ChannelModePlaceholder / GalleryChannel / map place UI if touch is cheap. Cross-link this plan from a short `docs/plans/2026-07-18-channel-types-follows-chat-refs.md` outline (does not implement channel UIs).
- **Files:** `docs/plans/2026-07-18-chat-object-refs.md` (update if needed), `docs/plans/2026-07-18-channel-types-follows-chat-refs.md` (new outline), optional touch: `ChannelModePlaceholder.svelte`, `GalleryChannel.svelte`
- **Acceptance:** Outline lists register/share requirements; placeholder/gallery has at least a comment or minimal Share entry pointing at helpers; hy3 can start channel UIs without re-litigating link grammar.
- **Verify:** `test -f /var/home/Ronin/wabi/docs/plans/2026-07-18-channel-types-follows-chat-refs.md && rg -n "registerObjectRef|shareToChannel|\\^" /var/home/Ronin/wabi/docs/plans/2026-07-18-channel-types-follows-chat-refs.md`
- **Notes:** Explicitly YAGNI on full forum/wiki UI here. This card prevents the next workstream from inventing `?`/`!` again.
