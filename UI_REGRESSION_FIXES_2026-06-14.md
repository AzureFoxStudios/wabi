> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# UI Regression Fixes — 2026-06-14

## Backend / Infrastructure

- **Fixed malformed STDB token env vars** in wabi-server container — removed `WABI_STDB_TOKEN` / `WABI_CALL_STDB_TOKEN` that had bad values for local (tokenless) STDB
- **Fixed SELinux filesystem permission conflict** — separated wabi-server `./data/wabi-server` mount from STDB's `./data/spacetimedb` to prevent overlapping `:Z,U` labels breaking STDB write access

## Frontend — CSS/Layout

| Issue | File | Fix |
|---|---|---|
| Mute/deafen/settings oversized (x3 complaint) | `sidebar-profile.css` | Added `!important` 24x24px sizing with proper SVG scaling, scoped to `.profile-card .profile-controls .control-btn` |
| Right panel doesn't scale horizontally | `main-layout-part1.css` | Changed `flex-shrink: 0` -> `flex-shrink: 1` with `flex-basis: 320px` and `max-width: min(480px, 45vw)` |
| Xfers button fighting collapse button | `MainLayout.svelte` | Hidden when any right panel is open (`rightPanelView === 'none'`) |
| Pinned messages vs channel settings crowding | `sidebar-channels.css`, `sidebar-core-part2.css` | Buttons reduced 24px->18px, margins 0.2rem->0.06rem |
| Upload preview burying send button | `chat-upload.css` | Bounded thumbnail grid with `max-height: 150px`, `object-fit: cover`, scroll overflow |
| Add media menu cut off on right | `chat-composer.css` | Changed from `left: 0` -> `left: auto; right: 0` |
| Channel animation too hyper | `chat-header.css` | Replaced cubic-bezier spring with `ease` timing, added `translateY(-1px)` scale(1.04) hover |
| Notes input selection glow | `user-popout.css` | Replaced browser glow with subtle `outline: 1.5px solid accent` |
| Sidebar control button scoping | `sidebar-profile.css` | Added explicit 28px rules to prevent call-view `.control-btn` leakage |
| Settings status banner | `settings-nav.css` | Added `.settings-inline-status` with success/error styles |
| Channel error feedback | `sidebar-channels.css` | Added `.create-channel-error` alert styling |

## Frontend — Logic/Components

| Issue | File | Fix |
|---|---|---|
| Font save infinite loop | `UniformFontMode.svelte:103` | Removed `on:change={handleToggle}` that fought `bind:checked` — toggle now works via binding alone |
| Emoji support completely missing | `emoji-store.ts`, `socket.ts`, `+layout.svelte` | Ran `fetch-openmoji.sh` (4284 PNGs), created `initEmojis()` fetcher for `/openmoji/emojis.json` manifest, unified both emoji stores (socket.ts re-exports from emoji-store.ts) |
| Profile pic alert->inline status | `Settings.svelte` | Replaced blocking `alert()` with `.settings-inline-status` banner, added optimistic `currentUser.update()` |
| Search click->hover | `ChatHeader.svelte` | Changed from `on:click={onOpenSearch}` to `on:focus` + `on:mouseenter` on container with `role="search"` |
| Channel creation error visibility | `CreateChannelForm.svelte` | Form stays open on failure, shows backend error text instead of silently closing |
| Transfer button overlap | `MainLayout.svelte` | Conditional render: hidden when `rightPanelView !== 'none'` |

## Build / Static Assets

- **OpenMoji emoji set**: 4284 PNG files fetched to `frontend/static/openmoji/png/`
- **Emoji manifest**: Generated `static/openmoji/emojis.json` for runtime loading
- **Frontend build**: Rebuilt with `npm run build` — OpenMoji files at `build/client/openmoji/` (note: Rust binary needs recompile to embed these for port 3001 access)
- **Vite dev server**: Running at `http://100.87.255.66:5173/` with `VITE_WABI_LOCAL_MOCK=1`

## Not Fixed (Requires Server-Side or Deeper Work)

- **Voice channel member display** — server must emit `voice-channel-state` after join; frontend can't populate member list alone
- **CallView center avatars** — intentionally disabled (`+layout.svelte:165`); would need testing/re-enabling
- **Reaction button icons** — use `quickEmoji.url` which requires populated emoji store; works on Vite dev (5173) but not on wabi-server (3001) until Rust binary is recompiled
- **Profile picture upload** — requires backend upload endpoint + socket broadcast; mock mode catches error gracefully now

Svelte-check: **0 errors, 55 warnings** (same pre-existing count).
