# 📋 Session Notes — Deep Work + Mobile Focus

**Date:** April 29, 2026  
**Focus:** Addon architecture, persistence, Tauri, mobile view  
**Status:** Code complete, bug squashing in progress

---

## ✅ What Got Built

### 1. Addon Loader Runtime
**Location:** `frontend/src/lib/addons/`

| File | Purpose |
|------|---------|
| `loader.ts` | Dynamic load/enable/disable/unload at runtime |
| `registry.ts` | Svelte store for addon state |
| `settings.ts` | IndexedDB config persistence |
| `index.ts` | Exports |

**Features:**
- No page reload required
- Per-addon config storage
- Enable/disable via Settings panel

---

### 2. Local-First Storage + Encryption
**Location:** `frontend/src/lib/`

| File | Purpose |
|------|---------|
| `storage-compression.ts` | AES-256-GCM + Gzip compression |
| `storage.ts` | Integrated (de)compress + (de)encrypt |

**Features:**
- Optional encryption toggle in Settings
- Key derived from password (PBKDF2)
- Auto-encrypt on write, decrypt on read

---

### 3. Persistence Model
**Location:** `PROJECT_DOCS/PERSISTENCE_MODEL.md`

**Philosophy:** Signal-like with self-host flexibility

| Tier | Default | Who Controls |
|------|---------|--------------|
| Client IndexedDB | ✅ Always | User |
| Server STDB memory | ✅ Always | Admin |
| Server disk (.jsonl) | ❌ Opt-in | Admin |

**New Addon:** `core/addons/persistence-disk/`
- Rust crate, writes JSONL per channel
- Per-channel config (ephemeral/session/persistent)
- Retention policies + rotation

---

### 4. Tauri Desktop App
**Location:** `src-tauri/`

| Feature | Status |
|---------|--------|
| System tray + menu | ✅ |
| Native notifications | ✅ |
| Frameless window | ✅ |
| Linux binary | ✅ 19MB |

**Binary:** `src-tauri/target/release/wabi-desktop`

**Packages:** `.deb`/`.rpm`/`.AppImage` need `libappindicator` installed first

---

### 5. Mobile View
**Location:** `frontend/src/lib/components/MainLayout.svelte`

**Already implemented:**
- Bottom nav bar (Chat / Channels / Users)
- Full-screen sidebar overlays
- Touch-optimized (44px buttons)
- Safe area insets (notch/home indicator)
- Swipe gestures

**Test URL:** `http://192.168.1.99:5173` (local dev server)

---

### 6. Documentation Audit
**Before:** 86 files, disorganized  
**After:** Reorganized into 6 categories

```
PROJECT_DOCS/
├── README.md                    # New index
├── 01-architecture/             # 8 files
├── 02-deployment/               # 5 files
├── 03-features/                 # 4 files
├── 04-payments/                 # 1 file
├── 05-tauri/                    # 2 files
└── archive/                     # ~60 files
```

---

## 🐛 Known Issues / Bug Squashing

### Login Flow (wabi.chat)
**Status:** Broken — needs investigation

**Symptoms:**
- Login page loads but...
- [Fill in after testing]

**Suspects:**
1. STDB connection (socat proxy on Iyoku)
2. JWT token handling
3. Frontend/backend API mismatch
4. Session/cookie issues

**Action:** Test login flow, identify root cause

---

### Android SDK Setup
**Status:** Blocked on Bazzite (immutable Fedora)

**Options:**
1. Distrobox container (requires reboot + rpm-ostree)
2. VM with mutable Linux
3. Skip for now, use PWA on phone

---

## 🔧 What's Running

| Service | Status | URL/Port |
|---------|--------|----------|
| Frontend dev server | ✅ | `http://192.168.1.99:5173` |
| wabi-server (Iyoku) | ✅ | `http://100.104.166.42:8080` |
| STDB (Tim) | ✅ | `100.96.11.45:3030` |
| socat proxy (Iyoku) | ⚠️ Manual | `localhost:3100 → Tim:3030` |

---

## 📝 Next Steps

1. **Bug squashing** — Login flow on wabi.chat
2. **Deploy new structure** — Upload wabi-server to Iyoku
3. **Bundle Linux packages** — Install libappindicator, build .deb/.rpm
4. **Android** — Decide: distrobox or skip for now

---

## 🧠 Key Decisions

| Decision | Rationale |
|----------|-----------|
| Persistence opt-in | Self-host = admin's risk/choice |
| JSONL format | Easy backup, grep, human-readable |
| PWA for mobile now | Works immediately, no SDK needed |
| Tauri desktop first | Linux users can deploy/test now |
| Addon system runtime | Dynamic, no reload, Blender-style |

---

**Handoff Notes:**
- Login bug is priority #1
- Claude C is also helping — coordinate to avoid collisions
- Mobile PWA works on phone at `http://192.168.1.99:5173`
- Desktop binary ready to run/test
