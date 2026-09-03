# S1 — Steam Addon Integration — Report

Date: 2026-08-03
Scope: opt-in Steam addon per `docs/steam-integration-proposal.md` (Phase 1 +
Phase 2). Backend `wabi-server` + frontend + protocol types.

Constraints honored: `core/crates/wabidb/`, `src-tauri/`, `data/`, `docs/`,
`ModelViewer3D.svelte`, `socket-types.ts`, `ProfileSettingsTab.svelte`,
`ProfileCard.svelte`, all Lore code, and the auth/login backend were NOT
touched. No commit made.

Note: the working tree also contained **pre-existing concurrent B3/B4 branding
changes** (`branding.ts`, `login.css`, `LaunchPanel.svelte`, `loginHelpers.ts`,
`savedServer*.ts`, `tokens.css`, `neutral-branding.css`) that are NOT mine and
were left untouched.

## Verification

| Step                  | Result |
|-----------------------|--------|
| `cargo check -p wabi-server` (repo root) | ✓ compiles (only pre-existing warnings) |
| `cargo test -p wabi-server`             | ✓ 79 + 88 + 2 passed, 0 failed |
| `cargo test -p wabi-server steam`       | ✓ 7 passed (steam module + messages tests) |
| `bun run check` (frontend/)             | 6 errors / 64 warnings — ALL pre-existing `bun:test`/`bun` "Cannot find module" noise in test files (`storage-salt.test.ts`, `dm/*.test.ts`, `layoutSchema.test.ts`). No new errors, warning count unchanged. |
| `bun run build:only` (frontend/)        | ✓ builds |

## What was done

### Backend — `core/crates/wabi-server/src/api/steam.rs` (new)

- `GET /api/steam/status?steamId=<id>` and `GET /api/steam/rich-presence?steamId=<id>`.
  Both accept `steamId` or the Steam-native `steamids` alias.
- Polls `ISteamUser/GetPlayerSummaries/v0002/` with `?key=<STEAM_API_KEY>&steamids=<id>`.
- **Server-side 60s cache** in a `HashMap<String, CacheEntry>` guarded by
  `tokio::sync::Mutex`, added to `AppState` as `steam_cache` (in `state.rs`).
  The lock is only held for the map lookup, never across the upstream HTTP call.
- **Opt-in + graceful 404:** if `STEAM_API_KEY` env var is unset, both endpoints
  return 404 (`NotFound` "Steam addon is not configured") instead of crashing.
- Auth required (`AuthUser`) — Steam data is personal.
- Maps `response.players[0]` → `SteamStatus` (`steamId, personaName, profileUrl,
  avatar, inGame, gameId, gameName, updatedAt, richPresence`). Unknown/private
  ids (empty players array) resolve to a not-in-game status. Non-2xx upstream
  responses are cached as empty rather than surfacing as a 500.
- `/rich-presence` keeps any `richpresence` field from the row (falling back to
  the game name); `/status` always nulls it out.
- 4 unit tests (in-game parse, not-in-game parse, unknown player, query alias).

### Backend — module + routes

- `api/mod.rs`: added `pub mod steam;`.
- `api/routes.rs`: `.nest("/steam", steam::routes(state.clone()))`.
- `state.rs`: added `pub steam_cache: Arc<Mutex<SteamCache>>` + init.

### Backend — `steam://run` detection in `api/messages.rs`

- `find_steam_join_appids(content)` — regex `steam://run/(\d+)`, de-duped.
- `emit_steam_join_events(...)` — after `send_message` writes a message, emits a
  `steam_join` Socket.IO event per unique appid
  (`{ appid, messageId, channelId, username, userId }`) to the channel room via
  `sio_broadcast_tx` (same pattern as `bots.rs`). Fire-and-forget.
- 4 unit tests.

### Protocol — `SteamStatus` + `SteamJoinLink` event variants

**Deviation:** the dispatch listed `shared/wabi-protocol/`, which does not exist
in this repo. The actual protocol package is `packages/wabi-protocol`
(ts-rs generated types). Added:
- `packages/wabi-protocol/src/generated/SteamStatus.ts`
- `packages/wabi-protocol/src/generated/SteamJoinLink.ts`
- re-exported both from `packages/wabi-protocol/src/index.ts`.

