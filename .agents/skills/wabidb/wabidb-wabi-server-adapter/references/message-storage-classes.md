# Message Storage Classes — live / timed / forever (2026-07-17 build)

Session context: flipped Wabi's chat retention default and added true no-disk "live" rooms.

## Product model

| Class | Disk write | Restart | Default? |
|-------|------------|---------|----------|
| live | NO (session_messages only) | gone | opt-in room type |
| timed | yes, then auto-delete | survives until TTL | YES — default 24h |
| forever | yes, no TTL | survives | opt-in |

Original default was inverted: every send persisted, delete only ran if a timer was set → default was effectively "forever." Correct product default is **timed 24h** (Discord-as-pseudo-email), keep-forever opt-in, live as a dedicated room type. Live ≠ E2EE: operator can read live messages while the process is up.

## Send-path split (the load-bearing change)

Two live send paths, both must gate:
1. `core/crates/wabi-server/src/socketio/messages.rs::on_message` — registered at `socketio/wiring.rs` `socket.on("message", ...)`. The `#[allow(dead_code)]` is lint suppression only; it is the real handler.
2. `core/crates/wabi-server/src/api/messages.rs::send_message` — REST POST "/".

Both call `state.app.wdb.send_message(&channel_id, user_id, &text, is_spoiler)`. Live path skips that call, assigns `format!("live_{}", uuid::Uuid::new_v4())`, and skips the TTL `tokio::spawn`. Both live and non-live still push to `session_messages` and emit the socket event.

Default-24h retention logic (from the earlier flip) belongs INSIDE the non-live `else` branch:

```rust
const DEFAULT_CHANNEL_AUTO_DELETE_MS: u64 = 24 * 60 * 60 * 1000;
// map override (ms) → label "forever" → WDB RetentionPolicy(days>0 → ms; days==0 → forever)
// → fallback DEFAULT_CHANNEL_AUTO_DELETE_MS
```

`AppState` already has `channel_auto_delete_ms: Arc<RwLock<HashMap<String,u64>>>` and `channel_auto_delete_label: Arc<RwLock<HashMap<String,String>>>`. Live/forever are sentinels in the label map — no Channel struct / postcard change (avoids the replay-break account-loss bug class).

## Contract test shape

`core/crates/wabi-server/tests/live_session_room_contract.rs`, two `#[tokio::test]`:
- `live_message_never_written_to_disk` — TempDir data dir, mark channel live, send `LIVE-CANARY-<uuid>`, recursively scan every file under data dir → canary bytes ABSENT (assert no new `.wseg`).
- `control_non_live_message_written_to_disk` — same but timed; canary PRESENT, new `.wseg` appears, readable via `get_message_typed`.

To reach `WdbAdapter` from an integration test the worker added a `[lib]` target + `src/lib.rs` mirroring the module tree. Compiles clean, legit pattern, but bigger than the feature needs — keep if build is green, flag as incidental.

## Verifying delegated (OpenCode) work on an ALREADY-dirty tree

- **Diff-base false-revert trap:** `git diff <file>` bases on last commit, not your pre-dispatch uncommitted state. A hunk can show your own earlier work as `-removed` while it is actually still present, just re-nested. Do NOT conclude "worker clobbered my work" from the red side. Confirm with `rg -n "<unique token>" <file>` and read the surrounding lines. Here the diff looked like it reverted the 24h/keep-forever block; `rg DEFAULT_CHANNEL_AUTO_DELETE_MS` proved it survived inside the new non-live branch.
- **Separate worker output from pre-existing dirt:** cross-check `git status --short` against the `pre-opencode-status-*.txt` backup. Files already in the pre-run status are not the worker's (here: `shared.rs`, `projections/messages.rs` is_spoiler dual-decode, `src-tauri/Cargo.toml` wgpu deps were pre-existing).
- Always re-run the build + contract test yourself; don't trust the worker's "2 passed" self-report.

## Frontend follow-up (not yet built as of this note)

Frontend already has a `stage` channel type and `autoDeleteAfter`/`persistMessages` plumbed through `channelStore` + `update-channel-settings`. Live wiring is small: send the `"live"` label via the existing settings path, add a `LIVE / session only` badge, disable load-older-history for live, and block (or force-ephemeral) attachments in live rooms.

## Plan

Full plan: `docs/plans/2026-07-17-live-session-rooms-no-disk.md`.
