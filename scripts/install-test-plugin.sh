#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_NAME="${1:-model-viewer}"
SOURCE_DIR="${ROOT_DIR}/TEST/${PLUGIN_NAME}"
DEST_DIR="${ROOT_DIR}/plugins/${PLUGIN_NAME}"

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "[plugin-install] Test plugin not found: ${SOURCE_DIR}" >&2
  exit 1
fi

if [[ ! -f "${SOURCE_DIR}/plugin.json" ]]; then
  echo "[plugin-install] Missing plugin.json in ${SOURCE_DIR}" >&2
  exit 1
fi

echo "[plugin-install] Installing test plugin '${PLUGIN_NAME}'"
echo "[plugin-install] Source: ${SOURCE_DIR}"
echo "[plugin-install] Dest:   ${DEST_DIR}"

rm -rf "${DEST_DIR}"
mkdir -p "${ROOT_DIR}/plugins"
cp -R "${SOURCE_DIR}" "${DEST_DIR}"

if [[ ! -f "${DEST_DIR}/plugin.json" ]]; then
  echo "[plugin-install] Install failed: destination plugin.json missing" >&2
  exit 1
fi

PLUGIN_ID="$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "${DEST_DIR}/plugin.json" | head -1 | sed -E 's/.*"([^"]*)"/\1/')"
PLUGIN_VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${DEST_DIR}/plugin.json" | head -1 | sed -E 's/.*"([^"]*)"/\1/')"

echo "[plugin-install] Installed: id=${PLUGIN_ID:-unknown} version=${PLUGIN_VERSION:-unknown}"
echo "[plugin-install] Next: restart backend to load plugin."
