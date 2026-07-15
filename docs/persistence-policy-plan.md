# Persistence Policy System — Implementation Plan

```
Author:  (session Jun 2026)
Status:  Planned — not yet implemented
Depends: wabidb engine + wabi-server adapter
```

## Philosophy

Wabi is opt-in persistence by default. No message content is written to disk unless
the owner, channel, or user explicitly chooses to save it. System metadata (users,
channels, roles) persists so the server works across restarts — but user content
is ephemeral unless opted in.

Legal rationale (per Carl): "never written" means there are no bytes to subpoena.
`Off` policy = the Signal one-page defense.

---

## Architecture: The 4 Persistence Modes

```
Off ──── Session ──── On ──── Custom
  │         │           │        └── Rules-based (per-channel, per-user, TTL, etc.)
  │         │           └── Write to disk + replay on restart
  │         └── Write to disk, no replay (crash recovery, not intentional restart)
  └── Never written to disk at all
```

### Resolution order (highest to lowest priority)

```
User override → Channel override → Server default → Hardcoded fallback
```

### System streams (always `On`, hardcoded — cannot be changed)

These streams always write to disk and always replay on restart:

- `users`
- `channels`
- `channel_members`
- `audit`
- `barrier`
- `persistence_policy`
- `rebuild_auth`

Everything else (messages, reactions, emotes, webhooks, layouts, etc.) follows
the resolved persistence policy.

---

## The 4 Modes in Detail

### `Off`
- **Sequencer**: Skipped entirely. No `.wseg`, no `.widx`.
- **Projection**: Still updated in-memory (user sees the message in the UI).
- **Commit seq**: Not consumed from the sequencer. The command gets a seq but no
  disk write.
- **Recovery**: Nothing on disk. After restart, the event is gone.
- **Implementation**: In `WdbAdapter::run()`, if the resolved policy is `Off`,
  create a `DispatchItem` directly and send it to the `ProjectionDispatcher`
  without going through the sequencer at all.

### `Session`
- **Sequencer**: Normal path — writes `.wseg` and `.widx`.
- **Projection**: Updated normally.
- **Replay on restart**: The event is read from disk but NOT routed to the
  projection dispatcher. Only the raw bytes exist.
- **Recovery**: `load-history` Socket.IO handler can still find and return
  these messages by scanning segments. The frontend re-caches them.
- **Use case**: "I closed my browser and want my history back." Survives crash,
  not intentional restart.

### `On`
- **Sequencer**: Normal path — writes `.wseg` and `.widx`.
- **Projection**: Updated normally.
- **Replay on restart**: The event IS read and routed to the projection
  dispatcher. Projection state is fully rebuilt.
- **Use case**: Channels/servers that want full persistence across restarts.

### `Custom`
- Rules stored in the `persistence_policy` projection.
- Evaluated at write time to determine effective mode (Off/Session/On).
- Re-evaluated at replay time using **current** rules (not historical).
- Example rules:
  - `"persist channel #mod-log always"`
  - `"auto-delete user X's messages after 7 days"`
  - `"never persist channel #random"`
- The rules key/value format TBD when implemented.

---

## Pre-Setup Default

Before the owner answers the setup prompt, the effective default for user-content
streams is **`Session`**. This means the first user's messages are written to disk
(crash recovery) but won't appear on restart unless the owner later sets the server
default to `On`.

Why `Session` and not `Off`? Because `Off` means the first-time user experience
sends messages that vanish on any crash — that's confusing. `Session` is the
conservative "we keep it safe until you tell us otherwise" default.

---

## Phase 1: Persistence Policy Projection (~400 lines)

### New file: `core/crates/wabidb/src/projections/persistence.rs`

```
PersistenceMode enum:
  Off = 0
  Session = 1
  On = 2
  Custom = 3

PersistencePolicyRecord:
  scope:     ServerDefault | Channel(String) | User(u64)
  mode:      PersistenceMode
  rules:     Option<Vec<Rule>>  // only for Custom
  updated_at_micros: i64
```

The projection stores entries in the `persistence_policies` index keyed by
the scope identifier (e.g. `"server_default"`, `"channel:ch_2"`, `"user:42"`).

