# Wabi Calling Transport Plan — Evaluation
## Critical Review After Codebase Re-read

**Status:** EVALUATION — Plan adjusted based on real code
**Author:** Hermes (AI Agent)

---

## 1. What the Plan Got Right

| Claim | Verified? | Evidence |
|-------|-----------|----------|
| `EffectiveCallTransport` excludes `'stdb'` | **Confirmed** | `mediaRuntime.ts` line 21: `export type EffectiveCallTransport = 'p2p' | 'sfu';` |
| `'stdb'` mode returns `effective: 'p2p'` | **Confirmed** | `mediaRuntime.ts` line 566-576: `if (mode === 'stdb') return { effective: 'p2p' }` |
| `experimentalStdbCalls.ts` only records, doesn't route | **Confirmed** | Only `markExperimentalStdbCallAttempt()` exists; it invokes `spacechatdb_record_experimental_call` to Tauri backend |
| No call session tables in STDB | **Confirmed** | Searched `spacetimedb/wabi_state_bridge/src/lib.rs` — no `StateCallSession` or `StateCallParticipant` |
| Socket.IO already handles voice channels | **Confirmed** | `socketio.rs` line 823: `on_voice_channel_join`, line 916: `on_voice_channel_leave` |
| Server already broadcasts participant join/leave | **Confirmed** | `socketio.rs` lines 882, 894, 905: `voice-channel-state`, `voice-channel-joined`, `voice-channel-user-joined` |
| `resolveActiveTransport` only checks LiveKit → P2P | **Confirmed** | `calling_impl.ts` lines 2306-2400: no `'stdb'` branch |

---

## 2. What the Plan Got Wrong or Oversimplified

### 2.1 WebCodecs AudioEncoder — Not Universally Available

The plan assumes `AudioEncoder` with `codec: 'opus'` works in all browsers. **It doesn't.**

- Chrome/Edge: Supported (since ~M94)
- Firefox: **Not supported** — Firefox has no WebCodecs AudioEncoder
- Safari: **Not supported** — Safari has WebCodecs VideoEncoder but not AudioEncoder

**Impact:** The STDB audio path would be Chrome-only. For Firefox/Safari, we'd need a fallback.

**Adjustment:** Fallback to `RTCPeerConnection` with a `RTCDataChannel` for the media payload. Still TCP-based (works through CGNAT), but uses WebRTC framing. Or: use the existing `MediaRecorder` with `timeslice: 20` to emit small blobs, though latency would suffer.

**Better option:** Use the `opus-recorder` library (WASM Opus encoder) which works in all browsers. It captures from AudioWorklet, encodes to Opus in WASM, and emits chunks every 20ms. This avoids WebCodecs entirely.

### 2.2 "Naive Server Relay" Ignores Jitter Buffer

The plan proposes the server does a dumb `socket.emit` broadcast of Opus frames. **This is technically correct but practically naive.**

Opus frames arriving at irregular intervals (WebSocket jitter) will cause audio stutter. WebRTC's built-in jitter buffer and packet loss concealment (PLC) handle this. A raw Socket.IO relay has none of that.

**Adjustment:** The receiver needs a jitter buffer. Implementation:
- Queue incoming Opus frames in an `AudioWorkletProcessor`
- Maintain a 100-200ms buffer
- Decode and play on a steady 20ms interval
- If a frame is missing, Opus decoder can do PLC (packet loss concealment)

This adds complexity to `stdbAudioRelay.ts` that the plan underestimated.

### 2.3 Mid-Call Transport Migration Is Harder Than Documented

The plan says: "If a 5-person STDB call grows to 12, disconnect STDB, reconnect LiveKit."

**In practice this is a full call restart.**
- All participants must simultaneously stop their STDB encoder
- Simultaneously join LiveKit
- Re-negotiate audio routing
- Risk: participants drop out during the switch

**Adjustment:** Don't support mid-call migration. Instead:
- When a call is created, set a `max_participants` cap on the transport
- If the cap is exceeded, reject new joiners with "call full, start a stage?"
- Or: create a new "stage" session (LiveKit) and invite overflow participants there
- STDB calls are "breakout rooms" — small, fixed-size. LiveKit is "main stage" — large, planned.

### 2.4 Server CPU on 10-Person Relay

The plan claims server CPU is "negligible" because it's just forwarding bytes. **Partially true, but incomplete.**

- CPU for forwarding 80KB/sec is indeed negligible
- But Socket.IO JSON serialization of base64-encoded Opus chunks is NOT negligible. Each 160-byte chunk becomes ~214 bytes base64, wrapped in JSON: `{"session_id":"...","payload":"..."}`. That's ~300 bytes per packet.
- For 10 people × 50 packets/sec = 500 broadcasts/sec. JSON parsing/stringifying 500 times/sec per room is measurable CPU.

**Adjustment:** Use binary Socket.IO (`socket.emit('stdb-media', ArrayBuffer)`) instead of JSON base64. Socket.IO supports binary payloads directly. This halves CPU and bandwidth.

### 2.5 Tauri Audio Path Is a Major Side Quest

The plan mentions `cpal` → `opus` crate → Socket.IO as a desktop enhancement. **This is real but orthogonal to the main plan.**

