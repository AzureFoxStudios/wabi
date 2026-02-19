#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/relay-admin.sh list
  scripts/relay-admin.sh approve <relay_id>

Required env vars:
  WABI_ORIGIN_URL=https://chat.example.com
  WABI_ADMIN_TOKEN=<Bearer JWT>
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ -z "${WABI_ORIGIN_URL:-}" || -z "${WABI_ADMIN_TOKEN:-}" ]]; then
  echo "WABI_ORIGIN_URL and WABI_ADMIN_TOKEN are required." >&2
  exit 1
fi

COMMAND="$1"

case "$COMMAND" in
  list)
    curl -fsS \
      -H "Authorization: Bearer $WABI_ADMIN_TOKEN" \
      "$WABI_ORIGIN_URL/api/relays/admin"
    ;;
  approve)
    if [[ $# -lt 2 ]]; then
      echo "Missing relay_id for approve command." >&2
      usage
      exit 1
    fi
    RELAY_ID="$2"
    curl -fsS \
      -X POST \
      -H "Authorization: Bearer $WABI_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"relay_id\": $RELAY_ID}" \
      "$WABI_ORIGIN_URL/api/relay/approve"
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    usage
    exit 1
    ;;
esac
