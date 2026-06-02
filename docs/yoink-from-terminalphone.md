# What's Actionable from TerminalPhone for Wabi

**Source:** TerminalPhone v1.1.6 — single Bash script, walkie-talkie over Tor hidden services, Opus+AES+OpenSSL. Read the full README before this doc.

---

## Verified: what works in TerminalPhone

| Feature | TerminalPhone approach | Why it works |
|---------|----------------------|--------------|
| **Opus 16kbps mono 8kHz** | One-size-fits-all low-bitrate pipeline | Intelligible speech at <20KB per 10s message. Proves "lowest-common-denominator" audio pipelines work. |
| **Record-then-send** | Full message compressed+encrypted before TX | No live streaming jitter, works over irregular/transient networks. |
| **AES-256-CBC + PBKDF2** | Application-layer encryption independent of Tor | Zero server trust; relay cannot decrypt. |
| **HMAC-SHA256 per message + nonce + replay log** | Every wire message signed | Prevents injection/replay even if Tor circuit is compromised. |
| **Single script / no build** | Bash + apt/brew/pkg install deps | Validates the "own your stack" philosophy — less is more. |

---

## What Wabi should actively adopt

### 1. Low-bitrate Opus fallback toggle (~1 day impl)

Add a `qualityProfile` field to `CallTransportPlan` / `EffectiveMediaSettingsSnapshot`:
- `default` — current behavior (whatever bitrate Wabi uses now)
- `lowBandwidth` — force 16kbps mono, disable stereo/spatial, reduce video to disabled
- `localEnhanced` — Tauri-only, higher bitrates, spatial audio on

This is not a new transport mode. It's a media quality profile that any transport (`p2p`, `sfu`, `stdb`) can respect.

**File to touch:** `mediaRuntime.ts` + `callingTypes.ts` + each transport init function.

### 2. `storefwd` — a fourth transport mode (the main "yoink")

Record-hold-release semantics over Socket.IO. No WebRTC. No STDB dependency. No peer connection setp.

Use cases:
- Hotel/captive-portal WiFi where STUN/TURN/ICE fail
- Mobile data with high packet loss
- When helper nodes are unavailable and user wants voice anyway
- As a "works anywhere" fallback that Wabi can guarantee

**Wire flow:**
```
hold PTT  →  record()  →  Opus encode  →  AES-GCM encrypt  →  socket.emit('voice-segment', {chunkId, encrypted, nonce, hmac})
                                              ↓
server/relay  →  fan out to channel subscribers  →  client buffers  →  play()
```

**Why Wabi can do this and TerminalPhone can't:**
- Wabi already has a persistent Socket.IO connection per client
- Wabi already has a channel subscription model (`voice-channel-subscribe`)
- Wabi's server can buffer and replay for late joiners (store-and-forward, not just forward)
- Wabi has user identity/credentials (no out-of-band secret exchange)

**Why TerminalPhone validates it:** TerminalPhone proves the Opus+AES pipeline works end-to-end. The only novelty Wabi adds is server-assisted relay and replay.

### 3. HMAC per signaling message (medium effort, high value)

TerminalPhone signs `PTT_START`, `AUDIO:`, `MSG:`, etc. Wabi's Socket.IO signaling (`voice-channel-join`, `voice-channel-leave`, `offer`, `answer`, `candidate`) currently has no message-level auth beyond the TLS/Socket session.

Add an optional `hmac` field to all Socket.IO voice events. Derive key from a per-call ephemeral secret. Reject any message with bad/missing HMAC. Freeze the key at call start (like TerminalPhone freezes its HMAC setting).

This is hardening, not a new transport.

**File to touch:** `socketio/wiring_handlers.rs` (authority side) and `calling_impl_core.ts` (client side). Both must opt in.

### 4. Zero-knowledge relay principle for Phase 4 helper nodes

