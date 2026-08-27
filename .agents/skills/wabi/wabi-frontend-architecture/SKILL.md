---
name: wabi-frontend-architecture
description: "Wabi frontend architecture patterns: surface routing, layout shell, right-panel system, and how mature standalone modules are isolated and merged into the main app. Use when refactoring the SvelteKit frontend, integrating standalone routes like `/business` into the main workspace, or renaming/resurfacing modules without duplicating state."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, frontend, sveltekit, architecture, routing, surfaces]
---

# Wabi Frontend Architecture

## Multi-issue cleanup triage

When a user reports several frontend problems at once, do not bundle implementation immediately. First trace each symptom to its actual frontend/backend boundary and classify it as **correctness/data integrity**, **persistence**, **navigation**, or **polish**. Prioritize correctness and persistence issues before navigation polish, then record the remaining items in a durable task list so none are silently dropped.

**Execution discipline:** keep the user-facing interaction in English only. For a large regression list, keep moving autonomously unless a product decision genuinely blocks the next safe fix; do not repeatedly ask the user to choose between obvious bounded slices. Separate `implemented`, `build-verified`, `runtime-smoked`, and `deployed` statuses. Do not claim the entire list is complete after a successful build or health check. When the user says `continue`, act immediately; do not offer a menu. For Ronin's Wabi work, prefer batches of 2–4 tightly related fixes, then build/deploy for visual confirmation rather than forcing one-by-one browser checks. For concurrent WIP, never turn a clean-build stash into a silent destructive operation: announce the stash, restore it after deployment, and if committed/untracked collisions occur, preserve the stash and report the exact remaining files.

**Persistence verification:** when a UI reorder appears correct until reload, trace the complete event chain: client payload → Socket.IO handler → durable event names → projection subscription → bootstrap query → client normalization → grouping/sort. A handler can write events successfully while the projection silently ignores those event names. Add the event aliases to the projection and test both `parent_id` and `position`; also persist the last selected channel separately from server channel metadata so reload restores the user's screen without changing server authority. Confirm the projection test exercises the exact event aliases, and never rename the local parsed payload variable without updating all subsequent field accesses.

**User corrections from Wabi regression work:** profile/settings changes must be explicit and composited, not dead-looking forms: show a live card preview with clearly labeled Profile picture, Profile banner, and Avatar overlay upload controls; show `@handle` rather than internal `#id` fragments; compress membership metadata into muted supporting text; represent online state primarily with a status dot and tooltip. Channel row actions (pin/follow/settings/voice controls) are progressive-disclosure controls: hidden by default, visible on row hover or keyboard focus. Do not let later generic or voice CSS override that rule.

**Media/GIF/emoji UX:** GIF mode must visibly identify itself as GIF search and keep its own scrollable result area. Emoji and stickers are distinct UI modes, but their search should use human-facing aliases/search concepts rather than raw asset filenames or generated IDs. Typed emoji suggestions should be prefix/semantic matches for real emoji entries, excluding stickers unless an explicit product decision merges the taxonomies. Preserve source filtering and paginate large datasets.

**Progressive disclosure:** message reaction/action bars and channel-row pin/follow/settings actions should be hidden by default and revealed on row hover or keyboard focus; mobile long-press may explicitly add a visible class. Inspect all imported/shared CSS layers because a later generic rule such as `opacity: 1` can override the component rule. For alternate-click features, bind the behavior to the full interactive row/button and handle auxiliary-click browser paths when needed.

**Deployment + visual confirmation:** after a deploy, distinguish build/live health from browser visual confirmation. The user's visual check is the gate for accumulated UI batches; don't claim visual completion from `/health` or a matching binary SHA alone.

**When a user says “continue,” continue without another menu.** Choose the next bounded correctness or persistence item, state the scope briefly, and act. Ask only when an unresolved product decision would materially change the implementation; otherwise defer it explicitly and keep working. If a worker or tool drifts, stop it and verify the real tree before proceeding.

