# WabiDB Integration Plan — Moving Wabi from SpacetimeDB to WabiDB

> **Date:** 2026-06-21
> **Author:** Joey (Hermes session for integration)
> **Companion track:** Carl (Hermes session for WabiDB validation — memory leak, load, failure injection, MIRI follow-up)
> **Audience:** Ronin
> **Status:** Plan, awaiting review before any code changes
> **Source of truth this plan extends:** `docs/proposals/wabidb-endstate.md` §12 (Connection to Existing Wabi Code)

---

## 1. Goal

Wabi-server reads and writes go through WabiDB. SpacetimeDB is decommissioned. The current wabi feature surface (channels, messages, DMs, users, presence, bans, whiteboard, notes, places, business hub) keeps working with the same user-visible behavior.

This is a substrate swap, not a feature plan.

## 2. The constraint that shapes this plan

Verbatim from Ronin: "almost done, more safety testing instead of function working right? If we do big things with the DB then we'll add it in then right?"

The end-state design doc (`wabidb-endstate.md`) defines 60+ commands across channels, DMs, calls, whiteboards, maps, places, notes, business hub, settings, retention, helper administration, and addon registration. **This plan uses the subset that maps to what wabi actually does today.** The rest come later, after WabiDB is the proven substrate in production.

Carl handles WabiDB-internal safety (Track 1.2-1.5 of `wabidb-test-plan.md`: valgrind, load, failure injection, real-workload replay). Joey handles the integration work described in this plan.

## 3. In scope vs out of scope

In scope:

- Every current wabi-server handler continues to work, byte-equivalent behavior
- Every current wabi feature (channels, messages, DMs, users, sessions, presence, bans, mutes, reactions, webhooks, whiteboard-lite, notes, places, business-hub-lite, role/RBAC) keeps working
- SpacetimeDB shutdown after a defined grace period
- The two STDB bridge modules deleted (`spacetimedb/wabi_state_bridge/`, `spacetimedb/wabi_call_state_bridge/`)
- A migration tool that reads STDB and writes WabiDB
- A validation script that proves the migration preserved data
- A cutover runbook

Out of scope (deferred until WabiDB is the production substrate for 30+ clean days):

- Proposed X3DH + Double Ratchet + per-device envelopes for DMs; unshipped and not a current security guarantee
- Full whiteboard patch system (rich drawing primitives, patch streaming, history)
- Full business hub (kanban tasks, projects, sprints, calendar events, diary)
- Helper node protocol (search helper, media node, transcode node, regional anchor)
- Addon system (CAD, music sequencer, etc.)
- The ~40 wabidb commands in the endstate doc that have no current STDB reducer equivalent
- FTS5-equivalent search (the endstate defers this to a search helper; the current wabi doesn't have full-text search)
- Any frontend change. The frontend keeps talking to wabi-server the same way. (The wabidb-frontend cutover is a separate plan; this one ends at the server boundary.)

If a current feature breaks in the cutover, that's in-scope to fix. If a current feature needs a NEW wabidb command (one that doesn't exist in the 99 cards), that's in-scope to add, but only the minimum needed to preserve current behavior. Adding new features is not.

## 4. Current architecture (baseline)

```
┌─────────────┐       Socket.IO + HTTP        ┌──────────────┐
│  Frontend   │ ────────────────────────────▶ │  wabi-server │ port 3001
│  (Tauri +   │ ◀──────────────────────────── │              │
│   Svelte)   │        WebSocket              └──────┬───────┘
└─────────────┘                                       │ reqwest HTTP
                                                      │ POST /v1/database/wabi/sql
                                                      │ POST /v1/database/wabi/call/<reducer>
                                                      ▼
                                            ┌──────────────────┐
                                            │  SpacetimeDB     │ port 3000
                                            │  (wabi module)   │
                                            └──────────────────┘
```

What exists today:

- **`wabi-server` binary** at `core/crates/wabi-server/src/main.rs` (473 lines), built on axum + socketioxide.
- **AppState** at `core/crates/wabi-server/src/state.rs` holds a `StdbClient` field, used by every handler.
- **`StdbClient`** at `core/crates/wabi-server/src/db/mod.rs` is a `reqwest::Client` wrapper that:
  - `sql_query("SELECT * FROM state_X")` for reads
  - `call_reducer("ingest_wabi_event", [entity, operation, payload])` for writes (the universal funnel)
  - `ingest_event(entity, operation, payload)` is a thin convenience over `call_reducer`
  - `bootstrap_ingest_key()` for one-time STDB auth setup
- **STDB bridge modules** at `spacetimedb/wabi_state_bridge/src/lib.rs` and `spacetimedb/wabi_call_state_bridge/src/lib.rs` — these are the STDB WASM modules. Already excluded from the Cargo workspace. They define ~35 STDB tables (`StateMessage`, `StateChannel`, `StateUser`, `StateSession`, `StateRbacAssignment`, `StateBan`, `StateWhiteboard`, …) and 2 reducers (`ingest_wabi_event`, `set_ingest_key`).
- **Local state files** that are NOT in STDB: `data/server_owner.json`, `data/node_registry.json`, `data/job_queue.json`, `data/blacklist.txt`, the `core/addons/mesh/backend/` mesh service, the `core/addons/webhooks/backend/` webhook addon. These stay as files; WabiDB doesn't absorb them in this plan.

The current write path is "everything funnels through `ingest_wabi_event(entity, op, payload)`" — the bridge module's reducer parses the JSON `payload` and dispatches to the right STDB table. The current read path is "every handler hand-writes a `SELECT * FROM state_X WHERE ...` SQL string." Both paths are load-bearing for the integration plan.

## 5. Target architecture (end state)

```
┌─────────────┐       Socket.IO + HTTP        ┌──────────────────────────┐
│  Frontend   │ ────────────────────────────▶ │  wabi-server             │ port 3001
│  (unchanged)│ ◀──────────────────────────── │                          │
└─────────────┘                              │  ┌────────────────────┐  │
                                             │  │ WdbAdapter         │  │
                                             │  │ (StdbClient shape) │  │
                                             │  └─────────┬──────────┘  │
                                             │            │ direct Rust │
                                             │            ▼             │
                                             │  ┌────────────────────┐  │
                                             │  │ WabiDbEngine       │  │
                                             │  │ (core/crates/wabidb│  │
                                             │  │  embedded in proc) │  │
                                             │  └────────────────────┘  │
                                             └──────────────────────────┘
```

What changes:

- **`wabidb` becomes a dependency** of `wabi-server`'s `Cargo.toml`. Embedded mode (not sibling process) — the engine and the server share a process so handlers call `WabiDbEngine::invoke(command, ctx)` directly with no IPC.
- **`WdbAdapter`** replaces `StdbClient` in `AppState`. Same method shape (`sql_query`, `ingest_event`, etc.) so handlers don't have to change. The implementation calls WabiDB commands under the hood.
- **`AppState.stdb` is renamed to `AppState.wdb`** with the new type. (Field rename is mechanical; the type rename is the real change.)
- **The two STDB bridge modules are deleted.** They become dead code the moment the last `StdbClient` reference is removed.
- **SpacetimeDB process is shut down.** The `data/wabi-state-local` STDB module directory can stay as a read-only backup for 30 days, then deleted.
- **Frontend is unchanged.** The frontend still talks to wabi-server via Socket.IO + HTTP. The `spacetimedb` SDK in the frontend, if anything uses it directly (mostly the legacy bindings), is replaced in a separate plan. (Verified: most of the frontend uses the `wabi-core` TypeScript types and the Socket.IO client, not the `spacetimedb` SDK directly. Frontend migration is a follow-up, not part of this plan.)

## 6. Integration strategy — Option A, downtime import, no rollback after writes start

The endstate doc §12.5 names three honest options. For wabi, Option A is right.