### Resolution function

```
fn resolve_policy(
  user_id: Option<u64>,
  channel_id: Option<&str>,
  stream_id: &str
) -> PersistenceMode
```

Resolution:
1. If `stream_id` is a hardcoded system stream → return `On`
2. Look up `user:{user_id}` override → if found, return it
3. Look up `channel:{channel_id}` override → if found, return it
4. Look up `server_default` → if found, return it
5. Return `Session` (pre-setup fallback)

### Changes to existing files

| File | Change |
|------|--------|
| `projections/mod.rs` | Add `pub mod persistence` |
| `engine/mod.rs` `build_dispatch_table()` | Import and register `PersistenceProjection` as a **system stream** handler |
| `adapter/mod.rs` | Add `resolve_policy()` method on `WdbAdapter` |

### New API endpoints

| Method | Path | Auth | Body | Effect |
|--------|------|------|------|--------|
| `POST` | `/api/setup/persistence` | Owner only | `{ "defaultPolicy": "Session" }` | Sets server default |
| `GET` | `/api/setup/persistence` | Owner only | — | Returns current policy |
| `PUT` | `/api/channels/{id}/persistence` | Channel admin | `{ "policy": "On" }` | Per-channel override |
| `PUT` | `/api/user/me/persistence` | Authenticated | `{ "policy": "Off" }` | Per-user override |

### Frontend: setup overlay

After first registration, if `isOwner && !persistenceConfigured`:
- Show a modal with a picker: Off / Session / On / Custom
- Description of each mode
- "Learn more about persistence settings" link
- Save button → POST /api/setup/persistence
- On success → reload to normal app

---

## Phase 2: Write Filter (~250 lines)

### Sequencer changes

`CommandCommit` struct in `sequencer/mod.rs` gets a new field:

```rust
pub struct CommandCommit {
    // ... existing fields ...
    pub persistence: PersistenceMode,
}
```

The sequencer main loop:

```rust
match command.persistence {
    PersistenceMode::On => {
        // current behavior: encrypt, write .wseg, write .widx, dispatch
    }
    PersistenceMode::Session => {
        // write .wseg and .widx but tag segments so replay skips them
        // (e.g. a flag byte in the segment trailer or a separate index)
    }
    PersistenceMode::Off => {
        // skip .wseg and .widx entirely
        // still dispatch to projection dispatcher
    }
    PersistenceMode::Custom => {
        // evaluate rules → map to On/Session/Off → handle accordingly
    }
}
```

### Adapter `run()` changes

```rust
async fn run(&self, ..., mode_override: Option<PersistenceMode>) -> Result<u64> {
    let stream_id = determine_stream_id(...);
    let mode = mode_override.unwrap_or_else(|| self.resolve_policy(...));

    if mode == PersistenceMode::Off {
        // Bypass sequencer entirely.
        // Assign a fake commit_seq (e.g. from an atomic counter) for ordering,
        // create DispatchItem, send directly to dispatcher.
        // Return a best-effort seq (u64::MAX or a negative sentinel).
        return self.dispatch_direct(...).await;
    }

    // Current sequencer path, passing `mode` in CommandCommit.
    self.sequencer.submit(CommandCommit { persistence: mode, ... }).await
}
```

**Important:** The `Off` path still needs to update projections so the UI
responds immediately. The `ProjectionDispatcher::submit()` method (or a new
`dispatch_direct()`) sends a `DispatchItem` directly to the dispatcher channel,
bypassing encryption, stream key lookup, and disk I/O entirely.

### Stream key lookup

Currently, `get_or_create_stream_key()` is called before every write to ensure
the key exists. For `Off` events, this call should be skipped (no encryption
needed since nothing is written to disk). The projection dispatcher receives
the raw plaintext payload.

---

## Phase 3: Event Log Replay (~500 lines)

### New file: `core/crates/wabidb/src/engine/replay.rs`

Two-phase replay:

