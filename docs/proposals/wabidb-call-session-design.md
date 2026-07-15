# Wabidb Call-Session Design

> **Card:** F16 (depends on this doc: F17, F18, F19, F20, F21)
> **Status:** v1 draft
> **Author:** Carl (engine) — Joey will validate the call_impl_core.ts contract before F19 starts
> **Goal:** Replace SpacetimeDB call-state tables (3 tables, 5 reducers) with wabidb-native equivalents. Hard rip — no STDB fallback path.

---

## 1. Scope

This design replaces these STDB constructs (currently in `frontend/src/lib/stdbConnection.ts`):

| STDB construct | Wabidb replacement |
|----------------|---------------------|
| `state_call_session` table | `wabidb::domain::CallSession` + `CallSessionsProjection` |
| `state_call_participant` table | `wabidb::domain::CallParticipant` + `CallParticipantsProjection` |
| `state_call_signal` table | `wabidb::domain::CallSignal` + `CallSignalsProjection` |
| `call_session_create` reducer | `wabidb::commands::call_session_create::create(...)` |
| `call_session_join` reducer | `wabidb::commands::call_session_join::join(...)` |
| `call_session_leave` reducer | `wabidb::commands::call_session_leave::leave(...)` |
| `call_session_end` reducer | `wabidb::commands::call_session_end::end(...)` |
| `call_signal_emit` reducer | `wabidb::commands::call_signal_emit::emit(...)` |
| `SELECT * FROM state_call_session WHERE session_id = '...'` (subscription) | `WabiStore::get_call_session(session_id)` + WS push events |
| `SELECT * FROM state_call_participant WHERE session_id = '...'` | `WabiStore::get_call_participants(session_id)` + WS push |
| `SELECT * FROM state_call_signal WHERE session_id = '...'` | `WabiStore::get_call_signals(session_id, since)` + WS push |

---

## 2. Domain Types (add to `wabidb/src/domain/mod.rs`)

Pattern match: existing types like `Message`, `ChannelMember` use `i64 created_at_micros`. We follow that.

```rust
/// A voice/video call session scoped to one channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallSession {
    pub session_id: String,
    pub channel_id: String,
    pub call_type: String,         // "audio-call" | "video-call" | "screen-share"
    pub host_user_id: u64,
    pub started_at_micros: i64,
    pub ended_at_micros: Option<i64>,
    pub transport: String,         // "stdb-replacement" | "webrtc" | "sfu"
    pub max_participants: u32,
    pub active: bool,
    pub last_updated_at_micros: i64,
}

/// One participant in a call session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallParticipant {
    pub participant_key: String,   // "<session_id>:<user_id>" — synthetic primary key
    pub session_id: String,
    pub user_id: u64,
    pub stable_user_id: String,    // client-side UUID, survives reconnects
    pub joined_at_micros: i64,
    pub left_at_micros: Option<i64>,
    pub is_host: bool,
    pub muted: bool,
    pub video_enabled: bool,
    pub last_updated_at_micros: i64,
}

/// A signaling message within a call (offer/answer/ICE/mute/etc).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallSignal {
    pub signal_id: u64,            // monotonically assigned by projection
    pub session_id: String,
    pub from_user_id: u64,
    pub signal_type: String,       // "offer" | "answer" | "ice" | "mute" | "unmute" | "kick"
    pub target_user_id: Option<u64>,
    pub payload: String,           // JSON-stringified signal body
    pub created_at_micros: i64,
}
```

### 2.1 Field mapping notes

- **STDB `bigint` -> wabidb `i64` (signed micros) or `u64` (counters/IDs).** STDB uses `bigint` for IDs and timestamps; wabidb separates `u64` for entity IDs and `i64` for micros timestamps. This matches existing `Message.message_id`/`Message.created_at_micros` style.
- **`lastUpdatedAt: Timestamp`** in STDB -> `last_updated_at_micros: i64` in wabidb. STDB Timestamp is a struct; wabidb uses raw micros.
- **`participant_key: String`** is a synthetic primary key formatted as `<session_id>:<user_id>`. STDB uses this exact pattern (see frontend import). We preserve it so the same external identity survives the rip.
- **`signal_id: u64`** is assigned by the projection on insert (monotonic per engine). STDB auto-assigns; we follow the projection-counter pattern.

---

## 3. Command Modules (add under `wabidb/src/commands/`)

Five new files, each following the pattern in `send_dm_message.rs`:

### 3.1 `call_session_create.rs`

```rust
pub async fn create_call_session(
    session_id: String,
    channel_id: String,
    call_type: String,
    host_user_id: u64,
    max_participants: u32,
    transport: String,
    sequencer: &CommitSequencer,
    projection_state: &ProjectionState,
) -> Result<CommandOutcome>
```

Behavior:
1. Build `CallSession` record with `started_at_micros = now`, `active = true`, `last_updated_at_micros = now`.
2. Submit `CommandCommit` with `command_name = "call_session_create"`, one `EventToWrite` to stream `call_session:<session_id>` (stream_kind = 6 = "other" per sequencer/mod.rs line 43-52).
3. The event payload is `serde_json::to_vec(&session)`.
4. Sequencer assigns `commit_seq`, fsyncs, advances barrier.

### 3.2 `call_session_join.rs`

```rust
pub async fn join_call_session(
    session_id: String,
    user_id: u64,
    stable_user_id: String,
    is_host: bool,
    sequencer: &CommitSequencer,
    projection_state: &ProjectionState,
) -> Result<CommandOutcome>
```

Builds `CallParticipant` with `joined_at_micros = now`, `left_at_micros = None`, `participant_key = "<session_id>:<user_id>"`. Writes to stream `call_participant:<participant_key>` (stream_kind = 6).

### 3.3 `call_session_leave.rs`

```rust
pub async fn leave_call_session(
    session_id: String,
    user_id: u64,
    sequencer: &CommitSequencer,
    projection_state: &ProjectionState,
) -> Result<CommandOutcome>
```

Loads existing `CallParticipant`, sets `left_at_micros = Some(now)`, `last_updated_at_micros = now`. Writes updated record. If participant doesn't exist, returns `WabiError::NotFound`.

### 3.4 `call_session_end.rs`

```rust
pub async fn end_call_session(
    session_id: String,
    sequencer: &CommitSequencer,
    projection_state: &ProjectionState,
) -> Result<CommandOutcome>
```

Loads `CallSession`, sets `ended_at_micros = Some(now)`, `active = false`, `last_updated_at_micros = now`. Writes updated record.

### 3.5 `call_signal_emit.rs`

```rust
pub async fn emit_call_signal(
    session_id: String,
    from_user_id: u64,
    signal_type: String,
    target_user_id: Option<u64>,
    payload: String,
    sequencer: &CommitSequencer,
    projection_state: &ProjectionState,
) -> Result<CommandOutcome>
```

Builds `CallSignal`. Stream id = `call_signal:<session_id>` (stream_kind = 6). The projection assigns `signal_id` on insert (monotonic per session via a separate counter).

---

## 4. Projection Modules (add under `wabidb/src/projections/`)

Three new files, each following the pattern in `messages.rs`:

### 4.1 `call_sessions.rs`

Projection name: `call_sessions`
Event type handled: `call_session_created`
Index key: `session_id` (encode as `encode_string(buf, session_id)`)
Index value: full `CallSession` encoded as JSON via `serde_json::to_vec` (matching the simpler pattern in `users.rs` — see existing code).

Note: STDB's `lastUpdatedAt` semantics mean updates arrive as separate `onUpdate` events. Our projection will be additive (insert + replace by key), so updated `CallSession` records overwrite the old one at the same key.

### 4.2 `call_participants.rs`

Projection name: `call_participants`
Event type handled: `call_participant_joined` / `call_participant_left`
Index key: `participant_key`
Index value: full `CallParticipant` as JSON.

Secondary key (for the subscription query `WHERE session_id = '...'`): a side index `call_participants_by_session:<session_id>` -> set of participant_keys. Implementation: a `HashMap<String, HashSet<String>>` wrapped in `SkipMap`. On insert/remove, update both indexes.

### 4.3 `call_signals.rs`

Projection name: `call_signals`
Event type handled: `call_signal_emitted`
Index key: `<session_id>:<signal_id>` (encode as two strings separated by delimiter)
Index value: full `CallSignal` as JSON.

Secondary key: `call_signals_by_session:<session_id>` -> sorted list of signal_ids. Implementation: a `BTreeMap<(session_id, signal_id), ()>` so we can range-query by session and stream since.

---

## 5. WabiStore Trait Extension

Add to `wabidb/src/engine/wabi_store.rs`:

