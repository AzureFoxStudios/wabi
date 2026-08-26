# HANDOFF — Channel Glimpse Rework (alt-click only, scrollable, ephemeral-safe) — 2026-08-26

**For:** Ox-Alpha (or any competent Svelte 5 agent — model-agnostic).
**From:** ZCode (GLM-5.3, max-mode session), investigation + design approved by William (Ronin) 2026-08-26.
**Scope:** Frontend only (`ChannelSidebar.svelte`, `UnifiedChannelList.svelte`, two CSS files). **No backend, no protocol, no codegen.**
**Read AGENTS.md first.** Relevant golden rules: #2 (runes in new code; legacy-mode files match their own idiom), #7 (headless Chromium cannot render Wabi — verify in a real browser), #10 (one subagent per message).

---

## 1. What the user reported (verbatim intent)

> "the current implementation is half baked. Always showing up instead of on alt-click, while also giving 3 messages instead of a scrollable list of dozens […] it's arguable we only capture like 12 of the last messages and if they want to scroll farther they go to the channel? I'm not sure what the explicit design should fully be but 3 messages isn't enough"

Steer added during planning (drives §5 — treat it as a hard requirement):

> "something I want to make sure is ephemeral servers or low message servers don't have accidental sticky glue to deleted messages with this"

## 2. Decided design (user-confirmed 2026-08-26 — do not re-litigate)

| Decision | Choice |
|---|---|
| Trigger | **Alt-click only.** Remove the 500 ms hover-dwell trigger entirely. Alt+middle-click stays. |
| Message count | **Render everything the socket delivered** (server pushes up to 50 persisted / full live session window). No fixed 12-cap. |
| Ordering | **Chat order** (oldest→newest), popout opens **auto-scrolled to bottom** (newest visible). Discord-peek style. |
| Hydration | **Unconditionally `joinChannel` on every glimpse open** — the ephemeral-safety rule (§5). |
| Layout | Header (`#name`, count, Follow) stays pinned; message list scrolls inside `max-height: min(420px, 60vh)`. |

## 3. How it works today (verified, with line refs)

Trigger paths:
- **Hover dwell (the "always shows up" culprit):** `frontend/src/lib/components/sidebar/UnifiedChannelList.svelte:121-147` — `GLIMPSE_DWELL_MS = 500`, `handleGlimpseEnter` starts a timer on every `.channel-btn` `on:mouseenter` (bound at 266-267), fires `onChannelGlimpseHover(channelId, rect)` prop → `handleChannelGlimpseHover` → `openChannelGlimpse` in the parent.
- **Alt-click:** `frontend/src/lib/components/ChannelSidebar.svelte:318-324` — `handleChannelButtonClick` checks `e.altKey`, calls `toggleChannelGlimpse`. Alt+middle-click: `UnifiedChannelList.svelte:268-273` (`on:auxclick`, `button === 1 && altKey`). Tooltip "Alt-click to glimpse" at `UnifiedChannelList.svelte:274` (stays).

Popout (all in `ChannelSidebar.svelte`):
- State 105-108; `openChannelGlimpse` 110-120 (position math + hydration guard); dismissal listeners in `onMount` 256-260 (outside `pointerdown`, `Escape`, **any** document `scroll` capture-phase); derived messages 306-308; markup 1123-1160; CSS `frontend/src/styles/components/sidebar-core-part1.css:398-470` (fixed variant 416-423).

Data path (no REST involved): `joinChannel` (`frontend/src/lib/channelStore.ts:74-79`) emits socket `join-channel` → server `on_join_channel` (`core/crates/wabi-server/src/socketio/presence.rs:755`; fallback window `list_messages_typed(&channel_id, 50)` at :841; emits `channel-messages` at :881) → client handler (`frontend/src/lib/socketConnectionCore.ts:705-731`) **replaces** `channelMessages[channelId]` with the server window (only locally-pending sends are preserved).

Dead weight: props `glimpseChannelId`, `onChannelGlimpseHover`, `onChannelGlimpseCancel` on `UnifiedChannelList` (declared 37-39; the first and third are never used by the child after this rework — remove). Legacy unimported lists (`TextChannelList.svelte`, `ForumChannelList.svelte`, …) carry their own old glimpse code — **out of scope, do not touch**.

## 4. Confirmed bugs to fix (all verified by reading, not speculation)

