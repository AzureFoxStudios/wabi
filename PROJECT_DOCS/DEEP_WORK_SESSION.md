# 🎯 Wabi Deep Work Session

**Date:** April 29, 2026  
**Focus:** Core infrastructure that compounds  
**Excluded:** Onboarding wizard (2), Payment E2E (5) — deferred

---

## 1. Voice Channel Implementation — Single UDP Port SFU

**Goal:** Voice channels + direct/group calls with **one UDP port forward** (not 10000-20000 range)

### Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| **SFU library** | Pion (Go) or mediasoup (Node) or raw WebRTC | Need single-UDP-port design |
| **Signaling** | Socket.IO (existing) | Already wired, no new infra |
| **Codec** | Opus | Standard for voice, low latency |
| **Simulcast** | No (Phase 1) | Adds complexity, skip for now |
| **TURN** | coturn (single port 3478) | Fallback for NAT traversal |

### Architecture

```
wabi-server (Rust)
├── Signaling (Socket.IO) ✅ existing
│   ├── join-call
│   ├── offer/answer exchange
│   ├── ice-candidate
│   └── leave-call
│
└── SFU Sidecar (optional addon)
    ├── Single UDP port (e.g., 9987)
    ├── Mixes audio streams
    └── Distributes to participants
```

### Tasks

- [ ] Research: Pion vs mediasoup vs raw WebRTC for single-port design
- [ ] Create `addons/voice-sfu/` structure
- [ ] Implement signaling handlers in `wabi-server`
- [ ] Build/test SFU sidecar
- [ ] Wire frontend voice UI to backend
- [ ] Document: "Forward 2 ports: 8080 (TCP) + 9987 (UDP) = voice enabled"

---

## 3. Addon Loader Runtime

**Goal:** Frontend dynamically loads/enables/disables addons at runtime

### Current State

- `Settings.svelte` has Addons tab ✅
- `addonInventory.ts` fetches plugin list ✅
- `AddonFallbackPanel.svelte` exists ✅
- Addon directory structure created ✅

### What's Missing

- Dynamic import of addon UI components
- Enable/disable state persistence (user + server level)
- Addon dependency resolution
- Addon lifecycle (init, enable, disable, uninstall)
- Settings panel per addon

### Tasks

- [ ] Create `frontend/src/lib/addons/loader.ts` — dynamic import + lifecycle
- [ ] Create `frontend/src/lib/addons/registry.ts` — addon manifest + state
- [ ] Create `frontend/src/lib/addons/settings.ts` — per-addon config storage
- [ ] Wire Settings → Addons panel to actual enable/disable
- [ ] Add addon toolbar buttons to chat/panels (conditional on enable)
- [ ] Test: Enable 3D viewer, disable, re-enable — verify no reload needed

---

## 4. Local-First Storage Polish

**Goal:** All data lives on user's device by default, server is optional cache

### Current State

- `frontend/src/lib/storage.ts` — IndexedDB wrapper ✅
- `StorageSettings.svelte` — rotation, export, clear ✅
- `tauri-storage.ts` — desktop app data path ✅
- `addons/compliance/server-auditor/` — optional archival ✅

### What's Missing

- Compression (already have script, not integrated)
- Encryption at rest ( IndexedDB + Tauri filesystem)
- Sync strategy (local → server-auditor optional)
- Conflict resolution (multi-device)
- Backup/restore UX

### Tasks

- [ ] Integrate compression into `chatStorage` (scripts/compression-storage-smoke.mjs exists)
- [ ] Add encryption layer (Web Crypto API for IndexedDB)
- [ ] Implement `server-auditor` backend (Rust addon)
- [ ] Create sync queue (local changes → server when online)
- [ ] Add "Export my data" → ZIP with JSON + media
- [ ] Document: "Your data is yours — here's how to backup/restore"

---

## 6. Documentation Overhaul

**Goal:** Complete docs for deployers, users, contributors

### Structure

```
docs/
├── deployment/
│   ├── quickstart.md          # "Download, run, forward port, done"
│   ├── iyoku-tim-setup.md     # Multi-node (TAFKAT pattern)
│   ├── router-port-forward.md # TP-Link, ASUS, etc. guides
│   └── firewall-config.md     # firewalld, ufw, Windows Defender
├── users/
│   ├── getting-started.md     # Join server, chat, voice
│   ├── payments.md            # Send/receive BTC, TH, cards
│   └── addons.md              # Enable/disable addons
├── contributors/
│   ├── architecture.md        # Core + addons model
│   ├── creating-addons.md     # Already exists ✅
│   ├── rust-typescript.md     # Protocol type generation
│   └── testing.md             # How to run tests
└── legal/
    ├── non-custodial.md       # Payment model (P2P)
    ├── self-hosting.md        # Why self-hosted > SaaS
    └── compliance-notes.md    # What server operators need to know
```

### Tasks

- [ ] Write `deployment/quickstart.md`
- [ ] Write `deployment/router-port-forward.md`
- [ ] Write `users/getting-started.md`
- [ ] Write `users/payments.md`
- [ ] Write `contributors/architecture.md`
- [ ] Write `legal/non-custodial.md`
- [ ] Create `README.md` overhaul (one-pager for GitHub)

---

## 7. Tauri App Integration

**Goal:** Desktop + Mobile apps use new addon structure

### Current State

- `frontend/src-tauri/` exists ✅
- Tauri v2 (based on earlier session context)
- Custom titlebar mentioned in memory
- Relay toggle mentioned in memory

### What's Missing

- Wire up addon system to Tauri
- Native notifications (already have `tauri-notifications.ts`)
- System tray integration
- Auto-update (Tauri Updater)
- Mobile-specific: push notifications, background audio

### Tasks

- [ ] Audit `frontend/src-tauri/` — what exists vs what's needed
- [ ] Wire addon loader to Tauri plugin system
- [ ] Enable native notifications (desktop + mobile)
- [ ] Add system tray with quick actions (mute, status)
- [ ] Configure auto-update (GitHub Releases)
- [ ] Mobile: push notification setup (FCM/APNs)
- [ ] Mobile: background audio for voice calls
- [ ] Build test: `npm run tauri build` → verify binary

---

## Priority Order

1. **Addon loader runtime** (3) — Unlocks everything else
2. **Local-first storage** (4) — Core value prop
3. **Tauri integration** (7) — Ships with desktop/mobile
4. **Voice SFU** (1) — Phase 1 completeness
5. **Documentation** (6) — Ongoing, parallel with above

---

## Session Notes

[Fill in as we work]
