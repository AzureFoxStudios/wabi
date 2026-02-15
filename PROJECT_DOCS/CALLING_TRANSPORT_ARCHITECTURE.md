# Calling Transport Architecture (Web Baseline + Tauri Enhanced)

## Goals
- Keep browser calls lightweight and reliable for self-hosted deployments.
- Enable higher-quality transport/features for Tauri-native targets without breaking web compatibility.
- Keep memory/CPU budgets low with graceful degradation.

> Important: this document describes the target architecture. The current implementation includes runtime policy/heartbeat hooks and early process controls, but it does **not** yet ship a production-ready full SRT media gateway implementation.

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
- ⚠️ Full SRT gateway not yet shipped (design + early control hooks only in this phase).
- ✅ Control-plane hardening in place: pipeline preset validation, URL-scheme allow-list, optional stream token checks, max-concurrency guardrails, graceful-stop escalation behavior, persisted pipeline state snapshots with optional auto-restart policy hooks, and authenticated runtime metrics exposure (`/api/media/metrics`).

## Operational Requirements (SRT Gateway)
- Explicit ports/TLS config in deployment docs.
- Per-stream auth and ACL rules.
- Metrics: packet loss, jitter, RTT, bitrate, reconnection counts.
- Fallback to pure WebRTC when gateway unavailable.

## Rollout Tasks
1. Fix call control bugs (deafen/video-on upgrade).
2. Stabilize WebRTC sender tuning (Opus preference + bitrate caps).
3. Add adaptive quality ladder (resolution/fps/bitrate).
4. Harden gateway control hooks for SRT mode (authz, restart policy, stream lifecycle cleanup).
5. Add Tauri capability gates for enhanced mode.

## Non-Goals
- Replacing browser WebRTC call transport with direct SRT.
- Forcing heavy transcoding on low-resource hosts by default.
