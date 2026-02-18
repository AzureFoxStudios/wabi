#!/usr/bin/env bash
set -euo pipefail

# Clean Docker Compose deployment without full downtime.
# - Rebuilds and recreates only app services.
# - Removes orphaned compose containers.
# - Prunes dangling images to avoid buildup.

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
USE_TURN_PROFILE="${USE_TURN_PROFILE:-true}"
PRUNE_DANGLING_IMAGES="${PRUNE_DANGLING_IMAGES:-true}"
PRUNE_STOPPED_CONTAINERS="${PRUNE_STOPPED_CONTAINERS:-false}"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-clean.sh [options]

Options:
  --no-turn-profile        Do not include coturn profile deployment.
  --no-prune-images        Skip dangling image prune.
  --prune-stopped          Also prune all stopped containers.
  -h, --help               Show help.

Environment overrides:
  COMPOSE_FILE=<path>                    (default: docker-compose.yml)
  USE_TURN_PROFILE=true|false            (default: true)
  PRUNE_DANGLING_IMAGES=true|false       (default: true)
  PRUNE_STOPPED_CONTAINERS=true|false    (default: false)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-turn-profile)
      USE_TURN_PROFILE=false
      ;;
    --no-prune-images)
      PRUNE_DANGLING_IMAGES=false
      ;;
    --prune-stopped)
      PRUNE_STOPPED_CONTAINERS=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

compose=(docker compose -f "$COMPOSE_FILE")

echo "[deploy] Validating compose config..."
"${compose[@]}" config >/dev/null

echo "[deploy] Building and updating backend/frontend (no full down)..."
"${compose[@]}" up -d --build --remove-orphans backend frontend

if [[ "$USE_TURN_PROFILE" == "true" ]]; then
  echo "[deploy] Updating coturn profile service..."
  "${compose[@]}" --profile turn up -d --build --remove-orphans coturn
fi

if [[ "$PRUNE_DANGLING_IMAGES" == "true" ]]; then
  echo "[deploy] Pruning dangling images..."
  docker image prune -f >/dev/null
fi

if [[ "$PRUNE_STOPPED_CONTAINERS" == "true" ]]; then
  echo "[deploy] Pruning stopped containers..."
  docker container prune -f >/dev/null
fi

echo "[deploy] Done."