| Option | Effort | Rollback | When to use |
|---|---|---|---|
| **A. Downtime import, no rollback after writes start** | Single migration + cutover | Only before the cutover. After, rollback means replaying WDB deltas back to STDB. | Self-hosted single-server with modest write rate. |
| B. Dual-write shadow | Two engines running, reconciliation tooling, dual-write idempotency keys | Yes, until STDB writes stop. | High-confidence / high-stakes cutovers. |
| C. Feature-by-feature cutover | Per-feature migration scripts, freeze-and-replay, complex cross-feature consistency | Per-feature, narrow blast radius. | Large apps with many stateful features. |

Why A is right for wabi:

- **Self-hosted = no multi-region coordination.** We're not running two datacenters; we're running one box.
- **Single-server = no second engine to run in parallel.** Option B requires a second WabiDB process during the dual-write window. WabiDB is embedded; running a second copy is real complexity.
- **Low write rate.** The current wabi is a self-hosted Discord alt at a few hundred to a few thousand messages per minute in a busy community. Downtime of minutes is acceptable; the user will see a "maintenance" banner.
- **The grace-period STDB backup gives rollback.** For 30 days after cutover, STDB is read-only and frozen. If WabiDB turns out to be broken in a way the validation didn't catch, an operator can revert (lose the WDB deltas; restore STDB as source of truth; manual replay of any lost-but-needed messages).

Why B and C are wrong for this cutover:

- **B is overkill.** The reconciliation tooling is real complexity. The dual-write idempotency story is real complexity. For a self-hosted product where one person presses "go," the cost-benefit doesn't work.
- **C is fragile.** Features cross-reference each other (messages reference users, users reference sessions, sessions reference devices). Cutting over users before messages means messages can't be read in the new system. Cutting over messages before users means a message author becomes anonymous. The cross-feature consistency story is the real cost, and Option A avoids it by going all-or-nothing.

## 7. Build order

The work has 10 steps. Each step has a clear "done" condition.

### Step 1 — Add `wabidb` as a dependency in `wabi-server/Cargo.toml`

Add `wabidb = { path = "../wabidb" }` to the `[dependencies]` block. Run `cargo check -p wabi-server`. Expect: clean (the wabidb crate already passes `cargo check` and exposes the `WabiDbEngine`, `WabiStore` trait, and `WabiError` types). No behavior change. **Done:** `cargo check -p wabi-server` returns 0 with wabidb listed in the dep tree.

### Step 2 — Create the `WdbAdapter` skeleton

New file `core/crates/wabi-server/src/db/wdb_adapter.rs`. Define `WdbAdapter` as the new struct that will replace `StdbClient`. It holds an `Arc<WabiDbEngine>`. Method signatures match `StdbClient`'s public surface (`sql_query`, `ingest_event`, `bootstrap_ingest_key`, etc.) but the bodies are stubs that return `unimplemented!()` for now. **Done:** the file compiles, `WdbAdapter` has the same public methods as `StdbClient`.

### Step 3 — Add `WdbAdapter` to `AppState` alongside `StdbClient`

In `state.rs`, add `pub wdb: WdbAdapter,` to `AppState` and initialize it in `AppState::new`. The `StdbClient` field stays. Both are present; only `stdb` is wired to handlers. **Done:** `cargo check -p wabi-server` passes, `state.wdb` is reachable, no handler uses it yet.

### Step 4 — Implement the WDB command surface that maps to current STDB writes

The current write path is `ingest_wabi_event(entity, op, payload)`. The WDB equivalent is a set of typed commands. For each entity the current wabi actually writes:

- `user` op (`create`, `update`) → WDB `register_user` / `update_user` command
- `channel` op (`create`, `update`, `delete`) → `create_channel` / `update_channel` / `delete_channel`
- `message` op (`create`, `update`, `delete`) → `send_message` / `edit_message` / `delete_message`
- `reaction` op → `add_reaction` / `remove_reaction`
- `channel_member` op → `add_channel_member` / `remove_channel_member`
- `ban` op → `ban_user` / `unban_user`
- `mute` op → `mute_user` / `unmute_user`
- `rbac_assignment` op → `assign_role` / `revoke_role`
- `role_definition` op → `upsert_role_definition`
- `presence` op → ephemeral bus (live lane, not durable)
- `webhook` op → `register_webhook` / `delete_webhook`
- `whiteboard` op → `create_whiteboard` / `update_whiteboard`
- `note` op → `create_note` / `update_note`
- `place` op → `create_place` / `update_place`
- `kanban` / `project` / `sprint` ops → minimal WDB commands (the business hub surface; keep the schema, not the features)

