#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
FRONTEND_ENV_FILE="$ROOT_DIR/frontend/.env"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
WABI_CONFIG_FILE="${WABI_CONFIG_FILE:-$ROOT_DIR/wabi.config}"
PROFILE_LOCK_FILE="${PROFILE_LOCK_FILE:-$ROOT_DIR/.wabi-profile}"

RECONFIGURE=false
USE_TURN_PROFILE="${USE_TURN_PROFILE:-true}"
USE_SRT_GATEWAY_PROFILE="${USE_SRT_GATEWAY_PROFILE:-auto}"
USE_SFU_PROFILE="${USE_SFU_PROFILE:-auto}"
PRUNE_DANGLING_IMAGES="${PRUNE_DANGLING_IMAGES:-true}"
PRUNE_STOPPED_CONTAINERS="${PRUNE_STOPPED_CONTAINERS:-false}"

usage() {
  cat <<'EOF'
Usage: scripts/launch.sh [options]

Single command for first-run setup + normal deployment updates.
If wabi.config exists in repo root, it is applied before CLI args.

Options:
  --mode <normal|community>   Override WABI_MODE.
  --runtime <node|bun>        Override WABI_RUNTIME.
  --reconfigure            Regenerate .env and frontend/.env using setup defaults.
  --no-turn-profile        Do not deploy coturn profile.
  --srt-gateway            Force deploy media-gateway profile.
  --no-srt-gateway         Force skip media-gateway profile.
  --no-prune-images        Skip dangling image prune.
  --prune-stopped          Also prune all stopped containers.
  -h, --help               Show help.

Advanced environment overrides:
  WABI_MODE=normal|community           (default: normal)
  WABI_RUNTIME=node|bun                (default: node)
  WABI_DOMAIN=<domain|localhost|no>    (default: localhost)
  TURN_EXTERNAL_IP=<ip>                (default: auto-detect or 127.0.0.1)
  GIPHY_KEY=<key>                      (default: empty)
  USE_TURN_PROFILE=true|false          (default: true)
  USE_SRT_GATEWAY_PROFILE=auto|true|false (default: auto; true when MEDIA_SRT_GATEWAY_ENABLED=true)
  USE_SFU_PROFILE=auto|true|false      (default: auto; true when SFU_PROVIDER=livekit and LIVEKIT_URL/API_KEY/API_SECRET are set)
  SFU_PROVIDER=none|livekit            (default: none)
  PRUNE_DANGLING_IMAGES=true|false     (default: true)
  PRUNE_STOPPED_CONTAINERS=true|false  (default: false)
  WABI_CONFIG_FILE=<path>              (default: ./wabi.config)
EOF
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    printf '%s' "$(date +%s)-$$-wabi-secret-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo fallback)"
  fi
}

generate_hex_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    generate_secret | tr -dc 'A-Za-z0-9' | cut -c1-48
  fi
}

validate_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "[launch] Docker is required but not found on PATH." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "[launch] Docker Compose plugin is required but not available." >&2
    exit 1
  fi
}

normalize_domain() {
  local raw="${1:-localhost}"
  local lowered="${raw,,}"
  if [[ -z "$raw" || "$lowered" == "no" ]]; then
    echo "localhost"
    return
  fi
  raw="${raw#http://}"
  raw="${raw#https://}"
  raw="${raw%%/*}"
  echo "${raw:-localhost}"
}

trim() {
  local value="${1-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_bool() {
  local raw
  raw="$(trim "${1-}")"
  case "${raw,,}" in
    1|true|yes|on)
      echo "true"
      ;;
    0|false|no|off)
      echo "false"
      ;;
    *)
      echo "${2:-false}"
      ;;
  esac
}

to_wabi_mode() {
  case "${1,,}" in
    starter|normal)
      echo "normal"
      ;;
    community)
      echo "community"
      ;;
    *)
      echo ""
      ;;
  esac
}

to_calls_mode() {
  case "${1,,}" in
    off|none|disabled)
      echo "off"
      ;;
    self_hosted_turn|self-hosted-turn|self_turn|self-hosted)
      echo "self_hosted_turn"
      ;;
    external_turn|external-turn|external)
      echo "external_turn"
      ;;
    *)
      echo ""
      ;;
  esac
}

apply_calls_mode() {
  local calls_mode="$1"
  case "$calls_mode" in
    off|external_turn)
      USE_TURN_PROFILE=false
      ;;
    self_hosted_turn)
      USE_TURN_PROFILE=true
      ;;
  esac
}

