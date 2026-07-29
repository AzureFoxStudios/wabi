# Wabi Calling + Recording — Audit & Fix Log

> Goal: audit ALL calling (channels / DMs / groups) and ensure voice (especially
> recording) is properly piped and syntactically correct. Work done in order:
> backend → calls/channels/DMs → recording.

## Verification (all green)
- `cargo test -p wabidb --lib call` → 25 passed
- `cargo test -p wabi-server` → 44 passed, 0 failed
- `npm run check` (frontend svelte-check) → 0 errors

---

## Phase 1 — Backend (skeleton)
- **B1 — `UnknownStreamKey` (root cause of every call write 500'ing):**
  The 5 call commands (`call_session_create/join/leave/end`, `call_signal_emit`)
  in `core/crates/wabidb/src/commands/` called `run_command` directly, bypassing
  the stream-key registration that the adapter's `run()` normally does. Every
  `POST /api/calls/*` therefore failed with `UnknownStreamKey`.
  Fix: added an `engine: &WabiDbEngine` param to each command and call
  `engine.get_or_create_stream_key(&stream_id)` before building the
  `CommandCommit`. Updated adapter call sites (`core/crates/wabi-server/src/adapter/mod.rs`)
  and all unit tests.
- **B2 — WS mount path:** backend did `.nest("/ws", ws_router)` where the inner
  route was also `/ws` → real path `/ws/ws`, but the frontend connects `/ws`
  (`wabidbCallConnection.ts:239`). Fixed inner route to `/`
  (`core/crates/wabi-server/src/websocket.rs`).
- **B3 — participants projection:** `CallParticipantsProjection` only registered
  `call_participant_joined`, so `call_participant_left` never updated the roster.
  Added `call_participant_left` to `event_types()`
  (`core/crates/wabidb/src/projections/call_participants.rs`).
- **B4 — tests:** flipped the now-broken `happy_path_*_returns_unknown_stream_key`
  tests to assert success. Also fixed a latent bug where `setup_engine()` dropped
  the tempdir before the test ran (hidden because old tests only asserted
  `is_err`).

## Phase 2 — Frontend transports
- **F3 — "voice goes through" decode bug (`wabidbMediaRelay.ts`):**
  The receive side was completely dead:
  - decoder worker never received `init` (opus-recorder v8 needs
    `{command:'init', ...}`) before `decode`;
  - sent `{cmd:'decode', payload}` but worker expects `{command:'decode', pages}`,
    and resolved on a non-existent `{id,result}` protocol (worker posts raw
    `Float32Array[]`);
  - loaded the AudioWorklet from a `.ts` URL (browsers reject uncompiled TS);
  - `AudioContext` never `resume()`d (silence).
  Fix: rewrote decode with a pending-queue + correct `init`/`decode` protocol,
  converted the worklet to loadable `src/lib/audio-worklet-playback.js`, and
  `resume()` the context. Also scoped `socket.off` to the instance handler.
- **F1 — DM/Group calls were dead:** no inbound socket listeners for any
  `call-*` event. Added them in `socketConnectionCore.ts` wired to the existing
  (previously dead) handlers, matching the server's exact event contract
  (`call-incoming`, `call-accepted`, `call-offer`, `call-answer-sdp`,
  `call-ice-candidate`, `call-ended`, `call-cancelled`, `call-rejected`,
  `call-error`, `group-call-*`).
- **F2 — `call-ice-candidate` listener missing** (P2P ICE never flowed). Added.
  (The screen-share `targetId`/`senderId` "mismatch" was a false alarm — the
  server relay uses `targetId`→`senderId` symmetrically, same as `call-*`.)
- **F4 — channel `stdb` branch missing** in `joinVoiceChannel`
  (`calling_impl_core.ts`). Added, mirroring the guarded group-call pattern.
  Also added `'stdb'` to `EffectiveCallTransport` (`mediaRuntime.ts`) so the
  resolver's default return type-checks.
- **F5 — storefwd playback field mismatch:** listener read `payload.audioUrl`
  but emit sent `audioBase64` → `atob(undefined)` throw. Aligned to `audioBase64`.
- **F6 — `connectWabidbCall` (`callingWabidb.ts`):** now stores the userId,
  actually calls `joinSession`, and reuses the userId on leave.
- **F7 — media-gateway typo:** `gatewayControlPlaneStatus: ... ? 'idle':'idle'`
  → `'ready':'idle'`.

## Phase 3 — Recording (main selling point)
- **R1 — silent recordings:** `RecordingAudioMixer` never resumed its
  `AudioContext`. Added `unlockAudioContext()` gesture-path call in
  `startCallRecording` + eager `resume()` in the mixer constructor.
- **R3 — empty-stream guard:** `createRecordingArtifact` now throws a clear
  error instead of an opaque `NotSupportedError` when no tracks exist yet.
- **R4 — container/extension mismatch:** `onstop` now uses the recorder's actual
  `mimeType` for the Blob type.
- **R2 — Tauri desktop save (KNOWN GAP):** `save_call_recording` invoke in
  `tauri-recording.ts` has no registered command. `src-tauri/` in this checkout
  only contains `handlers_secure.rs` (no `main.rs` / `invoke_handler`), so the
  Tauri desktop backend isn't scaffolded here. Recording falls back gracefully to
  a browser download. Requires wiring the Tauri desktop backend to fully close.

## Out of scope / follow-ups
- Live two-client end-to-end smoke test of a DM + channel call and a recording
  (signaling is fully wired on both sides; needs a running server + 2 browsers).
- Tauri `save_call_recording` command registration (R2).