**Dirty-tree/OpenCode rule:** OpenCode is optional assistance, not the execution plan. Use it only for a bounded, disjoint file scope; stop it when it explores without producing a scoped diff, and verify the actual changed paths rather than trusting its report. Before deploying a dirty Wabi tree, announce the stash name and file class, preserve/restore concurrent WIP, and never silently bake unrelated whiteboard/lore/channel work into a regression deploy. If stash restoration collides because files became committed, preserve the stash and report exactly what remains rather than deleting or force-restoring files.

**Media regression rule:** trace file picker → preview → classification/MIME → upload endpoint → attachment record → renderer. Browser MIME may be empty or unreliable, so filename fallback is required for previews/gallery filtering. Do not classify `audio/webm` by `.webm` alone; recorded WebM audio needs an audio-aware extension/MIME path and must not enter video compression. Use proper media MIME values in `<source>` elements, not `audio/<extension>` or `video/<extension>` strings.

**Async projection rule:** when an API command commits an event and immediately reads its projection (albums, wiki, or similar WabiDB surfaces), expect eventual consistency. Use the authenticated actor ID, wait/retry briefly for the projection, and return a truthful readiness error if it still is not visible. Normalize snake_case wire responses and microsecond timestamps at the API boundary before rendering them; otherwise UI labels such as `Updated unknown` and empty galleries mask a data-contract bug.

For profile media, distinguish the three concepts explicitly in both code and UI: **profile picture/avatar** (the circular identity image), **profile banner** (wide background), and **avatar overlay/frame** (decorative layer). Never infer the upload's purpose from placement alone. Verify each upload's endpoint and persistence path separately; a localStorage or optimistic in-memory fallback is not durable server persistence.

When reporting findings, separate confirmed code facts from proposed fixes. If the user has only asked to add an item to the backlog, update the task list and do not imply that any fix is implemented or live.

## Project layout conventions

- Frontend lives under `frontend/`.
- App shell is SvelteKit: `frontend/src/routes/+page.svelte` owns auth/bootstrap and mounts `LayoutRouter`.
- `LayoutRouter.svelte` picks the main workspace surface.
- Main chrome lives in `frontend/src/lib/components/MainLayout.svelte` (server rail, channel sidebar, right panel, mobile backdrops).
- Right panel is tab-stacked: `MainLayout.svelte` + `RightPanel.svelte` + `rightPanelHelpers.ts`.

## Surface routing pattern

Mature UIs are often isolated as standalone routes first and only later brought into the main shell.

Typical standalone-surface shape:
- `frontend/src/routes/<surface>/+page.svelte` — shell + tabs
- `frontend/src/lib/<surface>/` — stores, state, sync, types
- `frontend/src/lib/components/<surface>/*.svelte` — view components
- Optional theme file: `frontend/src/lib/<surface>/theme.css`

## Standalone-module isolation lifecycle

1. **Standalone route** — the module mounts under `/surface` with its own layout, stores, and often optional chat sidepanel.
2. **First-class surface** — `LayoutRouter.svelte` / `MainLayout.svelte` gain a route/view mode so the surface lives inside the normal auth shell.
3. **Panelization** — views from the surface are also exposed as right-panel tabs or split panes.
4. **Phased-out route** — `/surface` becomes an alias/redirect into the same panel/state. Old route kept until redirects verified.

## Merging a standalone surface into main (v1 pattern)

### P1 Route anchors
- Add a main view mode in `LayoutRouter` or `MainLayout` that activates the surface.
- Move the surface's stores into a layout-safe import path; keep them localStorage-first until backend persistence is ready.
- Preserve all views from the standalone page; do not dumb down in the name of "integration."

### P2 Sidebar / right-panel anchors
- Right panel accepts new tab stacks/drawer entries (`layoutStore.openRightPanel`, `setActiveRightPanel`).
- Surface tabs can either:
  - replace the center channel view, or
  - live as pinned right-panel stacks.

### P3 Legacy route decrement
- Keep `/surface` as a soft redirect into the same view/state once P1/P2 are proven.
- Remove the standalone route file only after validated redirect.

