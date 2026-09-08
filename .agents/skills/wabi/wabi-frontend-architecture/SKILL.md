---
name: wabi-frontend-architecture
description: "Wabi frontend architecture patterns: surface routing, layout shell, right-panel system, and how mature standalone modules are isolated and merged into the main app. Use when refactoring the SvelteKit frontend, integrating standalone routes like `/business` into the main workspace, or renaming/resurfacing modules without duplicating state."
license: MIT
metadata:
  version: 1.0.0
  author: Hermes Agent
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

**Projection acknowledgment rule:** WabiStore adapter commands now wait for whole-command projection application (2026-09-05 write-completion work). Do not add handler polling to compensate for a missing post-write projection: investigate event/dispatch/completion instead, and report invariant failure truthfully. Normalize snake_case wire responses and microsecond timestamps at the API boundary before rendering them; otherwise UI labels such as `Updated unknown` and empty galleries mask a data-contract bug.

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
5. Add the workspace to `WorkspaceViewBar.svelte`, `workspaceNavigationState.ts`, and the `MainLayout.svelte` render chain. The persistent center-pane picker owns discovery/navigation; do not duplicate it in ChatHeader, ChannelSidebar, or ServerRail. See the ownership rules below.

### Surface naming

The user-facing name for the merged business module is **Planner**, not Business. Use "Planner" in titles, rail/sidebar labels, and route metadata. The internal prefix `PLANNER_ADDON_ID = 'planner'` is fine; do NOT rename it to `business` in code.

## Workspace views must NEVER softlock — shared WorkspaceViewBar (2026-08-06)

**Rule (Ronin, explicit):** every center-stage workspace view (Reader, 3D Model Viewer, Map, Media Albums, Planner, Notes) must have a visible way back to Messages. "Reloading is the only way to get out" is an unacceptable bug class.

**How the softlock happened:** the view-pill bar (Messages/Whiteboard/Planner/Notes/Media/Reader/3D/Map) lived ONLY inside `ChatHeader.svelte`. When MainLayout renders a full workspace view (`isReaderTabActive` → `<ReaderTab />` etc.) it REPLACES `<Chat />` entirely — taking ChatHeader's pill bar with it. ModelViewportTab/MediaAlbumsTab/MapWorkspace/PlannerWorkspace had ZERO back affordance of their own → softlock.

**Current ownership (2026-09-08):** `MainLayout` mounts one persistent `WorkspaceViewBar` above `.chat-surface`, outside the changing workspace branches. `ChatHeader` only owns channel-specific context/actions. Project and Files also render in the shell, not inside the chat message scroller.

- `workspaceNavigation.ts` resolves and selects all `WorkspaceViewKey` values using the existing addon queue, voice-view flag, and per-channel whiteboard state. `workspaceNavigationState.ts` wires production stores/IDs. Do not add a parallel persisted view store or a second switch statement.
- Addon selection wins over remembered channel surfaces. Messages/Whiteboard/Calls select the actual current channel once; they do not close a hardcoded list of addons and repeatedly choose fallbacks. Returning to Messages clears the current board/voice view without erasing other open tabs. Voice navigation must not change media ownership.
- The labeled picker is explicit (click/tap/keyboard), not hover-revealed. It keeps its trigger mounted, restores focus on selection/Escape, dismisses outside/on window blur, and fits the available center pane. Reserve the Messages-return slot. Do not restore unconditional selection blur or the old invisible icon strip.
- Full-height workspace roots live below navigation and above the existing call layers. Keep sidebar/docking/customization intact; Notes and other ordinary workspaces must not become fullscreen admin stages.
- Run `bun test src/lib/workspaceNavigation.test.ts` and, after checks/builds, `node scripts/workspace-browser-smoke.mjs`. The latter uses the full app and an isolated local release server in headful Chromium, never a live account. It needs an existing `target/release/wabi-server`; it does not prove native Tauri or external Lore operation.

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

**2026-09-07 membership boundary:** retain the shared `channelStore.joinChannel`
entry point: it first awaits `api/channelAccess.ensureChannelMembership`, then
emits only on the same socket generation (preserving Socket.IO buffering before
the initial handshake). Wiki/forum/gallery
feedback and album-scope loads use `fetchChannel` so content cannot race the
membership acknowledgment. Coordination coalesces in-flight requests only;
never cache permission indefinitely, self-join DMs on the server, or hide a
403 as an empty workspace. Keep multiple DM/workspace surfaces independent.

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

