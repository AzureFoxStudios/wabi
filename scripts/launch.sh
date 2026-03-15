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
WABI_CONFIG_HAS_STATE_BACKEND_MODE=false
WABI_CONFIG_STATE_BACKEND_MODE_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_READ_ENABLED=false
WABI_CONFIG_STATE_STDB_READ_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_MESSAGE_READ_CANARY_PERCENT=false
WABI_CONFIG_STATE_STDB_MESSAGE_READ_CANARY_PERCENT_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_CHANNEL_READ_CANARY_PERCENT=false
WABI_CONFIG_STATE_STDB_CHANNEL_READ_CANARY_PERCENT_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=false
WABI_CONFIG_STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_USER_READ_CANARY_PERCENT=false
WABI_CONFIG_STATE_STDB_USER_READ_CANARY_PERCENT_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_SESSION_READ_CANARY_PERCENT=false
WABI_CONFIG_STATE_STDB_SESSION_READ_CANARY_PERCENT_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_RBAC_READ_CANARY_PERCENT=false
WABI_CONFIG_STATE_STDB_RBAC_READ_CANARY_PERCENT_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_WARMUP_ENABLED=false
WABI_CONFIG_STATE_SHADOW_WARMUP_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_WARMUP_LIMIT=false
WABI_CONFIG_STATE_SHADOW_WARMUP_LIMIT_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_WRITE_ENABLED=false
WABI_CONFIG_STATE_STDB_WRITE_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_SUBSCRIPTIONS_ENABLED=false
WABI_CONFIG_STATE_STDB_SUBSCRIPTIONS_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_STDB_ENFORCE_RBAC=false
WABI_CONFIG_STATE_STDB_ENFORCE_RBAC_VALUE=""
WABI_CONFIG_HAS_STATE_BACKEND_STRICT=false
WABI_CONFIG_STATE_BACKEND_STRICT_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_PATH=false
WABI_CONFIG_STATE_OUTBOX_PATH_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_REDACT_SENSITIVE=false
WABI_CONFIG_STATE_OUTBOX_REDACT_SENSITIVE_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_MAX_BYTES=false
WABI_CONFIG_STATE_OUTBOX_MAX_BYTES_VALUE=""
WABI_CONFIG_HAS_STATE_OUTBOX_TRUNCATE_MIN_BYTES=false
WABI_CONFIG_STATE_OUTBOX_TRUNCATE_MIN_BYTES_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_WRITER_ENABLED=false
WABI_CONFIG_STATE_SHADOW_WRITER_ENABLED_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_SINK=false
WABI_CONFIG_STATE_SHADOW_SINK_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_ENDPOINT=false
WABI_CONFIG_STATE_SHADOW_ENDPOINT_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_TOKEN=false
WABI_CONFIG_STATE_SHADOW_TOKEN_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_SIGNING_SECRET=false
WABI_CONFIG_STATE_SHADOW_SIGNING_SECRET_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_SIGNING_KEY_ID=false
WABI_CONFIG_STATE_SHADOW_SIGNING_KEY_ID_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_COMMAND=false
WABI_CONFIG_STATE_SHADOW_COMMAND_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_COMMAND_TIMEOUT_MS=false
WABI_CONFIG_STATE_SHADOW_COMMAND_TIMEOUT_MS_VALUE=""
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
WABI_CONFIG_HAS_STATE_SHADOW_POLL_INTERVAL_MS=false
WABI_CONFIG_STATE_SHADOW_POLL_INTERVAL_MS_VALUE=""
WABI_CONFIG_HAS_STATE_SHADOW_BATCH_SIZE=false
WABI_CONFIG_STATE_SHADOW_BATCH_SIZE_VALUE=""
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
  --mode <normal|community>   Override WABI_MODE.
  --runtime <node|bun>        Override WABI_RUNTIME.
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
  WABI_MODE=normal|community           (default: normal)
  WABI_RUNTIME=node|bun                (default: node)
  WABI_DOMAIN=<domain|localhost|no>    (default: localhost)
  TURN_EXTERNAL_IP=<ip>                (default: auto-detect or 127.0.0.1)
  GIPHY_KEY=<key>                      (default: empty)
  WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED=true|false (default: false)
  VITE_VIDEO_COMPRESSION_CLIENT_METRICS=true|false         (default: false)
  STATE_BACKEND_MODE=legacy|dual_write|stdb_primary        (default: legacy)
  STATE_STDB_READ_ENABLED=true|false                       (default: false)
  STATE_STDB_MESSAGE_READ_CANARY_PERCENT=<0-100>           (default: 10, state-plane read canary)
  STATE_STDB_CHANNEL_READ_CANARY_PERCENT=<0-100>           (default: message canary percent)
  STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=<0-100>    (default: message canary percent)
  STATE_STDB_USER_READ_CANARY_PERCENT=<0-100>              (default: message canary percent)
  STATE_STDB_SESSION_READ_CANARY_PERCENT=<0-100>           (default: message canary percent)
  STATE_STDB_RBAC_READ_CANARY_PERCENT=<0-100>              (default: message canary percent)
  STATE_SHADOW_WARMUP_ENABLED=true|false                   (default: true)
  STATE_SHADOW_WARMUP_LIMIT=<100-500000>                   (default: 25000, per-store cap)
  STATE_STDB_WRITE_ENABLED=true|false                      (default: false)
  STATE_STDB_SUBSCRIPTIONS_ENABLED=true|false              (default: false)
  STATE_STDB_ENFORCE_RBAC=true|false                       (default: true)
  STATE_BACKEND_STRICT=true|false                          (default: false)
  STATE_OUTBOX_PATH=<path>                                 (default: /app/data/state-plane-outbox.ndjson)
  STATE_OUTBOX_REDACT_SENSITIVE=true|false                 (default: true)
  STATE_OUTBOX_MAX_BYTES=<1048576-1073741824>             (default: 67108864)
  STATE_OUTBOX_TRUNCATE_MIN_BYTES=<1048576-STATE_OUTBOX_MAX_BYTES> (default: 16777216)
  STATE_SHADOW_WRITER_ENABLED=true|false                   (default: false, auto true when dual_write + stdb_write)
  STATE_SHADOW_SINK=mirror|http|command                    (default: mirror)
  STATE_SHADOW_ENDPOINT=<url>                              (default: empty)
  STATE_SHADOW_TOKEN=<token>                               (default: empty)
  STATE_SHADOW_SIGNING_SECRET=<secret>                     (default: empty, enables HMAC headers when set)
  STATE_SHADOW_SIGNING_KEY_ID=<key-id>                     (default: empty)
  STATE_SHADOW_COMMAND=<shell command>                     (default: empty)
  STATE_SHADOW_COMMAND_TIMEOUT_MS=<100-300000>             (default: 10000)
  STATE_PLANE_SCHEMA_VERSION=<1-1000>                      (default: 1)
  STATE_PLANE_SCHEMA_AUTO_APPLY=true|false                 (default: true)
  STATE_REDUCER_INGRESS_ENABLED=true|false                 (default: false)
  STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true|false       (default: true)
  STATE_REDUCER_INGRESS_MAX_SKEW_MS=<1000-3600000>         (default: 300000)
  STATE_REDUCER_INGRESS_MAX_BODY_BYTES=<4096-16777216>     (default: 1048576)
  STATE_SHADOW_POLL_INTERVAL_MS=<250-60000>                (default: 1000)
  STATE_SHADOW_BATCH_SIZE=<1-5000>                         (default: 250)
  WABI_STDB_BRIDGE_MODE=spacetime-call|stdout|file         (default: spacetime-call)
  WABI_STDB_BRIDGE_SERVER=<name|url>                       (default: local)
  WABI_STDB_BRIDGE_DATABASE=<database>                     (default: empty)
  WABI_STDB_BRIDGE_REDUCER=<reducer>                       (default: ingest_wabi_event)
  WABI_STDB_BRIDGE_MAP_FILE=<path>                         (default: empty)
  WABI_STDB_BRIDGE_TIMEOUT_MS=<100-300000>                 (default: 10000)
  WABI_STDB_AUTH_TOKEN=<token>                             (default: empty; uses anonymous when unset)
  WABI_STDB_ANONYMOUS=true|false                           (default: false)
  WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=true|false       (default: false)
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
      STATE_BACKEND_MODE)
        case "${value,,}" in
          legacy|dual_write|dual-write|dual|stdb_primary|stdb-primary|stdb)
            WABI_CONFIG_HAS_STATE_BACKEND_MODE=true
            case "${value,,}" in
              dual-write|dual) WABI_CONFIG_STATE_BACKEND_MODE_VALUE="dual_write" ;;
              stdb-primary|stdb) WABI_CONFIG_STATE_BACKEND_MODE_VALUE="stdb_primary" ;;
              *) WABI_CONFIG_STATE_BACKEND_MODE_VALUE="${value,,}" ;;
            esac
            ;;
        esac
        ;;
      STATE_STDB_READ_ENABLED)
        WABI_CONFIG_HAS_STATE_STDB_READ_ENABLED=true
        WABI_CONFIG_STATE_STDB_READ_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_STDB_MESSAGE_READ_CANARY_PERCENT)
        WABI_CONFIG_HAS_STATE_STDB_MESSAGE_READ_CANARY_PERCENT=true
        WABI_CONFIG_STATE_STDB_MESSAGE_READ_CANARY_PERCENT_VALUE="$(normalize_positive_int "$value" "10" "0" "100")"
        ;;
      STATE_STDB_CHANNEL_READ_CANARY_PERCENT)
        WABI_CONFIG_HAS_STATE_STDB_CHANNEL_READ_CANARY_PERCENT=true
        WABI_CONFIG_STATE_STDB_CHANNEL_READ_CANARY_PERCENT_VALUE="$(normalize_positive_int "$value" "10" "0" "100")"
        ;;
      STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT)
        WABI_CONFIG_HAS_STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=true
        WABI_CONFIG_STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT_VALUE="$(normalize_positive_int "$value" "10" "0" "100")"
        ;;
      STATE_STDB_USER_READ_CANARY_PERCENT)
        WABI_CONFIG_HAS_STATE_STDB_USER_READ_CANARY_PERCENT=true
        WABI_CONFIG_STATE_STDB_USER_READ_CANARY_PERCENT_VALUE="$(normalize_positive_int "$value" "10" "0" "100")"
        ;;
      STATE_STDB_SESSION_READ_CANARY_PERCENT)
        WABI_CONFIG_HAS_STATE_STDB_SESSION_READ_CANARY_PERCENT=true
        WABI_CONFIG_STATE_STDB_SESSION_READ_CANARY_PERCENT_VALUE="$(normalize_positive_int "$value" "10" "0" "100")"
        ;;
      STATE_STDB_RBAC_READ_CANARY_PERCENT)
        WABI_CONFIG_HAS_STATE_STDB_RBAC_READ_CANARY_PERCENT=true
        WABI_CONFIG_STATE_STDB_RBAC_READ_CANARY_PERCENT_VALUE="$(normalize_positive_int "$value" "10" "0" "100")"
        ;;
      STATE_SHADOW_WARMUP_ENABLED)
        WABI_CONFIG_HAS_STATE_SHADOW_WARMUP_ENABLED=true
        WABI_CONFIG_STATE_SHADOW_WARMUP_ENABLED_VALUE="$(normalize_bool "$value" "true")"
        ;;
      STATE_SHADOW_WARMUP_LIMIT)
        WABI_CONFIG_HAS_STATE_SHADOW_WARMUP_LIMIT=true
        WABI_CONFIG_STATE_SHADOW_WARMUP_LIMIT_VALUE="$(normalize_positive_int "$value" "25000" "100" "500000")"
        ;;
      STATE_STDB_WRITE_ENABLED)
        WABI_CONFIG_HAS_STATE_STDB_WRITE_ENABLED=true
        WABI_CONFIG_STATE_STDB_WRITE_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_STDB_SUBSCRIPTIONS_ENABLED)
        WABI_CONFIG_HAS_STATE_STDB_SUBSCRIPTIONS_ENABLED=true
        WABI_CONFIG_STATE_STDB_SUBSCRIPTIONS_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_STDB_ENFORCE_RBAC)
        WABI_CONFIG_HAS_STATE_STDB_ENFORCE_RBAC=true
        WABI_CONFIG_STATE_STDB_ENFORCE_RBAC_VALUE="$(normalize_bool "$value" "true")"
        ;;
      STATE_BACKEND_STRICT)
        WABI_CONFIG_HAS_STATE_BACKEND_STRICT=true
        WABI_CONFIG_STATE_BACKEND_STRICT_VALUE="$(normalize_bool "$value" "false")"
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
      STATE_SHADOW_WRITER_ENABLED)
        WABI_CONFIG_HAS_STATE_SHADOW_WRITER_ENABLED=true
        WABI_CONFIG_STATE_SHADOW_WRITER_ENABLED_VALUE="$(normalize_bool "$value" "false")"
        ;;
      STATE_SHADOW_SINK)
        case "${value,,}" in
          mirror|http|command)
            WABI_CONFIG_HAS_STATE_SHADOW_SINK=true
            WABI_CONFIG_STATE_SHADOW_SINK_VALUE="${value,,}"
            ;;
        esac
        ;;
      STATE_SHADOW_ENDPOINT)
        WABI_CONFIG_HAS_STATE_SHADOW_ENDPOINT=true
        WABI_CONFIG_STATE_SHADOW_ENDPOINT_VALUE="$value"
        ;;
      STATE_SHADOW_TOKEN)
        WABI_CONFIG_HAS_STATE_SHADOW_TOKEN=true
        WABI_CONFIG_STATE_SHADOW_TOKEN_VALUE="$value"
        ;;
      STATE_SHADOW_SIGNING_SECRET)
        WABI_CONFIG_HAS_STATE_SHADOW_SIGNING_SECRET=true
        WABI_CONFIG_STATE_SHADOW_SIGNING_SECRET_VALUE="$value"
        ;;
      STATE_SHADOW_SIGNING_KEY_ID)
        WABI_CONFIG_HAS_STATE_SHADOW_SIGNING_KEY_ID=true
        WABI_CONFIG_STATE_SHADOW_SIGNING_KEY_ID_VALUE="$value"
        ;;
      STATE_SHADOW_COMMAND)
        WABI_CONFIG_HAS_STATE_SHADOW_COMMAND=true
        WABI_CONFIG_STATE_SHADOW_COMMAND_VALUE="$value"
        ;;
      STATE_SHADOW_COMMAND_TIMEOUT_MS)
        WABI_CONFIG_HAS_STATE_SHADOW_COMMAND_TIMEOUT_MS=true
        WABI_CONFIG_STATE_SHADOW_COMMAND_TIMEOUT_MS_VALUE="$(normalize_positive_int "$value" "10000" "100" "300000")"
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
      STATE_SHADOW_POLL_INTERVAL_MS)
        WABI_CONFIG_HAS_STATE_SHADOW_POLL_INTERVAL_MS=true
        WABI_CONFIG_STATE_SHADOW_POLL_INTERVAL_MS_VALUE="$(normalize_positive_int "$value" "1000" "250" "60000")"
        ;;
      STATE_SHADOW_BATCH_SIZE)
        WABI_CONFIG_HAS_STATE_SHADOW_BATCH_SIZE=true
        WABI_CONFIG_STATE_SHADOW_BATCH_SIZE_VALUE="$(normalize_positive_int "$value" "250" "1" "5000")"
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
  local state_backend_mode state_stdb_read_enabled state_stdb_message_read_canary_percent state_stdb_channel_read_canary_percent
  local state_stdb_channel_member_read_canary_percent state_stdb_user_read_canary_percent state_stdb_session_read_canary_percent
  local state_stdb_rbac_read_canary_percent state_shadow_warmup_enabled state_shadow_warmup_limit state_stdb_write_enabled
  local state_stdb_subscriptions_enabled state_stdb_enforce_rbac state_backend_strict
  local state_outbox_path state_outbox_redact_sensitive state_outbox_max_bytes state_outbox_truncate_min_bytes state_shadow_writer_enabled state_shadow_sink
  local state_shadow_endpoint state_shadow_token state_shadow_signing_secret state_shadow_signing_key_id state_shadow_command state_shadow_command_timeout_ms
  local state_plane_schema_version state_plane_schema_auto_apply
  local state_reducer_ingress_enabled state_reducer_ingress_require_signature state_reducer_ingress_max_skew_ms state_reducer_ingress_max_body_bytes
  local state_shadow_poll_interval_ms state_shadow_batch_size
  local wabi_stdb_bridge_mode wabi_stdb_bridge_server wabi_stdb_bridge_database wabi_stdb_bridge_reducer wabi_stdb_bridge_map_file wabi_stdb_bridge_timeout_ms wabi_stdb_auth_token wabi_stdb_anonymous wabi_stdb_allow_anonymous_in_production
  local webhook_max_body_bytes webhook_allow_private_targets webhook_allowed_hosts webhook_max_dns_records
  local webhook_max_concurrent_deliveries webhook_max_event_fanout
  local video_compression_metrics
  local livekit_url livekit_api_key livekit_api_secret

  domain="$(normalize_domain "${WABI_DOMAIN:-localhost}")"
  mode="${WABI_MODE:-normal}"
  runtime="${WABI_RUNTIME:-node}"
  giphy_key="${GIPHY_KEY:-${VITE_GIPHY_API_KEY:-}}"
  video_compression_metrics="$(normalize_bool "${WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED:-${VITE_VIDEO_COMPRESSION_CLIENT_METRICS:-false}}" "false")"
  plugins_enabled="$(normalize_bool "${PLUGINS_ENABLED:-false}" "false")"
  plugins_allow_install="$(normalize_bool "${PLUGINS_ALLOW_INSTALL:-false}" "false")"
  state_backend_mode="${STATE_BACKEND_MODE:-legacy}"
  state_stdb_read_enabled="$(normalize_bool "${STATE_STDB_READ_ENABLED:-false}" "false")"
  state_stdb_message_read_canary_percent="$(normalize_positive_int "${STATE_STDB_MESSAGE_READ_CANARY_PERCENT:-10}" "10" "0" "100")"
  state_stdb_channel_read_canary_percent="$(normalize_positive_int "${STATE_STDB_CHANNEL_READ_CANARY_PERCENT:-$state_stdb_message_read_canary_percent}" "$state_stdb_message_read_canary_percent" "0" "100")"
  state_stdb_channel_member_read_canary_percent="$(normalize_positive_int "${STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT:-$state_stdb_message_read_canary_percent}" "$state_stdb_message_read_canary_percent" "0" "100")"
  state_stdb_user_read_canary_percent="$(normalize_positive_int "${STATE_STDB_USER_READ_CANARY_PERCENT:-$state_stdb_message_read_canary_percent}" "$state_stdb_message_read_canary_percent" "0" "100")"
  state_stdb_session_read_canary_percent="$(normalize_positive_int "${STATE_STDB_SESSION_READ_CANARY_PERCENT:-$state_stdb_message_read_canary_percent}" "$state_stdb_message_read_canary_percent" "0" "100")"
  state_stdb_rbac_read_canary_percent="$(normalize_positive_int "${STATE_STDB_RBAC_READ_CANARY_PERCENT:-$state_stdb_message_read_canary_percent}" "$state_stdb_message_read_canary_percent" "0" "100")"
  state_shadow_warmup_enabled="$(normalize_bool "${STATE_SHADOW_WARMUP_ENABLED:-true}" "true")"
  state_shadow_warmup_limit="$(normalize_positive_int "${STATE_SHADOW_WARMUP_LIMIT:-25000}" "25000" "100" "500000")"
  state_stdb_write_enabled="$(normalize_bool "${STATE_STDB_WRITE_ENABLED:-false}" "false")"
  state_stdb_subscriptions_enabled="$(normalize_bool "${STATE_STDB_SUBSCRIPTIONS_ENABLED:-false}" "false")"
  state_stdb_enforce_rbac="$(normalize_bool "${STATE_STDB_ENFORCE_RBAC:-true}" "true")"
  state_backend_strict="$(normalize_bool "${STATE_BACKEND_STRICT:-false}" "false")"
  state_outbox_path="${STATE_OUTBOX_PATH:-}"
  state_outbox_redact_sensitive="$(normalize_bool "${STATE_OUTBOX_REDACT_SENSITIVE:-true}" "true")"
  state_outbox_max_bytes="$(normalize_positive_int "${STATE_OUTBOX_MAX_BYTES:-67108864}" "67108864" "1048576" "1073741824")"
  state_outbox_truncate_min_bytes="$(normalize_positive_int "${STATE_OUTBOX_TRUNCATE_MIN_BYTES:-16777216}" "16777216" "1048576" "$state_outbox_max_bytes")"
  state_shadow_sink="${STATE_SHADOW_SINK:-mirror}"
  case "${state_shadow_sink,,}" in
    mirror|http|command)
      state_shadow_sink="${state_shadow_sink,,}"
      ;;
    *)
      state_shadow_sink="mirror"
      ;;
  esac
  if [[ -n "${STATE_SHADOW_WRITER_ENABLED:-}" ]]; then
    state_shadow_writer_enabled="$(normalize_bool "${STATE_SHADOW_WRITER_ENABLED}" "false")"
  else
    state_shadow_writer_enabled=""
  fi
  state_shadow_endpoint="${STATE_SHADOW_ENDPOINT:-}"
  state_shadow_token="${STATE_SHADOW_TOKEN:-}"
  state_shadow_signing_secret="${STATE_SHADOW_SIGNING_SECRET:-}"
  state_shadow_signing_key_id="${STATE_SHADOW_SIGNING_KEY_ID:-}"
  state_shadow_command="${STATE_SHADOW_COMMAND:-}"
  state_shadow_command_timeout_ms="$(normalize_positive_int "${STATE_SHADOW_COMMAND_TIMEOUT_MS:-10000}" "10000" "100" "300000")"
  state_plane_schema_version="$(normalize_positive_int "${STATE_PLANE_SCHEMA_VERSION:-1}" "1" "1" "1000")"
  state_plane_schema_auto_apply="$(normalize_bool "${STATE_PLANE_SCHEMA_AUTO_APPLY:-true}" "true")"
  state_reducer_ingress_enabled="$(normalize_bool "${STATE_REDUCER_INGRESS_ENABLED:-false}" "false")"
  state_reducer_ingress_require_signature="$(normalize_bool "${STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE:-true}" "true")"
  state_reducer_ingress_max_skew_ms="$(normalize_positive_int "${STATE_REDUCER_INGRESS_MAX_SKEW_MS:-300000}" "300000" "1000" "3600000")"
  state_reducer_ingress_max_body_bytes="$(normalize_positive_int "${STATE_REDUCER_INGRESS_MAX_BODY_BYTES:-1048576}" "1048576" "4096" "16777216")"
  state_shadow_poll_interval_ms="$(normalize_positive_int "${STATE_SHADOW_POLL_INTERVAL_MS:-1000}" "1000" "250" "60000")"
  state_shadow_batch_size="$(normalize_positive_int "${STATE_SHADOW_BATCH_SIZE:-250}" "250" "1" "5000")"
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

  db_mode="sqlite"

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
STATE_BACKEND_MODE=$state_backend_mode
STATE_STDB_READ_ENABLED=$state_stdb_read_enabled
STATE_STDB_MESSAGE_READ_CANARY_PERCENT=$state_stdb_message_read_canary_percent
STATE_STDB_CHANNEL_READ_CANARY_PERCENT=$state_stdb_channel_read_canary_percent
STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=$state_stdb_channel_member_read_canary_percent
STATE_STDB_USER_READ_CANARY_PERCENT=$state_stdb_user_read_canary_percent
STATE_STDB_SESSION_READ_CANARY_PERCENT=$state_stdb_session_read_canary_percent
STATE_STDB_RBAC_READ_CANARY_PERCENT=$state_stdb_rbac_read_canary_percent
STATE_SHADOW_WARMUP_ENABLED=$state_shadow_warmup_enabled
STATE_SHADOW_WARMUP_LIMIT=$state_shadow_warmup_limit
STATE_STDB_WRITE_ENABLED=$state_stdb_write_enabled
STATE_STDB_SUBSCRIPTIONS_ENABLED=$state_stdb_subscriptions_enabled
STATE_STDB_ENFORCE_RBAC=$state_stdb_enforce_rbac
STATE_BACKEND_STRICT=$state_backend_strict
STATE_OUTBOX_PATH=$state_outbox_path
STATE_OUTBOX_REDACT_SENSITIVE=$state_outbox_redact_sensitive
STATE_OUTBOX_MAX_BYTES=$state_outbox_max_bytes
STATE_OUTBOX_TRUNCATE_MIN_BYTES=$state_outbox_truncate_min_bytes
STATE_SHADOW_WRITER_ENABLED=$state_shadow_writer_enabled
STATE_SHADOW_SINK=$state_shadow_sink
STATE_SHADOW_ENDPOINT=$state_shadow_endpoint
STATE_SHADOW_TOKEN=$state_shadow_token
STATE_SHADOW_SIGNING_SECRET=$state_shadow_signing_secret
STATE_SHADOW_SIGNING_KEY_ID=$state_shadow_signing_key_id
STATE_SHADOW_COMMAND=$state_shadow_command
STATE_SHADOW_COMMAND_TIMEOUT_MS=$state_shadow_command_timeout_ms
STATE_PLANE_SCHEMA_VERSION=$state_plane_schema_version
STATE_PLANE_SCHEMA_AUTO_APPLY=$state_plane_schema_auto_apply
STATE_REDUCER_INGRESS_ENABLED=$state_reducer_ingress_enabled
STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=$state_reducer_ingress_require_signature
STATE_REDUCER_INGRESS_MAX_SKEW_MS=$state_reducer_ingress_max_skew_ms
STATE_REDUCER_INGRESS_MAX_BODY_BYTES=$state_reducer_ingress_max_body_bytes
STATE_SHADOW_POLL_INTERVAL_MS=$state_shadow_poll_interval_ms
STATE_SHADOW_BATCH_SIZE=$state_shadow_batch_size
WABI_STDB_BRIDGE_MODE=$wabi_stdb_bridge_mode
WABI_STDB_BRIDGE_SERVER=$wabi_stdb_bridge_server
WABI_STDB_BRIDGE_DATABASE=$wabi_stdb_bridge_database
WABI_STDB_BRIDGE_REDUCER=$wabi_stdb_bridge_reducer
WABI_STDB_BRIDGE_MAP_FILE=$wabi_stdb_bridge_map_file
WABI_STDB_BRIDGE_TIMEOUT_MS=$wabi_stdb_bridge_timeout_ms
WABI_STDB_AUTH_TOKEN=$wabi_stdb_auth_token
WABI_STDB_ANONYMOUS=$wabi_stdb_anonymous
WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=$wabi_stdb_allow_anonymous_in_production
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
CLOUDFLARE_TUNNEL_TOKEN=
TUNNEL_CONNECTOR=named

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
  if [[ "${STATE_BACKEND_MODE:-legacy}" == "stdb_primary" || "${STATE_STDB_WRITE_ENABLED:-false}" == "true" || "${STATE_STDB_READ_ENABLED:-false}" == "true" ]]; then
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

