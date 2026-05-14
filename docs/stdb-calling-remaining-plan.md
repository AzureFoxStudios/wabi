# STDB Calling — Remaining Implementation Plan

## Context after prior work
- `stdbConnection.ts` is complete and typed (uses generated SDK bindings)
- `opus-recorder` is installed for cross-browser Opus encode/decode
- Rust tables + reducers compile and WASM is built

## Next 3 tasks (in order)

### 1. `stdbMediaRelay.ts` (frontend audio pipeline)
**Path:** `frontend/src/lib/stdbMediaRelay.ts`

Capture path:
- Acquire `MediaStream` from `navigator.mediaDevices.getUserMedia({ audio: true })`
- Pipe into `opus-recorder` (WASM encoder) to produce Opus packets
- Each packet → `socket.emit('stdb-media', { sessionId, userId, payload: ArrayBuffer })`

Receive path:
- Listen for `stdb-media` Socket.IO events
- Push received ArrayBuffer packets into a tiny jitter buffer (50-100ms target)
- Feed into `opus-recorder` decoder worker → raw PCM
- Pipe PCM into an `AudioWorklet` for playback (avoids main-thread audio glitches)

### 2. Server binary relay handler (Rust)
**Path:** `core/crates/wabi-server/src/socketio.rs`

Add `on_std_media` handler inside `SocketIoClient`:
- Extract `sessionId` + `payload` from client event
- Look up `sessionId` in STDB call state (or keep local `VoiceChannels`-style HashMap)
- Iterate participants in that session
- `socket.broadcast.to(participantSocketId).emit('stdb-media', payload)`
- Zero decode of payload — raw binary fan-out only

### 3. `calling_impl.ts` activation wiring
**Path:** `frontend/src/lib/calling_impl.ts`

In the `'stdb'` branch of `resolveActiveTransport()` / activation flow:
- Instantiate `StdbCallState` with `{ host, database, token }`
- `stdb.connect()`
- On connect: `stdb.createSession(...)` or `stdb.joinSession(...)` depending on initiator vs joiner
- `stdb.subscribeToSession(sessionId)`
- Start `stdbMediaRelay` with the same `sessionId` + `userId`
- On call end: stop relay, `stdb.leaveSession(...)` or `stdb.endSession(...)`, disconnect

## Open questions to resolve during implementation
- `socket.io-client` binary emit syntax in the frontend (ensure `ArrayBuffer` not base64)
- AudioWorklet path for `opus-recorder` decoded PCM — may need a tiny `audio-worklet` bridge file
- Server-side session-to-socket mapping: add `stdb_session_id` field to `UserSocket` struct or look up via existing `VoiceChannels` map

## Files to touch
- `frontend/src/lib/stdbMediaRelay.ts` (new)
- `core/crates/wabi-server/src/socketio.rs` (add handler)
- `frontend/src/lib/calling_impl.ts` (wire activation)
- Possibly `frontend/src/lib/audio-worklet-bridge.ts` (new, small)