load_wabi_config() {
  if [[ ! -f "$WABI_CONFIG_FILE" ]]; then
    return
  fi

  echo "[launch] Loading operator config from $WABI_CONFIG_FILE"
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line key value mode bool_value calls_mode
    line="${raw_line%%#*}"
    line="$(trim "$line")"
    [[ -z "$line" ]] && continue

    if [[ "$line" != *=* ]]; then
      echo "[launch] Ignoring malformed config line: $raw_line"
      continue
    fi

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    case "${key^^}" in
      PROFILE)
        mode="$(to_wabi_mode "$value")"
        if [[ -n "$mode" ]]; then
          WABI_MODE="$mode"
        fi
        ;;
      RUNTIME)
        case "${value,,}" in
          node|bun) WABI_RUNTIME="${value,,}" ;;
        esac
        ;;
      DOMAIN)
        WABI_DOMAIN="$value"
        ;;
      CALLS)
        calls_mode="$(to_calls_mode "$value")"
        if [[ -n "$calls_mode" ]]; then
          WABI_CALLS_MODE="$calls_mode"
          apply_calls_mode "$calls_mode"
        fi
        ;;
      ENABLE_RELAYS)
        bool_value="$(normalize_bool "$value" "false")"
        VITE_ENABLE_RELAYS="$bool_value"
        ;;
      ENABLE_MEDIA_GATEWAY)
        bool_value="$(normalize_bool "$value" "false")"
        MEDIA_SRT_GATEWAY_ENABLED="$bool_value"
        if [[ "$bool_value" == "true" ]]; then
          USE_SRT_GATEWAY_PROFILE=true
        else
          USE_SRT_GATEWAY_PROFILE=false
        fi
        ;;
      ENABLE_SFU)
        bool_value="$(normalize_bool "$value" "false")"
        if [[ "$bool_value" == "true" ]]; then
          USE_SFU_PROFILE=true
          SFU_PROVIDER="livekit"
        else
          USE_SFU_PROFILE=false
          SFU_PROVIDER="none"
        fi
        ;;
      SFU_PROVIDER)
        case "${value,,}" in
          livekit|none)
            SFU_PROVIDER="${value,,}"
            ;;
        esac
        ;;
      LIVEKIT_URL)
        LIVEKIT_URL="$value"
        ;;
      LIVEKIT_API_KEY)
        LIVEKIT_API_KEY="$value"
        ;;
      LIVEKIT_API_SECRET)
        LIVEKIT_API_SECRET="$value"
        ;;
      GIPHY_API_KEY)
        GIPHY_KEY="$value"
        ;;
      PLUGINS_ENABLED)
        PLUGINS_ENABLED="$(normalize_bool "$value" "false")"
        ;;
      PLUGINS_ALLOW_INSTALL)
        PLUGINS_ALLOW_INSTALL="$(normalize_bool "$value" "false")"
        ;;
    esac
  done < "$WABI_CONFIG_FILE"
}

enforce_profile_lock() {
  local locked_mode locked_runtime

  if [[ -f "$PROFILE_LOCK_FILE" ]]; then
    locked_mode="$(grep -E '^WABI_MODE=' "$PROFILE_LOCK_FILE" | head -1 | cut -d= -f2- || true)"
    locked_runtime="$(grep -E '^WABI_RUNTIME=' "$PROFILE_LOCK_FILE" | head -1 | cut -d= -f2- || true)"

    if [[ -n "$locked_mode" && "$locked_mode" != "$WABI_MODE" ]]; then
      echo "[launch] Profile lock mismatch: locked mode=$locked_mode, requested mode=$WABI_MODE" >&2
      echo "[launch] Explicit migration is required before changing deployment mode." >&2
      exit 1
    fi
    if [[ -n "$locked_runtime" && "$locked_runtime" != "$WABI_RUNTIME" ]]; then
      echo "[launch] Profile lock mismatch: locked runtime=$locked_runtime, requested runtime=$WABI_RUNTIME" >&2
      echo "[launch] Explicit migration is required before changing runtime." >&2
      exit 1
    fi
    return
  fi

  cat > "$PROFILE_LOCK_FILE" <<EOF
WABI_MODE=$WABI_MODE
WABI_RUNTIME=$WABI_RUNTIME
EOF
  echo "[launch] Wrote profile lock: $PROFILE_LOCK_FILE"
}