### P4 Cleanup
- Remove duplicated shell code.
- Reconcile surface theme CSS with global tokens (`theme.css`, `buildTokens.ts`).

## Verified Planner/Business merge recipe

This section encodes the tested path from `/business` → main-app `Planner` workspace.

1. Create `frontend/src/lib/plannerWorkspace.ts` with `PLANNER_ADDON_ID` and `openPlannerSurface()` using `mobileTabQueue.openAddonTab(PLANNER_ADDON_ID)`.
2. Create `frontend/src/lib/components/business/PlannerWorkspace.svelte`:
   - Use Svelte 5 runes: `$props()` for props, `$state()` for local state, `$derived()` for derived values. Do NOT use `export let` or `$:` reactive statements; `svelte-check` fails on them.
   - Import existing business views (`Calendar`, `KanbanBoard`, `DiaryView`, `ProjectsView`, `TaskPanel`) and the new `plannerWorkspace.ts`.
   - Import scoped styles from `PlannerWorkspace.css`; map onto main app tokens, do NOT re-add a separate `--biz-*` theme.
3. Register in `MainLayout.svelte` alongside `MapWorkspace`, `ReaderTab`, `MediaAlbumsTab`, `ModelViewportTab`:
   - import `PLANNER_ADDON_ID`
   - add `PLANNER_TAB_TOKEN = mobileTabQueue.toAddonTabId(PLANNER_ADDON_ID)`
   - add `isPlannerTabActive` derived flag
   - conditionally render `<PlannerWorkspace variant="full" />`
   - register/unregister addon tab in `onMount`/`onDestroy`
4. Convert `frontend/src/routes/business/+page.svelte` to a lean redirect page: title, noindex, no standalone shell.
5. Add workspace view entry buttons in `frontend/src/lib/components/chat/ChatHeader.svelte`, not in `ChannelSidebar.svelte` or `ServerRail.svelte`. `ChatHeader` already owns the Messages/Whiteboard/Media/Reader/3D/Map pill bar from `chat/types.ts:WorkspaceViewKey`. Follow that pattern even for center-stage add-ons like Planner. Do NOT add duplicate sidebar buttons for a center-stage workspace; the user notices and will undo it.

### Surface naming

The user-facing name for the merged business module is **Planner**, not Business. Use "Planner" in titles, rail/sidebar labels, and route metadata. The internal prefix `PLANNER_ADDON_ID = 'planner'` is fine; do NOT rename it to `business` in code.

## Workspace views must NEVER softlock — shared WorkspaceViewBar (2026-08-06)

**Rule (Ronin, explicit):** every center-stage workspace view (Reader, 3D Model Viewer, Map, Media Albums, Planner, Notes) must have a visible way back to Messages. "Reloading is the only way to get out" is an unacceptable bug class.

**How the softlock happened:** the view-pill bar (Messages/Whiteboard/Planner/Notes/Media/Reader/3D/Map) lived ONLY inside `ChatHeader.svelte`. When MainLayout renders a full workspace view (`isReaderTabActive` → `<ReaderTab />` etc.) it REPLACES `<Chat />` entirely — taking ChatHeader's pill bar with it. ModelViewportTab/MediaAlbumsTab/MapWorkspace/PlannerWorkspace had ZERO back affordance of their own → softlock.

**The fix — shared `WorkspaceViewBar.svelte`** (`frontend/src/lib/components/WorkspaceViewBar.svelte`):
- Presentational component (no stores): props `activeView: string`, `onSelectView: (view) => void`, `showReturnToMessages?`. Renders the "Messages" return button + all 8 `.view-open-btn` pills with the exact ChatHeader SVGs.
- MainLayout mounts it ABOVE the `{#if isModelViewportTabActive ...}` chain, guarded by `{#if isModelViewportTabActive || isReaderTabActive || ...}`, so every full view gets the bar. `handleWorkspaceViewSelect` maps pills → `mobileTabQueue.openAddonTab(ADDON_ID)`; 'messages'/'whiteboard' → `closeAllAddonTabs()` helper (closes all six addon tabs).
- ChatHeader refactored to use the same component (deletes ~130 duplicated lines). Svelte 5 runes `$props()` + `onclick` are fine in the new component; repo's older components use `export let` + `on:click` — either compiles.

