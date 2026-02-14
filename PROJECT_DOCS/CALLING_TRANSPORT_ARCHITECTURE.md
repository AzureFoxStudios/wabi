# Calling Transport Architecture (Web Baseline + Tauri Enhanced)

## Goals
- Keep browser calls lightweight and reliable for self-hosted deployments.
- Enable higher-quality transport/features for Tauri-native targets without breaking web compatibility.
- Keep memory/CPU budgets low with graceful degradation.

> Important: this document describes the target architecture. The current implementation only includes WebRTC-side tuning and Opus preference hints; it does **not** include a full SRT media gateway implementation yet.

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
- Gateway must expose a control interface to app backend and preserve auth boundaries.

### Current Status
- ✅ WebRTC baseline improvements shipped (deafen/video-toggle fixes, sender tuning, Opus preference attempt).
- ⚠️ SRT gateway not yet shipped (design only in this phase).

## Operational Requirements (SRT Gateway)
- Explicit ports/TLS config in deployment docs.
- Per-stream auth and ACL rules.
- Metrics: packet loss, jitter, RTT, bitrate, reconnection counts.
- Fallback to pure WebRTC when gateway unavailable.

## Rollout Tasks
1. Fix call control bugs (deafen/video-on upgrade).
2. Stabilize WebRTC sender tuning (Opus preference + bitrate caps).
3. Add adaptive quality ladder (resolution/fps/bitrate).
4. Introduce gateway control hooks for SRT mode (disabled by default).
5. Add Tauri capability gates for enhanced mode.

## Non-Goals
- Replacing browser WebRTC call transport with direct SRT.
- Forcing heavy transcoding on low-resource hosts by default.
