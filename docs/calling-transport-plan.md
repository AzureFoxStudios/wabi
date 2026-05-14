# Wabi Calling Transport Plan
## 3-Tier Media Transport Architecture — LOCKED

**Status:** LOCKED — decisions made, ready for implementation
**Author:** Hermes (AI Agent)
**Context:** Ronin / Wabi repository

---

## 1. Philosophy

STDB is the default. P2P is opt-in. SFU is opt-in for admins who plug in LiveKit.

Users should never switch transports mid-call. Audio + video both flow through the same pipe. Quality degrades gracefully as more people join — no hard caps, no magic thresholds. Server owners set their own caps if they want them.

---

## 2. Problem Statement

Current `resolveCallTransportPlan()` in `mediaRuntime.ts` has a critical bug: the `'stdb'` transport mode maps to `effective: 'p2p'`. STDB is never used for actual media routing. The `experimentalStdbCalls.ts` module only records call attempts via Tauri invoke — it does not encode, packetize, or relay audio.

Additionally:
- `EffectiveCallTransport` type is `'p2p' | 'sfu'` only — `'stdb'` is excluded.
- No call session tables exist in the STDB Rust module.

---

## 3. Target Architecture

Three transport tiers. User picks mode. System respects the choice.

| Tier | Name | Default? | Use Case | Network Req |
|------|------|----------|----------|-------------|
| 1 | STDB Relay | **YES** | All calls unless overridden | TCP only (WebSocket) |
| 2 | P2P | Opt-in | 1:1 when both users want lowest latency | STUN/TURN |
| 3 | LiveKit SFU | Admin opt-in | Large rooms, server owner plugged in SFU | UDP + open ports |

**Mode behavior:**
- `mode === 'stdb'` (default) → `effective: 'stdb'`
- `mode === 'p2p-only'` → `effective: 'p2p'` (both sides must agree or call fails)
- `mode === 'sfu-preferred'` → `effective: 'sfu'` if LiveKit is configured, else falls back to `'stdb'`
- No auto-switching based on participant count. No mid-call migration.

---

## 4. Two-Pipe Architecture

The frontend maintains **two concurrent connections** for calls:

```
┌─────────────┐     STDB WebSocket (wss://)      ┌─────────────┐
│  Frontend   │◄───── Call state, participant     │  STDB Host  │
│  (TS SDK)   │        roster, session lifecycle   │  (Rust)     │
└─────────────┘                                    └─────────────┘

┌─────────────┐     Socket.IO WebSocket (wss://)  ┌─────────────┐
│  Frontend   │◄───── Encoded Opus/H264 frames      │ Wabi Server │
│  (Socket.IO)│        raw binary, no JSON/base64    │  (Rust)     │
└─────────────┘                                    └─────────────┘
```

**Why two pipes:**
- STDB gives us typed subscriptions, filtered queries, and RLS for call state
- Socket.IO gives us raw binary frame relay without STDB's transactional overhead
- STDB is for **state**. Socket.IO is for **media**.

---

## 5. Schema Changes

### 5.1 Frontend Types (`mediaRuntime.ts`)

```ts
// BEFORE (BROKEN)
export type EffectiveCallTransport = 'p2p' | 'sfu';

// AFTER
export type EffectiveCallTransport = 'p2p' | 'sfu' | 'stdb';
```

### 5.2 STDB Rust Module (`spacetimedb/wabi_state_bridge/src/lib.rs`)

Add persistent tables for call state:

```rust
#[spacetimedb::table(accessor = state_call_session, public)]
#[derive(Clone)]
pub struct StateCallSession {
    #[primary_key]
    pub session_id: String,
    pub channel_id: String,
    pub call_type: String, // "direct" | "group" | "channel"
    pub host_user_id: Option<i64>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub transport: String, // "p2p" | "stdb" | "sfu"
    pub max_participants: i64, // 0 = unlimited (default)
    pub active: bool,
    pub last_updated_at: Timestamp,
}

#[spacetimedb::table(accessor = state_call_participant, public)]
#[derive(Clone)]
pub struct StateCallParticipant {
    #[primary_key]
    pub participant_key: String, // "{session_id}:{user_id}"
    pub session_id: String,
    pub user_id: i64,
    pub stable_user_id: String,
    pub joined_at: i64,
    pub left_at: Option<i64>,
    pub is_host: bool,
    pub muted: bool,
    pub video_enabled: bool,
    pub last_updated_at: Timestamp,
}
```

Add event table for transient call signals (invites, "who's talking", etc.):

```rust
#[spacetimedb::table(accessor = state_call_signal, public, event)]
pub struct StateCallSignal {
    pub session_id: String,
    pub signal_type: String, // "invite" | "join" | "leave" | "mute" | "talking"
    pub target_user_id: Option<i64>,
    pub payload: String, // JSON blob for extensibility
    pub created_at: Timestamp,
}
```

