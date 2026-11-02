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
  surfaces `game-sync:play` (addon panel; the design-alignment section below gives
  it its current name, glyph, row B and locality tag). MainLayout's existing
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
- `cargo test -p wabi-server --lib game_ops_tests` — all pass, including
  `komi_decides_half_point_games` (half-point komi both directions).
- `bun run check` — 0 errors. (The checkout's `frontend/node_modules` was a
  self-referencing symlink tracked on `main` since `ccf04aea`; it is untracked
  on this branch and the ignore rule hardened, which is what the toolchain
  repair requires.)
- `bun test src/lib/game-sync` — 4/4 pass (`goBoard.test.ts`).
- Visual/runtime acceptance by the operator in a real browser/Tauri window
  (headless Chromium is known broken on this host): enable `game-sync` via
  `WABI_GAME_SYNC_ENABLED=true` or Server Center → Add-ons, then check the
  right-dock board at narrow widths, stone/last-move/ko markers, pass/resign,
  the scored finish display, and that the panel is absent while disabled.

### Review-round fixes (2026-10-17, commit on `feature/game-sync-panel`)
- Server: every socket event gated behind the add-on switch; move coordinates
  bounds-checked before the u8 cast; pass lifts the ko ban; scored finishes
  serialize `score` {black, white} with komi applied so the panel can show it.
- Frontend: string panel declarations normalize to `${pluginId}:${id}` and
  bundled add-ons resolve via `BUNDLED_PANEL_COMPONENTS` (panel id is
  `game-sync:play`); disabled add-ons no longer register panels; channel
  selection survives chat switches once chosen manually; New-game button after
  a finished game.

## Design alignment (2026-11-02, against main's design pass)
The add-on moved onto the design contract; the contract was not bent to fit the add-on.

- The panel id stays `game-sync:play`, but the bundled manifest names it **Go**
  (not "Play", and not "Games", which belongs to the Steam-backed games surface),
  glyph `gamepad`, description "A shared Go board in this channel". Its rail stub,
  frame title and Add panels row use the same word.
- The panel owns row B (`ownsToolbar: true`): the channel `Select` and the
  `EXPERIMENTAL` maturity tag sit in the 40px band under the frame title, so there
  is no second header inside the body. Row A carries the locality tag from
  `retentionLabel('live')` — **Live only · not saved** — because sessions live in
  memory only.
- `GameSyncPanel.svelte` is rebuilt on the kit (`Select`, `Segmented`, `EmptyState`,
  `Notice`, `LoadLine`, `.w-skel`, `confirmAction`). Phases are
  `joining | ready | failed`; a 7s join deadline replaces the permanent "Loading…"
  state. Server refusals are mapped by `present.ts` to a cause plus one consequence
  line; the raw string reaches the console only. The arbitrary 400ms busy timers
  are replaced by a busy flag cleared by the next state/error, with an 8s safety
  deadline.
- The board is drawn in roles only: a `--w-lift` plate with `--w-shadow-1`, an SVG
  hairline grid and star points, ink-filled vs paper-hollow stones (the seats are
  still called Black and White in words), a `--w-accent` last-move dot and a
  dashed `--w-line-strong` ko ring. Up to 361 intersections share one tab stop;
  arrows/Home/End move it and Enter/Space play. Labels use Go coordinates
  ("C3, black stone, last move").
- `game-sync.css` is component-owned so `designLint` scans it: no hex, `rgb()`,
  named colours or legacy tokens, and no gradients or glows.
- Known limitation: a 19×19 board on a 640px phone sheet has roughly 21px cells
  (about 13px in a 304px pinned panel), below the 44px coarse-pointer target. The
  9×9 board is the phone-sized affordance; the grid is not faked into 44px with
  horizontal scrolling.
- Strings remain hardcoded English while the add-on is experimental; translation
  keys arrive with the shipping decision.

### Verification for the alignment
- `bun run check` — 0 errors (109 pre-existing warnings).
- `bun test --isolate src/lib/game-sync src/lib/rightPanelStubStrip.test.ts` — all pass,
  including the new `present.test.ts`, grid/keyboard cases and the bundled-Go manifest test.
- `bun test src/lib/designLint.test.ts` — passes with `game-sync.css` outside the debt ledger.
- `bun test --isolate src/lib` — 2897 pass, 3 skip; the only failure is the
  pre-existing timezone-dependent `userPopoutModel.test.ts` case ("Sep 2026" vs
  "Aug 2026").
- `bun run build:static` — succeeds (478 immutable assets prepared for offline use).
- Visual check still needs a real browser/Tauri window: pinned 304px, 240px minimum,
  peek, and the phone sheet, in Wabi Ink and Daylight.
