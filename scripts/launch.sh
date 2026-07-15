#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib/container-runtime.sh"
ENV_FILE="$ROOT_DIR/.env"
FRONTEND_ENV_FILE="$ROOT_DIR/frontend/.env"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
WABI_CONFIG_FILE="${WABI_CONFIG_FILE:-$ROOT_DIR/wabi.config}"
PROFILE_LOCK_FILE="${PROFILE_LOCK_FILE:-$ROOT_DIR/.wabi-profile}"

RECONFIGURE=false
USE_TURN_PROFILE="${USE_TURN_PROFILE:-true}"
USE_SRT_GATEWAY_PROFILE="${USE_SRT_GATEWAY_PROFILE:-auto}"
USE_SFU_PROFILE="${USE_SFU_PROFILE:-auto}"
USE_TUNNEL_PROFILE="${USE_TUNNEL_PROFILE:-auto}"
TUNNEL_CONNECTOR="${TUNNEL_CONNECTOR:-named}"
PRUNE_DANGLING_IMAGES="${PRUNE_DANGLING_IMAGES:-true}"
PRUNE_STOPPED_CONTAINERS="${PRUNE_STOPPED_CONTAINERS:-false}"
WABI_CONFIG_HAS_VIDEO_COMPRESSION_METRICS=false
WABI_CONFIG_VIDEO_COMPRESSION_METRICS_VALUE=""
WABI_CONFIG_HAS_ENABLE_MEDIA_GATEWAY=false
WABI_CONFIG_ENABLE_MEDIA_GATEWAY_VALUE=""
WABI_CONFIG_HAS_SFU_PROVIDER=false
WABI_CONFIG_SFU_PROVIDER_VALUE=""
WABI_CONFIG_HAS_LIVEKIT_URL=false
WABI_CONFIG_LIVEKIT_URL_VALUE=""
WABI_CONFIG_HAS_LIVEKIT_API_KEY=false
WABI_CONFIG_LIVEKIT_API_KEY_VALUE=""
WABI_CONFIG_HAS_LIVEKIT_API_SECRET=false
WABI_CONFIG_LIVEKIT_API_SECRET_VALUE=""
WABI_CONFIG_HAS_GIPHY_API_KEY=false
WABI_CONFIG_GIPHY_API_KEY_VALUE=""
WABI_CONFIG_HAS_PLUGINS_ENABLED=false
WABI_CONFIG_PLUGINS_ENABLED_VALUE=""
WABI_CONFIG_HAS_PLUGINS_ALLOW_INSTALL=false
WABI_CONFIG_PLUGINS_ALLOW_INSTALL_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_SUBSCRIPTIONS_ENABLED=false
WABI_CONFIG_STATE_STDB_SUBSCRIPTIONS_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_ENFORCE_RBAC=false
WABI_CONFIG_STATE_STDB_ENFORCE_RBAC_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_PATH=false
WABI_CONFIG_STATE_OUTBOX_PATH_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_REDACT_SENSITIVE=false
WABI_CONFIG_STATE_OUTBOX_REDACT_SENSITIVE_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_MAX_BYTES=false
WABI_CONFIG_STATE_OUTBOX_MAX_BYTES_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_TRUNCATE_MIN_BYTES=false
WABI_CONFIG_STATE_OUTBOX_TRUNCATE_MIN_BYTES_VALUE=""
WABI_CONFIG_HAS_STATE_PLANE_SCHEMA_VERSION=false
WABI_CONFIG_STATE_PLANE_SCHEMA_VERSION_VALUE=""
WABI_CONFIG_HAS_STATE_PLANE_SCHEMA_AUTO_APPLY=false
WABI_CONFIG_STATE_PLANE_SCHEMA_AUTO_APPLY_VALUE=""
WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_ENABLED=false
WABI_CONFIG_STATE_REDUCER_INGRESS_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=false
WABI_CONFIG_STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE_VALUE=""
WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_MAX_SKEW_MS=false
WABI_CONFIG_STATE_REDUCER_INGRESS_MAX_SKEW_MS_VALUE=""
WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_MAX_BODY_BYTES=false
WABI_CONFIG_STATE_REDUCER_INGRESS_MAX_BODY_BYTES_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_BRIDGE_MODE=false
WABI_CONFIG_WABI_STDB_BRIDGE_MODE_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_BRIDGE_SERVER=false
WABI_CONFIG_WABI_STDB_BRIDGE_SERVER_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_BRIDGE_DATABASE=false
WABI_CONFIG_WABI_STDB_BRIDGE_DATABASE_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_BRIDGE_REDUCER=false
WABI_CONFIG_WABI_STDB_BRIDGE_REDUCER_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_BRIDGE_MAP_FILE=false
WABI_CONFIG_WABI_STDB_BRIDGE_MAP_FILE_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_BRIDGE_TIMEOUT_MS=false
WABI_CONFIG_WABI_STDB_BRIDGE_TIMEOUT_MS_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_AUTH_TOKEN=false
WABI_CONFIG_WABI_STDB_AUTH_TOKEN_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_ANONYMOUS=false
WABI_CONFIG_WABI_STDB_ANONYMOUS_VALUE=""
WABI_CONFIG_HAS_WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=false
WABI_CONFIG_WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION_VALUE=""
WABI_CONFIG_HAS_WEBHOOK_MAX_BODY_BYTES=false
WABI_CONFIG_WEBHOOK_MAX_BODY_BYTES_VALUE=""
WABI_CONFIG_HAS_WEBHOOK_ALLOW_PRIVATE_TARGETS=false
WABI_CONFIG_WEBHOOK_ALLOW_PRIVATE_TARGETS_VALUE=""
WABI_CONFIG_HAS_WEBHOOK_ALLOWED_HOSTS=false
WABI_CONFIG_WEBHOOK_ALLOWED_HOSTS_VALUE=""
WABI_CONFIG_HAS_WEBHOOK_MAX_DNS_RECORDS=false
WABI_CONFIG_WEBHOOK_MAX_DNS_RECORDS_VALUE=""
WABI_CONFIG_HAS_WEBHOOK_MAX_CONCURRENT_DELIVERIES=false
WABI_CONFIG_WEBHOOK_MAX_CONCURRENT_DELIVERIES_VALUE=""
WABI_CONFIG_HAS_WEBHOOK_MAX_EVENT_FANOUT=false
WABI_CONFIG_WEBHOOK_MAX_EVENT_FANOUT_VALUE=""

