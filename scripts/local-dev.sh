#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-3001}"

cd "${ROOT_DIR}"

cat <<INFO
[local-dev] Real local Wabi dev mode — privacy-first topology
[local-dev] This is NOT frontend mock mode.
[local-dev] Expected stack:
[local-dev]   Rust server (wabi-server + embedded wabidb engine): http://${FRONTEND_HOST}:${BACKEND_PORT}
[local-dev]   Frontend:                                          http://${FRONTEND_HOST}:${FRONTEND_PORT}
INFO

if [[ "${VITE_WABI_LOCAL_MOCK:-}" == "1" || "${VITE_WABI_LOCAL_MOCK:-}" == "true" ]]; then
  echo "[local-dev] ERROR: VITE_WABI_LOCAL_MOCK is set. That is UI mock mode, not real dev mode." >&2
  echo "[local-dev] Use 'bun run dev:mock' only for visual-only smoke tests." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[local-dev] docker CLI is not installed; will try podman-compose as a fallback." >&2
fi

if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
  CONTAINER_CMD="docker"
  echo "[local-dev] Container runtime: docker (compose via 'docker compose')"
elif command -v podman-compose >/dev/null 2>&1; then
  CONTAINER_CMD="podman-compose"
  echo "[local-dev] Container runtime: podman-compose (docker socket not available, falling back)"
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  CONTAINER_CMD="podman"
  echo "[local-dev] Container runtime: podman (using 'podman compose' subcommand)"
else
  cat >&2 <<ERR
[local-dev] ERROR: No usable container runtime found.
[local-dev] Need ONE of:
[local-dev]   - 'docker ps' to work (docker installed + user has socket access), or
[local-dev]   - 'podman-compose' on PATH, or
[local-dev]   - 'podman compose version' to work
[local-dev]
[local-dev] On Bazzite/Ronin, the typical fix is one of:
[local-dev]   - grant this user Docker socket access intentionally, or
[local-dev]   - install podman-compose (rpm-ostree install podman-compose), or
[local-dev]   - run the wabi-server binary directly (cargo run -p wabi-server).
ERR
  exit 4
fi

cleanup() {
  if [[ -n "${FRONTEND_PID:-}" ]]; then kill "${FRONTEND_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "[local-dev] Building frontend for embedded server assets..."
STATIC_BUILD=1 bun run --cwd frontend build

echo "[local-dev] Building Rust server release binary for compose bind mount..."
cargo build --release -p wabi-server

echo "[local-dev] Starting canonical privacy-first compose stack..."
${CONTAINER_CMD} up -d wabi-server

echo "[local-dev] Waiting for wabi-server health..."
for _ in $(seq 1 60); do
  if curl -fsS "http://${FRONTEND_HOST}:${BACKEND_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://${FRONTEND_HOST}:${BACKEND_PORT}/health" >/dev/null

export VITE_SOCKET_URL="http://${FRONTEND_HOST}:${BACKEND_PORT}"
unset VITE_WABI_LOCAL_MOCK

echo "[local-dev] Starting frontend against real Rust + wabidb backend..."
echo "[local-dev] Open: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
bun run --cwd frontend dev -- --host "${FRONTEND_HOST}" --port "${FRONTEND_PORT}" &
FRONTEND_PID=$!
wait "${FRONTEND_PID}"