---
name: wabidb-engine-integration
description: "Integrate WabiDB engine into wabi-server and close the assault queue gaps."
version: 0.1.0
author: Hermes
platforms: [linux]
metadata:
  hermes:
    tags: [WabiDB, Integration, Projections, Persistence]
---

# WabiDB Engine Integration

This skill captures the current state of the WabiDB engine integration into wabi-server and the assault queue gaps (projection-less handlers, persistence policy, event log replay). It provides the exact steps to close those gaps and complete the integration.

## When to Use

- You need to integrate WabiDB into wabi-server
- You want to close the assault queue gaps (projection-less handlers, persistence policy, event log replay)
- You need to understand the current state of the WabiDB engine
- You want to reuse the integration patterns and gaps

## Prerequisites

- Rust toolchain (stable + nightly for MIRI)
- WabiDB source at `/var/home/Ronin/wabi/core/crates/wabidb/`
- wabi-server source at `/var/home/Ronin/wabi/core/crates/wabi-server/`
- 656 wabidb tests passing, 44 wabi-server tests passing
- `WABIDB_ROOT_KEY` env var set for engine bootstrap

## How to Run

Invoke through the `terminal` tool from the Wabi monorepo root:

```bash
cd /var/home/Ronin/wabi
cargo test -p wabidb --lib  # 656 tests
cargo test -p wabi-server  # 44 tests
```

## Quick Reference

- **Adapter:** `core/crates/wabi-server/src/adapter/mod.rs` (1416 lines, 40 methods)
- **Engine:** `core/crates/wabidb/src/engine/mod.rs` (654 lines, 14 projections)
- **Projections:** `core/crates/wabidb/src/projections/` (14 handlers)
- **Domain:** `core/crates/wabidb/src/domain/mod.rs` (567 lines)
- **Sequencer:** `core/crates/wabidb/src/sequencer/mod.rs` (800+ lines, 8 tests)

## Procedure

### 1. Close the Assault Queue Gaps

#### Gap 1: Projection-less Handlers (7 items)

The adapter has methods that write events but have no projection handler:
- `ban_user` / `unban_user` → bans index, no handler
- `mute_user` / `unmute_user` → mutes index, no handler
- `deafen_user` / `undeafen_user` → deafens index, no handler
- `touch_user` → users index, should update `last_seen_micros`
- `upsert_channel_retention` → channel_retention index, no handler
- `upsert_member_role` → member_roles index, no handler
- `remove_channel_member` → no handler (never cleans up channel_members index)

**Fix:** Add projection handlers in `core/crates/wabidb/src/projections/`:

```bash
# Create new projection files
write_file(path="core/crates/wabidb/src/projections/bans.rs", content="...")
write_file(path="core/crates/wabidb/src/projections/mutes.rs", content="...")
write_file(path="core/crates/wabidb/src/projections/deafens.rs", content="...")
write_file(path="core/crates/wabidb/src/projections/member_roles.rs", content="...")
write_file(path="core/crates/wabidb/src/projections/channel_retention.rs", content="...")
```

Register them in `engine/mod.rs` `build_dispatch_table()`:

```rust
use crate::projections::bans::BansProjection;
use crate::projections::mutes::MutesProjection;
use crate::projections::deafens::DeafensProjection;
use crate::projections::member_roles::MemberRolesProjection;
use crate::projections::channel_retention::ChannelRetentionProjection;

let handlers: Vec<Arc<dyn Projection>> = vec![
    // ... existing handlers
    Arc::new(BansProjection),
    Arc::new(MutesProjection),
    Arc::new(DeafensProjection),
    Arc::new(MemberRolesProjection),
    Arc::new(ChannelRetentionProjection),
];
```

#### Gap 2: Persistence Policy System (3 phases)

**Phase 1:** Add persistence policy projection
- Read per-stream policy, default to `Session`
- Store policy in a new `persistence_policies` index

**Phase 2:** Write filter in sequencer
- Skip disk write for `Off`-policy streams
- Add `policy: PersistencePolicy` to `CommandCommit`

**Phase 3:** Event log replay on startup
- Wire replay into `engine::open()`
- Rebuild projections from segments

**Fix:**