configure_defaults() {
  local domain mode runtime public_ip frontend_url public_url turn_realm turn_secret jwt_secret
  local db_mode postgres_db postgres_user postgres_password database_url giphy_key
  local relay_enabled plugins_enabled plugins_allow_install srt_gateway_enabled sfu_provider
  local livekit_url livekit_api_key livekit_api_secret

  domain="$(normalize_domain "${WABI_DOMAIN:-localhost}")"
  mode="${WABI_MODE:-normal}"
  runtime="${WABI_RUNTIME:-node}"
  giphy_key="${GIPHY_KEY:-${VITE_GIPHY_API_KEY:-}}"
  relay_enabled="$(normalize_bool "${VITE_ENABLE_RELAYS:-false}" "false")"
  plugins_enabled="$(normalize_bool "${PLUGINS_ENABLED:-false}" "false")"
  plugins_allow_install="$(normalize_bool "${PLUGINS_ALLOW_INSTALL:-false}" "false")"
  srt_gateway_enabled="$(normalize_bool "${MEDIA_SRT_GATEWAY_ENABLED:-false}" "false")"
  sfu_provider="${SFU_PROVIDER:-none}"
  livekit_url="${LIVEKIT_URL:-}"
  livekit_api_key="${LIVEKIT_API_KEY:-}"
  livekit_api_secret="${LIVEKIT_API_SECRET:-}"

  case "${sfu_provider,,}" in
    livekit|none) ;;
    *) sfu_provider="none" ;;
  esac

  if [[ "$plugins_enabled" != "true" ]]; then
    plugins_allow_install="false"
  fi

  if [[ "$mode" != "normal" && "$mode" != "community" ]]; then
    echo "[launch] Invalid WABI_MODE: $mode (expected normal|community)" >&2
    exit 1
  fi
  if [[ "$runtime" != "node" && "$runtime" != "bun" ]]; then
    echo "[launch] Invalid WABI_RUNTIME: $runtime (expected node|bun)" >&2
    exit 1
  fi

  if [[ "$domain" == "localhost" ]]; then
    frontend_url="http://localhost:3000"
    public_url="http://localhost:3000"
  else
    frontend_url="https://$domain"
    public_url="https://$domain"
  fi

  public_ip="${TURN_EXTERNAL_IP:-$(curl -fsS https://api.ipify.org 2>/dev/null || true)}"
  public_ip="${public_ip:-127.0.0.1}"
  turn_realm="$domain"

  if [[ "$mode" == "community" ]]; then
    db_mode="postgres"
    postgres_db="wabi"
    postgres_user="wabi"
    postgres_password="$(generate_hex_secret)"
    database_url="postgres://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}"
  else
    db_mode="sqlite"
    postgres_db=""
    postgres_user=""
    postgres_password=""
    database_url=""
  fi

  jwt_secret="$(generate_secret)"
  turn_secret="$(generate_secret)"

  cat > "$ENV_FILE" <<EOF
FRONTEND_URL=$frontend_url
PUBLIC_URL=$public_url
NODE_ENV=production
PORT=8080

# Generated by scripts/launch.sh
WABI_MODE=$mode
WABI_RUNTIME=$runtime
DB_MODE=$db_mode
DATABASE_PATH=/app/data/chat.db
DATABASE_URL=$database_url
POSTGRES_DB=$postgres_db
POSTGRES_USER=$postgres_user
POSTGRES_PASSWORD=$postgres_password

JWT_SECRET=$jwt_secret

DATA_DIR=/app/data
PLUGINS_DIR=/app/plugins
PLUGINS_ENABLED=$plugins_enabled
PLUGINS_ALLOW_INSTALL=$plugins_allow_install
STATIC_DIR=/app/frontend/build

TURN_EXTERNAL_IP=$public_ip
TURN_REALM=$turn_realm
TURN_SHARED_SECRET=$turn_secret
TURN_CREDENTIAL_TTL_SECONDS=3600

MEDIA_LOCAL_ENHANCED_ENABLED=true
MEDIA_SRT_GATEWAY_ENABLED=$srt_gateway_enabled
MEDIA_SRT_GATEWAY_URL=
MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS=45000
MEDIA_GATEWAY_KEY=
MEDIA_SRT_SESSION_TTL_SECONDS=900
MEDIA_SRT_BASE_PORT=7000
MEDIA_GATEWAY_ORIGIN_URL=http://backend:8080
MEDIA_GATEWAY_REGION=local
MEDIA_GATEWAY_HEARTBEAT_INTERVAL_MS=15000
MEDIA_GATEWAY_SESSION_SYNC_INTERVAL_MS=10000
SFU_PROVIDER=$sfu_provider
LIVEKIT_URL=$livekit_url
LIVEKIT_API_KEY=$livekit_api_key
LIVEKIT_API_SECRET=$livekit_api_secret