```rust
// Call session commands (write path - returns commit_seq)
async fn create_call_session(
    &self,
    session_id: String, channel_id: String, call_type: String,
    host_user_id: u64, max_participants: u32, transport: String,
) -> Result<u64>;

async fn join_call_session(
    &self, session_id: String, user_id: u64,
    stable_user_id: String, is_host: bool,
) -> Result<u64>;

async fn leave_call_session(
    &self, session_id: String, user_id: u64,
) -> Result<u64>;

async fn end_call_session(
    &self, session_id: String,
) -> Result<u64>;

async fn emit_call_signal(
    &self, session_id: String, from_user_id: u64, signal_type: String,
    target_user_id: Option<u64>, payload: String,
) -> Result<u64>;

// Call session queries (read path - returns rows)
fn get_call_session(&self, session_id: &str) -> Result<Option<CallSession>>;
fn get_call_participants(&self, session_id: &str) -> Result<Vec<CallParticipant>>;
fn get_call_signals(&self, session_id: &str, since_signal_id: u64) -> Result<Vec<CallSignal>>;
```

### 5.1 WdbAdapter implementation (in `wabi-server/src/adapter/mod.rs`)

Each write method constructs the appropriate `CommandCommit` and submits via `engine.run_command()`. Each read method queries the projection state and deserializes the JSON value (matching the existing 23-method pattern).

---

## 6. Wire Protocol (HTTP + WebSocket)

### 6.1 HTTP endpoints (new `api/calls.rs` in wabi-server)

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/calls/sessions` | `{session_id, channel_id, call_type, host_user_id, max_participants, transport}` | `{commit_seq}` |
| POST | `/api/calls/sessions/:id/join` | `{user_id, stable_user_id}` | `{commit_seq}` |
| POST | `/api/calls/sessions/:id/leave` | `{user_id}` | `{commit_seq}` |
| POST | `/api/calls/sessions/:id/end` | `{}` | `{commit_seq}` |
| POST | `/api/calls/sessions/:id/signals` | `{from_user_id, signal_type, target_user_id?, payload}` | `{commit_seq}` |
| GET | `/api/calls/sessions/:id` | — | `CallSession` |
| GET | `/api/calls/sessions/:id/participants` | — | `[CallParticipant]` |
| GET | `/api/calls/sessions/:id/signals?since=<id>` | — | `[CallSignal]` |

All endpoints require JWT (use `auth_extractor`). Authorization rule: only call participants or server admins can read; only the host or a server admin can end a session.

### 6.2 WebSocket protocol

Extend `wabi-server/src/websocket.rs` `WsMessage` enum:

```rust
// Client -> Server
SubscribeCall { session_id: String },
UnsubscribeCall { session_id: String },

// Server -> Client (pushed when projections update)
CallSessionChanged { session: CallSession },
CallParticipantChanged { session_id: String, participants: Vec<CallParticipant> },
CallSignalEmitted { signal: CallSignal },
```

Subscription tracking: server keeps `HashMap<session_id, HashSet<WebSocketConnectionId>>`. When a projection update lands, server iterates subscribers and pushes.

---

## 7. Frontend Client (F19 deliverable)

Replace `frontend/src/lib/stdbConnection.ts` with `frontend/src/lib/wabidbCallConnection.ts` exporting class `WabiDbCallState`. Same API shape as `StdbCallState` so `callingStdb.ts`, `stdbMediaRelay.ts`, `experimentalStdbCalls.ts` only need minimal rewiring (or file renames).

```typescript
export class WabiDbCallState {
  constructor(cfg: { serverUrl: string; token?: string }) {}
  connect(): void;                                  // opens WS
  disconnect(): void;
  get isConnected(): boolean;
  
  // HTTP-backed writes
  createSession(sessionId, channelId, callType, hostUserId, maxParticipants): Promise<void>;
  joinSession(sessionId, userId, stableUserId): Promise<void>;
  leaveSession(sessionId, userId, _stableUserId): Promise<void>;
  endSession(sessionId, _userId?, _stableUserId?): Promise<void>;
  emitSignal(sessionId, userId, signalType, payloadJson): Promise<void>;
  
  // WS-backed subscriptions (returns opaque handle)
  subscribeToSession(sessionId): Handle[];
  unsubscribeAll(): void;
  
  // HTTP-backed reads
  getSession(sessionId): Promise<StateCallSessionRow | undefined>;
  getParticipants(sessionId): Promise<StateCallParticipantRow[]>;
  getSignals(sessionId, since): Promise<StateCallSignalRow[]>;
  
