#!/usr/bin/env bash
# scripts/local-dev-minimal.sh
#
# Minimal Wabi local dev: STDB + wabi-server + vite, no compose, no tunnels,
# no ngrok, no caddy, no cloudflared, no helper nodes, no mesh. Two container
# processes and one vite dev process, all on localhost, all on Bazzite.
#
# Goal: a frontend dev (or a bot) can hit a real Wabi backend on
# http://127.0.0.1:3001 without a 3-4 minute cargo build, without touching
# Tim's wabi.chat, and without any cloud dependency.
#
# What it does:
#   1. Starts a single podman container running SpacetimeDB on host port 3000.
#   2. Publishes the wabi_state_bridge module to it (database name: wabi-state-local).
#   3. Starts a single podman container running wabi-server on host port 3001,
#      pointed at the local STDB.
#   4. Starts vite dev pointed at the local wabi-server.
#
# Cleanup: trap kills vite on exit. STDB and wabi-server keep running so
# subsequent runs are fast. Use `podman stop wabi-stdb-local wabi-server-local`
# to stop them.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}/frontend"
STDB_IMAGE="${STDB_IMAGE:-docker.io/clockworklabs/spacetime:latest}"
WABI_IMAGE="${WABI_IMAGE:-localhost/wabi_wabi-server:latest}"
STDB_HOST_PORT="${STDB_HOST_PORT:-3000}"
WABI_HOST_PORT="${WABI_HOST_PORT:-3001}"
FRONTEND_HOST_PORT="${FRONTEND_HOST_PORT:-5173}"
STDB_DATABASE="${WABI_STDB_DATABASE:-wabi-state-local}"
STDB_DATA_DIR="${ROOT_DIR}/data/spacetimedb-local"
STDB_CONFIG_DIR="${ROOT_DIR}/data/spacetimedb-local-config"

mkdir -p "${STDB_DATA_DIR}" "${STDB_CONFIG_DIR}"

# Detect podman
if ! command -v podman >/dev/null 2>&1; then
  echo "[local-dev-minimal] ERROR: podman not found. Install podman or run 'bash scripts/local-dev.sh' (full stack)." >&2
  exit 1
fi

# Pull STDB image if not present
if ! podman image exists "${STDB_IMAGE}" 2>/dev/null; then
  echo "[local-dev-minimal] Pulling ${STDB_IMAGE}..."
  podman pull "${STDB_IMAGE}"
fi

# Pull/load wabi image if not present
if ! podman image exists "${WABI_IMAGE}" 2>/dev/null; then
  echo "[local-dev-minimal] WARN: ${WABI_IMAGE} not present locally."
  echo "[local-dev-minimal] If you've never built it, run: podman build -t wabi_wabi-server -f core/crates/wabi-server/Dockerfile ."
  exit 2
fi

# Start STDB if not already running
if ! podman container exists wabi-stdb-local 2>/dev/null; then
  echo "[local-dev-minimal] Starting STDB on host port ${STDB_HOST_PORT}..."
  podman run -d --rm \
    --name wabi-stdb-local \
    --network=host \
    -v "${STDB_DATA_DIR}:/var/lib/spacetimedb:Z,U" \
    -v "${STDB_CONFIG_DIR}:/home/spacetime/.config/spacetime:Z,U" \
    "${STDB_IMAGE}" \
    start --listen-addr "0.0.0.0:${STDB_HOST_PORT}" --data-dir /var/lib/spacetimedb --non-interactive --page_pool_max_size 268435456
else
  echo "[local-dev-minimal] STDB container wabi-stdb-local already running"
fi

# Wait for STDB ping
echo -n "[local-dev-minimal] Waiting for STDB to come up"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${STDB_HOST_PORT}/v1/ping" >/dev/null 2>&1; then
    echo " — up"
    break
  fi
  echo -n "."
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${STDB_HOST_PORT}/v1/ping" >/dev/null 2>&1; then
  echo " — FAILED" >&2
  echo "[local-dev-minimal] STDB didn't respond to /v1/ping after 60s. Check: podman logs wabi-stdb-local" >&2
  exit 3
fi

# Publish wabi_state_bridge module to STDB
echo "[local-dev-minimal] Publishing wabi_state_bridge to STDB..."
spacetime server add --url "http://127.0.0.1:${STDB_HOST_PORT}" wabi-local --default 2>/dev/null || true
spacetime publish \
  --module-path "${ROOT_DIR}/spacetimedb/wabi_state_bridge" \
  --server wabi-local \
  "${STDB_DATABASE}" --yes \
  || echo "[local-dev-minimal] WARN: module publish failed (continuing — wabi-server may not need a pre-published module)"

# Start wabi-server if not already running
if ! podman container exists wabi-server-local 2>/dev/null; then
  echo "[local-dev-minimal] Starting wabi-server on host port ${WABI_HOST_PORT}..."
  podman run -d --rm \
    --name wabi-server-local \
    --network=host \
    -e WABI_STDB_SERVER="http://127.0.0.1:${STDB_HOST_PORT}" \
    -e WABI_STDB_DATABASE="${STDB_DATABASE}" \
    -e JWT_SECRET="dev-secret-do-not-use-in-production" \
    -e RUST_LOG=info \
    -v "${ROOT_DIR}/data/wabi-server-local:/app/data:Z,U" \
    "${WABI_IMAGE}"
else
  echo "[local-dev-minimal] wabi-server container wabi-server-local already running"
fi

# Wait for wabi-server health
echo -n "[local-dev-minimal] Waiting for wabi-server health"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WABI_HOST_PORT}/health" >/dev/null 2>&1; then
    echo " — up"
    break
  fi
  echo -n "."
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:${WABI_HOST_PORT}/health" >/dev/null 2>&1; then
  echo " — FAILED" >&2
  echo "[local-dev-minimal] wabi-server didn't respond to /health after 60s. Check: podman logs wabi-server-local" >&2
  exit 4
fi

# Start vite dev
echo "[local-dev-minimal] Starting vite dev on port ${FRONTEND_HOST_PORT}..."
echo "[local-dev-minimal] Open: http://127.0.0.1:${FRONTEND_HOST_PORT}/"
echo "[local-dev-minimal] Backend: http://127.0.0.1:${WABI_HOST_PORT}/  (STDB: http://127.0.0.1:${STDB_HOST_PORT}/)"
echo ""
echo "[local-dev-minimal] For a bot: send HTTP to http://127.0.0.1:${WABI_HOST_PORT}/api/auth/login"
echo "[local-dev-minimal] or socket.io to http://127.0.0.1:${WABI_HOST_PORT}/"
echo ""
echo "[local-dev-minimal] Ctrl-C to stop vite. STDB + wabi-server keep running."
echo ""

cd "${FRONTEND_DIR}"
unset VITE_WABI_LOCAL_MOCK
export VITE_SOCKET_URL="http://127.0.0.1:${WABI_HOST_PORT}"
bun x vite dev --host 0.0.0.0 --port "${FRONTEND_HOST_PORT}"