Reducers:
- `call_session_create(channel_id, call_type, max_participants)` → returns session_id
- `call_session_join(session_id, user_id, stable_user_id)`
- `call_session_leave(session_id, user_id)`
- `call_session_end(session_id)` — host or system ends call
- `call_signal_emit(session_id, signal_type, target_user_id, payload)` — ephemeral event

### 5.3 Server Socket.IO (`core/crates/wabi-server/src/socketio.rs`)

Add binary media relay handler:

```rust
async fn on_stdb_media_packet(socket: SocketRef, Data(data): Data<Vec<u8>>, state: SioState) {
    // data is raw bytes: [session_id_len: u8][session_id: bytes][track_id: u8][payload: bytes]
    // Server parses header, looks up session participants, fans out raw payload
    // No JSON. No base64. No serde Value.
}
```

Socket.IO events:
- `stdb-media` (binary) — client sends raw Opus/H264 frame blob
- `stdb-media-ack` — server confirms frame received (optional, for packet loss tracking)
- `voice-channel-join` / `voice-channel-leave` — existing events, already working

---

## 6. Frontend Wiring

### 6.1 `resolveCallTransportPlan()` — STDB Default

```ts
export async function resolveCallTransportPlan(): Promise<CallTransportPlan> {
    const mode = getStoredCallTransportMode();
    const runtime = (await syncMediaRuntimeFromServer()) || lastRuntimeSnapshot;
    const sfuProvider = getSfuProvider(runtime || null);
    const livekitReady = isLivekitReady(runtime || null);
    const canUseSfu = sfuProvider === 'livekit' && livekitReady;
    const checkedAt = Date.now();

    // STDB is the default. It always works.
    if (mode === 'stdb' || mode === 'auto') {
        return { mode, effective: 'stdb', fallbackApplied: false, reason: null, ... };
    }

    if (mode === 'p2p-only') {
        return { mode, effective: 'p2p', fallbackApplied: false, reason: null, ... };
    }

    if (mode === 'sfu-preferred') {
        if (canUseSfu) return { mode, effective: 'sfu', ... };
        return { mode, effective: 'stdb', fallbackApplied: true, reason: 'sfu_unavailable', ... };
    }

    // Fallback: STDB always works
    return { mode, effective: 'stdb', fallbackApplied: false, reason: 'default_stdb', ... };
}
```

### 6.2 `resolveActiveTransport()` — STDB Branch

In `calling_impl.ts`, add:

```ts
if (activeTransport === 'stdb') {
    // 1. Open STDB subscription to StateCallSession / StateCallParticipant
    await subscribeToCallSession(channelId);
    // 2. Initialize Socket.IO media relay (no RTCPeerConnections)
    await initializeStdbMediaRelay(channelId);
    // 3. Start capture → encode → emit
}
```

### 6.3 STDB Media Pipeline (`stdbMediaRelay.ts` — NEW FILE)

**Audio path (all browsers):**

```
getUserMedia() → AudioCaptureSession
  → Web Audio API (DSP pipeline, spatial positioning)
  → opus-recorder WASM encoder (48kHz, mono, 64kbps)
  → Uint8Array chunk (~160 bytes / 20ms)
  → socket.emit('stdb-media', binaryBlob)
  → Server fan-out
  → Receiver: jitter buffer (100-200ms)
  → opus-recorder WASM decoder
  → AudioWorkletNode → destination
```

**Video path (where WebCodecs available):**

```
getUserMedia() / getDisplayMedia()
  → WebCodecs VideoEncoder (H.264 or VP8)
  → EncodedVideoChunk
  → socket.emit('stdb-media', binaryBlob with track_id header)
  → Server fan-out
  → Receiver: VideoDecoder.decode()
  → <video> element
```

**Video path fallback (Firefox, no WebCodecs):**
- Use MediaRecorder with `timeslice: 100` for ~100ms chunks
- Higher latency but works everywhere
- Or: skip video on STDB for Firefox, show "video unavailable" badge

**Static frame detection (screenshare):**
- Compare consecutive video frames via canvas pixel diff
- If diff < threshold for 2 seconds: emit 1fps, send keyframe only
- On change: resume normal framerate
- This saves massive bandwidth for paused IDE/Photoshop windows

---

## 7. Server Changes

### 7.1 `socketio.rs` — Binary Media Relay

```rust
async fn on_stdb_media_packet(socket: SocketRef, Data(data): Data<Vec<u8>>, state: SioState) {
    // Binary frame format:
    // [0]: session_id length (u8)
    // [1..1+session_id_len]: session_id (UTF-8 bytes)
    // [1+session_id_len]: track_id (u8, 0=audio, 1=video-camera, 2=video-screen)
    // [rest]: raw Opus/H264 payload
    
    if data.len() < 3 {
        return;
    }
    let sid_len = data[0] as usize;
    if data.len() < 1 + sid_len + 1 {
        return;
    }
    let session_id = String::from_utf8_lossy(&data[1..1+sid_len]);
    let track_id = data[1 + sid_len];
    let payload = &data[2 + sid_len..];
    
    let sender_id = extract_user_id(&socket);
    
    // Fan-out to all session participants except sender
    let participants = state.voice_channels.read().await
        .get(&session_id.to_string())
        .cloned()
        .unwrap_or_default();
    
    for participant in participants {
        if participant.user_id != sender_id {
            if let Some(s) = state.sockets.read().await.get(&participant.socket_id) {
                let _ = s.emit("stdb-media", payload);
            }
        }
    }
}
```