**No fullscreen takeovers** (same session, same principle): the notes "Expand" button used to open a `centerPanelView === 'notes'` stage that replaced the ENTIRE app shell. Ronin: a full-screen stage is wrong — an expand/zoom button should open a **pill in the main channel viewer**, not take over the screen. Fix pattern: register Notes as another `mobileTabQueue` addon tab (mirror `plannerWorkspace.ts` → `notesWorkspace.ts`), add `'notes'` to `WorkspaceViewKey` in `chat/types.ts`, render `<KeepNotesView />` in both Chat.svelte's `selectedWorkspaceView` chain and MainLayout's chat-surface chain, add a Notes pill in ChatHeader, and DELETE the fullscreen stage branch + its CSS. General rule: workspace views live in the chat-surface area (sidebar + right panel stay visible); fullscreen centerPanelView stages are reserved for admin only.

**Quick panel light-switch tabs** (same session): the bottom-right QuickResourcesPanel Notes/DM tabs should toggle each other — clicking the ACTIVE tab switches to the OTHER one (`activeTab === 'notes' ? 'dm' : 'notes'`), so flipping between them doesn't require precision-clicking.

## MainLayout resize drag — window listeners are load-bearing (2026-08-06)

Both the channel-sidebar resize handle (`.resize-handle-channel`) and the right-panel handle (`.resize-handle-right`) work by setting a store flag on `mousedown` (`layoutStore.isResizingChannel/Right.set(true)`), then a local `resizingX` boolean subscribed from the store, then `handleMouseMove`/`stopResize` reading those booleans. **The bug:** `handleMouseMove`/`stopResize` were defined but NEVER attached — `window.addEventListener('mousemove', ...)` was missing entirely from MainLayout's `onMount`, so the handles set the flag and nothing ever tracked the pointer. Result: right panel (and channel sidebar) could not be dragged to resize AND could not be drag-closed (the `< 50px → width 0` close logic in `stopResize` never ran).

Fix: in MainLayout `onMount` add `window.addEventListener('mousemove', handleMouseMove)` + `window.addEventListener('mouseup', stopResize)`; mirror `removeEventListener` in `onDestroy`. If a panel "can't be dragged or closed by dragging," grep for the window-listener wiring BEFORE touching CSS or store logic — the handlers and store plumbing may be fully present and the wiring is the only missing piece.

Standalone surfaces often ship with `theme.css` scoped to the surface root. After moving into `MainLayout`, global classes from chat/other surfaces can collide. Mitigation:
- Prefix surface classes (`business-*`, `calendar-*`) rather than generic names.
- Scope `theme.css` through a container data attribute or wrapper class.
- Move shared tokens into `theme/palettes.ts` / `theme/buildTokens.ts` before unifying.

## Known risk: localStorage persistence at scale

Standalone modules often persist to `localStorage` (snapshot JSON). Valid for small datasets, but quota errors occur under large inputs. Plan for:
- Snapshot compression before save.
- Chunked snapshots or server persistence for >1 MB datasets.
- Graceful quota failure handling (`try` around `setItem`, fallback to in-memory with warning).

## DM channels require explicit `joinChannel()` at every open path (2026-08-07)

DM/group channels do NOT auto-join the socket room on creation or selection. The server echoes messages via `io.to(channel_id).emit("message", ...)`, which only reaches clients **joined to that room**. If the client never calls `joinChannel(channelId)`, sent messages appear optimistically but the server echo is never received — the message "disappears" from the view.

