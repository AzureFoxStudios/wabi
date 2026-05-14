# Wabi Native Build Guide (Linux Mint Edition)

This is the off-GitHub, local-only build path for producing Windows `.exe`, Linux AppImage/`.deb`, and Android `.apk`/`.aab` bundles from Linux Mint.

## 1. Install system dependencies (Mint / Ubuntu / Debian)

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config \
  patchelf \
  fakeroot \
  unzip git \
  nodejs npm \
  openjdk-17-jdk
```

## 2. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

## 3. Install Android toolchain (for mobile builds)

1. Download Android Studio or SDK command-line tools.
2. Set environment variables in `~/.bashrc`:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.11902837"
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

3. Install SDK components:

```bash
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
sdkmanager "ndk;27.0.11902837"
```

4. Add Rust targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## 4. Install cross-compile tools for Windows

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
```

`cargo-xwin` downloads MSVC headers and links with LLD — no Windows license needed.

**Note:** `cargo-xwin` produces a raw `.exe`. To generate an MSI installer you must either:
- Run `cargo tauri build` on a real Windows machine, or
- Use the existing GitHub Action (`.github/workflows/tauri-build.yml`) just for the MSI step.

## 5. Fix known config issues

### Remove broken mobile override configs

These override files contain an invalid `targets` schema for Tauri v2 CLI ≤2.11:

```bash
cd /path/to/wabi/frontend/src-tauri
rm -f tauri.android.conf.json tauri.ios.conf.json
```

### Ensure base config uses valid bundle targets

In `frontend/src-tauri/tauri.conf.json`, your `bundle` block should look like:

```json
  "bundle": {
    "active": true,
    "targets": "all"
  }
```

The `"targets": "all"` string is the correct v2 way to say "build all formats supported by the current platform."

## 6. Build everything

```bash
cd /path/to/wabi
chmod +x scripts/build-native.sh
./scripts/build-native.sh
```

Artifacts land in `wabi/dist/`:

- Linux: `wabi_0.5.0_amd64.AppImage`, `wabi_0.5.0_amd64.deb`
- Windows: `wabi-windows-x86_64.exe`
- Android: `*.apk`, `*.aab`

You can then zip/upload/p2p-share these however you want.

## 7. Building Android specifically

```bash
cd /path/to/wabi/frontend
npm run tauri android build
```

Outputs go to `src-tauri/gen/android/app/build/outputs/apk/release/`.

## Troubleshooting

- **"pkg-config exited with status code 1"** → Run step 1 again, ensure `libwebkit2gtk-4.1-dev` is installed.
- **"Java not found"** → Run step 3 and verify `JAVA_HOME`.
- **Vite build fails** → Your working tree likely has uncommitted frontend changes that break Svelte. Stash them: `git stash push -u`.
- **Windows .exe doesn't bundle into MSI** → Expected on Linux. Use a Windows VM or GitHub Actions for the MSI. The raw `.exe` works fine if distributed with a simple "extract and run" approach.