usage() {
  cat <<'EOF'
Usage: scripts/launch.sh [options]

Single command for first-run setup + normal deployment updates.
If wabi.config exists in repo root, it is applied before CLI args.
Relay node setup is intentionally separate (use scripts/relay-launch.sh).

Options:
  --mode <authority|anchor>   Override WABI_MODE.
  --runtime <rust>            Override WABI_RUNTIME.
  --reconfigure            Regenerate .env and frontend/.env using setup defaults.
  --no-turn-profile        Do not deploy coturn profile.
  --srt-gateway            Force deploy media-gateway profile.
  --no-srt-gateway         Force skip media-gateway profile.
  --tunnel                 Force deploy Cloudflare tunnel profile.
  --no-tunnel              Force skip Cloudflare tunnel profile.
  --tunnel-named           Use named tunnel connector (requires CLOUDFLARE_TUNNEL_TOKEN).
  --tunnel-quick           Use quick tunnel connector (ephemeral/testing only).
  --no-prune-images        Skip dangling image prune.
  --prune-stopped          Also prune all stopped containers.
  -h, --help               Show help.

Advanced environment overrides:
  WABI_MODE=authority|anchor           (default: authority)
  WABI_RUNTIME=rust                    (default: rust)
  WABI_DOMAIN=<domain|localhost|no>    (default: localhost)
  TURN_EXTERNAL_IP=<ip>                (default: auto-detect or 127.0.0.1)
  GIPHY_KEY=<key>                      (default: empty)
  WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED=true|false (default: false)
  VITE_VIDEO_COMPRESSION_CLIENT_METRICS=true|false         (default: false)
  STATE_STDB_SUBSCRIPTIONS_ENABLED=true|false              (default: false)
  STATE_STDB_ENFORCE_RBAC=true|false                       (default: true)
  STATE_OUTBOX_PATH=<path>                                 (default: /app/data/state-plane-outbox.ndjson)
  STATE_OUTBOX_REDACT_SENSITIVE=true|false                 (default: true)
  STATE_OUTBOX_MAX_BYTES=<1048576-1073741824>             (default: 67108864)
  STATE_OUTBOX_TRUNCATE_MIN_BYTES=<1048576-STATE_OUTBOX_MAX_BYTES> (default: 16777216)
  STATE_PLANE_SCHEMA_VERSION=<1-1000>                      (default: 1)
  STATE_PLANE_SCHEMA_AUTO_APPLY=true|false                 (default: true)
  STATE_REDUCER_INGRESS_ENABLED=true|false                 (default: false)
  STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true|false       (default: true)
  STATE_REDUCER_INGRESS_MAX_SKEW_MS=<1000-3600000>         (default: 300000)
  STATE_REDUCER_INGRESS_MAX_BODY_BYTES=<4096-16777216>     (default: 1048576)
  WABI_STDB_BRIDGE_MODE=spacetime-call|stdout|file         (default: spacetime-call)
  WABI_STDB_BRIDGE_SERVER=<name|url>                       (default: local)
  WABI_STDB_BRIDGE_DATABASE=<database>                     (default: empty)
  WABI_STDB_BRIDGE_REDUCER=<reducer>                       (default: ingest_wabi_event)
  WABI_STDB_BRIDGE_MAP_FILE=<path>                         (default: empty)
  WABI_STDB_BRIDGE_TIMEOUT_MS=<100-300000>                 (default: 10000)
  WABI_STDB_AUTH_TOKEN=<token>                             (default: empty; uses anonymous when unset)
  WABI_STDB_ANONYMOUS=true|false                           (default: false)
  WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=true|false       (default: false)
  WABI_PUBLIC_BACKEND_URL=<url>                            (default: empty; advertise direct backend URL for client failover)
  WABI_SERVER_INSTANCE_ID=<instance-id>                    (default: empty; runtime falls back to HOSTNAME)
  WABI_SERVER_REGION=<region>                              (default: empty; runtime falls back to local)
  WABI_SERVER_ROLE=<role>                                  (default: empty; runtime falls back to app)
  WABI_MESH_INSTANCE_URL_TEMPLATE=<url template>           (default: http://{instanceId}:8080)
  WABI_MESH_INGRESS_URL=<url>                              (default: empty)
  WABI_MESH_SHARED_TOKEN=<token>                           (default: empty)
  WEBHOOK_MAX_BODY_BYTES=<1024-1048576>                    (default: 65536)
  WEBHOOK_ALLOW_PRIVATE_TARGETS=true|false                 (default: false)
  WEBHOOK_ALLOWED_HOSTS=<csv host rules>                   (default: empty)
  WEBHOOK_MAX_DNS_RECORDS=<1-64>                           (default: 16)
  WEBHOOK_MAX_CONCURRENT_DELIVERIES=<1-100>                (default: 20)
  WEBHOOK_MAX_EVENT_FANOUT=<1-5000>                        (default: 250)
  USE_TURN_PROFILE=true|false          (default: true)
  USE_SRT_GATEWAY_PROFILE=auto|true|false (default: auto; true when MEDIA_SRT_GATEWAY_ENABLED=true)
  USE_SFU_PROFILE=auto|true|false      (default: auto; true when SFU_PROVIDER=livekit and LIVEKIT_URL/API_KEY/API_SECRET are set)
  USE_TUNNEL_PROFILE=auto|true|false   (default: auto; true when CLOUDFLARE_TUNNEL_TOKEN is set)
  TUNNEL_CONNECTOR=named|quick         (default: named)
  CLOUDFLARE_TUNNEL_TOKEN=<token>      (required when TUNNEL_CONNECTOR=named and tunnel profile enabled)
  SFU_PROVIDER=none|livekit            (default: none)
  PRUNE_DANGLING_IMAGES=true|false     (default: true)
  PRUNE_STOPPED_CONTAINERS=true|false  (default: false)
  WABI_CONTAINER_RUNTIME=auto|docker|podman (default: auto; prefers Docker when both are installed)
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
  if ! detect_compose_runtime; then
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

normalize_positive_int() {
  local raw min max fallback parsed
  raw="$(trim "${1-}")"
  fallback="${2:-1}"
  min="${3:-1}"
  max="${4:-2147483647}"

  if [[ -z "$raw" || ! "$raw" =~ ^[0-9]+$ ]]; then
    echo "$fallback"
    return
  fi

  parsed="$raw"
  if (( parsed < min )); then
    echo "$min"
    return
  fi
  if (( parsed > max )); then
    echo "$max"
    return
  fi
  echo "$parsed"
}

upsert_env_file_key() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [[ ! -f "$file" ]]; then
    return
  fi

  if grep -Eq "^${key}=" "$file"; then
    sed -i.bak -E "s|^${key}=.*$|${key}=${value}|" "$file"
    rm -f "${file}.bak"
    return
  fi

  printf '\n%s=%s\n' "$key" "$value" >> "$file"
}

to_wabi_mode() {
  case "${1,,}" in
    starter|normal|community|authority)
      echo "authority"
      ;;
    anchor|regional_anchor)
      echo "anchor"
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
          rust) WABI_RUNTIME="rust" ;;
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
        echo "[launch] ENABLE_RELAYS is managed separately now (set VITE_ENABLE_RELAYS in frontend/.env and use scripts/relay-launch.sh)."
        ;;
      ENABLE_MEDIA_GATEWAY)
        bool_value="$(normalize_bool "$value" "false")"
        MEDIA_SRT_GATEWAY_ENABLED="$bool_value"
        WABI_CONFIG_HAS_ENABLE_MEDIA_GATEWAY=true
        WABI_CONFIG_ENABLE_MEDIA_GATEWAY_VALUE="$bool_value"
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
          WABI_CONFIG_HAS_SFU_PROVIDER=true
          WABI_CONFIG_SFU_PROVIDER_VALUE="livekit"
        else
          USE_SFU_PROFILE=false
          SFU_PROVIDER="none"
          WABI_CONFIG_HAS_SFU_PROVIDER=true
          WABI_CONFIG_SFU_PROVIDER_VALUE="none"
        fi
        ;;
      SFU_PROVIDER)
        case "${value,,}" in
          livekit|none)
            SFU_PROVIDER="${value,,}"
            WABI_CONFIG_HAS_SFU_PROVIDER=true
            WABI_CONFIG_SFU_PROVIDER_VALUE="${value,,}"
            ;;
        esac
        ;;
      LIVEKIT_URL)
        LIVEKIT_URL="$value"
        WABI_CONFIG_HAS_LIVEKIT_URL=true
        WABI_CONFIG_LIVEKIT_URL_VALUE="$value"
        ;;
      LIVEKIT_API_KEY)
        LIVEKIT_API_KEY="$value"
        WABI_CONFIG_HAS_LIVEKIT_API_KEY=true
        WABI_CONFIG_LIVEKIT_API_KEY_VALUE="$value"
        ;;
      LIVEKIT_API_SECRET)
        LIVEKIT_API_SECRET="$value"
        WABI_CONFIG_HAS_LIVEKIT_API_SECRET=true
        WABI_CONFIG_LIVEKIT_API_SECRET_VALUE="$value"
        ;;
      GIPHY_API_KEY)
        GIPHY_KEY="$value"
        WABI_CONFIG_HAS_GIPHY_API_KEY=true
        WABI_CONFIG_GIPHY_API_KEY_VALUE="$value"
        ;;
      PLUGINS_ENABLED)
        PLUGINS_ENABLED="$(normalize_bool "$value" "false")"
        WABI_CONFIG_HAS_PLUGINS_ENABLED=true
        WABI_CONFIG_PLUGINS_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      PLUGINS_ALLOW_INSTALL)
        PLUGINS_ALLOW_INSTALL="$(normalize_bool "$value" "false")"
        WABI_CONFIG_HAS_PLUGINS_ALLOW_INSTALL=true
        WABI_CONFIG_PLUGINS_ALLOW_INSTALL_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_STDB_SUBSCRIPTIONS_ENABLED)
        WABI_CONFIG_HAS_STATE_STDB_SUBSCRIPTIONS_ENABLED=true
        WABI_CONFIG_STATE_STDB_SUBSCRIPTIONS_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_STDB_ENFORCE_RBAC)
        WABI_CONFIG_HAS_STATE_STDB_ENFORCE_RBAC=true
        WABI_CONFIG_STATE_STDB_ENFORCE_RBAC_VALUE="$(normalize_bool "$value" "true")"
        ;;
      STATE_OUTBOX_PATH)
        WABI_CONFIG_HAS_STATE_OUTBOX_PATH=true
        WABI_CONFIG_STATE_OUTBOX_PATH_VALUE="$value"
        ;;
      STATE_OUTBOX_REDACT_SENSITIVE)
        WABI_CONFIG_HAS_STATE_OUTBOX_REDACT_SENSITIVE=true
        WABI_CONFIG_STATE_OUTBOX_REDACT_SENSITIVE_VALUE="$(normalize_bool "$value" "true")"
        ;;
      STATE_OUTBOX_MAX_BYTES)
        WABI_CONFIG_HAS_STATE_OUTBOX_MAX_BYTES=true
        WABI_CONFIG_STATE_OUTBOX_MAX_BYTES_VALUE="$(normalize_positive_int "$value" "67108864" "1048576" "1073741824")"
        ;;
      STATE_OUTBOX_TRUNCATE_MIN_BYTES)
        WABI_CONFIG_HAS_STATE_OUTBOX_TRUNCATE_MIN_BYTES=true
        WABI_CONFIG_STATE_OUTBOX_TRUNCATE_MIN_BYTES_VALUE="$(normalize_positive_int "$value" "16777216" "1048576" "1073741824")"
        ;;
      STATE_PLANE_SCHEMA_VERSION)
        WABI_CONFIG_HAS_STATE_PLANE_SCHEMA_VERSION=true
        WABI_CONFIG_STATE_PLANE_SCHEMA_VERSION_VALUE="$(normalize_positive_int "$value" "1" "1" "1000")"
        ;;
      STATE_PLANE_SCHEMA_AUTO_APPLY)
        WABI_CONFIG_HAS_STATE_PLANE_SCHEMA_AUTO_APPLY=true
        WABI_CONFIG_STATE_PLANE_SCHEMA_AUTO_APPLY_VALUE="$(normalize_bool "$value" "true")"
        ;;
      STATE_REDUCER_INGRESS_ENABLED)
        WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_ENABLED=true
        WABI_CONFIG_STATE_REDUCER_INGRESS_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE)
        WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true
        WABI_CONFIG_STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE_VALUE="$(normalize_bool "$value" "true")"
        ;;
      STATE_REDUCER_INGRESS_MAX_SKEW_MS)
        WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_MAX_SKEW_MS=true
        WABI_CONFIG_STATE_REDUCER_INGRESS_MAX_SKEW_MS_VALUE="$(normalize_positive_int "$value" "300000" "1000" "3600000")"
        ;;
      STATE_REDUCER_INGRESS_MAX_BODY_BYTES)
        WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_MAX_BODY_BYTES=true
        WABI_CONFIG_STATE_REDUCER_INGRESS_MAX_BODY_BYTES_VALUE="$(normalize_positive_int "$value" "1048576" "4096" "16777216")"
        ;;
      WABI_STDB_BRIDGE_MODE)
        case "${value,,}" in
          spacetime-call|stdout|file)
            WABI_CONFIG_HAS_WABI_STDB_BRIDGE_MODE=true
            WABI_CONFIG_WABI_STDB_BRIDGE_MODE_VALUE="${value,,}"
            ;;
        esac
        ;;
      WABI_STDB_BRIDGE_SERVER)
        WABI_CONFIG_HAS_WABI_STDB_BRIDGE_SERVER=true
        WABI_CONFIG_WABI_STDB_BRIDGE_SERVER_VALUE="$value"
        ;;
      WABI_STDB_BRIDGE_DATABASE)
        WABI_CONFIG_HAS_WABI_STDB_BRIDGE_DATABASE=true
        WABI_CONFIG_WABI_STDB_BRIDGE_DATABASE_VALUE="$value"
        ;;
      WABI_STDB_BRIDGE_REDUCER)
        WABI_CONFIG_HAS_WABI_STDB_BRIDGE_REDUCER=true
        WABI_CONFIG_WABI_STDB_BRIDGE_REDUCER_VALUE="$value"
        ;;
      WABI_STDB_BRIDGE_MAP_FILE)
        WABI_CONFIG_HAS_WABI_STDB_BRIDGE_MAP_FILE=true
        WABI_CONFIG_WABI_STDB_BRIDGE_MAP_FILE_VALUE="$value"
        ;;
      WABI_STDB_BRIDGE_TIMEOUT_MS)
        WABI_CONFIG_HAS_WABI_STDB_BRIDGE_TIMEOUT_MS=true
        WABI_CONFIG_WABI_STDB_BRIDGE_TIMEOUT_MS_VALUE="$(normalize_positive_int "$value" "10000" "100" "300000")"
        ;;
      WABI_STDB_AUTH_TOKEN)
        WABI_CONFIG_HAS_WABI_STDB_AUTH_TOKEN=true
        WABI_CONFIG_WABI_STDB_AUTH_TOKEN_VALUE="$value"
        ;;
      WABI_STDB_ANONYMOUS)
        WABI_CONFIG_HAS_WABI_STDB_ANONYMOUS=true
        WABI_CONFIG_WABI_STDB_ANONYMOUS_VALUE="$(normalize_bool "$value" "false")"
        ;;
      WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION)
        WABI_CONFIG_HAS_WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=true
        WABI_CONFIG_WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION_VALUE="$(normalize_bool "$value" "false")"
        ;;
      WABI_PUBLIC_BACKEND_URL)
        WABI_PUBLIC_BACKEND_URL="$value"
        ;;
      WABI_SERVER_INSTANCE_ID)
        WABI_SERVER_INSTANCE_ID="$value"
        ;;
      WABI_SERVER_REGION)
        WABI_SERVER_REGION="$value"
        ;;
      WABI_SERVER_ROLE)
        WABI_SERVER_ROLE="$value"
        ;;
      WABI_MESH_INSTANCE_URL_TEMPLATE)
        WABI_MESH_INSTANCE_URL_TEMPLATE="$value"
        ;;
      WABI_MESH_INGRESS_URL)
        WABI_MESH_INGRESS_URL="$value"
        ;;
      WABI_MESH_SHARED_TOKEN)
        WABI_MESH_SHARED_TOKEN="$value"
        ;;
      USE_TUNNEL_PROFILE)
        case "${value,,}" in
          auto|true|false)
            USE_TUNNEL_PROFILE="${value,,}"
            ;;
        esac
        ;;
      TUNNEL_CONNECTOR)
        case "${value,,}" in
          named|quick)
            TUNNEL_CONNECTOR="${value,,}"
            ;;
        esac
        ;;
      CLOUDFLARE_TUNNEL_TOKEN)
        CLOUDFLARE_TUNNEL_TOKEN="$value"
        ;;
      WEBHOOK_MAX_BODY_BYTES)
        WABI_CONFIG_HAS_WEBHOOK_MAX_BODY_BYTES=true
        WABI_CONFIG_WEBHOOK_MAX_BODY_BYTES_VALUE="$(normalize_positive_int "$value" "65536" "1024" "1048576")"
        ;;
      WEBHOOK_ALLOW_PRIVATE_TARGETS)
        WABI_CONFIG_HAS_WEBHOOK_ALLOW_PRIVATE_TARGETS=true
        WABI_CONFIG_WEBHOOK_ALLOW_PRIVATE_TARGETS_VALUE="$(normalize_bool "$value" "false")"
        ;;
      WEBHOOK_ALLOWED_HOSTS)
        WABI_CONFIG_HAS_WEBHOOK_ALLOWED_HOSTS=true
        WABI_CONFIG_WEBHOOK_ALLOWED_HOSTS_VALUE="$value"
        ;;
      WEBHOOK_MAX_DNS_RECORDS)
        WABI_CONFIG_HAS_WEBHOOK_MAX_DNS_RECORDS=true
        WABI_CONFIG_WEBHOOK_MAX_DNS_RECORDS_VALUE="$(normalize_positive_int "$value" "16" "1" "64")"
        ;;
      WEBHOOK_MAX_CONCURRENT_DELIVERIES)
        WABI_CONFIG_HAS_WEBHOOK_MAX_CONCURRENT_DELIVERIES=true
        WABI_CONFIG_WEBHOOK_MAX_CONCURRENT_DELIVERIES_VALUE="$(normalize_positive_int "$value" "20" "1" "100")"
        ;;
      WEBHOOK_MAX_EVENT_FANOUT)
        WABI_CONFIG_HAS_WEBHOOK_MAX_EVENT_FANOUT=true
        WABI_CONFIG_WEBHOOK_MAX_EVENT_FANOUT_VALUE="$(normalize_positive_int "$value" "250" "1" "5000")"
        ;;
      VIDEO_COMPRESSION_METRICS|VIDEO_COMPRESSION_CLIENT_METRICS)
        bool_value="$(normalize_bool "$value" "false")"
        WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED="$bool_value"
        VITE_VIDEO_COMPRESSION_CLIENT_METRICS="$bool_value"
        WABI_CONFIG_HAS_VIDEO_COMPRESSION_METRICS=true
        WABI_CONFIG_VIDEO_COMPRESSION_METRICS_VALUE="$bool_value"
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
  local db_mode giphy_key
  local plugins_enabled plugins_allow_install srt_gateway_enabled sfu_provider
  local state_stdb_subscriptions_enabled state_stdb_enforce_rbac
  local state_outbox_path state_outbox_redact_sensitive state_outbox_max_bytes state_outbox_truncate_min_bytes
  local state_plane_schema_version state_plane_schema_auto_apply
  local state_reducer_ingress_enabled state_reducer_ingress_require_signature state_reducer_ingress_max_skew_ms state_reducer_ingress_max_body_bytes
  local wabi_stdb_bridge_mode wabi_stdb_bridge_server wabi_stdb_bridge_database wabi_stdb_bridge_reducer wabi_stdb_bridge_map_file wabi_stdb_bridge_timeout_ms wabi_stdb_auth_token wabi_stdb_anonymous wabi_stdb_allow_anonymous_in_production
  local wabi_server_instance_id wabi_server_region wabi_server_role wabi_mesh_instance_url_template wabi_mesh_ingress_url wabi_mesh_shared_token
  local webhook_max_body_bytes webhook_allow_private_targets webhook_allowed_hosts webhook_max_dns_records
  local webhook_max_concurrent_deliveries webhook_max_event_fanout
  local video_compression_metrics
  local livekit_url livekit_api_key livekit_api_secret
  local use_tunnel_profile tunnel_connector cloudflare_tunnel_token

  domain="$(normalize_domain "${WABI_DOMAIN:-localhost}")"
  mode="${WABI_MODE:-normal}"
  runtime="${WABI_RUNTIME:-node}"
  giphy_key="${GIPHY_KEY:-${VITE_GIPHY_API_KEY:-}}"
  video_compression_metrics="$(normalize_bool "${WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED:-${VITE_VIDEO_COMPRESSION_CLIENT_METRICS:-false}}" "false")"
  plugins_enabled="$(normalize_bool "${PLUGINS_ENABLED:-false}" "false")"
  plugins_allow_install="$(normalize_bool "${PLUGINS_ALLOW_INSTALL:-false}" "false")"
  state_stdb_subscriptions_enabled="$(normalize_bool "${STATE_STDB_SUBSCRIPTIONS_ENABLED:-false}" "false")"
  state_stdb_enforce_rbac="$(normalize_bool "${STATE_STDB_ENFORCE_RBAC:-true}" "true")"
  state_outbox_path="${STATE_OUTBOX_PATH:-}"
  state_outbox_redact_sensitive="$(normalize_bool "${STATE_OUTBOX_REDACT_SENSITIVE:-true}" "true")"
  state_outbox_max_bytes="$(normalize_positive_int "${STATE_OUTBOX_MAX_BYTES:-67108864}" "67108864" "1048576" "1073741824")"
  state_outbox_truncate_min_bytes="$(normalize_positive_int "${STATE_OUTBOX_TRUNCATE_MIN_BYTES:-16777216}" "16777216" "1048576" "$state_outbox_max_bytes")"
  state_plane_schema_version="$(normalize_positive_int "${STATE_PLANE_SCHEMA_VERSION:-1}" "1" "1" "1000")"
  state_plane_schema_auto_apply="$(normalize_bool "${STATE_PLANE_SCHEMA_AUTO_APPLY:-true}" "true")"
  state_reducer_ingress_enabled="$(normalize_bool "${STATE_REDUCER_INGRESS_ENABLED:-false}" "false")"
  state_reducer_ingress_require_signature="$(normalize_bool "${STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE:-true}" "true")"
  state_reducer_ingress_max_skew_ms="$(normalize_positive_int "${STATE_REDUCER_INGRESS_MAX_SKEW_MS:-300000}" "300000" "1000" "3600000")"
  state_reducer_ingress_max_body_bytes="$(normalize_positive_int "${STATE_REDUCER_INGRESS_MAX_BODY_BYTES:-1048576}" "1048576" "4096" "16777216")"
  wabi_stdb_bridge_mode="${WABI_STDB_BRIDGE_MODE:-spacetime-call}"
  case "${wabi_stdb_bridge_mode,,}" in
    spacetime-call|stdout|file)
      wabi_stdb_bridge_mode="${wabi_stdb_bridge_mode,,}"
      ;;
    *)
      wabi_stdb_bridge_mode="spacetime-call"
      ;;
  esac
  wabi_stdb_bridge_server="${WABI_STDB_BRIDGE_SERVER:-local}"
  wabi_stdb_bridge_database="${WABI_STDB_BRIDGE_DATABASE:-}"
  wabi_stdb_bridge_reducer="${WABI_STDB_BRIDGE_REDUCER:-ingest_wabi_event}"
  wabi_stdb_bridge_map_file="${WABI_STDB_BRIDGE_MAP_FILE:-}"
  wabi_stdb_bridge_timeout_ms="$(normalize_positive_int "${WABI_STDB_BRIDGE_TIMEOUT_MS:-10000}" "10000" "100" "300000")"
  wabi_stdb_auth_token="${WABI_STDB_AUTH_TOKEN:-}"
  wabi_stdb_anonymous="$(normalize_bool "${WABI_STDB_ANONYMOUS:-false}" "false")"
  wabi_stdb_allow_anonymous_in_production="$(normalize_bool "${WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION:-false}" "false")"
  wabi_public_backend_url="${WABI_PUBLIC_BACKEND_URL:-}"
  wabi_server_instance_id="${WABI_SERVER_INSTANCE_ID:-}"
  wabi_server_region="${WABI_SERVER_REGION:-}"
  wabi_server_role="${WABI_SERVER_ROLE:-}"
  wabi_mesh_instance_url_template="${WABI_MESH_INSTANCE_URL_TEMPLATE:-}"
  if [[ -z "$wabi_mesh_instance_url_template" ]]; then
    wabi_mesh_instance_url_template='http://{instanceId}:8080'
  fi
  wabi_mesh_ingress_url="${WABI_MESH_INGRESS_URL:-}"
  wabi_mesh_shared_token="${WABI_MESH_SHARED_TOKEN:-}"
  webhook_max_body_bytes="$(normalize_positive_int "${WEBHOOK_MAX_BODY_BYTES:-65536}" "65536" "1024" "1048576")"
  webhook_allow_private_targets="$(normalize_bool "${WEBHOOK_ALLOW_PRIVATE_TARGETS:-false}" "false")"
  webhook_allowed_hosts="${WEBHOOK_ALLOWED_HOSTS:-}"
  webhook_max_dns_records="$(normalize_positive_int "${WEBHOOK_MAX_DNS_RECORDS:-16}" "16" "1" "64")"
  webhook_max_concurrent_deliveries="$(normalize_positive_int "${WEBHOOK_MAX_CONCURRENT_DELIVERIES:-20}" "20" "1" "100")"
  webhook_max_event_fanout="$(normalize_positive_int "${WEBHOOK_MAX_EVENT_FANOUT:-250}" "250" "1" "5000")"
  srt_gateway_enabled="$(normalize_bool "${MEDIA_SRT_GATEWAY_ENABLED:-false}" "false")"
  sfu_provider="${SFU_PROVIDER:-none}"
  livekit_url="${LIVEKIT_URL:-}"
  livekit_api_key="${LIVEKIT_API_KEY:-}"
  livekit_api_secret="${LIVEKIT_API_SECRET:-}"
  use_tunnel_profile="${USE_TUNNEL_PROFILE:-auto}"
  case "${use_tunnel_profile,,}" in
    auto|true|false)
      use_tunnel_profile="${use_tunnel_profile,,}"
      ;;
    *)
      use_tunnel_profile="auto"
      ;;
  esac
  tunnel_connector="${TUNNEL_CONNECTOR:-named}"
  case "${tunnel_connector,,}" in
    named|quick)
      tunnel_connector="${tunnel_connector,,}"
      ;;
    *)
      tunnel_connector="named"
      ;;
  esac
  cloudflare_tunnel_token="${CLOUDFLARE_TUNNEL_TOKEN:-}"

  case "${sfu_provider,,}" in
    livekit|none) ;;
    *) sfu_provider="none" ;;
  esac

  if [[ "$plugins_enabled" != "true" ]]; then
    plugins_allow_install="false"
  fi

  case "${state_backend_mode,,}" in
    legacy|dual_write|stdb_primary) ;;
    dual-write|dual) state_backend_mode="dual_write" ;;
    stdb-primary|stdb) state_backend_mode="stdb_primary" ;;
    *) state_backend_mode="legacy" ;;
  esac

  if [[ -z "$state_shadow_writer_enabled" ]]; then
    if [[ "$state_backend_mode" == "dual_write" && "$state_stdb_write_enabled" == "true" ]]; then
      state_shadow_writer_enabled="true"
    else
      state_shadow_writer_enabled="false"
    fi
  fi

  if [[ "$mode" != "authority" && "$mode" != "anchor" ]]; then
    echo "[launch] Invalid WABI_MODE: $mode (expected authority|anchor)" >&2
    exit 1
  fi
  if [[ "$runtime" != "rust" ]]; then
    echo "[launch] Invalid WABI_RUNTIME: $runtime (expected rust)" >&2
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
STATE_STDB_SUBSCRIPTIONS_ENABLED=$state_stdb_subscriptions_enabled
STATE_STDB_ENFORCE_RBAC=$state_stdb_enforce_rbac
STATE_OUTBOX_PATH=$state_outbox_path
STATE_OUTBOX_REDACT_SENSITIVE=$state_outbox_redact_sensitive
STATE_OUTBOX_MAX_BYTES=$state_outbox_max_bytes
STATE_OUTBOX_TRUNCATE_MIN_BYTES=$state_outbox_truncate_min_bytes
STATE_PLANE_SCHEMA_VERSION=$state_plane_schema_version
STATE_PLANE_SCHEMA_AUTO_APPLY=$state_plane_schema_auto_apply
STATE_REDUCER_INGRESS_ENABLED=$state_reducer_ingress_enabled
STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=$state_reducer_ingress_require_signature
STATE_REDUCER_INGRESS_MAX_SKEW_MS=$state_reducer_ingress_max_skew_ms
STATE_REDUCER_INGRESS_MAX_BODY_BYTES=$state_reducer_ingress_max_body_bytes
WABI_STDB_BRIDGE_MODE=$wabi_stdb_bridge_mode
WABI_STDB_BRIDGE_SERVER=$wabi_stdb_bridge_server
WABI_STDB_BRIDGE_DATABASE=$wabi_stdb_bridge_database
WABI_STDB_BRIDGE_REDUCER=$wabi_stdb_bridge_reducer
WABI_STDB_BRIDGE_MAP_FILE=$wabi_stdb_bridge_map_file
WABI_STDB_BRIDGE_TIMEOUT_MS=$wabi_stdb_bridge_timeout_ms
WABI_STDB_AUTH_TOKEN=$wabi_stdb_auth_token
WABI_STDB_ANONYMOUS=$wabi_stdb_anonymous
WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=$wabi_stdb_allow_anonymous_in_production
WABI_PUBLIC_BACKEND_URL=$wabi_public_backend_url
WABI_SERVER_INSTANCE_ID=$wabi_server_instance_id
WABI_SERVER_REGION=$wabi_server_region
WABI_SERVER_ROLE=$wabi_server_role
WABI_MESH_INSTANCE_URL_TEMPLATE=$wabi_mesh_instance_url_template
WABI_MESH_INGRESS_URL=$wabi_mesh_ingress_url
WABI_MESH_SHARED_TOKEN=$wabi_mesh_shared_token
WEBHOOK_MAX_BODY_BYTES=$webhook_max_body_bytes
WEBHOOK_ALLOW_PRIVATE_TARGETS=$webhook_allow_private_targets
WEBHOOK_ALLOWED_HOSTS=$webhook_allowed_hosts
WEBHOOK_MAX_DNS_RECORDS=$webhook_max_dns_records
WEBHOOK_MAX_CONCURRENT_DELIVERIES=$webhook_max_concurrent_deliveries
WEBHOOK_MAX_EVENT_FANOUT=$webhook_max_event_fanout