1. **Hover-dwell opens the peek uninvited** — any 500 ms pause over any channel row (§3). Remove per design.
2. **Alt-click positioning bug:** `toggleChannelGlimpse` (:318) sets `glimpseChannelId` but never `glimpsePosition`, so alt-clicking without a prior hover opens the popout at stale coordinates (initially `{0,0}` = viewport top-left).
3. **`glimpseChannelMessages` is not reactive to the store:** the derived (:306-308) calls `get(channelMessages)` — an imperative read Svelte does not track. It only re-runs when `glimpseChannelId` changes, so (a) the "Loading…" state for a first-time glimpsed channel **never resolves** even after the join reply lands, and (b) messages arriving while the peek is open never appear. Fix: reference `$channelMessages` in the derived (the component already has the store imported).
4. **Scroll-close conflict:** the document-level capture `scroll` listener (:259) closes the peek on *any* scroll — with a scrollable list, the peek would close the moment the user scrolls inside it.
5. **Loading vs empty conflation:** store key `undefined` (never hydrated) and `[]` (hydrated, genuinely empty) both render "Loading recent messages…" — on quiet ephemeral channels that is an eternal lie.
6. **Side-flip dead code:** `sidebar-compact.css:67-71` tries to flip the popout left for compact/nav-right layouts, but the fixed variant sets inline `left`, which wins over the stylesheet — the JS must do the flip. Signal: `$layoutStore.navDock === 'right'` (class binding at `frontend/src/lib/components/MainLayout.svelte:1005`).

## 5. Ephemeral safety (the steer — this section is the contract)

How deletions actually flow today (all verified):

- Server broadcasts `message-deleted` to the channel room (`io.to(channel_id)`) on **manual delete** (`core/crates/wabi-server/src/socketio/messages.rs:460-465`), on the **live-room reaper every 5 s** (`core/crates/wabi-server/src/main.rs:393-460`, emits at 449-452), and on the **durable retention reaper every 60 s** (`main.rs:463-531`, emits at 524-526). Default retention is **24 h ephemeral**; keep-forever is a per-channel opt-in (`messages.rs:120-160`).
- Client prunes unconditionally on `message-deleted` (`frontend/src/lib/messageStore.ts:92-97` — filters by id from `channelMessages[channelId]`, not just optimistic rows). Incoming `message` events append per channel (`socketConnectionCore.ts:733-754`). `channel-messages-cleared` empties the store + local cache (:786-798).
- The normal chat view **self-heals**: `switchChannel` calls `joinChannel` on every open (`channelStore.ts:102`), and the reply replaces the window with server truth.

**The hole (glimpse-specific):** `openChannelGlimpse` only re-hydrates when the store is *empty* (`ChannelSidebar.svelte:119`). Messages that expired while the client was disconnected/asleep — the norm on ephemeral and low-message servers — remain as ghosts in the store, and the glimpse happily renders deleted messages. This is the "sticky glue"; it does not affect the main chat view.

**Rules for the rework:**

- **R1 — Always re-hydrate:** `openChannelGlimpse` calls `joinChannel(channelId)` unconditionally on every open. It is a cheap idempotent emit; the reply replaces the window, wiping ghosts. (While the peek is open the socket is room-joined, so reaper deletes and new arrivals keep it live — cite-worthy behavior, not a bug.)
- **R2 — Honest empty states:** render "Loading…" only while the store key is `undefined` (never hydrated); once hydrated-but-empty show "No recent messages". Distinguish via `Array.isArray($channelMessages[id])`.
- **R3 — No client-side TTL guessing:** do not try to filter by `channel.autoDeleteAfter` labels client-side — the server window is the single source of truth (R1 makes it fresh).

**Live-room note (verified):** glimpsing `live` channels works through this same path — when the session cache is non-empty, `on_join_channel` returns it via `channel-messages` (`presence.rs:802-830`), so a busy live room shows real content in the peek. `LiveChannelView`'s separate `live-buffer-snapshot` handler is redundant for the peek path and can be ignored here.

## 6. Implementation checklist (ordered)

### 6.1 `frontend/src/lib/components/sidebar/UnifiedChannelList.svelte`
- [ ] Delete dwell machinery: `GLIMPSE_DWELL_MS`, `glimpseHoverTimer`, `glimpseHoverChannelId`, `cancelGlimpseDwell`, `handleGlimpseEnter`, `handleGlimpseLeave` (117-147) and the `on:mouseenter` / `on:mouseleave` bindings (266-267).
- [ ] Remove props `glimpseChannelId`, `onChannelGlimpseHover`, `onChannelGlimpseCancel` (37-39). Keep the alt+middle-click `on:auxclick` (268-273) and the tooltip (274).

### 6.2 `frontend/src/lib/components/ChannelSidebar.svelte`
- [ ] `handleChannelButtonClick` alt path: compute `rect = (e.currentTarget as HTMLElement).getBoundingClientRect()`, then same-channel → `closeChannelGlimpse()`, else `openChannelGlimpse(id, rect)`. Delete `toggleChannelGlimpse`'s rect-less form and `handleChannelGlimpseHover` (:122).
- [ ] `openChannelGlimpse`: position per this sketch (fixes bugs 2 and 6):
  ```ts
  const width = Math.min(320, Math.round(window.innerWidth * 0.56));
  const maxH = Math.min(420, Math.round(window.innerHeight * 0.6));
  const flipLeft = get(layoutStore).navDock === 'right';
  const x = flipLeft
    ? Math.max(8, anchorRect.left - width - 12)
    : Math.min(anchorRect.right + 12, window.innerWidth - width - 12);
  const y = Math.max(8, Math.min(anchorRect.top - 6, window.innerHeight - maxH - 12));
  ```