if [[ "$WABI_CONFIG_HAS_STATE_BACKEND_MODE" == "true" ]]; then
  STATE_BACKEND_MODE="$WABI_CONFIG_STATE_BACKEND_MODE_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_BACKEND_MODE" "$STATE_BACKEND_MODE"
  echo "[launch] Applied STATE_BACKEND_MODE from wabi.config (backend=$STATE_BACKEND_MODE)."
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_READ_ENABLED" == "true" ]]; then
  STATE_STDB_READ_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_STDB_READ_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_READ_ENABLED" "$STATE_STDB_READ_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_MESSAGE_READ_CANARY_PERCENT" == "true" ]]; then
  STATE_STDB_MESSAGE_READ_CANARY_PERCENT="$(normalize_positive_int "${WABI_CONFIG_STATE_STDB_MESSAGE_READ_CANARY_PERCENT_VALUE:-10}" "10" "0" "100")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_CHANNEL_READ_CANARY_PERCENT" == "true" ]]; then
  STATE_STDB_CHANNEL_READ_CANARY_PERCENT="$(normalize_positive_int "${WABI_CONFIG_STATE_STDB_CHANNEL_READ_CANARY_PERCENT_VALUE:-10}" "10" "0" "100")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_CHANNEL_READ_CANARY_PERCENT" "$STATE_STDB_CHANNEL_READ_CANARY_PERCENT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT" == "true" ]]; then
  STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT="$(normalize_positive_int "${WABI_CONFIG_STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT_VALUE:-10}" "10" "0" "100")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT" "$STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_USER_READ_CANARY_PERCENT" == "true" ]]; then
  STATE_STDB_USER_READ_CANARY_PERCENT="$(normalize_positive_int "${WABI_CONFIG_STATE_STDB_USER_READ_CANARY_PERCENT_VALUE:-10}" "10" "0" "100")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_USER_READ_CANARY_PERCENT" "$STATE_STDB_USER_READ_CANARY_PERCENT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_SESSION_READ_CANARY_PERCENT" == "true" ]]; then
  STATE_STDB_SESSION_READ_CANARY_PERCENT="$(normalize_positive_int "${WABI_CONFIG_STATE_STDB_SESSION_READ_CANARY_PERCENT_VALUE:-10}" "10" "0" "100")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_SESSION_READ_CANARY_PERCENT" "$STATE_STDB_SESSION_READ_CANARY_PERCENT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_RBAC_READ_CANARY_PERCENT" == "true" ]]; then
  STATE_STDB_RBAC_READ_CANARY_PERCENT="$(normalize_positive_int "${WABI_CONFIG_STATE_STDB_RBAC_READ_CANARY_PERCENT_VALUE:-10}" "10" "0" "100")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_RBAC_READ_CANARY_PERCENT" "$STATE_STDB_RBAC_READ_CANARY_PERCENT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_WARMUP_ENABLED" == "true" ]]; then
  STATE_SHADOW_WARMUP_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_SHADOW_WARMUP_ENABLED_VALUE:-true}" "true")"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_WARMUP_ENABLED" "$STATE_SHADOW_WARMUP_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_WARMUP_LIMIT" == "true" ]]; then
  STATE_SHADOW_WARMUP_LIMIT="$(normalize_positive_int "${WABI_CONFIG_STATE_SHADOW_WARMUP_LIMIT_VALUE:-25000}" "25000" "100" "500000")"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_WARMUP_LIMIT" "$STATE_SHADOW_WARMUP_LIMIT"
