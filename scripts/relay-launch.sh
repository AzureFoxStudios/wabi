#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="${RELAY_DIR:-$ROOT_DIR/relay-node}"
COMPOSE_FILE="$RELAY_DIR/docker-compose.yml"
PROJECT_NAME="${RELAY_PROJECT_NAME:-wabi-relay-node}"
LOG_TAIL="${RELAY_LOG_TAIL:-200}"

usage() {
  cat <<'EOF'
Usage: scripts/relay-launch.sh [command]

Dedicated Relay Node workflow (separate from core server launch).

Commands:
  configure   Run relay-node setup wizard (.env generation).
  up          Build and start relay node.
  down        Stop and remove relay node containers.
  restart     Force-recreate relay node container.
  logs        Tail relay node logs.
  status      Show relay node container status.
  shell       Open shell in relay node container.
  -h, --help  Show this help.

Environment overrides:
  RELAY_DIR=<path>                (default: ./relay-node)
  RELAY_PROJECT_NAME=<name>       (default: wabi-relay-node)
  RELAY_LOG_TAIL=<n>              (default: 200)
EOF
}

compose() {
  docker compose --project-directory "$RELAY_DIR" -f "$COMPOSE_FILE" -p "$PROJECT_NAME" "$@"
}

require_relay_dir() {
  if [[ ! -d "$RELAY_DIR" || ! -f "$COMPOSE_FILE" ]]; then
    echo "[relay-launch] relay-node directory or compose file not found: $RELAY_DIR" >&2
    exit 1
  fi
}

require_env_file() {
  if [[ ! -f "$RELAY_DIR/.env" ]]; then
    echo "[relay-launch] Missing relay-node/.env." >&2
    echo "[relay-launch] Run: scripts/relay-launch.sh configure" >&2
    exit 1
  fi
}

COMMAND="${1:-up}"

require_relay_dir

case "$COMMAND" in
  configure)
    (
      cd "$RELAY_DIR"
      ./setup.sh
    )
    ;;
  up)
    require_env_file
    compose up -d --build
    ;;
  down)
    compose down
    ;;
  restart)
    require_env_file
    compose up -d --build --force-recreate
    ;;
  logs)
    compose logs -f --tail "$LOG_TAIL"
    ;;
  status)
    compose ps
    ;;
  shell)
    require_env_file
    compose exec relay-node sh
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "[relay-launch] Unknown command: $COMMAND" >&2
    usage
    exit 1
    ;;
esac
