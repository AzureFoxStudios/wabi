# OpenCode Dispatch: S1 — Steam Addon Integration

## Goal
Implement the Steam addon (opt-in) per `docs/steam-integration-proposal.md`.
Two pieces:
1. Backend: Rust module in `core/crates/wabi-server/src/api/steam.rs` — `GET /api/steam/status` and `GET /api/steam/rich-presence`.
2. Frontend: Svelte component `SteamStatusBadge.svelte` + message render for `steam://run/` links. Badge placed inline in message rendering, not in ProfileCard (avoids conflict with PR4 changes there).

## Scope: Files you MAY touch
- `core/crates/wabi-server/src/api/steam.rs` (new)
- `core/crates/wabi-server/src/api/mod.rs` — register `steam` module
- `core/crates/wabi-server/src/api/messages.rs` — detect `steam://run/<appid>` in messages, emit `steam_join` event
- `frontend/src/lib/components/SteamStatusBadge.svelte` (new)
- `frontend/src/lib/components/plugins/SteamJoinButton.svelte` (new — inline message button)
- `frontend/src/lib/steam/steamStatusStore.ts` (new — polls /api/steam/status)
- `frontend/src/styles/components/steam-status.css` (new)
- `frontend/src/lib/components/Message.svelte` — render Steam status badge for sender + SteamJoinButton for steam:// links
- `shared/wabi-protocol/` — add SteamStatus + SteamJoinLink event variants

## Scope: Files you MUST NOT touch
- `core/crates/wabidb/` database engine
- `src-tauri/` Tauri backend
- `data/` directory
- `docs/` directory (read-only, including steam-integration-proposal.md)
- `frontend/src/lib/components/plugins/ModelViewer3D.svelte` (done in S3)
- `frontend/src/lib/socket-types.ts` (done in H1c)
- `frontend/src/lib/components/settings/ProfileSettingsTab.svelte` (done in PR4)
- `frontend/src/lib/components/sidebar/ProfileCard.svelte` — ONLY add Steam badge integration, do NOT re-edit PR4 changes
- No Lore-related code (off-limits)
- Auth/login backend — B4 is separate

## CRITICAL INTERFACE NOTES

### Rust backend pattern
Follow existing API modules (e.g., `core/crates/wabi-server/src/api/bots.rs`):
- Handler functions take `&AppState` (not &mut — use inner Mutex/Arc)
- `AppState` is accessed via `State<AppState>` extractor in axum
- Use `wdb.send_message` for broadcasting (see bots.rs H1c)
- Return `impl IntoResponse`
- Register route in `api/mod.rs` with `api_router` function

### Frontend store pattern
Follow `src/lib/components/sidebar/ProfileCard.svelte` pattern for reading `$currentUser`.
Use `safeReadSettings()` pattern from customStatusPresets.ts for localStorage.

### Steam API integration
- Poll `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/` with `?key=<API_KEY>&steamids=<id>`
- Cache results server-side for 60 seconds (use `tokio::time::sleep` or a `HashMap` with timestamp)
- Steam API key must be configured via env var `STEAM_API_KEY` (check `data/.env` or config)
- If no API key, return 404/empty (feature is opt-in)

### steam://run/ detection
- In messages.rs, scan message text for `steam://run/(\d+)` pattern
- Emit a `SteamJoinLink { appid: u32, message_id: ... }` event via Socket.IO
- Frontend renders an inline "Join Game" button

### Svelte 5 runes
- Use `$props()`, `$derived`, `$state` — NO `export let`, NO `$:`
- New code only

## Verification Steps
```
cd /var/home/Ronin/wabi
cargo check -p wabi-server          # backend compiles
cd frontend && bun run check        # no new errors
cd frontend && bun run build:only   # must compile
```

## Constraints
- NO headless browser verification
- Write report to `audit/s1-opencode-report.md`
- Do NOT commit unless Ronin says "commit"
- If Steam API key is not configured, return graceful 404 (don't crash)