This is a dumb pipe. Zero decode. CPU cost is connection management only.

### 7.2 Admin Caps (Optional Config)

Server config (`config.yaml` or env):

```yaml
calling:
  stdb_max_participants: 0      # 0 = unlimited (default)
  stdb_max_video_tracks: 4       # max simultaneous video streams per room
  stdb_bitrate_limit_kbps: 2000  # per-participant upload cap
```

Enforced at `on_voice_channel_join`: if room is at cap, reject with `"room_full"`.

---

## 8. Desktop (Tauri) Differentiation

**Web path (minimode):**
`opus-recorder` WASM → Socket.IO binary relay

**Desktop path (full power, Phase 2):**
`cpal` capture → `nnnoiseless` denoise → `opus` crate encode → Socket.IO binary relay

Benefits:
- No browser AEC latency (~20-40ms saved)
- Raw DAW input via CoreAudio/ASIO virtual devices
- Push-to-talk with global hotkeys (no web keydown latency)
- Direct device selection without browser sandbox

---

## 9. Quality-of-Life Features (Phase 2)

### 9.1 Per-Track Quality Lock

Each participant's video exposes tiers. Viewer locks a tier. Default is auto.

### 9.2 Admin Room Caps

Per-voice-channel setting: `max_participants` in STDB table. Admin overrides via server UI.

---

## 10. Diagnostics

Existing `callConnectionDiagnostics` store (ping, jitter, loss, bitrate) already renders in MainLayout.svelte and ChannelSidebar.svelte.

For STDB path, add equivalent metrics:

| Metric | STDB Source |
|--------|-------------|
| Ping | App-level echo: client sends timestamp, server echoes back. RTT measured. |
| Jitter | Inter-arrival time variance of received Opus frames. |
| Packet Loss | Sequence number gaps in the frame stream. |
| Bitrate | Byte counters on emit/receive handlers. |
| Transport | `'stdb'` |

UI already exists — just feed it STDB-path data.

---

## 11. Bandwidth Reality Check

For server owners who want to know:

**Audio only:** `n * (n-1) * 64 kbps` total server relay
- 5 people: 5 * 4 * 64 = 1.28 Mbps
- 10 people: 10 * 9 * 64 = 5.76 Mbps
- 20 people: 20 * 19 * 64 = 24.32 Mbps

**With one screenshare (500 kbps):** add `n * 500 kbps` down per viewer
- 10 people + 1 screen: 5.76 + (10 * 0.5) = 10.76 Mbps

These are realistic numbers for a home server on a 100 Mbps connection.

---

## 12. Implementation Order

### Phase 1: Foundation (Minimum Viable)

1. Fix `mediaRuntime.ts`: `mode === 'stdb'` returns `'stdb'` not `'p2p'`
2. Add `'stdb'` to `EffectiveCallTransport`
3. Add `StateCallSession`, `StateCallParticipant`, `StateCallSignal` to STDB module
4. Add reducers: `call_session_create`, `call_session_join`, `call_session_leave`, `call_signal_emit`
5. Server: Binary `stdb-media` Socket.IO handler
6. Frontend: `stdbMediaRelay.ts` with `opus-recorder` WASM audio pipeline
7. Frontend: Wire `joinVoiceChannel()` to STDB path by default
8. Integration test: 3-person LAN call

### Phase 2: Video + Polish

9. Frontend: `stdbMediaRelay.ts` video path (WebCodecs encoder)
10. Static frame detection for screenshare
11. Admin room caps (`max_participants` field + server enforcement)
12. STDB diagnostics feeding existing `callConnectionDiagnostics` store
13. Per-track quality lock UI

### Phase 3: Desktop

14. Tauri native audio thread (`cpal` → `opus` crate)
15. Global hotkeys for push-to-talk

---

## 13. Evaluation

**What this gives Ronin:**
- STDB is the default. It works for everyone, including CGNAT, no UDP ports.
- P2P is opt-in for 1:1 low-latency purists.
- LiveKit is admin opt-in for large rooms.
- No mid-call switching. No threshold math. No magic numbers.
- Self-hosting is one Docker Compose. Server owner decides their own caps.
- Video + audio both work on STDB. Screenshare has static-frame bandwidth saver.

**What this costs:**
- STDB module redeployment (breaking change — adds tables)
- Frontend: ~800 lines new code (stdbMediaRelay.ts, STDB subscription wiring)
- Server: ~150 lines (binary Socket.IO handler)
- Desktop: Phase 3, optional

**Verdict:** STDB as default transport fixes the core bug and aligns with self-host-first philosophy. Two-pipe architecture (STDB for state, Socket.IO for media) is the correct separation. No hard caps respects server owner autonomy.