JWT_SECRET=$jwt_secret

DATA_DIR=/app/data
PLUGINS_DIR=/app/plugins
PLUGINS_ENABLED=$plugins_enabled
PLUGINS_ALLOW_INSTALL=$plugins_allow_install
WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED=$video_compression_metrics
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
USE_TUNNEL_PROFILE=$use_tunnel_profile
TUNNEL_CONNECTOR=$tunnel_connector
CLOUDFLARE_TUNNEL_TOKEN=$cloudflare_tunnel_token

OPENMOJI_VERSION=15.1.0
EOF

  cat > "$FRONTEND_ENV_FILE" <<EOF
VITE_SOCKET_URL=
VITE_GIPHY_API_KEY=$giphy_key
VITE_TURN_SERVER=$public_ip
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
VITE_ENABLE_GOOGLE_STUN=true
VITE_VIDEO_COMPRESSION_CLIENT_METRICS=$video_compression_metrics
EOF

  echo "[launch] Generated config:"
  echo "  - $ENV_FILE"
  echo "  - $FRONTEND_ENV_FILE"
}

is_config_missing() {
  [[ ! -s "$ENV_FILE" || ! -s "$FRONTEND_ENV_FILE" ]]
}

validate_security_config() {
  local errors=()

  if [[ -z "${JWT_SECRET:-}" || "${JWT_SECRET}" == "replace_with_long_random_jwt_secret" || "${JWT_SECRET}" == "dev-secret-change-in-production" ]]; then
    errors+=("JWT_SECRET must be set to a strong non-placeholder value.")
  fi

  if [[ -z "${TURN_SHARED_SECRET:-}" || "${TURN_SHARED_SECRET}" == "replace_with_long_random_shared_secret" ]]; then
    errors+=("TURN_SHARED_SECRET must be set to a strong non-placeholder value.")
  fi

  if [[ "${SFU_PROVIDER:-none}" == "livekit" ]]; then
    if [[ -z "${LIVEKIT_API_KEY:-}" || -z "${LIVEKIT_API_SECRET:-}" ]]; then
      errors+=("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required when SFU_PROVIDER=livekit.")
    fi
  fi

  local stdb_active="false"
  if [[ -n "${WABI_STDB_BRIDGE_DATABASE:-}" ]]; then
    stdb_active="true"
  fi
  if [[ "${NODE_ENV:-production}" == "production" && "$stdb_active" == "true" ]]; then
    if [[ -z "${WABI_STDB_AUTH_TOKEN:-}" && "${WABI_STDB_ANONYMOUS:-false}" == "true" && "${WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION:-false}" != "true" ]]; then
      errors+=("STDB is active with anonymous auth in production. Set WABI_STDB_AUTH_TOKEN or explicitly set WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=true.")
    fi
  fi

  if [[ ${#errors[@]} -gt 0 ]]; then
    echo "[launch] Security configuration validation failed:" >&2
    for err in "${errors[@]}"; do
      echo "  - $err" >&2
    done
    exit 1
  fi
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
    --tunnel)
      USE_TUNNEL_PROFILE=true
      ;;
    --no-tunnel)
      USE_TUNNEL_PROFILE=false
      ;;
    --tunnel-named)
      TUNNEL_CONNECTOR=named
      ;;
    --tunnel-quick)
      TUNNEL_CONNECTOR=quick
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