- [ ] **R1:** replace the `if (!(…length))` guard at :119 with an unconditional `joinChannel(channelId)`. Update the hydration comment (it currently describes the hover flow).
- [ ] **Bug 3:** derived becomes store-reactive and chat-ordered:
  ```ts
  $: glimpseChannelMessages = glimpseChannelId
    ? ($channelMessages[glimpseChannelId] || [])
    : [];
  ```
  (drop `.reverse()` AND any client-side count cap — §2 says render everything the socket delivered. Persisted joins are bounded at 50 server-side (`presence.rs:841`); live-room joins return the full session cache up to `live_channel_cap` (`presence.rs:806-830`, default 1000) — the `max-height` scroll box absorbs large windows, so do not re-add a `slice()`.)
- [ ] Auto-scroll to bottom: `let glimpseMessagesEl: HTMLElement | null = null` + `bind:this` on `.channel-glimpse-messages`; on `glimpseChannelId`/length change, `void tick().then(() => { if (glimpseMessagesEl) glimpseMessagesEl.scrollTop = glimpseMessagesEl.scrollHeight; })` (`tick` is already imported).
- [ ] **Bug 4:** the `onScroll` closer (in `onMount`, :259) must ignore scrolls whose target is inside the popout:
  ```ts
  const onScroll = (e: Event) => {
    if (!glimpseChannelId) return;
    const t = e.target as Node | null;
    if (t && glimpsePopover?.contains(t)) return;
    glimpseChannelId = null;
  };
  ```
  Outside-`pointerdown` and `Escape` dismissal stay as-is.
- [ ] **R2 / bug 5:** markup branches on `Array.isArray($channelMessages[glimpseChannelId])`: `undefined` → "Loading recent messages…", `[]` → "No recent messages", else the list. Keep "N recent" count in the header (N = rendered count). **Note:** the header `<small>` has its own ternary (`ChannelSidebar.svelte:1133`) that currently shows 'Loading…' on empty — update it with the same three-state logic (hydrated-but-empty should read "No recent" or "0 recent", not 'Loading…'), not just the body branch.
- [ ] Header `#name` becomes a clickable affordance (`on:click` → `handleChannelClick(glimpseChannel.id)` — navigates and closes the peek); keep the Follow button.
- [ ] Remove `glimpseChannelId` / `onChannelGlimpseHover` / `onChannelGlimpseCancel` from **both** `<UnifiedChannelList>` instantiations (:1097, :1101).

### 6.3 CSS
- [ ] `sidebar-core-part1.css`: `.channel-glimpse-popout.channel-glimpse-fixed` → `display: flex; flex-direction: column; overflow: hidden;` (keep `max-height: min(420px, 60vh)`; content grows up to it, so short channels don't get a forced-tall box). `.channel-glimpse-messages` → `flex: 1 1 auto; min-height: 0; overflow-y: auto;`. Add a minimal style for the clickable header name (button reset + hover accent).
- [ ] `sidebar-compact.css:67-71` is now inert for the fixed variant (JS flips sides). Leave it or delete it — do NOT rely on it.

### 6.4 Not changes
- `frontend/src/lib/components/FollowingFeed.svelte:111` hint text ("Alt-click a channel there to glimpse it") remains accurate — no edit.
- Legacy unimported channel lists, backend, `packages/wabi-protocol` — untouched.

## 7. Verification

1. `cd frontend && bun run check` — 0 errors.
2. Real browser only (golden rule 7 — headless cannot render Wabi):
   - Alt-click a spammy channel → popout anchored beside the row, chat-ordered, dozens of messages, opens scrolled to the bottom; scrolling *inside* the list does **not** close it; Escape / outside pointerdown / scrolling the channel list do; alt-click the same channel toggles off; alt+middle-click works; clicking the header name navigates.
   - Hover a channel for 2+ s → **nothing** opens.
   - Nav docked right → popout opens to the *left* of the row. Compact sidebar alone does **not** flip — opening rightward over the main area is intended (it clamps on-screen; only dock-right risks going off-window).
   - **Ghost-check (the steer):** set a channel's auto-delete to a short preset (channel settings; sub-day presets exist 5 s–24 h), post a few messages, visit the channel, wait out the TTL, then alt-click it from elsewhere → the expired messages must NOT appear (store key resolves to `[]` after re-hydrate → "No recent messages").
3. No `cargo` work needed; no tests required beyond `bun run check` for this UI-only change (frontend has no component-test harness for the sidebar).

## 8. Hazards / gotchas

- `ChannelSidebar.svelte` is **legacy-mode** Svelte (`$:` reactive statements, event directives) — match that idiom in-file; runes rules apply to *new* components, not to edits here.
- Do not reintroduce hover-dwell "as a feature flag" — the user explicitly rejected hover as a trigger.
- Keep the popout `position: fixed` (it escapes the channel-list scroll clip); the scroll-closer exemption (6.2) is what makes an internally-scrollable fixed popout possible.
- If a join reply never arrives (dead socket), "Loading…" persists by design — acceptable; do not fake content.
