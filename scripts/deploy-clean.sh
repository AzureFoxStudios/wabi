#!/usr/bin/env bash
set -euo pipefail

# Clean Docker Compose deployment without full downtime.
# - Rebuilds and recreates only app services.
# - Removes orphaned compose containers.
# - Prunes dangling images to avoid buildup.

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
USE_TURN_PROFILE="${USE_TURN_PROFILE:-true}"
USE_SFU_PROFILE="${USE_SFU_PROFILE:-auto}"
PRUNE_DANGLING_IMAGES="${PRUNE_DANGLING_IMAGES:-true}"
PRUNE_STOPPED_CONTAINERS="${PRUNE_STOPPED_CONTAINERS:-false}"
WABI_MODE="${WABI_MODE:-normal}"
WABI_RUNTIME="${WABI_RUNTIME:-node}"

to_lower() {
  echo "$1" | tr '[:upper:]' '[:lower:]'
}

append_unique_file() {
  local file="$1"
  local existing
  for existing in "${COMPOSE_FILES[@]}"; do
    if [[ "$existing" == "$file" ]]; then
      return
    fi
  done
  COMPOSE_FILES+=("$file")
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-clean.sh [options]

Options:
  --mode <normal|community>  Deployment mode (default: env WABI_MODE or normal)
  --runtime <node|bun>       Runtime mode (default: env WABI_RUNTIME or node)
  --no-turn-profile        Do not include coturn profile deployment.
  --no-prune-images        Skip dangling image prune.
  --prune-stopped          Also prune all stopped containers.
  -h, --help               Show help.

Environment overrides:
  COMPOSE_FILE=<path>                    (default: docker-compose.yml)
  WABI_MODE=normal|community             (default: normal)
  WABI_RUNTIME=node|bun                  (default: node)
  USE_TURN_PROFILE=true|false            (default: true)
  USE_SFU_PROFILE=auto|true|false        (default: auto; true when SFU_PROVIDER=livekit and LIVEKIT_URL/API_KEY/API_SECRET are set)
  SFU_PROVIDER=none|livekit              (default: none)
  PRUNE_DANGLING_IMAGES=true|false       (default: true)
  PRUNE_STOPPED_CONTAINERS=true|false    (default: false)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --mode" >&2
        exit 1
      fi
      WABI_MODE="$2"
      shift
      ;;
    --runtime)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --runtime" >&2
        exit 1
      fi
      WABI_RUNTIME="$2"
      shift
      ;;
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

WABI_MODE="$(to_lower "$WABI_MODE")"
WABI_RUNTIME="$(to_lower "$WABI_RUNTIME")"

if [[ "$WABI_MODE" != "normal" && "$WABI_MODE" != "community" ]]; then
  echo "Invalid WABI_MODE: $WABI_MODE (expected normal|community)" >&2
  exit 1
fi

if [[ "$WABI_RUNTIME" != "node" && "$WABI_RUNTIME" != "bun" ]]; then
  echo "Invalid WABI_RUNTIME: $WABI_RUNTIME (expected node|bun)" >&2
  exit 1
fi

COMPOSE_FILES=()
IFS=':, ' read -r -a requested_files <<<"$COMPOSE_FILE"
if [[ ${#requested_files[@]} -eq 0 ]]; then
  requested_files=("docker-compose.yml")
fi

for compose_file in "${requested_files[@]}"; do
  [[ -z "$compose_file" ]] && continue
  append_unique_file "$compose_file"
done

if [[ "$WABI_MODE" == "community" ]]; then
  append_unique_file "docker-compose.community.yml"
fi

if [[ "$WABI_RUNTIME" == "bun" ]]; then
  append_unique_file "docker-compose.bun.yml"
fi

for compose_file in "${COMPOSE_FILES[@]}"; do
  if [[ ! -f "$compose_file" ]]; then
    echo "Compose file not found: $compose_file" >&2
    exit 1
  fi
done

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Neither 'docker compose' nor 'docker-compose' was found in PATH." >&2
  exit 1
fi

for compose_file in "${COMPOSE_FILES[@]}"; do
  compose+=(-f "$compose_file")
done

app_services=(backend frontend)
if [[ "$WABI_MODE" == "community" ]]; then
  app_services+=(postgres)
fi

echo "[deploy] Mode: $WABI_MODE"
echo "[deploy] Runtime: $WABI_RUNTIME"
echo "[deploy] Compose files: ${COMPOSE_FILES[*]}"

echo "[deploy] Validating compose config..."
"${compose[@]}" config >/dev/null

echo "[deploy] Building and updating app services (no full down)..."
"${compose[@]}" up -d --build --remove-orphans "${app_services[@]}"

if [[ "$USE_TURN_PROFILE" == "true" ]]; then
  echo "[deploy] Updating coturn profile service..."
  "${compose[@]}" --profile turn up -d --build --remove-orphans coturn
fi

effective_sfu_profile="$USE_SFU_PROFILE"
if [[ "$effective_sfu_profile" == "auto" ]]; then
  if [[ "${SFU_PROVIDER:-none}" == "livekit" && -n "${LIVEKIT_URL:-}" && -n "${LIVEKIT_API_KEY:-}" && -n "${LIVEKIT_API_SECRET:-}" ]]; then
    effective_sfu_profile="true"
  else
    effective_sfu_profile="false"
  fi
fi

if [[ "$effective_sfu_profile" == "true" ]]; then
  echo "[deploy] Updating livekit SFU profile service..."
  "${compose[@]}" --profile sfu up -d --build --remove-orphans livekit
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