WABI_MODE="${WABI_MODE:-authority}"
WABI_RUNTIME="${WABI_RUNTIME:-rust}"

if [[ "$WABI_MODE" != "authority" && "$WABI_MODE" != "anchor" ]]; then
  echo "[launch] Invalid WABI_MODE: $WABI_MODE (expected authority|anchor)" >&2
  exit 1
fi

if [[ "$WABI_RUNTIME" != "rust" ]]; then
  echo "[launch] Invalid WABI_RUNTIME: $WABI_RUNTIME (expected rust)" >&2
  exit 1
fi

if [[ "$WABI_CONFIG_HAS_VIDEO_COMPRESSION_METRICS" == "true" ]]; then
  WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED="$(normalize_bool "${WABI_CONFIG_VIDEO_COMPRESSION_METRICS_VALUE:-false}" "false")"
  VITE_VIDEO_COMPRESSION_CLIENT_METRICS="$(normalize_bool "${WABI_CONFIG_VIDEO_COMPRESSION_METRICS_VALUE:-${WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED}}" "${WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED}")"
  upsert_env_file_key "$ENV_FILE" "WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED" "$WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED"
  upsert_env_file_key "$FRONTEND_ENV_FILE" "VITE_VIDEO_COMPRESSION_CLIENT_METRICS" "$VITE_VIDEO_COMPRESSION_CLIENT_METRICS"
  echo "[launch] Applied VIDEO_COMPRESSION_METRICS from wabi.config (backend=$WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED frontend=$VITE_VIDEO_COMPRESSION_CLIENT_METRICS)."