fi

STATE_STDB_MESSAGE_READ_CANARY_PERCENT="$(normalize_positive_int "${STATE_STDB_MESSAGE_READ_CANARY_PERCENT:-10}" "10" "0" "100")"
STATE_STDB_CHANNEL_READ_CANARY_PERCENT="$(normalize_positive_int "${STATE_STDB_CHANNEL_READ_CANARY_PERCENT:-$STATE_STDB_MESSAGE_READ_CANARY_PERCENT}" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "0" "100")"
STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT="$(normalize_positive_int "${STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT:-$STATE_STDB_MESSAGE_READ_CANARY_PERCENT}" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "0" "100")"
STATE_STDB_USER_READ_CANARY_PERCENT="$(normalize_positive_int "${STATE_STDB_USER_READ_CANARY_PERCENT:-$STATE_STDB_MESSAGE_READ_CANARY_PERCENT}" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "0" "100")"
STATE_STDB_SESSION_READ_CANARY_PERCENT="$(normalize_positive_int "${STATE_STDB_SESSION_READ_CANARY_PERCENT:-$STATE_STDB_MESSAGE_READ_CANARY_PERCENT}" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "0" "100")"
STATE_STDB_RBAC_READ_CANARY_PERCENT="$(normalize_positive_int "${STATE_STDB_RBAC_READ_CANARY_PERCENT:-$STATE_STDB_MESSAGE_READ_CANARY_PERCENT}" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "0" "100")"
STATE_SHADOW_WARMUP_ENABLED="$(normalize_bool "${STATE_SHADOW_WARMUP_ENABLED:-true}" "true")"
STATE_SHADOW_WARMUP_LIMIT="$(normalize_positive_int "${STATE_SHADOW_WARMUP_LIMIT:-25000}" "25000" "100" "500000")"
upsert_env_file_key "$ENV_FILE" "STATE_STDB_MESSAGE_READ_CANARY_PERCENT" "$STATE_STDB_MESSAGE_READ_CANARY_PERCENT"
upsert_env_file_key "$ENV_FILE" "STATE_STDB_CHANNEL_READ_CANARY_PERCENT" "$STATE_STDB_CHANNEL_READ_CANARY_PERCENT"
upsert_env_file_key "$ENV_FILE" "STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT" "$STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT"
upsert_env_file_key "$ENV_FILE" "STATE_STDB_USER_READ_CANARY_PERCENT" "$STATE_STDB_USER_READ_CANARY_PERCENT"
upsert_env_file_key "$ENV_FILE" "STATE_STDB_SESSION_READ_CANARY_PERCENT" "$STATE_STDB_SESSION_READ_CANARY_PERCENT"
upsert_env_file_key "$ENV_FILE" "STATE_STDB_RBAC_READ_CANARY_PERCENT" "$STATE_STDB_RBAC_READ_CANARY_PERCENT"
upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_WARMUP_ENABLED" "$STATE_SHADOW_WARMUP_ENABLED"
upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_WARMUP_LIMIT" "$STATE_SHADOW_WARMUP_LIMIT"

