# Wabi First Pilot — Device & Call Acceptance Checklist

**Campaign:** production-finish Wave 5 | **Source:** `docs/plans/2026-09-15-production-finish-campaign.md`

## Build Identity (record before testing)

| Source | Command / URL | Value |
|---|---|---|
| Server public metadata | `GET /api/public/build-info` | server version / revision / OS / arch |
| Client build manifest | `GET /wabi-client-build.json` | client version / source revision |
| Settings → About | in-app | compiled client + selected server revision |

Record exact values from each machine. No private IPs or credentials.

## Pilot Devices

| Label | Device | OS | Role |
|---|---|---|---|
| BZ1 | Bazzite | Linux | hosted + self-hosted |
| BZ2 | Bazzite | Linux | hosted + self-hosted |
| ironin | Mint 22.3 | Linux | mic/camera, SSH read-only |
| Tim | Mint | Linux | preserve hosting role |
| TWin | Windows 10 | Windows | browser + native candidate |
| PWin | Windows 10/11 | Windows | browser + native candidate |
| Redmi | A7 | Android | mobile web/PWA |
| Void | (unconfirmed) | maybe Win11 | unavailable |

## Pairing Matrix (planned; results pending)

| # | Caller → Callee | Route | Status |
|---|---|---|---|
| 1 | BZ1 → BZ2 | Linux↔Linux | ☐ |
| 2 | BZ1 → TWin | Linux↔Windows | ☐ |
| 3 | BZ1 → Redmi | Linux↔Android | ☐ |
| 4 | ironin → BZ1 | Linux↔Linux | ☐ |
| 5 | TWin → PWin | Windows↔Windows | ☐ |

## Test Cards

### A. Audio / Video / Capture

| # | Test | Steps | Actual | Expected | Pass |
|---|---|---|---|---|---|
| A1 | Mic permission | Join call, allow mic prompt | | | ☐ |
| A2 | Camera permission | Join call, allow camera prompt | | | ☐ |
| A3 | Mute / deafen | Toggle mute, toggle deafen | | | ☐ |
| A4 | Leave / capture stopped | Leave call → capture stops | | | ☐ |
| A5 | Screen sharing | Start/stop sharing; cancel picker once; check advertised sound capture | | Remote image updates; stop ends capture; unsupported capture is recorded explicitly | ☐ |
| A6 | Echo prevention | Put devices in separate physical rooms or use one headset per participant | | Speech is clear without feedback | ☐ |
| A7 | Headset vs speakers | Switch output device where supported | | Audio reaches selected output; no duplicate playback | ☐ |

### B. Failure / Reconnection / Auth

| # | Test | Steps | Actual | Expected | Pass |
|---|---|---|---|---|---|
| B1 | Reconnect | Drop network, observe rejoin | | | ☐ |
| B2 | Network switch | Switch WiFi/mobile data if available; otherwise record not tested | | Recovery is clear, with no duplicate session | ☐ |
| B3 | Logout | Logout during call → session cleared | | | ☐ |
| B4 | Authorized room membership | Non-member cannot join private room | | | ☐ |
| B5 | Capture permission denied | Deny mic/camera, confirm graceful failure | | | ☐ |

### C. Room Capacity

| # | Test | Participants | Status |
|---|---|---|---|
| C1 | 3+ participants call | 3 devices | ☐ |
| C2 | Optional capacity-6 test | 6 devices (if available) | ☐ |
| C3 | CPU/memory/latency recorded | during C1/C2 | ☐ |

*No capacity claim beyond verified count.*

### D. Native vs Web

| # | Test | Native | Web | Status |
|---|---|---|---|---|
| D1 | Install | Actual offered package; record filename/version | browser entry | ☐ |
| D2 | Upgrade | package update | browser refresh | ☐ |
| D3 | Notifications | native toast | browser permission | ☐ |
| D4 | Detached windows | Exercise if offered | Exercise if offered | ☐ |

### E. Self-Hosted

| # | Test | Steps | Status |
|---|---|---|---|
| E1 | Self-hosted install | Fresh disposable installation on an agreed spare host; preserve Tim’s production service | ☐ |
| E2 | Build identity matches | `/api/public/build-info` vs compiled | ☐ |
| E3 | Self-hosted call | BZ2 ↔ ironin over public/WAN | ☐ |

## Result Summary

| Category | Pass | Fail | Not Tested |
|---|---|---|---|
| A. Audio/Video/Capture | | | |
| B. Failure/Auth | | | |
| C. Capacity | | | |
| D. Native/Web | | | |
| E. Self-Hosted | | | |

**Total devices tested:** ____ (record distinct physical devices; Windows versions may share one machine)

## Notes

- Record browser/OS/network for each test row.
- Failures: state repro steps, actual behavior, expected behavior.
- Apple platforms excluded from pilot; capabilities preserved.
- Void unavailable; second network unconfirmed.
- No private IPs or credentials in this document.