fi

if [[ "$WABI_CONFIG_HAS_ENABLE_MEDIA_GATEWAY" == "true" ]]; then
  MEDIA_SRT_GATEWAY_ENABLED="$(normalize_bool "${WABI_CONFIG_ENABLE_MEDIA_GATEWAY_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "MEDIA_SRT_GATEWAY_ENABLED" "$MEDIA_SRT_GATEWAY_ENABLED"
  echo "[launch] Applied ENABLE_MEDIA_GATEWAY from wabi.config (backend=$MEDIA_SRT_GATEWAY_ENABLED)."
fi

if [[ "$WABI_CONFIG_HAS_SFU_PROVIDER" == "true" ]]; then
  case "${WABI_CONFIG_SFU_PROVIDER_VALUE,,}" in
    livekit|none)
      SFU_PROVIDER="${WABI_CONFIG_SFU_PROVIDER_VALUE,,}"
      upsert_env_file_key "$ENV_FILE" "SFU_PROVIDER" "$SFU_PROVIDER"
      echo "[launch] Applied SFU provider from wabi.config (backend=$SFU_PROVIDER)."
      ;;
  esac
fi

if [[ "$WABI_CONFIG_HAS_LIVEKIT_URL" == "true" ]]; then
  LIVEKIT_URL="$WABI_CONFIG_LIVEKIT_URL_VALUE"
  upsert_env_file_key "$ENV_FILE" "LIVEKIT_URL" "$LIVEKIT_URL"
  echo "[launch] Applied LIVEKIT_URL from wabi.config."
