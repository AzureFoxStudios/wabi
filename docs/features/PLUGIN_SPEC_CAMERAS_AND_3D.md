# Plugin Spec: Security Cameras + 3D/CAD Viewer

**Date:** 2026-04-28  
**Updated:** 2026-04-29  
**Status:** Planning  
**Context:** Designed around a real use case — architecture business with 20+ cameras
across multiple properties, and daily use of SketchUp/AutoCAD for design work.

---

## Part 1 — Security Camera Plugin

### The Problem

iVMS-4500 (Hikvision's desktop client) is laggy even on capable hardware because it
software-decodes H.264/H.265 streams on the CPU instead of using GPU hardware decode.
Opening a separate app to check cameras is friction. 20+ cameras across multiple
properties is a management problem as well as a viewing problem.

### Design Goals

- She opens wabi. Cameras are just there. No separate app.
- Setup is: plug in a wabi-base node at a property, it finds cameras automatically.
- 20+ cameras across many properties is a first-class use case, not an afterthought.
- Desktop (Tauri) gets native low-latency streams. Browser/mobile gets a graceful fallback.
- Motion alerts flow into a protected admin channel so nothing gets missed.

---

### The #security Channel

Created automatically on plugin install. Properties:

```
channel_type: "system"
plugin_managed: true        — wabi-base rejects delete requests
admin_only: true            — non-admin roles cannot see it
undeletable: true
```

Motion alerts post here as a `camera-alert` message type:

```
[Camera: Rear Door — Property: Main Office]
[snapshot thumbnail]
Motion detected · Zone 2 · 14:32:07
[View Live]  [View Playback]
```

The `[View Live]` button opens the camera panel or a fullscreen stream depending
on where the user clicks it from.

---

### Actual Architecture — One NVR, All Properties

The NVR hardware already solves multi-property aggregation. All cameras
from all properties feed back to **one central NVR box** at her desk.
wabi-base talks to that single box. No per-property networking needed.

```
Property A cameras ─┐
Property B cameras ─┤──→ NVR box (local, at desk) ──→ wabi-base ──→ screen
Property C cameras ─┘
```

wabi-base sees one ISAPI endpoint. One IP. One set of credentials.
ISAPI returns all 20+ cameras in a single call.

Multi-property grouping in the camera UI is purely cosmetic —
cameras are named and tagged by property when set up, the grid
organises them visually, but there is no network complexity underneath.

**Setup:**
1. wabi-base on same local network as the NVR
2. Admin enters NVR IP + credentials once
3. ISAPI autodiscovers all cameras
4. Admin labels them by property and arranges the map
5. Done — no tunnels, no port forwarding, no cloud

No Cloudflare tunnel needed for this use case.
Remote access (checking cameras from home) can be added later
as an optional layer if ever needed, but is not required for
the core workflow.

---

### Camera Discovery — "Plug In and Go"

The setup flow should be:

1. Plug wabi-base box into the same network as the NVR/cameras
2. wabi-base runs ONVIF WS-Discovery on the local subnet
3. Discovered cameras appear in the admin panel for confirmation
4. Admin names them, assigns to a property, done

**ONVIF WS-Discovery** is a UDP multicast protocol supported by Hikvision,
Dahua, Axis, Hanwha, and most IP cameras made in the last 10 years.
One discovery implementation covers nearly all brands.

For Hikvision specifically, ISAPI also provides a device list endpoint:
`GET /ISAPI/System/Video/inputs` — returns all connected cameras on an NVR.
Point wabi-base at the NVR IP and it gets the full camera list in one call.

---

### Camera Grid Panel (The Viewer)

A persistent pull-out panel in the Tauri app, independent of the channel system.
Think: a tab or sidebar that becomes a full monitoring view.

```
┌─────────────────────────────────────────────────┐
│  📷 Cameras  [Main Office ▾]  [2×2 ▾]  [⊞ Add] │
├──────────────┬──────────────┬────────────────────┤
│ Front Door   │ Parking Lot  │                    │
│  [live]      │  [live]      │  + Add Camera      │
├──────────────┼──────────────┤                    │
│ Rear Entry   │ Reception    │                    │
│  [live]      │  [live]      │                    │
└──────────────┴──────────────┴────────────────────┘
│ ● Motion: Rear Entry 14:32  [View]               │
└─────────────────────────────────────────────────┘
```

- Property selector at top — switch between Main Office, Warehouse, etc.
- Grid layout selector: 1×1, 2×2, 3×3, 4×4
- Click any cell → fullscreen
- Bottom bar shows recent motion events
- Camera cells are drag-rearrangeable, layout saves per-user

---

### Stream Delivery

| Client | Method | Latency | Notes |
|--------|--------|---------|-------|
| Tauri desktop | Native RTSP via `retina` crate + NVDEC | ~200-400ms | GPU hardware decode, no CPU overhead |
| Browser | HLS via ffmpeg sidecar | 5-10s | Fine for check-in, not real-time monitoring |
| Browser (future) | WebRTC via mediasoup | ~1s | Better fallback if HLS latency unacceptable |

The GPU hardware decode is why this won't lag like iVMS-4500.
A GTX 1080 decodes H.264 in NVDEC with near-zero CPU use.
iVMS-4500 never touches the GPU for this.

## Known Hardware Profile (this deployment)

- **GPU:** GTX 1080
- **NVR:** Single Hikvision box, approximately a decade old, connected via local
  network to her desk computer. All cameras from all properties feed back to
  this one box — multi-property aggregation is handled by the hardware, not wabi.
- **Camera resolution:** Likely 1080p or lower (hardware age). Confirmed NOT 4K.
- **Current usage:** 5-6 streams in a custom iVMS view simultaneously.
- **iVMS complaint:** Visibly laggy despite the rest of the machine being smooth.
  Root cause: iVMS software-decodes on CPU, never uses NVDEC.

### Why wabi will be dramatically better on this hardware

The GTX 1080's NVDEC block can handle approximately 32 simultaneous 1080p H.264
decode sessions at near-zero CPU overhead. iVMS uses none of this.

At 1080p or lower with ~20 cameras, wabi on Tauri with NVDEC decode has headroom
to run **all cameras live simultaneously** — not just the 5-6 she currently
watches. The full 20+ camera grid is feasible on hardware she already owns
that iVMS has been underutilizing for years.

**Default camera grid design for this deployment:** All cameras live, grouped
by property, always on. Not "click to load" — she should just see everything.
This is the correct security monitoring experience and the hardware supports it.

---

### wabi-base API Routes (new)

```
GET  /api/cameras                    — list all cameras (grouped by property)
GET  /api/cameras/:id/snapshot       — current still frame via ISAPI
GET  /api/cameras/:id/stream/hls     — HLS manifest for browser clients
POST /api/cameras/:id/ptz            — pan/tilt/zoom command
GET  /api/properties                 — list properties
POST /api/properties                 — add property + NVR config
POST /api/cameras/discover           — trigger ONVIF discovery on a subnet
```

---

### Tauri Plugin: `tauri-plugin-cameras`

```
src-tauri/plugins/tauri-plugin-cameras/
├── src/
│   ├── lib.rs          — plugin registration
│   ├── rtsp.rs         — retina-based stream handling + NVDEC decode
│   └── commands.rs     — start_stream, stop_stream, get_snapshot
└── guest-js/
    └── index.ts        — TypeScript bindings
```

Frontend usage:
```typescript
import { startStream, stopStream } from 'tauri-plugin-cameras';

// Attach a live stream to a canvas element
await startStream({ cameraId: 'rear-door', canvasId: 'cam-grid-2' });
```

Rust side uses `retina` for RTSP + GStreamer bindings for NVDEC hardware decode,
pipes decoded frames to the webview canvas via a custom Tauri protocol handler.

---

## Part 2 — 3D Model / CAD Viewer Plugin

### The Blender Connection

SketchUp exports GLTF/GLB natively — the same format Blender uses.
Three.js loads GLB and gives you an orbit viewport with the same feel as
Blender's viewport (orbit, pan, zoom). If you've used Blender you already
understand exactly what this viewer does.

This means the viewer for SketchUp models is essentially free —
Three.js is already in the frontend ecosystem and GLB is a first-class format.

---

### Supported Formats

| Format | Source | How | Notes |
|--------|--------|-----|-------|
| `.glb` / `.gltf` | SketchUp, Blender, any | Three.js native | Best quality, textures preserved |
| `.skp` | SketchUp | Export to GLB first | One-click in SketchUp Pro |
| `.dxf` | AutoCAD | dxf-parser → SVG (2D) or OBJ (3D) | Open format, no SDK needed |
| `.dwg` | AutoCAD | ODA converter or Autodesk SDK | Proprietary, harder — phase 2 |
| `.obj` | AutoCAD, many | Three.js OBJLoader | Widely supported |

**Recommended workflow for her:**
- SketchUp Pro → Export → GLB → drop in wabi channel. Done.
- SketchUp Free → Export → OBJ → drop in wabi channel → wabi converts to GLB server-side. Transparent to her.
- AutoCAD → Export → DXF → drop in wabi channel. Done.
- No Autodesk cloud account required.

wabi-base detects the uploaded file extension and routes to the correct
conversion pipeline automatically. The viewer is identical regardless of path.

---

### The Inline Viewer

When a supported 3D/CAD file is dropped in a channel, it renders inline
without any click-to-open. Same principle as how Slack shows image previews
but for 3D models.

```
[Sofia attached: smith-house-rev3.glb]
┌─────────────────────────────────────────┐
│           Smith House — Rev 3           │
│  ┌─────────────────────────────────┐   │
│  │                                 │   │
│  │     [orbitable 3D viewport]     │   │
│  │     drag to rotate              │   │
│  │     scroll to zoom              │   │
│  │                                 │   │
│  └─────────────────────────────────┘   │
│  Layers: [All ▾]  [Wireframe □]        │
│  📎 Download  🔗 Share  💬 Comment 4   │
└─────────────────────────────────────────┘
```

- **Orbit/pan/zoom** — standard Three.js OrbitControls
- **Layer toggle** — show/hide model layers (SketchUp layers map to GLTF mesh groups)
- **Comments** thread below, same as any message

---

### 2D Floor Plan Viewer (DXF)

For AutoCAD 2D construction documents (.dxf), a separate viewer optimized for
flat drawings rather than 3D orbit:

```
┌────────────────────────────────────────────┐
│  Floor Plan — Level 1  [1:100 ▾]  [🔍±]   │
│  Layers: [All] [Walls] [Electrical] [HVAC] │
│  ┌──────────────────────────────────────┐  │
│  │                                      │  │
│  │     [pannable, zoomable SVG]         │  │
│  │     rendered from DXF                │  │
│  │                                      │  │
│  └──────────────────────────────────────┘  │
│  📎 Download DXF  📄 Export PDF            │
└────────────────────────────────────────────┘
```

- Layer visibility toggles (walls, electrical, plumbing, HVAC etc.)
- Scale selector
- PDF export for sending to contractors

---

### Client Portal Use Case

A dedicated channel per project, visible only to that client:

```
#smith-house-project  [client: Smith family]
  ├── Rev 1 model + comment thread
  ├── Rev 2 model + "we moved the kitchen wall" note
  ├── Rev 3 model — awaiting client approval
  └── [Approve Design ✓]  [Request Changes ✗]
```

Client gets a wabi invite with access to only their channel.
They can orbit the model, leave comments, approve or request changes.
No Autodesk account, no Houzz Pro subscription, no Buildertrend license.

Replaces: ~$100-200/month of client-facing project management software.

---

### wabi-base API Routes (new)

```
POST /api/files/preview          — generate preview metadata for uploaded file
GET  /api/files/:id/preview      — serve converted/processed file for viewer
POST /api/files/:id/convert      — trigger DXF→SVG or OBJ conversion
```

Conversion runs server-side on wabi-base so the browser just gets a clean
SVG or optimized GLB regardless of what was uploaded.

---

### Tauri Advantage for 3D

In the Tauri desktop app the Three.js viewer gets WebGL hardware acceleration
with no sandboxing overhead. Large GLB files (complex architectural models
can be 100MB+) load faster, orbit is smoother, and the GPU handles
rendering without competing with browser tab isolation.

---

---

## Part 3 — Interactive Camera Map ("FNAF Mode")

### Concept

A floor plan or site map with clickable camera icons placed at real locations.
Click an icon, the live feed opens. Motion alerts make icons pulse.
Multiple properties and floors are tabs.

The map background is her own architectural drawing — the DXF floor plan
rendered to SVG. The building she designed becomes the camera map.
No commercial NVR software does this. iVMS-4500 has a basic version
but with generic placeholder maps. Using actual architecture drawings
as the background is genuinely useful and looks impressive to clients
and staff.

---

### What It Looks Like

```
[Main Office] [Warehouse] [Parking Lot]   ← property/floor tabs

        🔴  ← pulsing = active motion alert
   ┌─────────────────────────────────┐
   │  📷              📷            │  ← camera icons placed on
   │       [break room]             │     the actual floor plan SVG
   │  📷         📷      📷        │
   │                                │
   │              📷                │
   └─────────────────────────────────┘

  Click any 📷 → feed opens inline or fullscreen
  🔴 pulsing red = motion detected in last 60s
  🟡 yellow = camera offline
  🟢 green = live, no motion
```

---

### How It's Built

**The map background:**
- Upload any image (photo, PNG, hand-drawn sketch) as a quick setup
- Or render directly from her DXF floor plan — the same SVG the 2D
  viewer already generates. One file serves double duty.
- Multiple floors = multiple SVG layers, tab to switch

**Camera placement:**
- Admin drag-and-drops camera icons onto the map in a setup mode
- Positions stored as percentage coordinates (so the map scales to any
  screen size without recalculating)
- One-time setup per property, persists forever

**Camera icon states:**

| State | Visual | Condition |
|-------|--------|-----------|
| Live, quiet | 📷 grey | Connected, no recent motion |
| Live, motion | 📷 pulsing red | Motion in last 60s |
| Offline | 📷 yellow | No ping response |
| Selected | 📷 highlighted | Currently viewing this feed |

**Click behaviour:**
- Single click → feed opens in a side panel next to the map
- Double click → fullscreen feed
- Right click → snapshot, go to alert history, camera settings

---

### Integration With the Rest

The camera map, the grid panel, and the #security channel alerts are all
reading from the same camera state. Motion on Camera 3 simultaneously:
- Pulses the icon on the map
- Posts a snapshot to #security
- Highlights that cell in the grid panel if it's open

One event, three surfaces. No duplication of logic.

---

### The Architecture Drawing Advantage

Because wabi already renders DXF floor plans as SVG, and because she
creates those drawings herself, the camera map setup for a new property is:

1. Upload the floor plan DXF for that property
2. wabi renders it as the map background
3. Drag camera icons to where cameras physically are
4. Done — the map matches the building exactly

This is genuinely better than anything iVMS-4500 or most enterprise NVR
software offers. Normally you'd pay thousands for software that does
site-map camera placement. Here it falls out naturally from features
that already need to exist.

---

## Build Order

### Phase 1 — Quick Wins (days)
- [ ] GLB inline viewer in channel messages (Three.js, ~100 lines)
- [ ] DXF → SVG 2D floor plan viewer
- [ ] `#security` system channel creation on plugin install
- [ ] ISAPI motion alert listener → posts snapshot to channel

### Phase 2 — Camera Grid (weeks)
- [ ] ONVIF auto-discovery
- [ ] Camera management admin panel
- [ ] HLS stream bridge for browser clients
- [ ] Multi-property grouping

### Phase 3 — Native Desktop Streams (weeks)
- [ ] `tauri-plugin-cameras` with `retina` + NVDEC
- [ ] Camera grid pull-out panel in Tauri app
- [ ] Per-user layout persistence

### Phase 4 — Camera Map (weeks)
- [ ] DXF floor plan → SVG background rendering
- [ ] Camera icon placement UI (drag onto map, save coordinates)
- [ ] Live state indicators (quiet / motion / offline)
- [ ] Click-to-view feed from map icon
- [ ] Multi-property / multi-floor tab switching

### Phase 5 — Polish (ongoing)
- [ ] DWG support via ODA converter
- [ ] 3D annotation (click point on model → anchor comment)
- [ ] Revision diff (highlight changed geometry between model versions)
- [ ] Client approval workflow
- [ ] PTZ camera control
- [ ] Camera map motion pulse synced with #security alerts

---

## Resolved Decisions

### Networking — Fully Local, No Tunnels Needed
The NVR hardware already aggregates all properties. All cameras from all
sites pipe back to one central NVR box at her desk. wabi-base talks to
that single box on the local network. No inter-property networking,
no Cloudflare tunnel, no port forwarding, no Tailscale required.
External site topology is irrelevant — the NVR handles it.

### NVR — Single Hikvision Box
One company, one NVR box. This is the easy case.
ISAPI `/ISAPI/System/Video/inputs` returns all connected cameras in one call.
Setup: admin enters NVR IP + credentials once. wabi-base autodiscovers
everything attached to that box. No per-camera manual config needed.
ONVIF is still worth implementing as a fallback for any future mixed hardware.

**Integration model:** wabi talks to the NVR over the local network via HTTP
(Hikvision ISAPI). No code conversion, no changes to the NVR, no new hardware.
The NVR doesn't know wabi exists — it just receives HTTP requests the same way
iVMS does. wabi replaces the viewer, not the infrastructure.

**NVR access:** Needs to be confirmed — run `! tailscale up` on her machine
when available to get SSH access for a quick recon (NVR IP, ISAPI reachability,
firmware version, camera channel list). No changes will be made to the NVR.

### SketchUp — Both Paths Supported
Free and Pro both work, same viewer output. See file format table above.

### Client Portal — Phased
- **Now:** Employees and admin only. Standard wabi role system.
- **Later:** Per-project channels for homeowner clients. One channel per
  house build. Client gets a scoped invite — sees only their project,
  can comment on models and chat with the team, cannot see other
  channels or client lists.

The per-project client channel is the right long-term direction and
worth building properly. Months-long house builds benefit enormously
from a persistent organised channel over email threads. No competitor
offers this in a self-hosted package.
