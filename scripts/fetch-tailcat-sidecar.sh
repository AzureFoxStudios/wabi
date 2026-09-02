#!/usr/bin/env bash
# Fetch the pinned tailcat release for THIS machine's target triple and place
# it where Tauri's sidecar bundling expects it: src-tauri/binaries/tailcat-<triple>.
# Run before `bun run tauri build` (or a release bundle will fail without it).
#
# Pin policy (docs/plans/2026-09-01-tailcat-private-access.md): upstream is
# v0.x with NO API stability promises — bump deliberately and re-run the
# real-binary E2E from the plan doc.
set -euo pipefail

TAILCAT_VERSION="v0.4.0"
cd "$(dirname "$0")/.."

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$TRIPLE" ]; then
  echo "could not detect rust target triple (rustc not installed?)" >&2
  exit 1
fi

OUT_DIR="src-tauri/binaries"
OUT="$OUT_DIR/tailcat-$TRIPLE"
mkdir -p "$OUT_DIR"

OS="$(uname -s)" ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)  ASSET_TAILCAT="linux_amd64" ;;
  Linux/aarch64) ASSET_TAILCAT="linux_arm64" ;;
  Darwin/arm64)  ASSET_TAILCAT="macos_arm64" ;;
  Darwin/x86_64) ASSET_TAILCAT="macos_amd64" ;;
  *) echo "no known tailcat asset for $OS/$ARCH — check https://github.com/tailscale/tailcat/releases" >&2; exit 1 ;;
esac

# Asset naming per release page: tailcat_<ver>_<os>_<arch>.tar.gz (macos via
# zip/tar.gz as published; adjust if upstream renames).
URL="https://github.com/tailscale/tailcat/releases/download/${TAILCAT_VERSION}/tailcat_${TAILCAT_VERSION#v}_${ASSET_TAILCAT}.tar.gz"
echo "fetching $URL"
TMP="$(mktemp -d)"
curl -sL -o "$TMP/tailcat.tar.gz" "$URL"
tar -xzf "$TMP/tailcat.tar.gz" -C "$TMP"
BIN="$(find "$TMP" -type f -name tailcat | head -1)"
if [ -z "$BIN" ]; then
  echo "tailcat binary not found in archive — asset layout changed?" >&2
  exit 1
fi
cp "$BIN" "$OUT"
chmod +x "$OUT"
rm -rf "$TMP"
echo "sidecar installed: $OUT"
