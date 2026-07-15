# STDB Removal — Timeline & Bookkeeping

This document records the removal of all SpacetimeDB ("STDB") references from the
wabi codebase and replaces them with the in-repo **wabiDB** system. It is a
naming/label/wire-string consolidation plus one behavioral fix — there is no
separate STDB SDK or live database connection in this repo to migrate.

## What STDB actually was in this repo

- There was **no** SpacetimeDB SDK, module, or live DB client. The `core/crates/wabi-server/src/db/`
  directory does not exist; the server's persistence/relay layer is the in-repo
  `wabidb` crate (`core/crates/wabidb`).
- The client-side adapter that previously wrapped the relay was already replaced
  by the **WDB** adapter. The only remaining `stdb` strings were:
  - a transport label (`'stdb'`) used by the experimental voice relay,
  - a handful of socket.io **wire event names** (`stdb-media`, `join-stdb-call`,
    `stdb-audio-playback`, `call-initiate` payload labels),
  - UI copy ("STDB EXP" / "SpacetimeDB") and CSS class names,
  - comments and doc strings in the server crates.

## Timeline

### Phase 0 — Investigation (scout)
Confirmed `frontend/src/lib/callingStdb.ts` was a thin re-export shim of
`callingWabidb.ts`; the real wabiDB call path already ran under the `'stdb'`
transport label (default). The server is in-repo and consumes the wire strings,
so any rename had to be coordinated with server listeners/handlers.

### Phase 1 — Delete the shim
- Deleted `frontend/src/lib/callingStdb.ts`.
- `calling_impl_core.ts` now imports `connectWabidbCall` / `disconnectWabidbCall`
  directly from `callingWabidb.ts`.

### Phase 2 — Rename transport label
- `'stdb'` → `'wabidb'` in `mediaRuntime.ts`, `callingTransport.ts`,
  `callingWabidb.ts`, `wabidbCallConnection.ts`.
- `getStoredCallTransportMode()` gained a legacy migration: stored `'stdb'`
  is transparently remapped to `'wabidb'`.

### Phase 3 — Remove experimental aliases
- Removed `experimentalStdbCall` / `experimentalStdbCallEnabled` aliases in
  `experimentalWabidbCalls.ts`; repointed `Chat.svelte`,
  `AudioSettingsTab.svelte`, and `calling_impl_core.ts`.

### Phase 4 — UI copy
- `AudioSettingsTab.svelte`: dropdown entry "SpacetimeDB" → "wabiDB" (reworded).
- `ChatHeader.svelte`: "STDB EXP" → "wabiDB EXP" toggle; component class
  `experimental-stdb-toggle` → `experimental-wabidb-toggle`.
- `p2pFileTransfer.ts`: message + comments updated.

### Phase 5 — Wire strings (coordinated with server)
- `stdb-media` → `wabidb-media`
- `join-stdb-call` → `join-wabidb-call`
- `stdb-audio-playback` → `wabidb-audio-playback` (also the AudioWorklet
  `registerProcessor` id)
- `call-initiate` payload labels `experimental-stdb-call` / `desktop-stdb`
  → `experimental-wabidb-call` / `desktop-wabidb`
- Server: `core/crates/wabi-server/src/socketio/wiring.rs` listeners and
  `media_reactions_signaling.rs` handlers + room prefix `wabidb-call-`.
- `wabidb` crate: `transport` string `"wabidb-replaced-stdb"` → `"wabidb"`.

### Phase 6 — Server comment scrub
- Bulk rename across `core/crates/wabi-server/src` and `core/crates/wabidb/src`:
  `SpacetimeDB`/`SpaceTimeDB` → `wabiDB`, `StdbClient` → `WdbClient`,
  `STDB` → `WDB`. Re-grep confirms zero remaining in server `.rs`.

### Phase 7 — Residual client cleanup (this pass)
- `audio-worklet-playback.js`: class `StdbAudioPlaybackWorklet` →
  `WabidbAudioPlaybackWorklet`.
- `mediaRuntime.ts`: removed `'stdb'` from the `EffectiveCallTransport` union.
- **Behavioral regression fixed**: `joinVoiceChannel()` in `calling_impl_core.ts`
  still branched on `if (activeTransport === 'stdb')`, but
  `resolveActiveTransport()` returns `'wabidb'` (never `'stdb'`) after the rename.
  The branch was dead — the wabiDB voice relay would never connect under the
  default transport. Changed the condition to `activeTransport === 'wabidb'`.
- CSS: `.experimental-stdb-toggle` selectors in `chat-calls.css` and
  `chat-mobile.css` renamed to `.experimental-wabidb-toggle` to match the
  component class.
- `FRACTURE_PLAN.md`: table row "StDB call" → "wabiDB call" / `callingWabidb.ts`.

## Out of scope (intentionally kept)
- `frontend/src/lib/i18n/locales/en.json` and `es.json` `mesh_*` strings
  (`mesh_stdb_url`, "SpacetimeDB connection", "STDB env vars"). These describe
  the **server-to-server mesh** configuration, a separate concern from the
  client voice relay. Left as-is pending a deliberate server-mesh rename.

## Verification
- `cd frontend && npm run build:only` — clean.
- `cd frontend && npm run check` — 1 pre-existing error
  (`MessageList.svelte` `clientNonce` on `Message`), unrelated to this work.
- `cargo check -p wabi-server -p wabidb` — green.
- `cargo test -p wabidb replay_test` — 3/3 pass (asserts `transport == "wabidb"`).
- Repo grep `stdb|spacetime` over `core/crates/*/src` and `frontend/src`
  returns only `docs/STDB_REMOVAL.md`, the `mesh_*` i18n labels above, and
  unrelated `dbUserId` fields in `savedServer*`.
