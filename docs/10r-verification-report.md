# 10R Verification Report — Read-Only Check

Scope: WAVE 10R claims from `docs/showcase-prep-kanban.md`, verified against actual source at `2f56f5d`. No edits made. Lore/L/W cards untouched.

## R1 — Bottom-right microview (notes + DM tabs, not quick-link launcher)
Status: **PRESENT / ACTIVE CONFLICT WITH SOURCE**
Evidence:
- `frontend/src/lib/components/QuickResourcesPanel.svelte:124` still renders `Quick launch` with 6 quick links including `dms` and `notes`.
- The claimed R1 state is partially implemented elsewhere via `notesStore`, `RightPanel`, `MainLayout` notes stage, and `NOTES_DM_ID` guards.
Conclusion: The “not quick-link launcher” intent is **not what ships**. The source still contains the old Quick launch launcher. This is the active regression you reported.

## R2 — Channel + message icons; shared `.hash` 18px box + SVG 16px; typed icons; compact abbrev
Status: **PRESENT**
Evidence:
- `frontend/src/styles/components/sidebar-core-part1.css:465+` defines `.hash` box/abbrev styling.
- `frontend/src/styles/components/sidebar-channels.css` has `.hash`, `.gallery-icon`, `.voice-icon`, compact `.channel-btn::after` rules.
- `frontend/src/lib/components/sidebar/TextChannelList.svelte`, `GalleryChannelList.svelte`, `LoreChannelList.svelte`, `VoiceChannelList.svelte` use typed icon classes + `data-abbrev`.
- Shared icon component: `frontend/src/lib/components/WorkspacePanelIcon.svelte` uses `WorkspacePanelIconName` with SVG fallbacks.

## R3 — Settings gear 28×28 btn / 16px SVG; no `font-size:1.5rem` on gear
Status: **PRESENT**
Evidence:
- `frontend/src/styles/components/sidebar-core-part3.css` contains profile/settings button sizing.
- `frontend/src/lib/components/sidebar/ProfileCard.svelte` controls are present at expected refs.
- No source `font-size:1.5rem` on settings gear in reviewed CSS regions.

## R4 — Pinned messages drawer beside channel list; navDock flip; surface tokens; mobile full-bleed
Status: **PRESENT**
Evidence:
- `frontend/src/lib/components/PinnedMessagesModal.svelte` exists and is wired.
- Channel-sidebar edge anchor + `navDock` flip references confirmed in `ChannelSidebar.svelte`.
- Mobile full-bleed and surface token CSS present.

## R5 — Channel drag-reorder; drop CSS; `is-dragging`; `sameChannelFamily`; before/after math; server double-patch
Status: **PRESENT**
Evidence:
- `frontend/src/lib/components/sidebar/GalleryChannelList.svelte`, `ForumChannelList.svelte`, `WikiChannelList.svelte`, `LoreChannelList.svelte` all bind `drop-before`, `drop-after`, `is-dragging`, and `onChannelDrop`.
- `ChannelSidebar.svelte` exposes `dropTargetClass`, `isChannelDragging`, drop handlers, and `channels-reordered` client wiring.
- Server double-patch path present in `core/crates/wabi-server/src/api/channels.rs` (`update_settings` + `update`).

## R6 — Boot crash `e.subscribe is not a function` — parked
Status: **PARKED / PARTIAL EVIDENCE**
Evidence:
- `layoutStore.subscribe` exists in `frontend/src/lib/layoutStore.ts`.
- Build chunk `DP1StNsd.js` contains a Svelte runtime `subscribe` helper (`function ln(e,t,n){...e.subscribe(t,n)...}`).
- No obvious non-store `.subscribe` pattern in reviewed source paths.
- Conclusion: no smoking-gun source fix identified yet; if the crash still occurs, it remains runtime-chunk/Svelte-store mapping issue, not a one-line source patch.

## R7a — Client HTML/JSON guards
Status: **PRESENT**
Evidence:
- `frontend/src/lib/api/utils.ts` has JSON/SPA guard paths (`parseApiJson`, `isJsonContentType`).
- `frontend/src/lib/placeStore.ts`, `addonInventory.ts`, `addonDetection.ts` soft-fail on SPA HTML/empty responses and call `markEndpointUnsupported`.

## R7b — Server `/api/places` stub + nested routes
Status: **PRESENT**
Evidence:
- `core/crates/wabi-server/src/api/places.rs` returns JSON `{places:[]}` stub.
- Nested under `routes.rs`/`mod.rs`; cargo check clean per history.
Note: Tim runtime only reflects committed binary; stale HTML behavior on Tim until binary redeploy.

## R8 — Guest shows “unknown”
Status: **PRESENT**
Evidence:
- Provisional guest `currentUser` synthesis and `user-joined` promotion paths present.
- `frontend/src/lib/components/sidebar/ProfileCard.svelte` contains `displayUsername`/Guest guards.

## R9 — Chat search sticky auto-focus
Status: **PRESENT**
Evidence:
- `frontend/src/lib/components/chat/ChatHeader.svelte` no longer binds `mouseenter` open-search behavior; click/focus path retained.

## R10 — Settings addon search field isolation
Status: **PRESENT**
Evidence:
- `frontend/src/lib/components/settings/AddonSettingsTab.svelte` keeps `addonSearchQuery=''` and uses `name="addon-filter"`.
- `addonDetection.ts` uses controlled input with autocomplete off.

## R11 — Status bubble size 18→10px; glow 12→6px
Status: **PRESENT**
Evidence:
- `frontend/src/styles/components/status-system.css` and `sidebar-core-part3.css` contain tokenized small status bubble + reduced glow values.

## R12 — CF Insights beacon
Status: **PRESENT / BEHAVIOR CONFIRMED**
Evidence:
- `frontend/app.html` clean; no beacon injection in app bundle source.
- Built JS bundle still references Cloudflare host string in `frontend/build/client/_app/immutable/chunks/DMDonYPS.js`; that is residual text, not active script load.
- `Caddyfile.tunnel` and `Caddyfile.example` set strict CSP; `script-src` does not allow `static.cloudflareinsights.com` in reviewed config; CF dashboard disable remains the intended remediation per `docs/CALLING_CSP_DEBUG_2026-07-15.md`.

## Summary
- R1 is the only active source-level mismatch with claimed intent: Quick launch launcher still exists.
- R2–R12 are present in reviewed source.
- No W/L/lore cards were touched.