TerminalPhone's relay "never possesses the shared secret." Wabi's Phase 4 `MediaRelay` job should adopt the same principle explicitly:
- Helper receives encrypted WebRTC frames from one client
- Helper forwards them to other clients without decrypting
- Helper never has access to DTLS keys or SRTP master key
- Helper only forwards `AUDIO:`/`MSG:` frames; drops control signals (like TerminalPhone's relay)

This should be written into the Phase 6 design doc before any real SFU code is written.

---

## What Wabi should NOT adopt

| TerminalPhone feature | Why not |
|-----------------------|---------|
| Tor-only transport | Too slow for real-time; alienates average-joe self-hoster. Not Wabi's threat model. |
| Walkie-talkie as primary UX | Discord users expect continuous duplex. PTT works as a *mode* but not the default. |
| Pre-shared secret only (no forward secrecy) | Wabi already has auth infrastructure; weakening it is a regression. |
| Bash script runtime | Irrelevant — Wabi is Rust+Svelte. The philosophy (single install script) can be borrowed, not the runtime. |

---

## How `storefwd` fits into existing `resolveCallTransportPlan()`

In `mediaRuntime.ts`:

```typescript
export type CallTransportMode = 'auto' | 'p2p-only' | 'sfu-preferred' | 'stdb' | 'storefwd';
export type EffectiveCallTransport = 'p2p' | 'sfu' | 'stdb' | 'storefwd';
```

In `resolveCallTransportPlan()`:

```typescript
if (mode === 'storefwd') {
    return { mode, effective: 'storefwd', fallbackApplied: false, reason: null, gatewayHealthy, sfuProvider, checkedAt };
}
```

In `resolveActiveTransport(channelId: string)` (`callingTransport.ts`):

```typescript
if (plan.effective === 'storefwd') {
    stopMediaGatewaySessionRenewal();
    callTransportState.set({
        mode: plan.mode,
        activeTransport: 'storefwd',
        isFallback: false,
        reason: 'storefwd_requested',
        gatewayHealthy: false, // does not use gateway
        checkedAt: Date.now(),
        gatewaySessionId: null,
        gatewayControlPlaneStatus: 'idle',
        gatewayMediaPlaneStatus: 'idle',
        gatewayActiveStreams: null,
        gatewayLastSeenAt: null
    });
    return 'storefwd';
}
```

In `calling_impl_core.ts` (call join/answer path):

```typescript
if (activeTransport === 'storefwd') {
    // No peer connection setup. No LiveKit. No STDB.
    // Attach to Socket.IO voice-channel stream, set up PTT handler.
    await startStorefwdSession(channelId);
}
```

New file: `src/lib/callingStorefwd.ts` — owns PTT state, Opus encoder, AES encryption, Socket.IO emitter, incoming buffer, player.

---

## Concrete Phase 6 implication

Phase 6 is the real SFU/WebRTC transport hookup in helper nodes. The TerminalPhone analysis doesn't change Phase 6's scope, but it adds two constraints:

1. **Helper node relay MUST be zero-knowledge.** The assigned `MediaRelay` helper cannot decrypt media. It forwards encrypted frames. This is explicit in the design.

2. **Phase 6 does NOT need to solve the "works anywhere" problem** — because `storefwd` is the answer to that. Phase 6 is for *performance* (real-time, low latency, many concurrent streams), not *reachability*. Don't over-engineer the SFU to punch through hotel firewalls — `storefwd` does that.

---

## Next step

After documenting and verifying, the next step is to actually work on Phase 6 itself as a sticky goal from which the user wants the task to continue.

**Phase 6 scope (from `FRACTURE_PLAN.md` and `futuresight-multi-anchor-helper-nodes.md`):**
Replace the `helper_client.rs` `"media_relay"` skeleton (`// TODO: real SFU init here`) with real WebRTC/SFU bridge wiring. Choose stack (LiveKit / mediasoup / Pion), implement the helper-side SFU listener that receives DTLS/SRTP from clients and fans out to channel participants. Integrate with the `helper_api.rs` LAN token verification so only authorized local clients can connect to the helper's SFU port.

**Blocked on:** WebRTC/SFU stack selection (user has not picked LiveKit vs mediasoup vs Pion). Skeleton is done. Real implementation needs that decision.
