#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/relay-admin.sh list-active
  scripts/relay-admin.sh list-all
  scripts/relay-admin.sh list-pending
  scripts/relay-admin.sh approve <relay_id>
  scripts/relay-admin.sh delete <relay_id>

Required env vars:
  WABI_ORIGIN_URL=https://chat.example.com
  WABI_ADMIN_TOKEN=<Bearer JWT>
EOF
}

require_env() {
  if [[ -z "${WABI_ORIGIN_URL:-}" || -z "${WABI_ADMIN_TOKEN:-}" ]]; then
    echo "WABI_ORIGIN_URL and WABI_ADMIN_TOKEN are required." >&2
    exit 1
  fi
}

curl_json() {
  curl -fsS \
    -H "Authorization: Bearer $WABI_ADMIN_TOKEN" \
    "$@"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

require_env

COMMAND="$1"

case "$COMMAND" in
  list-active)
    curl_json "$WABI_ORIGIN_URL/api/relays"
    ;;
  list-all)
    curl_json "$WABI_ORIGIN_URL/api/relays/admin"
    ;;
  list-pending)
    RAW="$(curl_json "$WABI_ORIGIN_URL/api/relays/admin")"
    if command -v jq >/dev/null 2>&1; then
      printf '%s\n' "$RAW" | jq '{ relays: [.relays[] | select(.approved == 0 or .status == "pending")] }'
    else
      # Fallback raw output when jq is unavailable.
      printf '%s\n' "$RAW"
    fi
    ;;
  approve)
    if [[ $# -lt 2 ]]; then
      echo "Missing relay_id for approve command." >&2
      usage
      exit 1
    fi
    RELAY_ID="$2"
    curl_json \
      -X POST \
      -H "Content-Type: application/json" \
      -d "{\"relay_id\": $RELAY_ID}" \
      "$WABI_ORIGIN_URL/api/relay/approve"
    ;;
  delete)
    if [[ $# -lt 2 ]]; then
      echo "Missing relay_id for delete command." >&2
      usage
      exit 1
    fi
    RELAY_ID="$2"
    curl_json \
      -X DELETE \
      "$WABI_ORIGIN_URL/api/relay/$RELAY_ID"
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    usage
    exit 1
    ;;
esac
