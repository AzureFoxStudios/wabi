#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DATA_DIR="${ROOT_DIR}/backend/data"
BACKEND_UPLOADS_DIR="${ROOT_DIR}/backend/uploads"
BACKEND_DB_PATH="${BACKEND_DATA_DIR}/chat.db"
FRONTEND_BUILD_DIR="${ROOT_DIR}/frontend/build"
BACKEND_PORT="${BACKEND_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"

mkdir -p "${BACKEND_DATA_DIR}" "${BACKEND_UPLOADS_DIR}"

export NODE_ENV=development
export BACKEND_PORT
export PORT="${BACKEND_PORT}"
export FRONTEND_URL="http://${FRONTEND_HOST}:${FRONTEND_PORT}"
export PUBLIC_URL="http://${FRONTEND_HOST}:${FRONTEND_PORT}"
export ALLOWED_ORIGINS="http://${FRONTEND_HOST}:${FRONTEND_PORT},http://localhost:${FRONTEND_PORT},http://${FRONTEND_HOST}:${BACKEND_PORT},http://localhost:${BACKEND_PORT},http://localhost,http://${FRONTEND_HOST},https://tauri.localhost,tauri://localhost"
export DB_MODE=sqlite
export DATABASE_PATH="${BACKEND_DB_PATH}"
export DATA_DIR="${BACKEND_DATA_DIR}"
export UPLOADS_DIR="${BACKEND_UPLOADS_DIR}"
export STATIC_DIR="${FRONTEND_BUILD_DIR}"
export VITE_SOCKET_URL="http://${FRONTEND_HOST}:${BACKEND_PORT}"
export VITE_TURN_SERVER=127.0.0.1
export VITE_TURN_PORT=3478
export VITE_USE_TURNS=false
export VITE_ENABLE_GOOGLE_STUN=true
export VITE_ENABLE_RELAYS=false
export STATE_STDB_SUBSCRIPTIONS_ENABLED=false
export WABI_STDB_BRIDGE_SERVER=
export WABI_STDB_BRIDGE_DATABASE=
export WABI_STDB_AUTH_TOKEN=
export WABI_STDB_ANONYMOUS=true

echo "[local-dev] Starting localhost stack"
echo "[local-dev] frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo "[local-dev] backend:  http://${FRONTEND_HOST}:${BACKEND_PORT}"
echo "[local-dev] health:   http://${FRONTEND_HOST}:${BACKEND_PORT}/health"

cd "${ROOT_DIR}"
bun run --cwd frontend dev -- --host "${FRONTEND_HOST}" --port "${FRONTEND_PORT}" &
FRONTEND_PID=$!

cargo run -p wabi-server -- --host "${FRONTEND_HOST}" --port "${BACKEND_PORT}" --data-dir "${BACKEND_DATA_DIR}" &
BACKEND_PID=$!

cleanup() {
  kill "${FRONTEND_PID}" "${BACKEND_PID}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

set +e
wait -n "${FRONTEND_PID}" "${BACKEND_PID}"
EXIT_CODE=$?
set -e

cleanup
wait "${FRONTEND_PID}" 2>/dev/null || true
wait "${BACKEND_PID}" 2>/dev/null || true

exit "${EXIT_CODE}"