**Every DM open path must call `joinChannel(channelId)` after the layout state change:**
- `socketConnectionCore.ts` — auto-join on `dm-created`, `dm-channel-added`, `group-created`, `group-channel-added` events (server-side DM creation)
- `DmHub.svelte` — `openInCenter()`, `openInSidePanel()`, `handlePersonSelected()`
- `DMTab.svelte` — `selectConversation()`
- `DmConversationView.svelte` — reactive `$: if (channelId) joinChannel(channelId)` (catches prop-driven re-opens)
- `QuickResourcesPanel.svelte` — `openFullDms()`
- `MainLayout.svelte` — `openUnreadDM()`
- `+page.svelte` — `dmPanelSignal` reactive

**Audit pattern:** search for `layoutStore.openDM`, `layoutStore.openCenterDm`, `layoutStore.openGroupDM`, `layoutStore.openCenterGroupDm` — every call site should be followed by `joinChannel(channelId)`.

**`closeDM()` must clear BOTH right-panel AND center-panel state.** Prior bug: `closeDM()` cleared `selectedDmChannelId` but NOT `centerDmChannelId`, so a DM opened in center panel stayed "sticky" — `MainLayout` kept rendering the center-DM layout even after clicking back to channels. Fix: `closeDM()` now calls `centerDmChannelId.set(null)` in addition to clearing `selectedDmChannelId`, `dmOtherUser`, and `selectedGroupChannel`.

See `references/dm-socket-room-join.md` for full audit trace and fix diff.

## Svelte 5 event syntax — `onclick` not `on:click` (2026-08-07)

In Svelte 5 runes components, ALL event handlers use the new `on` prefix (not `on:`):
- `onclick` (not `on:click`)
- `onchange` (not `on:change`)
- `onscroll` (not `on:scroll`)
- `onkeydown` (not `on:keydown`)
- `oninput` (not `on:input`)

**CRITICAL EXCEPTION:** `<svelte:window>` and `<svelte:document>` still use the OLD `on:` syntax:
```svelte
<svelte:window on:keydown={handler} />  <!-- CORRECT — svelte:window is special -->
<div onclick={handler}>  <!-- CORRECT — regular elements use new syntax -->
```

**Modifier syntax:** use `onclick={(e) => e.stopPropagation()}` (not `onclick|stopPropagation` which is a TypeScript error — `"onclick|stopPropagation"` is not a valid property name).

**Why this matters:** `svelte-check` emits deprecation warnings for `on:click` on regular elements, and `onclick|stopPropagation` produces a hard TS error. OpenCode workers (deepseek-v4-flash-free) default to `on:click` since most training data is Svelte 4. If dispatching frontend work, the prompt must explicitly state: "Use Svelte 5 `onclick` syntax (not `on:click`), except `<svelte:window>` which still uses `on:keydown`."

Observed 2026-08-07: Reader P1 worker produced 11 `on:click`/`on:change`/`on:scroll` instances + converted `<svelte:window on:keydown>` to `onkeydown` (which is wrong). All had to be fixed in-session.

## Registering a NEW right-dock workspace panel (2026-08-08)

The dock is registry-driven. Adding a panel (e.g. the lore **Code** panel) touches EXACTLY four places — no more:

1. `frontend/src/lib/workspacePanels.ts`:
   - Add `'code'` to the `WorkspacePanelComponentKey` union (line ~23).
   - Add a manifest to `BUILTIN_WORKSPACE_PANELS` (`id`, `label`, `shortLabel`, `icon` from `WorkspacePanelIcon` union — `'box'` exists, `component: 'code'`, `capabilities: ['repo-browse']`, `defaultDock: 'right'`, `mobileMode: 'sheet'`, `source: 'core'`, `sortOrder`). `WorkspacePanelId` is just `string` (layoutConstants.ts) so any id string is valid — no id-union edit needed.
   - Add `'code'` to `KNOWN_COMPONENT_KEYS` (line ~181). MISSING THIS = silently falls through to `AddonFallbackPanel`.