```
Phase 1: System streams
  1. Scan data_dir for .wseg segment files
  2. Collect all segments in commit_seq order
  3. For each segment:
     a. Decrypt using stream key (re-derived from bootstrap key)
     b. If stream_id is a system stream → route to dispatcher
     c. Track highest_commit_seq seen
  4. Wait for dispatcher to finish (flush)

Phase 2: User-content streams
  1. Read the current persistence policy from projection state
     (which was rebuilt in Phase 1 since it's a system stream)
  2. For each remaining segment (non-system):
     a. Resolve effective policy at time of event
        (use current policy — re-evaluate, not historical)
     b. If policy resolves to On → route to dispatcher
     c. If policy resolves to Session/Off → skip (don't project)
     d. Custom → evaluate rules → project if matches
```

### Engine `open()` changes

```rust
pub async fn open(config: WabiDbConfig) -> Result<Self> {
    // ... existing: lock file, bootstrap key, manifest ...

    // NEW: Build dispatch table early (needed for replay)
    let dispatch_table = build_dispatch_table()?;

    // NEW: Create projection state + dispatcher before sequencer
    let projection_state = Arc::new(ProjectionState::new());
    let dispatcher_handle = ProjectionDispatcher::spawn(...)?;

    // NEW: Replay existing segments
    let highest_seq = replay_event_log(
        &data_dir,
        &bootstrap_key,
        &key_registry,
        &dispatcher_handle.sender,
        &projection_state,
        &dispatch_table,
    ).await?;

    // Spawn sequencer with resumed commit_seq
    let starting_seq = highest_seq + 1;
    // ... pass starting_seq to sequencer ...

    // ... rest of existing setup ...
}
```

### Segment format considerations

Current `.wseg` segments have no "this is Session, not On" distinction. Options:

1. **Add a 1-byte mode flag** to the segment trailer (simplest)
2. **Separate directories** for Session vs On segments
3. **No distinction** — replay everything, then filter by policy at projection time