  // Event handlers (same names as StdbCallState)
  onConnect(cb): void;
  onDisconnect(cb): void;
  onError(cb): void;
  onSessionChange(cb): void;
  onParticipantChange(cb): void;
  onSignal(cb): void;
}
```

### 7.1 Auto-reconnect

Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. On reconnect, re-subscribe to all active session IDs. Buffer last-seen rows per session so `onSessionChange` fires with current state after reconnect.

---

## 8. Verification Plan (per card)

| Card | Verification |
|------|--------------|
| F16 | This doc reviewed by opencode as pair-of-eyes; sign-off before F17 |
| F17 | `cargo check -p wabidb && cargo check -p wabi-server` exits 0; unit tests for each new command (happy path + 2 error paths) |
| F18 | `cargo check -p wabi-server` exits 0; manual curl test of all 8 endpoints |
| F19 | `npm run check` exits 0; `npm run build` exits 0; old `calling_impl_core.ts` imports unchanged |
| F20 | `grep -rn 'spacetimedb' frontend/src/` returns 0; `npm install` exits 0; `npm run check` exits 0 |
| F21 | `grep -rn 'VITE_CALL_STDB\|VITE_STDB' .` returns 0 outside archive/ |

---

## 9. Risks + Open Questions

### 9.1 Auth/authz
The STDB binding had **no authorization** (call session state is shared). The HTTP endpoints need JWT + participant check. Need to decide: does `auth_extractor` support per-resource authz, or do we hand-roll it in each handler?

**Open question for Joey:** what's the existing pattern in `api/channels.rs` for "only channel members can do X"?

### 9.2 Concurrent join
STDB reducers are atomic. Wabidb commands are atomic per `CommandCommit`. But `join_call_session` needs to:
1. Read existing `CallParticipant` for that (session, user) pair
2. If exists: skip (idempotent rejoin)
3. If not: insert

This is a read-then-write race. **Mitigation:** projection-level uniqueness check inside the command (read projection state, fail if duplicate). Concurrent calls will serialize at the sequencer's `Semaphore(1)`.

### 9.3 Signal counter
`signal_id: u64` must be monotonic per session. The projection assigns it on insert. We need a per-session counter in the projection. If the engine restarts mid-call, counter resets — but signals with `signal_id <= last_seen` are filtered out by `get_signals(since)`. This means a client that received signal 5 before restart will miss signal 0-5 after restart.

**Mitigation:** store the next-signal-id in the durable event payload itself (computed at command time, not projection time). Projection just stores it. This is simpler and survives restart.

### 9.4 Room tracking for media relay
Existing `socketio/media_reactions_signaling.rs` uses STDB room IDs like `stdb-call-{session_id}`. Wabidb doesn't have rooms. Options:
- (a) Keep Socket.IO rooms as in-memory state, accept that they reset on restart (call ends -> everyone disconnects -> rooms gone, which is actually fine)
- (b) Store room membership as a wabidb projection

**Recommendation (a)** — rooms are transient anyway, and a restart mid-call is a real disconnect anyway. Don't bloat wabidb with room state.

### 9.5 VITE_CALL_STDB_URL frontend env var
Currently `ws://localhost:3101` (STDB proxy). After rip, becomes `wss://<wabi-server-host>` (same origin as the API). F21 handles rename.

---

## 10. Cross-references

- STDB tables being replaced: `frontend/src/lib/stdb_bindings/` (53 generated files)
- STDB reducers being replaced: same directory
- STDB consumer: `frontend/src/lib/stdbConnection.ts`, `frontend/src/lib/callingStdb.ts`, `frontend/src/lib/stdbMediaRelay.ts`, `frontend/src/lib/experimentalStdbCalls.ts`
- STDB server-side handler: `core/crates/wabi-server/src/socketio/media_reactions_signaling.rs` (needs adjustment for F18)
- Reference patterns to follow:
  - Domain: `core/crates/wabidb/src/domain/mod.rs` (User, Channel, Message)
  - Commands: `core/crates/wabidb/src/commands/send_dm_message.rs`
  - Projections: `core/crates/wabidb/src/projections/messages.rs`, `users.rs`
  - WabiStore: `core/crates/wabidb/src/engine/wabi_store.rs`
  - WdbAdapter: `core/crates/wabi-server/src/adapter/mod.rs`
- Related work: STDB removal A1-A14 (compose/scripts cleanup, all done); backend rip (engine done; backend mostly done; main.rs still reads WABI_STDB_SERVER but harmless default)