These are hand-written in the ts-rs generated style (no corresponding Rust
`#[ts(export)]` types exist in `crates/wabi-core`, so regeneration won't clash).

### Frontend — `frontend/src/lib/steam/steamStatusStore.ts` (new)

- Opt-in `writable` store. Reads the user's Steam id from localStorage
  (`wabi.steam.steamId`, `safeReadSettings()`-style guarded reads).
- Polls `${getApiBase()}/api/steam/status?steamId=...` every 60s with the
  Bearer token (`getAuthToken()`). Single-flight guard. 404 → feature disabled.
- Self-starts a `currentUser`-driven lifecycle (mirrors `desktopHelper.ts`
  pattern; also exported `startSteamStatusPolling()` / `setSteamId()` /
  `refreshSteamStatusNow()` / `getSteamId()`).

### Frontend — `SteamStatusBadge.svelte` (new, Svelte 5 runes)

- `$props()` / `$derived`. Renders `🎮 Playing <game>` inline next to the
  sender's name. The game name links to `steam://run/<appid>`.
- **Self-only scope:** the Steam addon is opt-in and there is no user→steamId
  directory, so the badge shows for the current user's own messages (the person
  who shared their Steam id). This satisfies "badge placed inline in message
  rendering, not in ProfileCard" without a contacts directory.

### Frontend — `SteamJoinButton.svelte` (new, in `plugins/`, Svelte 5 runes)

- `$props()` / `$derived`. Scans `messageText` for `steam://run/(\d+)` and
  renders one "Join Game" button per unique appid. Clicking sets
  `window.location.href = steam://run/<appid>` — launches the game via the OS
  Steam handler; a no-op/harmless on web/mobile (per proposal).
- Text-driven, so it works for history and live messages even without the
  socket `steam_join` event (which is emitted server-side as realtime signaling).

### Frontend — message rendering wiring

**Deviation:** `frontend/src/lib/components/Message.svelte` does not exist. The
real message rendering chain is `MessageItemContent.svelte` →
`MessageHeader.svelte` (sender name row) + `MessageContent.svelte` (body). Wired
into those:
- `message/MessageHeader.svelte`: `<SteamStatusBadge user={author} />` after the
  BOT badge, before the timestamp (non-continuation header only).
- `message/MessageContent.svelte`: `<SteamJoinButton {messageText} />` at the
  end of `.message-content`.

### Frontend — styles

- `frontend/src/styles/components/steam-status.css` (new): badge pill +
  join-button styles using design tokens (`--radius-full/md`, `--accent-primary`,
  `--surface-raised`, `--text-heading/secondary`).
- Imported in `frontend/src/styles/styles.css`.

## Files changed (mine)

New:
- `core/crates/wabi-server/src/api/steam.rs`
- `frontend/src/lib/steam/steamStatusStore.ts`
- `frontend/src/lib/components/SteamStatusBadge.svelte`
- `frontend/src/lib/components/plugins/SteamJoinButton.svelte`
- `frontend/src/styles/components/steam-status.css`
- `packages/wabi-protocol/src/generated/SteamStatus.ts`
- `packages/wabi-protocol/src/generated/SteamJoinLink.ts`

Modified:
- `core/crates/wabi-server/src/api/mod.rs`
- `core/crates/wabi-server/src/api/routes.rs`
- `core/crates/wabi-server/src/api/messages.rs`
- `core/crates/wabi-server/src/state.rs`
- `frontend/src/lib/components/message/MessageHeader.svelte`
- `frontend/src/lib/components/message/MessageContent.svelte`
- `frontend/src/styles/styles.css`
- `packages/wabi-protocol/src/index.ts`

## Notes / caveats

- No headless browser verification (project constraint). Visual check in a real
  browser/Tauri window recommended for: badge pill sizing next to usernames,
  join-button density in `.message-content`, and the Steam icon rendering.
- The `steam_join` Socket.IO event is emitted server-side but the frontend does
  not currently register a listener for it (socket-types.ts is off-limits); the
  join button is text-detection-driven, which is equivalent and more robust.
- The `STEAM_API_KEY` env var is read directly from the process environment in
  `steam.rs`; no config-file wiring was added (per "check data/.env or config" —
  no `data/.env` exists and none was created).
- The status badge is self-only by design (opt-in; no steamId directory). A
  future Phase 1.5 could add per-user Steam ids to the user model to extend the
  badge to other senders.
- No commit made (awaiting "commit" instruction).