Option 3 is the simplest: read all segments, then for each event, check the
projection state's policy and decide whether to project. This means `Session`
segments are still read and iterated but simply skipped during projection.
Downside: slightly slower replay (reading bytes you'll discard). Acceptable for
v1.

### commit_seq resumption

Read the highest `commit_seq` from the last segment file's trailer or from the
commit-index files. Pass this to the sequencer as the starting value.

```rust
// sequencer/mod.rs
pub async fn run(
    permit: SequencerPermit,
    key_registry: Arc<Mutex<StreamKeyRegistry>>,
    batcher: BatcherHandle,
    dispatcher: ProjectionDispatcherHandle,
    barrier: Arc<LinearizabilityBarrier>,
    mut cmd_rx: mpsc::Receiver<CommandCommit>,
    data_dir: PathBuf,
    start_seq: u64,         // NEW — resume from here
) {
    let mut next_commit_seq: u64 = start_seq;  // Was: = 1
```

---

## Phase 4: Binary/JSON Format Bug Fixes (~100 lines)

These are independent of the persistence system and can be done in any order.

### Reads using JSON decode on binary projections (4 fixes)

All follow the same pattern — replace `Self::decode::<T>` with the projection's
specific `decode_record` + `From` conversion:

1. **`list_channels` line 525:** `Self::decode::<ChannelMember>` on `"channel_members"` index
   → `channel_members::decode_record()` + `ChannelMember::from()`

2. **`get_emotes` line 912:** `Self::decode::<Emote>` on `"emotes"` index
   → Use `EmoteRecord::decode_record()` (or whatever the emotes projection uses)

3. **`get_webhooks` line 955:** `Self::decode::<Webhook>` on `"webhooks"` index
   → Use `WebhookRecord::decode_record()`

4. **`get_user_layout` line 988:** `Self::decode::<UserLayout>` on `"user_layouts"` index
   → Use `LayoutRecord::decode_record()`

### Writes sending JSON where projection expects binary (3 fixes)

Again, same pattern — replace `Self::payload_json(&payload)` with the projection's
`encode_record`:

1. **`upsert_emote` line 930:** JSON payload for `"emote_upserted"` event
   → Construct `EmoteRecord` and use `emotes::encode_record()`

2. **`upsert_webhook` line 976:** JSON payload for `"webhook_upserted"` event
   → Construct `WebhookRecord` and use `webhooks::encode_record()`

3. **`upsert_user_layout` line 1004:** JSON payload for `"user_layout_upserted"` event
   → Construct `LayoutRecord` and use `layouts::encode_record()`

### Direct state.insert corrupting messages index (2 fixes)

These write directly into the `"messages"` index via `state.insert()`, bypassing
`self.run()` entirely. We need to use binary encoding instead of JSON:

1. **`delete_message` line 723:** `Self::payload_json(&m)` → `messages::encode_record()`
   after converting the `Message` domain type back to `MessageRecord`

2. **`edit_message` line 740:** Same fix as delete_message

**Design decision:** Should these go through `self.run()` instead?

- Going through `self.run()` would create a proper event log entry (an "edit"
  event or "delete" event), which is architecturally cleaner.
- Keeping `state.insert()` is simpler but loses the audit trail.
- **Recommendation for v1:** Keep `state.insert()` but fix the format. An
  "event log with edits" is a Phase 6 concern.

---

## Complete File Change List

### New files

| File | Phase | Purpose |
|------|-------|---------|
| `core/crates/wabidb/src/projections/persistence.rs` | 1 | Persistence mode enum, record type, projection handler |
| `core/crates/wabidb/src/engine/replay.rs` | 3 | Two-phase event log replay on startup |

### Modified files

| File | Phase | Change |
|------|-------|--------|
| `core/crates/wabidb/src/projections/mod.rs` | 1 | Add `pub mod persistence` |
| `core/crates/wabidb/src/engine/mod.rs` | 1,3 | Register `PersistenceProjection`, add `replay_event_log()` call in `open()`, seed sequencer from highest_seq |
| `core/crates/wabidb/src/sequencer/mod.rs` | 2 | Add `start_seq` parameter, `PersistenceMode` to `CommandCommit`, mode-based write skip |
| `core/crates/wabidb/src/engine/locks.rs` | 2 | Maybe: make `ProjectionDispatcher::submit()` public for direct dispatch |
| `core/crates/wabi-server/src/adapter/mod.rs` | 1,2,4 | Add `resolve_policy()`, mode filter in `run()`, fix 9 bugs |
| `core/crates/wabidb/src/commit_index/batcher.rs` | 3 | Expose `read_highest_commit_seq()` |
| `core/crates/wabi-server/src/api/auth.rs` | 1 | Call setup prompt after first registration |
| `core/crates/wabi-server/src/api/setup.rs` | 1 | New: `POST /api/setup/persistence`, `GET /api/setup/persistence` |
| `core/crates/wabi-server/src/api/routes.rs` | 1 | Wire setup routes |
| `core/crates/wabi-server/src/state.rs` | 1 | Add `persistence_configured` accessor |

### Frontend files

| File | Change |
|------|--------|
| Setup overlay component | New: persistence policy picker |
| Channel settings | Add persistence selector |
| User settings | Add persistence selector |

---

## Estimated Scope

| Phase | Lines | Files touched | Risk |
|-------|-------|-------------|------|
| 1: Policy projection | ~400 | 8 | Low — isolated new module |
| 2: Write filter | ~250 | 4 | Medium — touches sequencer, critical path |
| 3: Event log replay | ~500 | 4 | High — startup path, data integrity |
| 4: Bug fixes | ~100 | 1 | Low — mechanical pattern |
| Frontend | ~300 | 3-5 | Medium — Svelte components |
| **Total** | **~1550** | **~20** | |

---

## Recovery (if session is interrupted)

1. The plan document at `docs/persistence-policy-plan.md` has the full spec.
2. Check `git log` for the last commit — all changes are incremental.
3. Phase 1 can be implemented independently from Phases 2-4.
4. Phase 4 (bug fixes) is independent of everything else — start there to warm up.
5. The key insight to remember: `ProjectionDispatcher` already exists and accepts
   `DispatchItem` directly. The `Off` path just needs to construct one and send
   it — no sequencer, no encryption, no disk I/O.
6. For Phase 3 replay: the `stream_log` directory has `SegmentReader` and
   `scan_segment_file()` in `recovery.rs` — these already do the low-level work
   of iterating records in a `.wseg` file.