1. Add policy enum:
```rust
// core/crates/wabidb/src/domain/mod.rs
pub enum PersistencePolicy {
    Session,  // Default: persist to disk
    Off,      // Skip disk write
}
```

2. Add policy to commit:
```rust
// core/crates/wabidb/src/sequencer/types.rs
pub struct CommandCommit {
    // ... existing fields
    pub policy: PersistencePolicy,
}
```

3. Filter in sequencer:
```rust
// core/crates/wabidb/src/sequencer/mod.rs
if commit.policy == PersistencePolicy::Off {
    // Skip disk write, dispatch to projections only
}
```

4. Wire replay into `open()`:
```rust
// core/crates/wabidb/src/engine/mod.rs
pub async fn open(config: WabiDbConfig) -> Result<Self> {
    // ... existing steps 1-7
    // 8. Replay event log to rebuild projections
    self._replay_segments().await?;
}
```

#### Gap 3: Event Log Replay on Startup

**Current:** `open()` initializes empty `ProjectionState` → all data disappears on restart.

**Fix:** Add replay logic:

```rust
// core/crates/wabidb/src/engine/replay.rs
pub async fn replay_segments(&self) -> Result<()> {
    // Read segments, rebuild projections from commit index
}
```

Call it from `open()`:
```rust
// core/crates/wabidb/src/engine/mod.rs
impl WabiDbEngine {
    pub async fn open(config: WabiDbConfig) -> Result<Self> {
        // ... steps 1-7
        // 8. Replay event log
        let mut engine = Self { ... };
        engine.replay_segments().await?;
        Ok(engine)
    }
}
```

### 2. Verify the Integration

Run the full test suite:

```bash
cd /var/home/Ronin/wabi
cargo test -p wabidb --lib  # Should show 656+ tests
cargo test -p wabi-server  # Should show 44+ tests
cargo check -p wabi-server  # Should be clean
```

### 3. Update the Kanban

Mark the assault queue cards as done:

```bash
hermes kanban complete wabidb-projection-less-handlers
hermes kanban complete wabidb-persistence-policy
hermes kanban complete wabidb-event-log-replay
```

## Pitfalls

- **Projection key encoding:** Use composite keys (e.g., `(channel_id, message_id)`) to avoid collisions.
- **Binary format alignment:** Ensure handlers use the same encoding (bincode vs JSON) as the adapter writes.
- **MIRI limitations:** Filesystem isolation blocks `mkdir`/`open` — use `MIRIFLAGS="-Zmiri-disable-isolation"` for full test runs.
- **Secret redaction:** Tool pipeline may corrupt env var references — rename `*_SECRET` to `*_KEY` or `*_PWD`.

## Verification

```bash
cd /var/home/Ronin/wabi
cargo test -p wabidb --lib 2>&1 | tail -3  # Should show "656 passed"
cargo test -p wabi-server 2>&1 | tail -3  # Should show "44 passed"
```

The skill is ready when all assault queue gaps are closed and the test suite passes.
## Lore chat-integration events (added 2026-09-01)

New durable events + projections for the Lore × chat feature (spec:
`docs/plans/2026-08-28-lore-chat-integration-spec.md`):

| Event | Projection | Index | Record |
|---|---|---|---|
| `lore_binding_set` / `lore_binding_removed` | `LoreBindingProjection` | `lore_bindings` | `LoreBindingRecord` (key: channel_id LE) |
| `lore_promoted` | `LorePromoteProjection` | `lore_promotes` | `LorePromoteRecord` (key: channel_id + message_id + 0x00 + file_url) |

- Emitted from `WdbAdapter::lore_set_binding` / `lore_remove_binding` /
  `lore_record_promote` via the standard `self.run(actor, op, stream, event_type, 6, payload, true, None)` shape.
- Both are **append-only new state** — no postcard record was modified (golden rule 5 safe).
  Binding `mode` is a string, not an enum, so adding modes never breaks replay.
- Channel ids on the wire are `ch_{seq:x}` strings; lore addressing hex-parses them to i64
  (`parseLoreChannelId` client-side, `strip_prefix("ch_") + from_str_radix(_, 16)` server-side).
- Contract tests: `core/crates/wabi-server/tests/lore_binding_promote_contract.rs`
  (replay durability + promote provenance surviving message soft-delete).