if [[ "$WABI_CONFIG_HAS_STATE_STDB_WRITE_ENABLED" == "true" ]]; then
  STATE_STDB_WRITE_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_STDB_WRITE_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_WRITE_ENABLED" "$STATE_STDB_WRITE_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_SUBSCRIPTIONS_ENABLED" == "true" ]]; then
  STATE_STDB_SUBSCRIPTIONS_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_STDB_SUBSCRIPTIONS_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_SUBSCRIPTIONS_ENABLED" "$STATE_STDB_SUBSCRIPTIONS_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_STDB_ENFORCE_RBAC" == "true" ]]; then
  STATE_STDB_ENFORCE_RBAC="$(normalize_bool "${WABI_CONFIG_STATE_STDB_ENFORCE_RBAC_VALUE:-true}" "true")"
  upsert_env_file_key "$ENV_FILE" "STATE_STDB_ENFORCE_RBAC" "$STATE_STDB_ENFORCE_RBAC"
fi
if [[ "$WABI_CONFIG_HAS_STATE_BACKEND_STRICT" == "true" ]]; then
  STATE_BACKEND_STRICT="$(normalize_bool "${WABI_CONFIG_STATE_BACKEND_STRICT_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_BACKEND_STRICT" "$STATE_BACKEND_STRICT"
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
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_WRITER_ENABLED" == "true" ]]; then
  STATE_SHADOW_WRITER_ENABLED="$(normalize_bool "${WABI_CONFIG_STATE_SHADOW_WRITER_ENABLED_VALUE:-false}" "false")"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_WRITER_ENABLED" "$STATE_SHADOW_WRITER_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_WRITER_ENABLED" != "true" ]]; then
  state_backend_mode_normalized="${STATE_BACKEND_MODE:-legacy}"
  case "${state_backend_mode_normalized,,}" in
    dual-write|dual) state_backend_mode_normalized="dual_write" ;;
    stdb-primary|stdb) state_backend_mode_normalized="stdb_primary" ;;
    legacy|dual_write|stdb_primary) ;;
    *) state_backend_mode_normalized="legacy" ;;
  esac
  if [[ "$state_backend_mode_normalized" == "dual_write" && "$(normalize_bool "${STATE_STDB_WRITE_ENABLED:-false}" "false")" == "true" ]]; then
    STATE_SHADOW_WRITER_ENABLED="true"
  else
    STATE_SHADOW_WRITER_ENABLED="false"
  fi
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_WRITER_ENABLED" "$STATE_SHADOW_WRITER_ENABLED"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_SINK" == "true" ]]; then
  case "${WABI_CONFIG_STATE_SHADOW_SINK_VALUE,,}" in
    mirror|http|command)
      STATE_SHADOW_SINK="${WABI_CONFIG_STATE_SHADOW_SINK_VALUE,,}"
      upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_SINK" "$STATE_SHADOW_SINK"
      ;;
  esac
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_ENDPOINT" == "true" ]]; then
  STATE_SHADOW_ENDPOINT="$WABI_CONFIG_STATE_SHADOW_ENDPOINT_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_ENDPOINT" "$STATE_SHADOW_ENDPOINT"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_TOKEN" == "true" ]]; then
  STATE_SHADOW_TOKEN="$WABI_CONFIG_STATE_SHADOW_TOKEN_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_TOKEN" "$STATE_SHADOW_TOKEN"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_SIGNING_SECRET" == "true" ]]; then
  STATE_SHADOW_SIGNING_SECRET="$WABI_CONFIG_STATE_SHADOW_SIGNING_SECRET_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_SIGNING_SECRET" "$STATE_SHADOW_SIGNING_SECRET"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_SIGNING_KEY_ID" == "true" ]]; then
  STATE_SHADOW_SIGNING_KEY_ID="$WABI_CONFIG_STATE_SHADOW_SIGNING_KEY_ID_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_SIGNING_KEY_ID" "$STATE_SHADOW_SIGNING_KEY_ID"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_COMMAND" == "true" ]]; then
  STATE_SHADOW_COMMAND="$WABI_CONFIG_STATE_SHADOW_COMMAND_VALUE"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_COMMAND" "$STATE_SHADOW_COMMAND"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_COMMAND_TIMEOUT_MS" == "true" ]]; then
  STATE_SHADOW_COMMAND_TIMEOUT_MS="$(normalize_positive_int "${WABI_CONFIG_STATE_SHADOW_COMMAND_TIMEOUT_MS_VALUE:-10000}" "10000" "100" "300000")"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_COMMAND_TIMEOUT_MS" "$STATE_SHADOW_COMMAND_TIMEOUT_MS"
