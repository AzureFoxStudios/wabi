# Game Sync Addon — shared board games (v1: Go)

Branch: `feature/game-sync-panel` off `main`.

## Product goal
An activity panel where people in a chat channel can sync up small board games
(Go in v1). Addon for now; v1.5 adds analysis tools (arrows, variations,
keyboard control, SGF), v2 adds persistence + casual/ranked modes + Elo.

## Honesty constraints (from AGENTS.md)
- Servers are not federated. A "competitive link" between servers means a shared
  addon skeleton + portable game records, never cross-server server state.
- v1 stores session state in memory only, lost on restart. Label honestly: not
  retained. v2 handles durability.
- No fake HA / no durable WabiDB writes in v1: avoids postcard migration and
  adapter-shape risks (golden rules 5, 8) for the smallest credible slice.
- Addon must fail clearly when the `WABI_GAME_SYNC_ENABLED` switch is off
  (core stays usable with addons disabled).

## Architecture
Backend inside `wabi-server` (like `steam`), runtime-gated by
`WABI_GAME_SYNC_ENABLED`, switchable in-app via Server Center → Add-ons.
Socket.IO events, channel-scoped rooms `game:<channelId>`, membership-checked
via `require_socket_channel` (channels + DMs). Server-authoritative board:
move → `apply_go_move` (place / capture / ko / suicide / own liberties).
One active game per channel. Complete match records live in the in-memory
session (board, move log, seats, revision) so v2 persistence replaces storage,
not the protocol.

Files:
- `core/addons/game-sync/plugin.json` — manifest, `workspacePanels: ["play"]`,
  bundled.
- `core/crates/wabi-server/src/socketio/game_ops.rs` — `game:join/leave/create/
  claim/move/pass/resign`, `game:state` fan-out, `game:error`, helpers
  `apply_go_move`, `score_go`. Unit tests (move básico / suicide / capture /
  scoring) pass.
- `socketio/wiring.rs` — handler registration next to the whiteboard block.
- `socketio/shared.rs` — `evict_channel_games` on channel delete/revocation.
- `api/addons.rs` — inventory entry + `AddonRuntimeFlags.game_sync_enabled`.
- `addon_switches.rs` — `game-sync` added to `SWITCHABLE_ADDONS`.

Frontend (`$lib/game-sync/`):
- `protocol.ts` — wire types, `GO_SIZES`, `KOMI`.
- `goBoard.ts` + tests — coordinate/star-point helpers.
- `GoBoard` deferred to tools phase; `GameSyncPanel.svelte` renders the grid.
- `GameSyncPanel.svelte` — right-dock activity view: channel picker, start/claim,
  board, turn indicator, pass/resign, status/empty/loading/error states.
- Wiring: `workspacePanels.ts` (`game-sync` component key), `WorkspacePanelHost`
  branch, `loader.ts` + `addonInventory.ts` bundled allowlist entries. Manifest
  surfaces `game-sync:play` (addon panel, icon `activity`). MainLayout's existing
  inventory-based `registerPluginWorkspacePanels` call registers it at runtime.

## Roadmap
- v1.5: analysis tools — arrows, variation stones, keyboard control, SGF
  export/import, score estimate. Pure frontend, server protocol unchanged.
- v2: WabiDB persistence of sessions and match records; casual vs ranked mode;
  addon-owned Elo records per `(game, size)` mirroring the existing `/games/me`
  revision pattern; later surface ratings on profiles. (The competitive-scene
  "link" to other servers is the addon skeleton + portable records — servers
  never share live state (AGENTS.md rule 10).)

## Verification
- `cargo build -p wabi-server` passes.
- `cargo test -p wabi-server --lib game_ops_tests` — 8/8 pass.
- Frontend typecheck (`bun run check`) pending: local node_modules/.bin symlinks
  are broken in this checkout; check to be run from a healthy frontend toolchain.
- Visual/runtime acceptance by the operator in a real browser/Tauri window
  (headless Chromium is known broken on this host).