This is the work the endstate doc calls "Section 4.2: complete command list." For this integration, we implement the subset above (the wabi-current surface). The remaining 40+ commands stay as "not yet implemented" in `wabidb::commands` and are not required for the cutover.

The `WdbAdapter::ingest_event(entity, op, payload)` method becomes a single match on `(entity, op)` that dispatches to the right WDB command. The JSON `payload` is deserialized into the command's input struct. **Done:** every entity the current wabi writes has a WDB command implementation, the WDB projection handler updates the right projection table, the WDB unit tests for that command pass.

### Step 5 — Implement the WDB projection query surface that maps to current STDB reads

The current read path is hand-written `SELECT * FROM state_X WHERE ...` SQL. The WDB equivalent is calls to the `WabiStore` trait (which `WabiDbEngine` implements). For each SQL pattern the current handlers use, write a `WabiStore` method:

- `get_channels()` → `storage.get_channels(filter, limit)`
- `get_channel_messages(channel_id, before, limit)` → `storage.get_channel_messages(...)`
- `get_user(user_id)` → `storage.get_user(...)`
- `get_users_by_username(...)` → `storage.find_user_by_username(...)`
- `get_session(session_token)` → `storage.get_session(...)`
- `get_rbac_assignments(user_id, workspace_id)` → `storage.get_rbac_for_user(...)`
- `get_role_definitions(workspace_id)` → `storage.get_role_definitions(...)`
- `get_bans(workspace_id)` → `storage.get_bans(...)`
- `get_whiteboard(board_id)` → `storage.get_whiteboard_snapshot(...)`
- `get_user_layout(user_id)` → `storage.get_user_layout(...)`
- `get_channel_retention(channel_id)` → `storage.get_channel_retention(...)`
- `get_webhooks()` → `storage.get_webhooks(...)`
- (etc., for every SELECT the current handlers use)

This is the wabidb-21 / wabidb-22 work from the kanban, extended to cover the actual STDB surface area. The `WdbAdapter::sql_query(sql)` method becomes a SQL-to-WDB dispatcher (a small shim that maps each known SQL pattern to the right `WabiStore` call). **Done:** every SELECT the current handlers use has a WDB equivalent that returns the same shape, the WDB projection unit tests pass.

### Step 6 — Build the migration tool

New crate `core/crates/wabidb-migrate/` (a binary, as the endstate §12.5 specifies). It:

1. Connects to STDB via the `StdbClient` HTTP API
2. For each table in the allowlist (the 35 `State*` tables, with an explicit per-table mapping to the WDB projection), runs `SELECT * FROM state_X` and pulls all rows
3. For each row, applies the schema transformation (mostly identity, but some STDB-isms to strip — see §8)
4. Translates each row to the right WDB command input
5. Submits the command via the `WabiDbEngine::invoke` API
6. Records progress so it can resume on failure

This is the long-running, one-shot tool. It does not run as part of wabi-server; it's a separate binary the operator runs. **Done:** the tool runs end-to-end on a STDB snapshot in dev. Output: a populated WabiDB data directory.

### Step 7 — Build the validation script

New crate `core/crates/wabidb-migrate/src/validate.rs` (or a sibling script). It:

1. Connects to STDB
2. Connects to the populated WabiDB
3. For each table, counts rows on both sides, asserts equal
4. For a deterministic sample of 1% of rows, hashes the row contents on both sides, asserts equal
5. Emits a `MigrationReport` (counts, hashes, per-table pass/fail) that the operator reviews before cutover

This is the gate. **Done:** the script runs against the dev migration and reports `OK` for all 35 tables. If any table fails, the migration tool is broken and the cutover is blocked.

### Step 8 — Cut over handler by handler

