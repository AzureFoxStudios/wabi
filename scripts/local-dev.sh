#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DATA_DIR="${ROOT_DIR}/backend/data"
BACKEND_UPLOADS_DIR="${ROOT_DIR}/backend/uploads"
BACKEND_DB_PATH="${BACKEND_DATA_DIR}/chat.db"
FRONTEND_BUILD_DIR="${ROOT_DIR}/frontend/build"

mkdir -p "${BACKEND_DATA_DIR}" "${BACKEND_UPLOADS_DIR}"

export NODE_ENV=development
export BACKEND_PORT=3000
export PORT=3000
export FRONTEND_URL=http://localhost:5173
export PUBLIC_URL=http://localhost:5173
export ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000,http://localhost,https://tauri.localhost,tauri://localhost
export DB_MODE=sqlite
export DATABASE_PATH="${BACKEND_DB_PATH}"
export DATA_DIR="${BACKEND_DATA_DIR}"
export UPLOADS_DIR="${BACKEND_UPLOADS_DIR}"
export STATIC_DIR="${FRONTEND_BUILD_DIR}"
export VITE_SOCKET_URL=http://localhost:3000
export VITE_TURN_SERVER=127.0.0.1
export VITE_TURN_PORT=3478
export VITE_USE_TURNS=false
export VITE_ENABLE_GOOGLE_STUN=true
export VITE_ENABLE_RELAYS=false
export STATE_BACKEND_MODE=legacy
export STATE_STDB_READ_ENABLED=false
export STATE_STDB_WRITE_ENABLED=false
export STATE_BACKEND_STRICT=false
export STATE_STDB_SUBSCRIPTIONS_ENABLED=false
export STATE_SHADOW_WRITER_ENABLED=false
export STATE_SHADOW_SINK=mirror
export WABI_STDB_BRIDGE_SERVER=
export WABI_STDB_BRIDGE_DATABASE=
export WABI_STDB_AUTH_TOKEN=
export WABI_STDB_ANONYMOUS=true

echo "[local-dev] Starting localhost stack"
echo "[local-dev] frontend: http://localhost:5173"
echo "[local-dev] backend:  http://localhost:3000"
echo "[local-dev] health:   http://localhost:3000/health"

cd "${ROOT_DIR}"
bun run --cwd frontend dev &
FRONTEND_PID=$!

bun run --cwd backend dev &
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