fi

if [[ "$WABI_CONFIG_HAS_LIVEKIT_API_KEY" == "true" ]]; then
  LIVEKIT_API_KEY="$WABI_CONFIG_LIVEKIT_API_KEY_VALUE"
  upsert_env_file_key "$ENV_FILE" "LIVEKIT_API_KEY" "$LIVEKIT_API_KEY"
  echo "[launch] Applied LIVEKIT_API_KEY from wabi.config."
fi

if [[ "$WABI_CONFIG_HAS_LIVEKIT_API_SECRET" == "true" ]]; then
  LIVEKIT_API_SECRET="$WABI_CONFIG_LIVEKIT_API_SECRET_VALUE"
  upsert_env_file_key "$ENV_FILE" "LIVEKIT_API_SECRET" "$LIVEKIT_API_SECRET"
  echo "[launch] Applied LIVEKIT_API_SECRET from wabi.config."
fi

if [[ "$WABI_CONFIG_HAS_GIPHY_API_KEY" == "true" ]]; then
  GIPHY_KEY="$WABI_CONFIG_GIPHY_API_KEY_VALUE"
  upsert_env_file_key "$FRONTEND_ENV_FILE" "VITE_GIPHY_API_KEY" "$GIPHY_KEY"
  echo "[launch] Applied GIPHY_API_KEY from wabi.config."
fi

if [[ "$WABI_CONFIG_HAS_PLUGINS_ENABLED" == "true" ]]; then
  PLUGINS_ENABLED="$(normalize_bool "${WABI_CONFIG_PLUGINS_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "PLUGINS_ENABLED" "$PLUGINS_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_PLUGINS_ALLOW_INSTALL" == "true" ]]; then
  PLUGINS_ALLOW_INSTALL="$(normalize_bool "${WABI_CONFIG_PLUGINS_ALLOW_INSTALL_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "PLUGINS_ALLOW_INSTALL" "$PLUGINS_ALLOW_INSTALL"
fi
if [[ "${PLUGINS_ENABLED:-false}" != "true" ]]; then
  PLUGINS_ALLOW_INSTALL="false"
  upsert_env_file_key "$ENV_FILE" "PLUGINS_ALLOW_INSTALL" "$PLUGINS_ALLOW_INSTALL"
fi

if [[ "$WABI_CONFIG_HAS_STATE_STDB_SUBSCRIPTIONS_ENABLED" == "true" ]]; then
  STATE_STDB_SUBSCRIPTIONS_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_STDB_SUBSCRIPTIONS_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_SUBSCRIPTIONS_ENABLED" "$STATE_STDB_SUBSCRIPTIONS_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_ENFORCE_RBAC" == "true" ]]; then
  STATE_STDB_ENFORCE_RBAC="$(normalize_bool "${WABI_CONFIG_STATE_STDB_ENFORCE_RBAC_VALUE:-true}" "true")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_ENFORCE_RBAC" "$STATE_STDB_ENFORCE_RBAC"
fi
if [[ "$WABI_CONFIG_HAS_STATE_OUTBOX_PATH" == "true" ]]; then
  STATE_OUTBOX_PATH="$WABI_CONFIG_STATE_OUTBOX_PATH_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_PATH" "$STATE_OUTBOX_PATH"
fi
if [[ "$WABI_CONFIG_HAS_STATE_OUTBOX_MAX_BYTES" == "true" ]]; then
  STATE_OUTBOX_MAX_BYTES="$(normalize_positive_int "${WABI_CONFIG_STATE_OUTBOX_MAX_BYTES_VALUE:-67108864}" "67108864" "1048576" "1073741824")"
  upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_MAX_BYTES" "$STATE_OUTBOX_MAX_BYTES"
fi
if [[ "$WABI_CONFIG_HAS_STATE_OUTBOX_REDACT_SENSITIVE" == "true" ]]; then
  STATE_OUTBOX_REDACT_SENSITIVE="$(normalize_bool "${WABI_CONFIG_STATE_OUTBOX_REDACT_SENSITIVE_VALUE:-true}" "true")"
  upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_REDACT_SENSITIVE" "$STATE_OUTBOX_REDACT_SENSITIVE"
fi
if [[ "$WABI_CONFIG_HAS_STATE_OUTBOX_TRUNCATE_MIN_BYTES" == "true" ]]; then
  STATE_OUTBOX_TRUNCATE_MIN_BYTES="$(normalize_positive_int "${WABI_CONFIG_STATE_OUTBOX_TRUNCATE_MIN_BYTES_VALUE:-16777216}" "16777216" "1048576" "1073741824")"
  upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_TRUNCATE_MIN_BYTES" "$STATE_OUTBOX_TRUNCATE_MIN_BYTES"
fi
STATE_OUTBOX_REDACT_SENSITIVE="$(normalize_bool "${STATE_OUTBOX_REDACT_SENSITIVE:-true}" "true")"
STATE_OUTBOX_MAX_BYTES="$(normalize_positive_int "${STATE_OUTBOX_MAX_BYTES:-67108864}" "67108864" "1048576" "1073741824")"
STATE_OUTBOX_TRUNCATE_MIN_BYTES="$(normalize_positive_int "${STATE_OUTBOX_TRUNCATE_MIN_BYTES:-16777216}" "16777216" "1048576" "$STATE_OUTBOX_MAX_BYTES")"
upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_REDACT_SENSITIVE" "$STATE_OUTBOX_REDACT_SENSITIVE"
upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_MAX_BYTES" "$STATE_OUTBOX_MAX_BYTES"
upsert_env_file_key "$ENV_FILE" "STATE_OUTBOX_TRUNCATE_MIN_BYTES" "$STATE_OUTBOX_TRUNCATE_MIN_BYTES"
if [[ "$WABI_CONFIG_HAS_WABI_STDB_BRIDGE_MODE" == "true" ]]; then
  WABI_STDB_BRIDGE_MODE="${WABI_CONFIG_WABI_STDB_BRIDGE_MODE_VALUE,,}"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_MODE" "$WABI_STDB_BRIDGE_MODE"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_BRIDGE_SERVER" == "true" ]]; then
  WABI_STDB_BRIDGE_SERVER="$WABI_CONFIG_WABI_STDB_BRIDGE_SERVER_VALUE"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_SERVER" "$WABI_STDB_BRIDGE_SERVER"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_BRIDGE_DATABASE" == "true" ]]; then
  WABI_STDB_BRIDGE_DATABASE="$WABI_CONFIG_WABI_STDB_BRIDGE_DATABASE_VALUE"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_DATABASE" "$WABI_STDB_BRIDGE_DATABASE"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_BRIDGE_REDUCER" == "true" ]]; then
  WABI_STDB_BRIDGE_REDUCER="$WABI_CONFIG_WABI_STDB_BRIDGE_REDUCER_VALUE"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_REDUCER" "$WABI_STDB_BRIDGE_REDUCER"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_BRIDGE_MAP_FILE" == "true" ]]; then
  WABI_STDB_BRIDGE_MAP_FILE="$WABI_CONFIG_WABI_STDB_BRIDGE_MAP_FILE_VALUE"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_MAP_FILE" "$WABI_STDB_BRIDGE_MAP_FILE"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_BRIDGE_TIMEOUT_MS" == "true" ]]; then
  WABI_STDB_BRIDGE_TIMEOUT_MS="$(normalize_positive_int "${WABI_CONFIG_WABI_STDB_BRIDGE_TIMEOUT_MS_VALUE:-10000}" "10000" "100" "300000")"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_TIMEOUT_MS" "$WABI_STDB_BRIDGE_TIMEOUT_MS"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_AUTH_TOKEN" == "true" ]]; then
  WABI_STDB_AUTH_TOKEN="$WABI_CONFIG_WABI_STDB_AUTH_TOKEN_VALUE"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_AUTH_TOKEN" "$WABI_STDB_AUTH_TOKEN"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_ANONYMOUS" == "true" ]]; then
  WABI_STDB_ANONYMOUS="$(normalize_bool "${WABI_CONFIG_WABI_STDB_ANONYMOUS_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_ANONYMOUS" "$WABI_STDB_ANONYMOUS"
fi
if [[ "$WABI_CONFIG_HAS_WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION" == "true" ]]; then
  WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION="$(normalize_bool "${WABI_CONFIG_WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION" "$WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION"
fi
case "${WABI_STDB_BRIDGE_MODE:-spacetime-call}" in
  spacetime-call|stdout|file) ;;
  *) WABI_STDB_BRIDGE_MODE="spacetime-call" ;;
