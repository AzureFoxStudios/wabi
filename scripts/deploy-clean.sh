#!/usr/bin/env bash
set -euo pipefail

echo "[deploy-clean] Legacy entrypoint. Prefer: ./scripts/launch.sh"

# Clean Docker Compose deployment without full downtime.
# - Rebuilds and recreates only app services.
# - Removes orphaned compose containers.
# - Prunes dangling images to avoid buildup.

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
WABI_MODE="${WABI_MODE:-normal}"
WABI_RUNTIME="${WABI_RUNTIME:-node}"
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
  --mode <normal|community>      Override WABI_MODE.
  --runtime <node|bun>           Override WABI_RUNTIME.
  -h, --help               Show help.

Environment overrides:
  COMPOSE_FILE=<path>                         (default: docker-compose.yml)
  WABI_MODE=normal|community                 (default: normal)
  WABI_RUNTIME=node|bun                      (default: node)
  USE_TURN_PROFILE=true|false                (default: true)
  PRUNE_DANGLING_IMAGES=true|false           (default: true)
  PRUNE_STOPPED_CONTAINERS=true|false        (default: false)
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
    --mode)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --mode (expected normal|community)" >&2
        usage
        exit 1
      fi
      WABI_MODE="$2"
      shift 2
      continue
      ;;
    --runtime)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --runtime (expected node|bun)" >&2
        usage
        exit 1
      fi
      WABI_RUNTIME="$2"
      shift 2
      continue
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

if [[ "$WABI_MODE" != "normal" && "$WABI_MODE" != "community" ]]; then
  echo "Invalid WABI_MODE: $WABI_MODE (expected normal|community)" >&2
  exit 1
fi

if [[ "$WABI_RUNTIME" != "node" && "$WABI_RUNTIME" != "bun" ]]; then
  echo "Invalid WABI_RUNTIME: $WABI_RUNTIME (expected node|bun)" >&2
  exit 1
fi

compose_files=("$COMPOSE_FILE")
if [[ "$WABI_MODE" == "community" ]]; then
  compose_files+=("docker-compose.community.yml")
fi
if [[ "$WABI_RUNTIME" == "bun" ]]; then
  compose_files+=("docker-compose.bun.yml")
fi

compose=(docker compose)
for file in "${compose_files[@]}"; do
  compose+=(-f "$file")
done

echo "[deploy] Mode: $WABI_MODE"
echo "[deploy] Runtime: $WABI_RUNTIME"
echo "[deploy] Compose files: ${compose_files[*]}"

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