The same Svelte 5 event attributes also work on `<svelte:window>` and `<svelte:document>`:
```svelte
<svelte:window onkeydown={handler} />
<div onclick={handler}>  <!-- CORRECT — regular elements use new syntax -->
```

**Modifier syntax:** use `onclick={(e) => e.stopPropagation()}` (not `onclick|stopPropagation` which is a TypeScript error — `"onclick|stopPropagation"` is not a valid property name).

Use Svelte 5 event attributes consistently in new/runes components. The older
advice that `svelte:window` requires `on:` was incorrect; CreateGroupModal's
`onkeydown` is compiled and headful-browser verified. Do not add modifier syntax
to event attributes or mix incompatible handler styles.

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

### Frontend polish and honest controls (2026-09-08)

- Message-store `sendMessage().ok` is a transport/local-queue handoff, not server
  acceptance. `MessageDeliveryRow` shows own-message pending/failure status;
  `messageDelivery.ts` owns the bounded attempt independently of composer mounts.
  Preserve the client nonce across acceptance, but only match it within the same
  sender: a peer echo/history snapshot must not replace local pending content.
  Do not restore the old persistence Retry button; it emitted into a no-op.
  Follow `wabidb-client-offline` for account-scoped receipts and reconnect races.
- ChatComposer is runes-based and keyed by account/channel at both Chat and
  DmConversationView mounts. `composerDraftState.ts` holds session-memory drafts,
  including selected File objects, separately for simultaneous center/dock
  editors. It never serializes private drafts to localStorage. Revocation clears
  every surface for that group; realm changes retire old editors. Save before
  revoking object URLs on teardown. An upload/split send captures its destination
  before awaits and cannot publish from a retired editor. Do not keep hidden
  capture components mounted just to preserve text.
  Preserve native File references outside `$state.snapshot`: it clones Files,
  breaking identity-based handoff settlement and File-keyed compression metadata.
  Snapshot mutable plain fields, then shallow-copy the selected File array.
- Settings and BaseModal use `actions/modalFocus.ts` for initial focus, Tab
  containment, one-layer Escape and opener restoration. Ancestor/global handlers
  must honor defaultPrevented. Opening Admin closes Settings; Back restores the
  app, not a hidden Profile tab.
- Admin role names are a read-only built-in catalog, not member counts or
  editable labels. Never implement a display-name command using membership
  assignment. Role commands require an online server receipt; old queued grants
  must not replay. See the full-polish plan for the wire and verification status.
- UI-16's pin test must exercise production layoutStore subscriptions and an
  acknowledged layout save before reload. Calling syncWorkspaceFromRuntime
  manually inside a test bypasses the missing wiring it is meant to detect.
  Startup/login/reconnect home-preference refresh is metadata, not an imperative
  panel-open command: saved layout (including a closed dock) owns restoration.
  Only explicit registration/Settings home choices apply the idempotent command.
- A setting is not functional merely because it writes a preference. Trace a
  consumer before exposing it; retain actual call/device controls and report
  unsupported server features instead of emitting into absent handlers.
- Server-wide Ban is unavailable: the old socket command never persisted or
  enforced exclusion. Do not restore its menu based on a successful emit or
  confuse role demotion with account revocation. Role Gates/reaction-role
  automation and public-channel minimum-role restrictions are also unsupported.
  Dashboard availability metadata distinguishes unknown counters from real zeroes.
- Pass reactive inputs across component boundaries explicitly. Stable callbacks
  closing over search/accordion state do not invalidate legacy child sections;
  derive callback identities from a captured filter snapshot, not forced remounts.

See `docs/plans/2026-09-08-full-frontend-polish.md` for scope and verification.

### Durable group client lifecycle (2026-09-08)

- Local `Channel` extends the generated protocol with explicit `ownerId` and
  decimal-string `membershipRevision`. Never infer owner from members[0], use
  floating-point revisions, or edit generated protocol files.
- `groupOperation.ts` waits for a correlated `group-operation-result`.
  `groupOperations.ts` coalesces duplicate requests on the same socket and retains
  uncertain creation IDs for explicit retry. Disconnect/destroy rejects pending
  work before removing listeners. Emitting/queueing is not successful membership.
- `groupMembership.ts` fences stale work by server/account, membership epoch and
  runtime realm generation. A newer explicit re-add permits new work but never
  revives an old lease. Capture before HTTP/import awaits and check on resumption.
- SocketManager filters old socket callbacks and removed-group content, applies
  versioned init/incrementals and tombstones, and refreshes selected group objects.
  `groupClientState.ts` clears only the removed group's stores/navigation; it must
  not close an unrelated center-stage DM or clear an unrelated voice roster.