The actual swap. For each handler file in `wabi-server/src/api/`, `wabi-server/src/socketio/`:

1. Change the call from `state.stdb.sql_query(...)` to `state.wdb.sql_query(...)` (or call the new WDB-specific method directly)
2. Change the call from `state.stdb.ingest_event(...)` to `state.wdb.ingest_event(...)` (or call the WDB command directly)
3. Build, test
4. Once all handler files are converted, delete the `StdbClient` struct
5. Rename `AppState.stdb` to `AppState.wdb`
6. Update Cargo.toml to remove the `reqwest`-for-STDB dependencies that are no longer used

**Why handler-by-handler, not all at once:** the surface area is large. Converting one handler at a time and rebuilding keeps the diff small and the reviewable. Each handler conversion is its own commit. **Done:** every handler uses `state.wdb`; the `stdb` field is gone; `cargo check` is clean.

### Step 9 — Delete the STDB bridge modules and shut down the STDB process

`rm -rf spacetimedb/wabi_state_bridge spacetimedb/wabi_call_state_bridge`. Update `Cargo.toml` workspace members if they were ever re-added (they're already excluded). Stop the `spacetimedb` process on the dev box and on the production box. **Done:** the bridge modules are gone; STDB is not running; the dev/prod environment only runs wabi-server + WabiDB.

### Step 10 — Runbook + 30-day observation

Write `docs/runbooks/wabidb-cutover.md` covering:

- The exact command sequence to run the migration
- The exact command sequence to start wabi-server pointing at WabiDB
- The exact command sequence to revert to STDB if the cutover fails in the first 30 days
- The 30-day decommission checklist
- The "what to do if WabiDB loses data" emergency procedure

The STDB backup is kept read-only for 30 days. After 30 days of clean WDB production, the STDB data directory is deleted. **Done:** the runbook is reviewed; the 30-day window starts.

## 8. Data migration details

The 35 STDB tables in `wabi_state_bridge/src/lib.rs` map to WDB projection tables in `wabidb-endstate.md` §3 and §12.4. The mapping is mostly 1:1 with a few schema-cleanup cases:

| STDB table | WDB projection | Cleanup notes |
|---|---|---|
| `StateUser` | `users` | STDB has a generic `row_json` blob; WDB has fixed columns. Migration tool unrolls the blob into the typed columns. |
| `StateUserMeta` | merged into `users` | The meta fields become columns on `users`. |
| `StateUserUsername` / `StateUserHandle` | merged into `users` | `username_lc` and `handle_lc` columns already on `users`. |
| `StateSession` | `sessions` | STDB has `session_token` (plaintext); WDB has `session_token_hash` (BLAKE3). Migration tool hashes. |
| `StateUserEncryptionKey` | `identity_keys`, `devices`, `device_pinned_keys` | The current STDB field is a single key blob; WDB's identity-keys table is per-device. Migration tool splits if multiple devices exist, else migrates the single device. |
| `StateRbacAssignment` | `rbac_assignments` | 1:1, column rename. |
| `StateRoleDefinition` | `role_definitions` | STDB has `row_json` blob; WDB has fixed columns + `capabilities_json`. Migration tool unrolls. |
| `StateMessage` | `messages` | 1:1, but STDB has `row_json` blob for content; WDB has fixed `content`, `content_alg`, `attachments` columns. |
| `StateReaction` | `reactions` | 1:1, no transformation. |
| `StateChannel` | `channels` | 1:1, `row_json` → fixed columns. |
| `StateChannelMember` | `channel_members` | 1:1. |
| `StateBan` / `StateMute` / `StateDeafen` | `bans` / `mutes` | 1:1. (Deafen → ephemeral, not durable; migration tool drops.) |
| `StateRelay` | merged into `channels` (relay entries are server-connection metadata, not state) | Migration tool drops; relays are runtime-only. |
| `StateDictionaryEntry` | `audit_log` (renamed) | 1:1, column rename. |
| `StateAppSetting` | `app_settings` | 1:1. |
| `StateBackendInstanceLease` / `StateSocketLease` / `StatePresenceLease` | dropped | All three are runtime leases; the new server creates fresh ones on startup. |
| `StateManualSettlement` | dropped | Internal bookkeeping; not user-visible state. |
| `StateWhiteboard` | `whiteboards`, `whiteboard_patches`, `whiteboard_snapshots` | The current STDB whiteboard is a single row; WDB has the full patch log. Migration tool reads the single row's content as the initial state and writes one `whiteboard_created` event. The full patch log is a future-feature. |
| `StateOfflineMessage` | `messages` + `dm_messages` | STDB stores offline messages in a separate table; WDB stores them as regular messages with a recipient list. Migration tool routes by type. |
| `StateGuestCode` | `guest_codes` | 1:1. |
| `StateEmojiRoleRule` | `role_definitions.capabilities_json` | Migration tool folds emoji-role rules into the role's capabilities JSON. |
| `StateEmote` | `emotes` | 1:1. |
| `StateAlbum` / `StateAlbumItem` | `albums` / `album_items` | 1:1. |
| `StateWebhook` / `StateWebhookDelivery` | `webhooks` / `webhook_deliveries` | 1:1. |
| `IngestAuthConfig` | dropped | STDB-only; WDB uses its own bootstrap key. |
| `IngestedEvent` | dropped | STDB-only; the events are now first-class in WDB. |
| `IngestEnvelope` | dropped | Private to STDB module. |
| `StateUserSettings` / `StateThemePreferences` / `StateLayoutPreferences` | `user_settings` (merged) | The three STDB tables become one WDB table with a `theme_json` and `layout_json` column. |

The migration tool reads `StateX.row_json` blobs and unrolls them into the typed WDB columns. The endstate doc §3.1 has the canonical column lists; the migration tool's row parser references those.

**Total transformation surface:** ~35 tables, ~5 with `row_json` unrolling, ~8 with simple renames, ~22 with 1:1 mapping, ~6 dropped (runtime-only STDB internals). The migration tool is the largest single piece of work in this plan; expect it to be a 1,500-2,500 LOC binary.

## 9. Risk analysis + rollback

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration tool misses a table | Medium | Critical (data loss) | Step 7's validation script catches it; the cutover is blocked until every table passes. |
| Migration tool mis-transforms a row | Medium | Critical (data corruption) | Per-table 1% sample hash check in validation; manual review of one full row per table before cutover. |
| Handler bug post-cutover | Low-Medium | High (functional break) | The cutover is per-handler in step 8, so a bad handler is reverted by reverting one commit. |
| WDB crash in production | Low | Critical (data unavailability) | STDB read-only backup for 30 days. WDB has manifest-based backups (`wabidb-68`/`wabidb-92`). The wabidb-99 power-loss test (Carl's track) verifies recovery from crashes. |
| WDB data loss in production | Low | Critical (permanent) | The wabidb-69 (`verify-backup`) and wabidb-93 (`restore from manifest`) runbooks let an operator restore from a recent manifest backup. STDB backup is the fallback for 30 days. |
| WebSocket fanout regression (subscribers stop receiving events) | Low | High (real-time break) | The wabidb-30 (indexes), wabidb-48 (live fanout), wabidb-49 (topic indexes) cards cover this. The integration work wires wabi-server's existing broadcast channels to WDB's subscription engine; the existing per-channel `ws_tx: broadcast::Sender` is the fanout primitive and stays. |
| Idempotency key collision during migration | Low | Medium (duplicate writes) | Migration tool generates fresh `client_request_id` per row; WDB's `command_idempotency` table keys on `(caller, client_request_id)`; the migration uses a unique synthetic caller per row. |
| `server_owner.json` ownership gets lost | Low | High (no admin login) | The migration tool writes the new `server_owner.json` from the STDB RBAC assignments (first user with `role=owner`). Manual review of the resulting owner ID before cutover. |

### Rollback

**Rollback is only valid before Step 8 completes.** The grace-period STDB backup is the rollback surface.

During Steps 1-7, no wabi-server writes have happened. The migration tool can be re-run, the validation script can be re-run. No data is at risk.

During Step 8, the cutover is handler-by-handler. A bad handler cutover is reverted by reverting the handler's commit. The STDB is still the source of truth; WDB writes from the bad cutover are discarded.

**After Step 8 completes, rollback means reverting to STDB as the source of truth.** The procedure:

1. Stop wabi-server
2. Restore the frozen STDB backup
3. Start the old version of wabi-server (the pre-cutover binary)
4. Manually replay any WDB deltas that happened during the cutover window back into STDB (this is a one-time effort; the STDB backup is from before the cutover, so anything written by WDB in between is lost unless replayed)
5. Open a follow-up issue to investigate what went wrong

This is why the 30-day observation window matters. The 30 days are the period during which the operator can decide to revert without losing more than the WDB-only writes from the cutover window.

## 10. Open questions for Ronin

1. **Downtime budget for the cutover.** Minutes, an hour, or "overnight, no banner needed"? The cutover is "stop STDB → run migration → start WDB." The migration time scales with the data size; a small server is sub-minute, a large one (years of messages) could be 10-30 minutes. The downtime window is mostly the migration run, not the cutover itself.

2. **Rollback grace period.** 30 days is the default in the endstate. You may want longer (90 days) or shorter (7 days, if you're confident). Longer = more insurance, more disk. Shorter = cleaner end state.

3. **Frontend SDK migration timing.** This plan ends at the server boundary; the frontend keeps using the existing pattern. A separate plan is needed to migrate the frontend's `spacetimedb` SDK usage to the `WabiClient` (the wabidb-frontend). Should that be: (a) part of this plan, (b) immediately after, (c) after the 30-day observation window?

4. **The `data/wabi-state-local` STDB module directory** — keep as backup (the plan's default), or move out of the wabi repo entirely (cleaner end state)?

5. **The wabi-server `data/server_owner.json`** — this is a JSON file on disk that holds the server owner. The endstate doc §12.5 says ownership should come from STDB RBAC. The migration tool reads RBAC and writes the JSON. After cutover, should the JSON be the source of truth (cheap, no DB hit) or should it be derived from WDB on every read (always-fresh, one DB hit per check)?

6. **The mesh service and webhooks addon** — these are in `core/addons/`, separate from the STDB module. They have their own state (mesh node registry, webhook delivery queue). The plan leaves them as-is. Confirm that's the right call, or do you want them absorbed into WDB in this round?

7. **The `data/blacklist.txt` file** — IP blacklist for anti-abuse. Currently a file, not in STDB. Leave as a file? Or move to WDB? The plan says "leave as a file" (out of scope).

## 11. What this plan does NOT do

Reaffirming the boundary, because the boundary is what makes the cutover tractable:

- It does not add new wabidb commands beyond the ~20 needed to preserve current behavior.
- It does not add the X3DH / Double Ratchet / per-device envelope DM encryption.
- It does not add the full whiteboard patch system.
- It does not add the helper node protocol.
- It does not add the addon system.
- It does not change the frontend.
- It does not add full-text search.
- It does not add cross-region replication.
- It does not "improve" any current feature. If a current feature is buggy, that's a separate fix.
- It does not touch the mesh, webhooks, blacklist, or node-registry subsystems.

The plan moves the substrate. It does not add features. The features come later, on a known-good substrate.

## 12. First concrete step

Step 1: `core/crates/wabi-server/Cargo.toml` adds `wabidb = { path = "../wabidb" }`. Then `cargo check -p wabi-server` from `/var/home/Ronin/wabi`. Expect: clean, 0 errors, wabidb in the dep tree. Zero risk. Zero behavior change. This is the lowest-cost way to confirm the wabidb crate is consumable from wabi-server (the only thing that could go wrong is a missing `pub` on a type the adapter will eventually need, and we want to find that out at minute 1, not minute 1000).

After Step 1 passes, Step 2 is the first real design decision: the `WdbAdapter` skeleton, with the `StdbClient` method shape. That decision is small (the methods are already defined by what the handlers call), but it's the file where the new architecture becomes concrete.
