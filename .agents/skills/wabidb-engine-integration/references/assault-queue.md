# WabiDB Assault Queue

## Current Gaps (as of 2026-06-28)

### 1. Projection-less Handlers (7 items)

These adapter methods write events but have no projection handler, so reads always return empty:

- `ban_user` / `unban_user` → bans index, no handler
- `mute_user` / `unmute_user` → mutes index, no handler
- `deafen_user` / `undeafen_user` → deafens index, no handler
- `touch_user` → users index, should update `last_seen_micros`
- `upsert_channel_retention` → channel_retention index, no handler
- `upsert_member_role` → member_roles index, no handler
- `remove_channel_member` → no handler (never cleans up channel_members index)

**Status:** Open
**Priority:** High (data loss on restart)

### 2. Persistence Policy System (3 phases)

- **Phase 1:** Persistence policy projection (read per-stream policy, default to Session)
- **Phase 2:** Write filter in sequencer (skip disk write for Off-policy streams)
- **Phase 3:** Event log replay on startup (rebuild projections from segments)

**Status:** Open
**Priority:** Critical (data disappears on restart)

### 3. Event Log Replay on Startup

The engine's `open()` method initializes an empty `ProjectionState` without replaying the event log. This means all in-memory data is lost on restart.

**Current behavior:**
```rust
pub async fn open(config: WabiDbConfig) -> Result<Self> {
    // 1. Validate data dir
    // 2. Acquire lock file
    // 3. Load bootstrap key
    // 4. Read/write storage manifest
    // 5. Initialize stream key registry (empty)
    // 6. Build projection dispatch table
    // 7. Create projection state, barrier, dispatcher
    // ❌ Missing: replay event log to rebuild projections
}
```

**Required:**
```rust
pub async fn open(config: WabiDbConfig) -> Result<Self> {
    // ... steps 1-7
    // 8. Replay event log to rebuild projections
    self.replay_segments().await?;
}
```

**Status:** Open
**Priority:** Critical (data loss on restart)

## Test Status

- **wabidb:** 656 tests passing
- **wabi-server:** 44 tests passing
- **cargo check -p wabi-server:** clean

## Key Files

- `core/crates/wabi-server/src/adapter/mod.rs` (1416 lines, 40 methods)
- `core/crates/wabidb/src/engine/mod.rs` (654 lines, 14 projections)
- `core/crates/wabidb/src/projections/` (14 handlers)
- `core/crates/wabidb/src/domain/mod.rs` (567 lines)
- `core/crates/wabidb/src/sequencer/mod.rs` (800+ lines, 8 tests)

## Verification Commands

```bash
cd /var/home/Ronin/wabi
cargo test -p wabidb --lib 2>&1 | tail -3
cargo test -p wabi-server 2>&1 | tail -3
cargo check -p wabi-server 2>&1 | tail -3
```

## Notes

- The assault queue represents the remaining work to make WabiDB production-ready.
- All gaps are mechanical and well-defined.
- The skill `wabidb-engine-integration` captures the exact steps to close these gaps.