# 2026-08-08 — Whiteboard backend: WabiDB doc persistence + socket contract enforcement

Wave 1 backend work per `docs/plans/2026-08-08-whiteboard-wire-contract.md`. Two
planes: (1) a durable per-board document in WabiDB, (2) production Socket.IO
handlers and REST routes that enforce the wire contract. `socketio/wiring.rs`
and the frontend were not touched.

## Files changed

| File | Change |
|------|--------|
| `core/crates/wabidb/src/domain/mod.rs` | Added `WhiteboardDoc { board_id: String, doc_json: String, updated_at_micros: i64 }`. |
| `core/crates/wabidb/src/projections/whiteboard_docs.rs` | **New.** Projection for event `whiteboard_doc_upserted` → index `whiteboard_docs`. Postcard codec (`encode_record`/`decode_record`), `encode_key = board_id.as_bytes()`. 6 unit tests. |
| `core/crates/wabidb/src/projections/mod.rs` | Registered `pub mod whiteboard_docs;`. |
| `core/crates/wabidb/src/engine/mod.rs` | Registered `WhiteboardDocsProjection` in `build_type_registry()` (`record_type_name: "wabidb::domain::WhiteboardDoc"`). |
| `core/crates/wabidb/src/engine/wabi_store.rs` | Added trait methods `get_whiteboard_doc` / `put_whiteboard_doc` (default no-op impls so any `WabiStore` compiles) + `LocalWabiStore` test assertions. |
| `core/crates/wabi-server/src/adapter/mod.rs` | Real impls: get reads the `whiteboard_docs` projection, `decode_record`, returns `Ok(Some(doc_json))` / `Ok(None)` / `Err(WabiError::Validation)`. Put builds `WhiteboardDoc`, postcard-payload `self.run(...)` with stream `whiteboard_docs:{board_id}`, schema v6. |
| `core/crates/wabi-server/src/socketio/whiteboard_ops.rs` | Replaced `#[allow(dead_code)]` shims with production handlers + helpers (see below). |
| `core/crates/wabi-server/src/api/whiteboard.rs` | Added `GET` and `PUT /api/whiteboard/boards/{board_id}/document` routes. |

## Durable document

- Event: `whiteboard_doc_upserted` (schema version 6). One record per board,
  keyed by `board_id`; the full doc JSON is stored in `doc_json` with an
  `updated_at_micros` stamp.
- Projection reads: `projection_state().get("whiteboard_docs", &encode_key(board_id))`.
- The doc JSON is the `BoardDocument` object (including `version`) so the
  version is recoverable after a restart even though the live version map is
  in-memory only.
- No fields were added to any existing postcard record — a new record type,
  so no V0/V1 dual-decode migration was required.

## Version tracking

The server owns version truth. `WHITEBOARD_VERSIONS` (a `OnceLock<Mutex<HashMap<String,u64>>>`)
in `whiteboard_ops.rs`, exposed `pub(crate) fn whiteboard_versions()` and shared
with the REST PUT handler so both paths agree. Resolution order:

1. in-memory map entry, else
2. persisted doc's `version` field, else
3. `0` (fresh board).

The map is guarded by a std `Mutex`; the guard is **never held across an
`.await`** — values are copied out first (`Option::copied`) so handler futures
stay `Send` (axum's `Handler` bound requires this; holding the guard across an
await is what initially broke the PUT handler's `Handler<_,_>` bound).

## Socket handlers (`socketio/whiteboard_ops.rs`)

All five handlers keep the signatures already wired in `wiring.rs`. Auth is the
`AuthToken` socket extension → `user_id_from_token(&token, &state.app.config.jwt_secret)`
(`-1` = invalid → `UNAUTHORIZED`). Membership uses `state.app.wdb.list_channels(Some(user_id as u64))`
plus admin (`state.app.is_admin(user_id).await`) and owner checks.

- **`whiteboard:join`** — requires `boardId`; auth; membership; loads the doc
  (default document when never saved: `{access:"open", writeAccess:"anyone"}`,
  empty `elements`/`layers`, `activeLayerId:"layer-default"`, `version:0`).
  Policy enforcement: `access:"desktop_only"` on a non-Tauri client →
  `DESKTOP_REQUIRED`; `writeAccess:"desktop"` on a web client → `write:false`.
  `socket.join("wb:{boardId}")` (non-blocking in this socketioxide), emit
  `whiteboard:joined` with doc + `capability.write`.
- **`whiteboard:leave`** — `socket.leave("wb:{boardId}")`, emit `whiteboard:left`.
- **`whiteboard:snapshot`** — size cap `WHITEBOARD_MAX_DOCUMENT_BYTES` (2MB) →
  `PAYLOAD_TOO_LARGE`; auth; membership; version check (client version must
  equal server version, else `VERSION_CONFLICT`); bump `version+1`, persist via
  `put_whiteboard_doc`, update version map, `io.to(room).except(sender).emit("whiteboard:snapshot", doc)`,
  then ack the sender `whiteboard:ack { patchId: null, version }`.
- **`whiteboard:patch`** — size cap `WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES` (128KB) →
  `PAYLOAD_TOO_LARGE`; auth; membership; requires an `op` field (else
  `READ_ONLY`); fan out `whiteboard:patch` to the room except the sender; ack
  `whiteboard:ack { patchId, version }` (current version from
  `current_version`).
- **`whiteboard:cursor`** — size cap; auth failures drop silently (ephemeral);
  fan out `whiteboard:cursor` `{boardId, cursor, userId:"user-{id}", username, color}`
  except the sender.

Error codes used exactly as contracted: `UNAUTHORIZED`, `DESKTOP_REQUIRED`,
`READ_ONLY`, `VERSION_CONFLICT`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND` — all via
`whiteboard:error { code, message }`.

## REST routes (`api/whiteboard.rs`)

- `GET /api/whiteboard/boards/{board_id}/document` — bearer auth
  (`extract_user_id`), board id validation, channel membership
  (`can_access_channel`, board ids already use `channel:<uuid>` form, but a
  bare uuid is handled as `channel:<uuid>`), reads the projection: `200` + doc
  JSON, `404 NOT_FOUND` when never saved, `500` on decode failure.
- `PUT /api/whiteboard/boards/{board_id}/document` — bearer auth, 2MB size cap
  (`PAYLOAD_TOO_LARGE`), must be a JSON object, membership, **version check**
  (client ≠ server → `409 CONFLICT`), bumps version, persists, updates the
  shared version map, returns `{ success, boardId, version }`. The PUT shares
  the socket snapshot path's version map, so REST and socket saves stay
  consistent.

## Build/test

```
cargo check -p wabidb        # clean (2 pre-existing dead-code warnings)
cargo check -p wabi-server   # clean (pre-existing warnings only)
cargo test -p wabidb --lib whiteboard_docs   # 6 passed
```

No full `cargo build` was run (out of scope for this task).

## Contract deviations / notes

- The version map is in-memory; on restart it rebuilds from the persisted doc.
- Socket snapshot/ack emits the full doc to other members (matching the
  contract's "server is truth" model); patches remain delta-based and
  ephemeral (no durable patch log this wave).
- `whiteboard_versions()` is the single shared version source across socket and
  REST. Do not duplicate version bookkeeping in the frontend.