2. `frontend/src/lib/components/WorkspacePanelHost.svelte`: `{:else if panel.component === 'code'}` branch rendering the panel component + import.
3. New panel component (e.g. `frontend/src/lib/components/lore/LoreCodePanel.svelte`): Svelte 5 runes (`$state`, `$derived`, `$props`), reads stores directly, small self-contained `<style>` (right dock is ~320px wide — tree on top, viewer below, `min-height: 0` + `overflow` everywhere).
4. Svelte 5 event syntax in new components: `onclick` not `on:click`; `oncontextmenu` not `on:contextmenu` (mixing old `on:` + new syntax on the SAME element is a hard svelte-check error `mixed_event_handler_syntaxes`).

**Pattern for lore panels:** reuse the shared stores (`loreRepo`/`loreFiles` from `$lib/loreStore`) + `loadLoreRepo()` + `getSignedLoreUrl(token, parseLoreChannelId($currentChannel), path)` — do NOT re-fetch inside the panel. Empty state when no repo; refresh button; context-menu intentionally no-op in read-only panel (full menu lives in center-stage `LoreChannelShell`).

**Auto-open on channel type is NOT wired:** there is no established channel-type→panel pattern; the panel just appears in the dock. Flag with the user if auto-open is wanted.

## Reader design TLC — complete (2026-08-07)

Reader is a full workspace view (`READER_ADDON_ID` addon tab). All 5 phases completed, pending deploy:

- **P1** (toolbar restructure): slim icon-only toolbar (~44px), title/meta moved into `.reader-article-header`, 3px reading progress bar, collapsible settings panel (gear icon), focus mode with `f` key toggle, Svelte 5 runes migration. Committed `2bf58ac`.
- **P2** (empty state): stripped explainer card to 4 import buttons only (Open File / Open Images / Paste Markdown / Paste Text), glass styling. The feature explains itself through what you can load — no "What is Reader Mode?" card.
- **P3** (horizontal reading mode): `ReadingDirection` now includes `'horizontal'` (alongside `ltr`/`rtl`). Continuous horizontal scroll container for images with snap scrolling, wheel→horizontal translation, arrow key nav, progress bar in horizontal mode. Auto-switches to horizontal when importing images via `openReaderImagesFromFiles`. CSS: `.reader-horizontal-scroll` (flex, `overflow-x: auto`, snap-x, `height: calc(100dvh - 60px)`), `.reader-horizontal-page`, `.reader-horizontal-img`. Critical for comics/webtoons/books.
- **P4** (typography): drop-cap on `.reader-document > p:first-of-type::first-letter`, heading rhythm (h1-h6 with clamp sizes, h1/h2 border-bottom), paragraph spacing (`1.2em 0`, `1.75`), per-theme `::selection` colors, code copy buttons on `<pre>` (Clipboard API + "Copied" feedback), softened paper card (16px radius, softer shadow), polished blockquote, stage vignette.
- **P5** (theme derivation): `ReaderTheme` includes `'auto'` (default). Auto resolves via `window.matchMedia('(prefers-color-scheme: dark)')` → night/paper. Clean semantic token mapping: paper/night derive from app tokens (`--surface-app`, `--surface-base`, `--text-primary`, `--accent-primary`), sepia is warm-hardcoded. Replaced `--text-warning`-as-background hack. WCAG AA contrast verified.

**Files:** `ReaderTabImpl.svelte`, `readerWorkspace.ts`, `reader-tab.css`
**Plan:** `docs/plans/reader-design-tlc.md`
**Golden rule:** sunburst gear SVG (`M19.4 15a1.65`) is FORBIDDEN — use proper cog icon with teeth (Lucide/Feather style).

## OpenCode dispatch lessons (2026-08-07)

**Worker scope drift is common and must be scrubbed.** OpenCode workers (deepseek-v4-flash-free) frequently modify files outside the explicitly listed scope. Observed this session:
- P3 worker (horizontal reading) drifted into `PlannerWorkspace.css` and `PlannerWorkspace.svelte`
- P4+P5 worker drifted into `CalendarImpl.svelte`, `DiaryView.svelte`, `KanbanBoardImpl.svelte`, and a lore doc

**Recovery pattern:** after worker exits, run `git diff --stat` and compare against the expected file list. Checkout any out-of-scope files: `git checkout -- <out-of-scope-paths>`. This is a mandatory verification step before committing worker output.

