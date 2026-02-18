#!/usr/bin/env sh
set -eu

VERSION="${OPENMOJI_VERSION:-15.1.0}"
EXPECTED_SHA="${OPENMOJI_72_SHA256:-}"
TARGET_DIR="${1:-./openmoji/png}"
TMP_DIR="$(mktemp -d)"
ZIP_PATH="$TMP_DIR/openmoji-72x72-color.zip"
URL="https://github.com/hfg-gmuend/openmoji/releases/download/${VERSION}/openmoji-72x72-color.zip"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "[OpenMoji] Downloading ${URL}"
curl -fsSL "$URL" -o "$ZIP_PATH"

if [ -n "$EXPECTED_SHA" ]; then
  echo "[OpenMoji] Verifying SHA256"
  echo "$EXPECTED_SHA  $ZIP_PATH" | sha256sum -c -
else
  echo "[OpenMoji] WARNING: OPENMOJI_72_SHA256 not set; skipping checksum verification"
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR/.extract"
unzip -q "$ZIP_PATH" -d "$TARGET_DIR/.extract"

find "$TARGET_DIR/.extract" -type f -name '*.png' -exec cp {} "$TARGET_DIR/" \;
rm -rf "$TARGET_DIR/.extract"

COUNT="$(find "$TARGET_DIR" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')"
if [ "$COUNT" -eq 0 ]; then
  echo "[OpenMoji] ERROR: no PNG assets found after extraction"
  exit 1
fi

PARENT_DIR="$(dirname "$TARGET_DIR")"
cat > "$PARENT_DIR/manifest.json" <<EOF
{
  "source": "openmoji",
  "version": "${VERSION}",
  "archive": "openmoji-72x72-color.zip",
  "count": ${COUNT}
}
EOF

echo "[OpenMoji] Installed ${COUNT} PNG files to ${TARGET_DIR}"
