#!/usr/bin/env bash
set -euo pipefail

# Wabi Native Build Script
# Produces Linux, Windows, and Android artifacts locally for off-GitHub distribution.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$PROJECT_ROOT/frontend"
TAURI_DIR="$FRONTEND/src-tauri"
DIST_DIR="$PROJECT_ROOT/dist"

# Ensure clean working tree compiles (warn if dirty)
if ! git -C "$PROJECT_ROOT" diff-index --quiet HEAD --; then
  echo "[warn] Working tree has uncommitted changes."
  echo "[warn] Some files in your tree are known to break the frontend build."
  echo "[warn] Consider: cd $PROJECT_ROOT && git stash push -u"
  read -rp "Continue anyway? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || exit 1
fi

mkdir -p "$DIST_DIR"

echo "=== Building frontend (platform-agnostic) ==="
cd "$FRONTEND"
npm run build:tauri

echo ""
echo "=== Linux Desktop (AppImage + .deb) ==="
cd "$TAURI_DIR"
cargo tauri build --target x86_64-unknown-linux-gnu

# Copy artifacts to dist/
find "$TAURI_DIR/target/release/bundle" \
  \( -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) \
  -exec cp {} "$DIST_DIR/" \;

echo ""
echo "=== Windows Desktop (.exe + .msi via cargo-xwin) ==="
# cargo-xwin downloads MSVC headers and links via LLD.
# This avoids needing a Windows VM.
cd "$TAURI_DIR"
cargo xwin build --target x86_64-pc-windows-msvc --release

# Tauri's bundler still needs to run; for cross-compiled Windows builds,
# the binary is at target/x86_64-pc-windows-msvc/release/wabi.exe
# We can optionally bundle it into an NSIS installer later, but for now
# we package the raw .exe plus a README.
WIN_EXE="$TAURI_DIR/target/x86_64-pc-windows-msvc/release/wabi.exe"
if [ -f "$WIN_EXE" ]; then
  cp "$WIN_EXE" "$DIST_DIR/wabi-windows-x86_64.exe"
  echo "[ok] Windows executable copied."
else
  echo "[warn] Windows .exe not found after cross-compile."
fi

echo ""
echo "=== Android (APK + AAB) ==="
# Requires Java, Android SDK, NDK to be installed.
if [ -n "${JAVA_HOME:-}" ] && command -v sdkmanager &>/dev/null; then
  cd "$FRONTEND"
  npm run tauri android build -- --target aarch64-linux-android
  # Artifacts land in src-tauri/gen/android/app/build/outputs/
  find "$TAURI_DIR/gen/android" \
    \( -name "*.apk" -o -name "*.aab" \) \
    -exec cp {} "$DIST_DIR/" \;
else
  echo "[skip] Android SDK not detected. Skipping Android build."
  echo "       To enable: install Android Studio, set JAVA_HOME, and run again."
fi

echo ""
echo "=== Done ==="
echo "Artifacts ready in: $DIST_DIR"
ls -lh "$DIST_DIR/"