Implementing this requires:
- A Rust Tauri command that runs a continuous audio capture loop
- Cross-platform audio device enumeration (CoreAudio on macOS, WASAPI on Windows, ALSA/Pulse on Linux)
- Thread-safe communication between Rust audio thread and Tauri/WebView frontend
- Sync with the frontend's mute/deafen state

**Adjustment:** Mark this as Phase 2. The web path (opus-recorder WASM) works for both web and desktop in Phase 1. Desktop-native audio is an optimization, not a prerequisite.

### 2.6 LiveKit "Never Tested" Means Unknown Failure Modes

The user said: "LiveKit had never worked because SRT and SFU are port locked."

The plan assumes LiveKit works when ports are open. **This is an untested assumption.** If LiveKit fails for other reasons (TLS cert issues, token generation bugs, client SDK mismatches), the fallback to STDB must be robust.

**Adjustment:** The `resolveCallTransportPlan()` should include a **probe step**:
1. Try to fetch a LiveKit token from the server (`/api/media/livekit-token`)
2. If that succeeds, try a WebSocket connection to the LiveKit URL
3. If WebSocket fails within 3 seconds, mark LiveKit as unavailable for this session
4. Fall back to STDB

This probe should happen before the user clicks "join call" so the UI can show the expected transport.

---

## 3. Adjusted Implementation Order

### Phase 1: STDB Foundation (Minimal Viable)

| Step | File/Area | Change |
|------|-----------|--------|
| 1 | `spacetimedb/wabi_state_bridge/src/lib.rs` | Add `StateCallSession` and `StateCallParticipant` tables. Add `call_session_create`, `call_session_join`, `call_session_leave`, `call_elect_host` reducers. |
| 2 | `shared/mediaContracts.ts` | Add `EffectiveCallTransport = 'p2p' | 'sfu' | 'stdb'` |
| 3 | `frontend/src/lib/mediaRuntime.ts` | Fix `resolveCallTransportPlan()` to return `effective: 'stdb'` when mode is `'stdb'`. Add `participantCount` parameter. |
| 4 | `frontend/src/lib/calling_impl.ts` | Add `'stdb'` branch to `resolveActiveTransport()`. |
| 5 | `frontend/src/lib/stdbAudioRelay.ts` | **NEW FILE**. Use `opus-recorder` WASM library (not WebCodecs). Implement: capture → Opus encode → Socket.IO binary emit → jitter buffer → decode → AudioWorklet. |
| 6 | `core/crates/wabi-server/src/socketio.rs` | Add `stdb-media` binary handler. Naive broadcast to session participants. |
| 7 | Integration test | 3-person call on LAN using STDB. Verify audio flows. |

### Phase 2: Polish

| Step | File/Area | Change |
|------|-----------|--------|
| 8 | `frontend/src/lib/calling_impl.ts` | Add static frame detection for screenshare (STDB path). |
| 9 | `frontend/src/lib/calling_impl.ts` | Add per-track quality pinning UI. |
| 10 | `core/crates/wabi-server/src/socketio.rs` | Add transport probe endpoint (`/api/media/probe-livekit`). |
| 11 | `spacetimedb/wabi_state_bridge/src/lib.rs` | Add `max_participants` enforcement at reducer level. |

### Phase 3: Desktop Enhancement (Optional)

| Step | File/Area | Change |
|------|-----------|--------|
| 12 | `src-tauri/src/audio.rs` | **NEW FILE**. `cpal` capture → `opus` crate encode → emit to frontend via Tauri event. |
| 13 | `frontend/src/lib/tauriAudio.ts` | Receive Tauri audio events, feed into existing STDB relay pipeline. |

---

## 4. Honest Verdict

**Can STDB handle up to 10 people? Yes, but with caveats.**

- **Audio quality**: Good with opus-recorder WASM + jitter buffer. WebCodecs path is Chrome-only.
- **Latency**: 100-300ms end-to-end (vs 50-100ms for WebRTC P2P). Acceptable for voice.
- **Bandwidth**: ~64kbps per person up, ~512kbps down (8 people). Total server load: ~5Mbps per room.
- **CPU**: Negligible if binary Socket.IO is used. JSON base64 would be problematic.
- **Screenshare**: Only viable with static-frame detection. Full-motion screenshare at 10 people via STDB is a bandwidth disaster.

**Should this replace LiveKit? No.**
LiveKit is for 9+ people and video-heavy calls. STDB is for 3-8 people and CGNAT fallback. They coexist.

**Is this worth building? Yes.**
The current bug (`stdb` → `p2p`) means the CGNAT fallback doesn't exist. STDB relay is the only path that works without UDP ports. For a self-host-first tool, this is essential.

---

## 5. Open Questions for Ronin

1. **Browser support priority**: Are you okay with Chrome/Edge-only for STDB audio in Phase 1, or do you need Firefox/Safari from day one? (Firefox needs `opus-recorder` WASM path instead of WebCodecs.)
2. **Screenshare on STDB**: Do you want screenshare in the STDB path at all, or audio-only for small groups? Screenshare would require a separate video encoder pipeline.
3. **Call caps**: Should STDB calls have a hard participant cap (e.g., 8 people)? If exceeded, reject joiners or auto-create a LiveKit stage?
4. **Desktop priority**: Should the desktop native audio path (cpal → opus crate) block Phase 1, or is it a Phase 3 enhancement?
