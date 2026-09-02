# 🐧 Tauri Desktop App

**Status:** ✅ Build complete  
**Version:** 0.1.0  
**Platform:** Linux (x86_64)

---

## Build Output

| Format | Path | Status |
|--------|------|--------|
| **Binary** | `src-tauri/target/release/wabi-desktop` | ✅ Built (14MB) |
| **.deb** | `src-tauri/target/release/bundle/deb/` | ⏳ Pending (needs libappindicator) |
| **.rpm** | `src-tauri/target/release/bundle/rpm/` | ⏳ Pending |
| **.AppImage** | `src-tauri/target/release/bundle/appimage/` | ⏳ Pending |

---

## Features

### ✅ Implemented

- **System Tray** — Background mode with tray icon
  - Right-click menu: About, Settings, Quit
  - Left-click: Restore window
  - Minimizes to tray on close

- **Native Notifications** — Via `tauri-plugin-notification`
  - Replaces web notifications
  - Works when app is minimized

- **Custom Window** — Frameless, transparent
  - 1200x800 default size
  - Custom titlebar (frontend renders)

- **Plugins**:
  - `tauri-plugin-notification` — Native notifications
  - `tauri-plugin-shell` — Open external URLs
  - `tauri-plugin-fs` — File system access
  - `tauri-plugin-dialog` — Open/save dialogs
  - `tauri-plugin-log` — Logging to file

### 🔧 Tauri Commands

```typescript
// From frontend
import { invoke } from '@tauri-apps/api/core'

// Greet user
await invoke('greet', { name: 'Ronin' })
// → "Hello, Ronin! Welcome to Wabi!"

// Get platform
const platform = await invoke('get_platform')
// → "linux"

// Open URL externally
await invoke('open_external_url', { url: 'https://wabi.chat' })
```

---

## Configuration

**Bundle ID:** `chat.wabi.app`  
**Window Title:** `Wabi`  
**Identifier:** `chat.wabi.app`

**tauri.conf.json:**
```json
{
  "build": {
    "frontendDist": "../frontend/build",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "cd /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend && npm run build"
  },
  "app": {
    "windows": [{
      "title": "Wabi",
      "width": 1200,
      "height": 800,
      "transparent": true,
      "decorations": false
    }],
    "trayIcon": {
      "iconPath": "icons/32x32.png"
    }
  },
  "bundle": {
    "targets": ["deb", "rpm", "appimage", "app", "dmg"]
  }
}
```

---

## Development

### Run in dev mode
```bash
cd /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi
npx tauri dev
```

### Build release
```bash
npx tauri build
```

### Build for specific target
```bash
npx tauri build --target x86_64-unknown-linux-gnu
```

---

## Linux Package Dependencies

### Required for bundling:
```bash
sudo dnf install libappindicator-gtk3 libappindicator-gtk3-devel
```

### Runtime dependencies (bundled in packages):
- `openssl` / `libssl3`
- `libappindicator-gtk3`
- `webkit2gtk3`
- `gtk3`

---

## Mobile (Android)

**Status:** 📱 Ready to configure

Tauri v2 supports Android. To build:

1. **Install Android SDK:**
```bash
# Install Android Studio or SDK command-line tools
# Accept licenses
sdkmanager --licenses
```

2. **Add Android target:**
```bash
rustup target add aarch64-linux-android
```

3. **Initialize Android:**
```bash
npx tauri android init
npx tauri android add chat.wabi.app
```

4. **Build APK:**
```bash
npx tauri android apk
```

5. **Deploy to device (USB connected):**
```bash
npx tauri android dev
```

---

## Frontend Integration

### Add Tauri to frontend
```bash
cd frontend
npm install @tauri-apps/api @tauri-apps/plugin-notification
```

### Use native notifications
```typescript
import { sendNotification } from '@tauri-apps/plugin-notification'

// Request permission
const permission = await sendNotification.requestPermission()

// Send notification
sendNotification({
  title: 'New Message',
  body: 'Ronin: Hey!',
  icon: '/icon.png'
})
```

### Detect Tauri environment
```typescript
import { isTauri } from '@tauri-apps/api/core'

if (isTauri()) {
  // Use native features
} else {
  // Use web fallbacks
}
```

---

## Next Steps

1. **Fix bundling** — Install libappindicator for .deb/.rpm/.appimage
2. **Android build** — Set up Android SDK, build APK
3. **Frontend integration** — Wire up native notifications in Svelte
4. **Auto-start** — Add systemd user service for Linux
5. **Updater** — Add auto-update plugin for releases

---

## Files

```
src-tauri/
├── Cargo.toml              # Rust dependencies
├── tauri.conf.json         # Tauri configuration
├── build.rs                # Build script
├── src/
│   └── main.rs             # Main entry point (tray, plugins)
├── icons/                  # App icons
└── target/
    └── release/
        └── wabi-desktop    # Built binary (14MB)
```