**Prompt discipline:** always list "Files to modify" and "Files to NOT touch" explicitly in the prompt. Even with explicit lists, workers may drift — verify after.

## Mobile shell wiring — data-shell, keyboard inset, safe-area ownership (2026-08-08)

Mobile is ONE SPA, two skins (no separate site). The shell branch happens on `<html>` attributes so first paint skips desktop chrome:

- **Early flag in `frontend/src/app.html`** — inline `<script>` in `<head>` sets `documentElement.dataset.shell = 'mobile'|'desktop'`, `dataset.displayMode = 'standalone'|'browser'`, classes `is-mobile-shell` / `is-pwa-standalone`. Runs BEFORE the Svelte bundle so CSS can branch pre-hydration.
- **`frontend/src/lib/pwa/mobileShell.ts`** — `startMobileShell()` called once in `+layout.svelte` `onMount` (cleaned up in `onDestroy`). Subscribes `isMobile` → re-applies `data-shell`; listens `display-mode` changes; and **tracks the on-screen keyboard** via `window.visualViewport`: sets `--keyboard-inset` px custom property + `data-keyboard-open="1"` when inset > 80px.
- **`frontend/src/styles/components/mobile-shell.css`** — imported AFTER `mobile-breakpoints.css` in `styles.css` (cascade order wins). Owns the *polish*: glass bottom nav, `--mobile-nav-bar` (56px content row) + `--mobile-nav-height` (incl. `env(safe-area-inset-bottom)`), active-tab glow, sheet/backdrop blur, chat-header glass, composer thumb targets.
- **Safe-area ownership rule (no double-counting):** when the bottom nav is VISIBLE it owns the home-indicator inset; the composer's `padding-bottom` is plain `0.4rem`. Only when nav is hidden (`.app-container:not(.mobile-nav-visible)`) or keyboard is open (`html[data-keyboard-open='1']`) does the composer add `env(safe-area-inset-bottom)`. `html[data-keyboard-open='1']` also hides `.mobile-bottom-nav`/`.mobile-nav-grabber` and shrinks `.app-container` by `--keyboard-inset` so the composer sits above the IME.
- **4-tab nav lives in `MainLayout.svelte`** — handlers `openMobileChat` / `openMobileBrowse` / `openMobileMessages` / `openMobileYou` (close sheets, set `activeView` / `showMobileChannels` / `showSettings`), plus `pushState` per sheet and a `popstate` handler (Settings → Browse → right overlay → DM → exit) for Android back. i18n keys `shell.mobile.{chat,browse,messages,you}` in `en.json`/`es.json`.
- **Deep links from push:** SW `notificationclick` posts `{type:'wabi-navigate', payload}` to the focused client OR opens `/?wabiNav=...`; `frontend/src/lib/pwa/deepLink.ts` parses and dispatches a `wabi:navigate` CustomEvent; MainLayout listens and applies view/channel/dm/settings.

**Peer-wipe hazard:** these files were wiped TWICE by the concurrent peer session (untracked new files + `app.html`/`styles.css` edits revert silently). Before trusting a mobile build, verify: `ls frontend/src/lib/pwa/` (expect 5 files incl. `mobileShell.ts`), `frontend/src/styles/components/mobile-shell.css` exists, `app.html` has the `data-shell` script, `styles.css` imports `mobile-shell.css`. Ship proof in deployed bundle: `dataset.shell` in `index.html`, `data-keyboard-open` + `mobile-nav-bar` in the hashed CSS, `shell.mobile.browse` in a JS chunk.

## References

- `references/business-module-isolation.md` — `/business` standalone surface layout, stores, views, and peer components.
- `references/routing-surface-pattern.md` — `+page.svelte`, `LayoutRouter.svelte`, `MainLayout.svelte`, and `RightPanel.svelte` routing relationships.
- `references/dm-socket-room-join.md` — DM socket room join pattern, every open path that must call `joinChannel()`, and the `closeDM()` sticky-state fix.
