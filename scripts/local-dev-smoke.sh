#!/usr/bin/env bash
# Smoke-check Wabi local development servers.
#
# Usage:
#   scripts/local-dev-smoke.sh mock   # check frontend only (bun run dev:mock)
#   scripts/local-dev-smoke.sh local  # check frontend + backend (bun run dev:local)
#   scripts/local-dev-smoke.sh        # auto-detect: frontend required, backend optional

set -euo pipefail

MODE="${1:-auto}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:5173/}"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-http://127.0.0.1:3000/health}"

if [[ "$MODE" != "auto" && "$MODE" != "mock" && "$MODE" != "local" ]]; then
  echo "Usage: $0 [auto|mock|local]" >&2
  exit 2
fi

check_url() {
  local label="$1"
  local url="$2"
  local body_file
  body_file="$(mktemp)"
  local code
  code="$(curl -sS -o "$body_file" -w '%{http_code}' "$url" 2>/tmp/wabi-smoke-curl.err || true)"
  if [[ "$code" == "200" ]]; then
    echo "PASS $label HTTP 200 $url"
    rm -f "$body_file"
    return 0
  fi
  echo "FAIL $label HTTP ${code:-000} $url"
  if [[ -s /tmp/wabi-smoke-curl.err ]]; then
    sed 's/^/  curl: /' /tmp/wabi-smoke-curl.err | head -3
  fi
  if [[ -s "$body_file" ]]; then
    sed 's/^/  body: /' "$body_file" | head -5
  fi
  rm -f "$body_file"
  return 1
}

echo "Wabi local-dev smoke ($MODE)"
echo "frontend: $FRONTEND_URL"
if [[ "$MODE" != "mock" ]]; then
  echo "backend:  $BACKEND_HEALTH_URL"
fi

failed=0
check_url "frontend" "$FRONTEND_URL" || failed=1

case "$MODE" in
  mock)
    ;;
  local)
    check_url "backend" "$BACKEND_HEALTH_URL" || failed=1
    ;;
  auto)
    if check_url "backend" "$BACKEND_HEALTH_URL"; then
      true
    else
      echo "NOTE backend failed in auto mode; this is expected if you are running dev:mock."
    fi
    ;;
esac

if [[ "$failed" -eq 0 ]]; then
  echo "Smoke PASS"
else
  echo "Smoke FAIL"
fi

exit "$failed"
