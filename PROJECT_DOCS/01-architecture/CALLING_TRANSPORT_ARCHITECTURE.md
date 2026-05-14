# Calling Transport Architecture (Web Baseline + Tauri Enhanced)

## Goals
- Keep browser calls lightweight and reliable for self-hosted deployments.
- Enable higher-quality transport/features for Tauri-native targets without breaking web compatibility.
- Keep memory/CPU budgets low with graceful degradation.

Important: SRT media-plane bridging is still in progress. Phase 2 MVP control-plane is implemented (gateway daemon + heartbeats + session lifecycle API), while browser call media remains WebRTC.

## Transport Modes

### 1) Web Baseline (default)
- Interactive calls use WebRTC (P2P + TURN fallback).
- Audio codec preference is Opus when browser APIs support explicit codec preference.
- Video and screen-share use conservative defaults to reduce RAM/CPU pressure.

### 2) Tauri Enhanced (optional)
- Tauri clients may enable native media enhancements via Rust-side capabilities.
- Browser interoperability remains via WebRTC signaling path.

### 3) SRT Gateway Mode (optional, self-hosted)
- Browsers do not directly use SRT for interactive peer calls.
- SRT is used between server-side media gateway components where needed:
  - ingest/relay,
  - recording,
  - distribution pipelines.
- Gateway exposes a control interface to app backend and preserves auth boundaries.

## Current Status
- WebRTC baseline improvements shipped (deafen/video-toggle fixes, sender tuning, Opus preference attempt).
- Phase 2 MVP control-plane shipped:
  - gateway heartbeat endpoint,
  - gateway session lifecycle endpoints,
  - gateway daemon (`media-gateway/`) for deployable heartbeat/session reconciliation.
- Full SRT media-plane bridge/transcoding is not shipped yet.

## Operational Requirements (SRT Gateway)
- Explicit ports/TLS config in deployment docs.
- Per-stream auth and ACL rules.
- Metrics: packet loss, jitter, RTT, bitrate, reconnection counts.
- Fallback to pure WebRTC when gateway unavailable.

## Rollout Tasks
1. Fix call control bugs (deafen/video-on upgrade).
2. Stabilize WebRTC sender tuning (Opus preference + bitrate caps).
3. Add adaptive quality ladder (resolution/fps/bitrate).
4. Integrate full media-plane gateway bridging on top of shipped control hooks.
5. Add Tauri capability gates for enhanced mode.

## Non-Goals
- Replacing browser WebRTC call transport with direct SRT.
- Forcing heavy transcoding on low-resource hosts by default.