esac
WABI_STDB_BRIDGE_SERVER="${WABI_STDB_BRIDGE_SERVER:-local}"
WABI_STDB_BRIDGE_DATABASE="${WABI_STDB_BRIDGE_DATABASE:-}"
WABI_STDB_BRIDGE_REDUCER="${WABI_STDB_BRIDGE_REDUCER:-ingest_wabi_event}"
WABI_STDB_BRIDGE_MAP_FILE="${WABI_STDB_BRIDGE_MAP_FILE:-}"
WABI_STDB_BRIDGE_TIMEOUT_MS="$(normalize_positive_int "${WABI_STDB_BRIDGE_TIMEOUT_MS:-10000}" "10000" "100" "300000")"
WABI_STDB_AUTH_TOKEN="${WABI_STDB_AUTH_TOKEN:-}"
WABI_STDB_ANONYMOUS="$(normalize_bool "${WABI_STDB_ANONYMOUS:-false}" "false")"
WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION="$(normalize_bool "${WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION:-false}" "false")"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_MODE" "$WABI_STDB_BRIDGE_MODE"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_SERVER" "$WABI_STDB_BRIDGE_SERVER"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_DATABASE" "$WABI_STDB_BRIDGE_DATABASE"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_REDUCER" "$WABI_STDB_BRIDGE_REDUCER"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_MAP_FILE" "$WABI_STDB_BRIDGE_MAP_FILE"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_BRIDGE_TIMEOUT_MS" "$WABI_STDB_BRIDGE_TIMEOUT_MS"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_AUTH_TOKEN" "$WABI_STDB_AUTH_TOKEN"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_ANONYMOUS" "$WABI_STDB_ANONYMOUS"
upsert_env_file_key "$ENV_FILE" "WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION" "$WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION"
if [[ "$WABI_CONFIG_HAS_WEBHOOK_MAX_BODY_BYTES" == "true" ]]; then
  WEBHOOK_MAX_BODY_BYTES="$(normalize_positive_int "${WABI_CONFIG_WEBHOOK_MAX_BODY_BYTES_VALUE:-65536}" "65536" "1024" "1048576")"
  upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_BODY_BYTES" "$WEBHOOK_MAX_BODY_BYTES"