fi
case "${STATE_SHADOW_SINK:-mirror}" in
  mirror|http|command) ;;
  *)
    STATE_SHADOW_SINK="mirror"
    ;;
esac
STATE_SHADOW_COMMAND_TIMEOUT_MS="$(normalize_positive_int "${STATE_SHADOW_COMMAND_TIMEOUT_MS:-10000}" "10000" "100" "300000")"
upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_SINK" "$STATE_SHADOW_SINK"
upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_COMMAND_TIMEOUT_MS" "$STATE_SHADOW_COMMAND_TIMEOUT_MS"
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
if [[ "${STATE_SHADOW_SINK:-mirror}" == "command" && -z "${STATE_SHADOW_COMMAND:-}" && -n "$WABI_STDB_BRIDGE_DATABASE" ]]; then
  generated_state_shadow_command="node scripts/state-plane-stdb-bridge.mjs --mode $WABI_STDB_BRIDGE_MODE --server $WABI_STDB_BRIDGE_SERVER --database $WABI_STDB_BRIDGE_DATABASE --reducer $WABI_STDB_BRIDGE_REDUCER --timeout-ms $WABI_STDB_BRIDGE_TIMEOUT_MS --no-config --yes"
  if [[ "${WABI_STDB_ANONYMOUS:-false}" == "true" ]]; then
    generated_state_shadow_command="$generated_state_shadow_command --anonymous"
  else
    generated_state_shadow_command="$generated_state_shadow_command --no-anonymous"
  fi
  if [[ -n "$WABI_STDB_BRIDGE_MAP_FILE" ]]; then
    generated_map_file_escaped="${WABI_STDB_BRIDGE_MAP_FILE//\"/\\\"}"
    generated_state_shadow_command="$generated_state_shadow_command --map-file \"$generated_map_file_escaped\""
  fi
  STATE_SHADOW_COMMAND="$generated_state_shadow_command"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_COMMAND" "$STATE_SHADOW_COMMAND"
  echo "[launch] Auto-generated STATE_SHADOW_COMMAND from WABI_STDB_BRIDGE_* settings."