OPENMOJI_VERSION=15.1.0
EOF

  cat > "$FRONTEND_ENV_FILE" <<EOF
VITE_SOCKET_URL=
VITE_GIPHY_API_KEY=$giphy_key
VITE_TURN_SERVER=$public_ip
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
VITE_ENABLE_GOOGLE_STUN=true
VITE_ENABLE_RELAYS=$relay_enabled
EOF

  echo "[launch] Generated config:"
  echo "  - $ENV_FILE"
  echo "  - $FRONTEND_ENV_FILE"
}

is_config_missing() {
  [[ ! -s "$ENV_FILE" || ! -s "$FRONTEND_ENV_FILE" ]]
}

load_wabi_config

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --reconfigure)
      RECONFIGURE=true
      ;;
    --no-turn-profile)
      USE_TURN_PROFILE=false
      ;;
    --srt-gateway)
      USE_SRT_GATEWAY_PROFILE=true
      ;;
    --no-srt-gateway)
      USE_SRT_GATEWAY_PROFILE=false
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

validate_prereqs

if [[ "$RECONFIGURE" == "true" ]] || is_config_missing; then
  echo "[launch] First run or reconfigure requested. Bootstrapping defaults..."
  configure_defaults
fi

# Preserve caller-provided overrides instead of letting .env overwrite them.
CLI_WABI_MODE="${WABI_MODE-}"
CLI_WABI_RUNTIME="${WABI_RUNTIME-}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -n "$CLI_WABI_MODE" ]]; then
  WABI_MODE="$CLI_WABI_MODE"
fi
if [[ -n "$CLI_WABI_RUNTIME" ]]; then
  WABI_RUNTIME="$CLI_WABI_RUNTIME"
fi

WABI_MODE="${WABI_MODE:-normal}"
WABI_RUNTIME="${WABI_RUNTIME:-node}"

if [[ "$WABI_MODE" != "normal" && "$WABI_MODE" != "community" ]]; then
  echo "[launch] Invalid WABI_MODE: $WABI_MODE (expected normal|community)" >&2
  exit 1
fi

if [[ "$WABI_RUNTIME" != "node" && "$WABI_RUNTIME" != "bun" ]]; then
  echo "[launch] Invalid WABI_RUNTIME: $WABI_RUNTIME (expected node|bun)" >&2
  exit 1
fi

enforce_profile_lock

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

echo "[launch] Mode: $WABI_MODE"
echo "[launch] Runtime: $WABI_RUNTIME"
echo "[launch] Compose files: ${compose_files[*]}"

echo "[launch] Validating compose config..."
"${compose[@]}" config >/dev/null

echo "[launch] Building and updating backend/frontend..."
"${compose[@]}" up -d --build --remove-orphans backend frontend

if [[ "$USE_TURN_PROFILE" == "true" ]]; then
  echo "[launch] Updating coturn profile service..."
  "${compose[@]}" --profile turn up -d --build --remove-orphans coturn
fi

effective_srt_profile="$USE_SRT_GATEWAY_PROFILE"
if [[ "$effective_srt_profile" == "auto" ]]; then
  if [[ "${MEDIA_SRT_GATEWAY_ENABLED:-false}" == "true" ]]; then
    effective_srt_profile="true"
  else
    effective_srt_profile="false"
  fi
fi

if [[ "$effective_srt_profile" == "true" ]]; then
  echo "[launch] Updating media-gateway profile service..."
  "${compose[@]}" --profile srt-gateway up -d --build --remove-orphans media-gateway
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
  echo "[launch] Updating livekit SFU profile service..."
  "${compose[@]}" --profile sfu up -d --build --remove-orphans livekit
fi

if [[ "$PRUNE_DANGLING_IMAGES" == "true" ]]; then
  echo "[launch] Pruning dangling images..."
  docker image prune -f >/dev/null
fi

if [[ "$PRUNE_STOPPED_CONTAINERS" == "true" ]]; then
  echo "[launch] Pruning stopped containers..."
  docker container prune -f >/dev/null
fi

echo "[launch] Done."