fi
if [[ "$WABI_CONFIG_HAS_WEBHOOK_ALLOW_PRIVATE_TARGETS" == "true" ]]; then
  WEBHOOK_ALLOW_PRIVATE_TARGETS="$(normalize_bool "${WABI_CONFIG_WEBHOOK_ALLOW_PRIVATE_TARGETS_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "WEBHOOK_ALLOW_PRIVATE_TARGETS" "$WEBHOOK_ALLOW_PRIVATE_TARGETS"
fi
if [[ "$WABI_CONFIG_HAS_WEBHOOK_ALLOWED_HOSTS" == "true" ]]; then
  WEBHOOK_ALLOWED_HOSTS="${WABI_CONFIG_WEBHOOK_ALLOWED_HOSTS_VALUE:-}"
  upsert_env_file_key "$ENV_FILE" "WEBHOOK_ALLOWED_HOSTS" "$WEBHOOK_ALLOWED_HOSTS"
fi
if [[ "$WABI_CONFIG_HAS_WEBHOOK_MAX_DNS_RECORDS" == "true" ]]; then
  WEBHOOK_MAX_DNS_RECORDS="$(normalize_positive_int "${WABI_CONFIG_WEBHOOK_MAX_DNS_RECORDS_VALUE:-16}" "16" "1" "64")"
  upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_DNS_RECORDS" "$WEBHOOK_MAX_DNS_RECORDS"
fi
if [[ "$WABI_CONFIG_HAS_WEBHOOK_MAX_CONCURRENT_DELIVERIES" == "true" ]]; then
  WEBHOOK_MAX_CONCURRENT_DELIVERIES="$(normalize_positive_int "${WABI_CONFIG_WEBHOOK_MAX_CONCURRENT_DELIVERIES_VALUE:-20}" "20" "1" "100")"
  upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_CONCURRENT_DELIVERIES" "$WEBHOOK_MAX_CONCURRENT_DELIVERIES"
fi
if [[ "$WABI_CONFIG_HAS_WEBHOOK_MAX_EVENT_FANOUT" == "true" ]]; then
  WEBHOOK_MAX_EVENT_FANOUT="$(normalize_positive_int "${WABI_CONFIG_WEBHOOK_MAX_EVENT_FANOUT_VALUE:-250}" "250" "1" "5000")"
  upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_EVENT_FANOUT" "$WEBHOOK_MAX_EVENT_FANOUT"
fi
WEBHOOK_MAX_BODY_BYTES="$(normalize_positive_int "${WEBHOOK_MAX_BODY_BYTES:-65536}" "65536" "1024" "1048576")"
WEBHOOK_ALLOW_PRIVATE_TARGETS="$(normalize_bool "${WEBHOOK_ALLOW_PRIVATE_TARGETS:-false}" "false")"
WEBHOOK_ALLOWED_HOSTS="${WEBHOOK_ALLOWED_HOSTS:-}"
WEBHOOK_MAX_DNS_RECORDS="$(normalize_positive_int "${WEBHOOK_MAX_DNS_RECORDS:-16}" "16" "1" "64")"
WEBHOOK_MAX_CONCURRENT_DELIVERIES="$(normalize_positive_int "${WEBHOOK_MAX_CONCURRENT_DELIVERIES:-20}" "20" "1" "100")"
WEBHOOK_MAX_EVENT_FANOUT="$(normalize_positive_int "${WEBHOOK_MAX_EVENT_FANOUT:-250}" "250" "1" "5000")"
upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_BODY_BYTES" "$WEBHOOK_MAX_BODY_BYTES"
upsert_env_file_key "$ENV_FILE" "WEBHOOK_ALLOW_PRIVATE_TARGETS" "$WEBHOOK_ALLOW_PRIVATE_TARGETS"
upsert_env_file_key "$ENV_FILE" "WEBHOOK_ALLOWED_HOSTS" "$WEBHOOK_ALLOWED_HOSTS"
upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_DNS_RECORDS" "$WEBHOOK_MAX_DNS_RECORDS"
upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_CONCURRENT_DELIVERIES" "$WEBHOOK_MAX_CONCURRENT_DELIVERIES"
upsert_env_file_key "$ENV_FILE" "WEBHOOK_MAX_EVENT_FANOUT" "$WEBHOOK_MAX_EVENT_FANOUT"
if [[ "$WABI_CONFIG_HAS_STATE_PLANE_SCHEMA_VERSION" == "true" ]]; then
  STATE_PLANE_SCHEMA_VERSION="$(normalize_positive_int "${WABI_CONFIG_STATE_PLANE_SCHEMA_VERSION_VALUE:-1}" "1" "1" "1000")"
  upsert_env_file_key "$ENV_FILE" "STATE_PLANE_SCHEMA_VERSION" "$STATE_PLANE_SCHEMA_VERSION"
fi
if [[ "$WABI_CONFIG_HAS_STATE_PLANE_SCHEMA_AUTO_APPLY" == "true" ]]; then
  STATE_PLANE_SCHEMA_AUTO_APPLY="$(normalize_bool "${WABI_CONFIG_STATE_PLANE_SCHEMA_AUTO_APPLY_VALUE:-true}" "true")"
  upsert_env_file_key "$ENV_FILE" "STATE_PLANE_SCHEMA_AUTO_APPLY" "$STATE_PLANE_SCHEMA_AUTO_APPLY"
fi
STATE_PLANE_SCHEMA_VERSION="$(normalize_positive_int "${STATE_PLANE_SCHEMA_VERSION:-1}" "1" "1" "1000")"
STATE_PLANE_SCHEMA_AUTO_APPLY="$(normalize_bool "${STATE_PLANE_SCHEMA_AUTO_APPLY:-true}" "true")"
upsert_env_file_key "$ENV_FILE" "STATE_PLANE_SCHEMA_VERSION" "$STATE_PLANE_SCHEMA_VERSION"
upsert_env_file_key "$ENV_FILE" "STATE_PLANE_SCHEMA_AUTO_APPLY" "$STATE_PLANE_SCHEMA_AUTO_APPLY"
if [[ "$WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_ENABLED" == "true" ]]; then
  STATE_REDUCER_INGRESS_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_REDUCER_INGRESS_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_ENABLED" "$STATE_REDUCER_INGRESS_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE" == "true" ]]; then
  STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE="$(normalize_bool "${WABI_CONFIG_STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE_VALUE:-true}" "true")"
  upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE" "$STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE"
fi
if [[ "$WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_MAX_SKEW_MS" == "true" ]]; then
  STATE_REDUCER_INGRESS_MAX_SKEW_MS="$(normalize_positive_int "${WABI_CONFIG_STATE_REDUCER_INGRESS_MAX_SKEW_MS_VALUE:-300000}" "300000" "1000" "3600000")"
  upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_MAX_SKEW_MS" "$STATE_REDUCER_INGRESS_MAX_SKEW_MS"
fi
if [[ "$WABI_CONFIG_HAS_STATE_REDUCER_INGRESS_MAX_BODY_BYTES" == "true" ]]; then
  STATE_REDUCER_INGRESS_MAX_BODY_BYTES="$(normalize_positive_int "${WABI_CONFIG_STATE_REDUCER_INGRESS_MAX_BODY_BYTES_VALUE:-1048576}" "1048576" "4096" "16777216")"
  upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_MAX_BODY_BYTES" "$STATE_REDUCER_INGRESS_MAX_BODY_BYTES"
fi
STATE_REDUCER_INGRESS_ENABLED="$(normalize_bool "${STATE_REDUCER_INGRESS_ENABLED:-false}" "false")"
STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE="$(normalize_bool "${STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE:-true}" "true")"
STATE_REDUCER_INGRESS_MAX_SKEW_MS="$(normalize_positive_int "${STATE_REDUCER_INGRESS_MAX_SKEW_MS:-300000}" "300000" "1000" "3600000")"
STATE_REDUCER_INGRESS_MAX_BODY_BYTES="$(normalize_positive_int "${STATE_REDUCER_INGRESS_MAX_BODY_BYTES:-1048576}" "1048576" "4096" "16777216")"
upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_ENABLED" "$STATE_REDUCER_INGRESS_ENABLED"
upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE" "$STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE"
upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_MAX_SKEW_MS" "$STATE_REDUCER_INGRESS_MAX_SKEW_MS"
upsert_env_file_key "$ENV_FILE" "STATE_REDUCER_INGRESS_MAX_BODY_BYTES" "$STATE_REDUCER_INGRESS_MAX_BODY_BYTES"
validate_security_config

enforce_profile_lock

compose_files=("$COMPOSE_FILE")
if [[ "$WABI_RUNTIME" == "bun" ]]; then
  compose_files+=("docker-compose.bun.yml")
fi

compose=("${COMPOSE_CMD[@]}")
for file in "${compose_files[@]}"; do
  compose+=(-f "$file")
done

echo "[launch] Mode: $WABI_MODE"
echo "[launch] Runtime: $WABI_RUNTIME"
echo "[launch] Container runtime: $CONTAINER_RUNTIME_LABEL ($COMPOSE_DISPLAY)"
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

effective_tunnel_profile="$USE_TUNNEL_PROFILE"
if [[ "$effective_tunnel_profile" == "auto" ]]; then
  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    effective_tunnel_profile="true"
  else
    effective_tunnel_profile="false"
  fi
fi

if [[ "$TUNNEL_CONNECTOR" != "named" && "$TUNNEL_CONNECTOR" != "quick" ]]; then
  echo "[launch] Invalid TUNNEL_CONNECTOR: $TUNNEL_CONNECTOR (expected named|quick)" >&2
  exit 1
fi

if [[ "$effective_tunnel_profile" == "true" ]]; then
  if [[ "$TUNNEL_CONNECTOR" == "named" ]]; then
    if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
      echo "[launch] Tunnel profile enabled, but CLOUDFLARE_TUNNEL_TOKEN is empty." >&2
      echo "[launch] Set CLOUDFLARE_TUNNEL_TOKEN in .env or export it before launch." >&2
      exit 1
    fi
    echo "[launch] Updating named Cloudflare tunnel profile services..."
    "${compose[@]}" --profile tunnel --profile tunnel-named up -d --build --remove-orphans caddy-tunnel cloudflared-named
  else
    echo "[launch] Updating quick Cloudflare tunnel profile services..."
    "${compose[@]}" --profile tunnel --profile tunnel-quick up -d --build --remove-orphans caddy-tunnel cloudflared-quick
  fi
fi

if [[ "$PRUNE_DANGLING_IMAGES" == "true" ]]; then
  echo "[launch] Pruning dangling images..."
  "$CONTAINER_ENGINE" image prune -f >/dev/null
fi

if [[ "$PRUNE_STOPPED_CONTAINERS" == "true" ]]; then
  echo "[launch] Pruning stopped containers..."
  "$CONTAINER_ENGINE" container prune -f >/dev/null
fi

echo "[launch] Done."
