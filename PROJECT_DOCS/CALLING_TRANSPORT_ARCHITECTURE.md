# Calling Transport Architecture (Web Baseline + Tauri Enhanced)

## Goals
- Keep browser calls lightweight and reliable for self-hosted deployments.
- Enable higher-quality transport/features for Tauri-native targets without breaking web compatibility.
- Keep memory/CPU budgets low with graceful degradation.

> Important: browsers still use WebRTC for interactive sessions. SRT is a server-side/gateway transport and must remain behind a control-plane contract.

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
- Gateway exposes a dedicated control-plane API contract to the backend with:
  - runtime registration/readiness,
  - authenticated heartbeats,
  - durable stream lease claim/release lifecycle,
  - audit log entries for gateway actions.

## Current Status
- ✅ WebRTC baseline improvements shipped (deafen/video-toggle fixes, sender tuning, Opus preference attempt).
- ✅ Backend control-plane endpoints shipped for gateway runtime + lease lifecycle:
  - `POST /api/media/gateway/register`
  - `POST /api/media/gateway-heartbeat`
  - `POST /api/media/gateway/streams/claim`
  - `POST /api/media/gateway/streams/release`
  - `GET /api/media/runtime`
- ✅ Durable gateway state persisted in SQLite tables (`media_gateway_runtime`, `media_gateway_stream_leases`, `media_gateway_audit_log`).
- ⚠️ Full external observability stack (dashboards/SLO alerts/runbooks) remains deployment work.

## Operational Requirements (SRT Gateway)
- Explicit ports/TLS config in deployment docs.
- Per-stream auth and ACL rules via signed token/rule mapping (`MEDIA_STREAM_ACCESS_RULES`).
- Metrics: packet loss, jitter, RTT, bitrate, reconnection counts.
- Fallback to pure WebRTC when gateway unavailable.

## Control Plane Environment Variables
- `MEDIA_GATEWAY_KEY` (required for gateway control endpoints).
- `MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS` (health timeout window).
- `MEDIA_SRT_GATEWAY_ENABLED` and `MEDIA_SRT_GATEWAY_URL` (feature/runtime hints).
- `MEDIA_STREAM_ACCESS_RULES` JSON map of `x-media-stream-token` to allowed tenant/workspace/channel scope.

Example:
```json
{
  "token-prod-a": {
    "tenantId": "tenant-a",
    "workspaceIds": ["workspace-1"],
    "channelIds": ["voice-general", "voice-stage"]
  },
  "token-ops": {
    "tenantId": "ops",
    "workspaceIds": ["*"],
    "channelIds": ["*"]
  }
}
```

## Rollout Tasks
1. Keep WebRTC sender tuning stable (Opus preference + bitrate caps).
2. Add adaptive quality ladder (resolution/fps/bitrate).
3. Integrate external SRT gateway worker implementation against the control-plane contract.
4. Wire metrics export into dashboards/alerts + incident runbooks.
5. Harden Tauri packaging/signing and release distribution.

## Non-Goals
- Replacing browser WebRTC call transport with direct SRT.
- Forcing heavy transcoding on low-resource hosts by default.