- GroupSettingsPanel/CreateGroupModal use Svelte 5 runes, server-confirmed pending/
  error states and the offline registered-user directory. Async callbacks must
  tolerate the panel/props disappearing BEFORE the removal receipt resolves.
  Group avatars remain unsupported; do not show a working uploader.
- Group calls have a cancellable owner in `calling_impl_core.ts`, retained from
  start/answer through teardown. Admission acknowledgements precede capture;
  participant events cannot create an unrequested call. Preserve that owner
  across awaits and use `revokeGroupCall`, not the global call teardown, for
  removal. Background listen-only sessions are capture consumers too. Relay
  ownership must be retired before HTTP leave awaits; never let an old catch or
  finalizer delete a replacement. `audio-browser-smoke.mjs` includes real-capture/
  peer/relay race harnesses with generated media and fixture network boundaries.
- Video lanes and preview stores are session-owned too. Use session-indexed
  video stores (CallSessionManager IDs), not the flattened user-keyed legacy
  store, for call surfaces. Screen capture has an explicit destination and
  correlated server admission; never restore the first-relay subscription or
  the union-of-all-calls screen audience. Keep early ICE parking with captured
  scope/share identity (`callingIce.ts`), and retain P2P video when WebCodecs is
  unavailable. See `docs/architecture/CALLING_TRANSPORT_ARCHITECTURE.md` for the
  paired client/server wire change and verification boundaries.
- Run `node scripts/group-membership-browser-smoke.mjs` for production-module/UI
  wiring with fixture network peers and real IndexedDB under desktop CSP. The
  active membership plan records remaining call teardown/archive work; this UI
  checkpoint alone is not deployment readiness.

### Call reconnection ownership (2026-09-08)

SocketManager replaces the Socket.IO object. Notify `callSocketLifecycle` before
removing listeners, and readmit only after authoritative init. A room join on a
new socket cannot heal an old relay. Group/voice owners retire transports locally
without a delayed durable leave, then build new transports after correlated
admission; preserve capture, mute and per-session controls. Group readmission
pins the original membership revision and never rings new members. Do not mutate
an old call owner's socket or revive media from a roster/queue echo. The headful
`audio-browser-smoke.mjs /__call_reconnect` route covers these races; the no-argument
script runs the complete media regression set.
Sidebar listen/unlisten wrappers must use these call owners too, not raw
presence emits. Explicit listening is a join option; offline unlisten cancels
local intent even without a socket. Legacy voice queue rows cannot be replayed
over readmission, and manual Join during recovery coalesces with its owner.

Forced voice moves use that same readmission path: retire source media before
awaits, transfer socket ownership and primary/listener intent, and cancel earlier
destination work. Never restore the separate relay-only move implementation.
Forced kicks use scoped leave; the last capture consumer cancels pending
permission as well as live tracks. An ended microphone is reacquired only after
fresh admission. Use each call's returned fallback outcome for its transport
label, not the shared diagnostic another concurrent session can overwrite.
The `/__voice_ownership` headful route covers moves, kicks and permission races.
Initial join failure uses that scoped leave too: deleting a session from the
model alone left a real unanswered P2P connection open after timeout. Retire the
failed attempt's socket mapping so later moderator events cannot revive it.

Channel panel viewing is independent of transmit focus. Keep upstream second-click
toggle semantics, but Hang up must leave the displayed session (also while
offline), not a global foreground call. Closing is not leaving. Badge media must
be indexed by channel/session, not flattened by account. `/__call_panel` mounts
the actual CallModal and VoiceChannelList; the no-argument media runner includes
eight routes. Member lists are siblings of their channel headers, not children;
test selectors must follow the real DOM before diagnosing badge failures.

Identity stores live in the import-light `presenceIdentity.ts`; presenceStore
re-exports the same instances. Derived lookup stores must not obtain `users`
through the socket/command barrel: that circular dependency caused an actual
browser initialization failure when obsolete reconnect code was removed.

- `references/business-module-isolation.md` — `/business` standalone surface layout, stores, views, and peer components.
- `references/routing-surface-pattern.md` — `+page.svelte`, `LayoutRouter.svelte`, `MainLayout.svelte`, and `RightPanel.svelte` routing relationships.
- `references/dm-socket-room-join.md` — DM socket room join pattern, every open path that must call `joinChannel()`, and the `closeDM()` sticky-state fix.