fi
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
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_POLL_INTERVAL_MS" == "true" ]]; then
  STATE_SHADOW_POLL_INTERVAL_MS="$(normalize_positive_int "${WABI_CONFIG_STATE_SHADOW_POLL_INTERVAL_MS_VALUE:-1000}" "1000" "250" "60000")"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_POLL_INTERVAL_MS" "$STATE_SHADOW_POLL_INTERVAL_MS"
fi
if [[ "$WABI_CONFIG_HAS_STATE_SHADOW_BATCH_SIZE" == "true" ]]; then
  STATE_SHADOW_BATCH_SIZE="$(normalize_positive_int "${WABI_CONFIG_STATE_SHADOW_BATCH_SIZE_VALUE:-250}" "250" "1" "5000")"
  upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_BATCH_SIZE" "$STATE_SHADOW_BATCH_SIZE"
fi
STATE_SHADOW_POLL_INTERVAL_MS="$(normalize_positive_int "${STATE_SHADOW_POLL_INTERVAL_MS:-1000}" "1000" "250" "60000")"
STATE_SHADOW_BATCH_SIZE="$(normalize_positive_int "${STATE_SHADOW_BATCH_SIZE:-250}" "250" "1" "5000")"
upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_POLL_INTERVAL_MS" "$STATE_SHADOW_POLL_INTERVAL_MS"
upsert_env_file_key "$ENV_FILE" "STATE_SHADOW_BATCH_SIZE" "$STATE_SHADOW_BATCH_SIZE"

validate_security_config

enforce_profile_lock

compose_files=("$COMPOSE_FILE")
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
  docker image prune -f >/dev/null
fi

if [[ "$PRUNE_STOPPED_CONTAINERS" == "true" ]]; then
  echo "[launch] Pruning stopped containers..."
  docker container prune -f >/dev/null
fi

echo "[launch] Done."
