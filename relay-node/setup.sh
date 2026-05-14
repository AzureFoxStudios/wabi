#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_TEMPLATE="$ROOT_DIR/relay-node.env.example"

if [[ ! -f "$ENV_TEMPLATE" ]]; then
  echo "[setup] Missing template: $ENV_TEMPLATE" >&2
  exit 1
fi

detect_region() {
  if command -v curl >/dev/null 2>&1; then
    local country
    country="$(curl -fsS --max-time 4 https://ipapi.co/country/ 2>/dev/null || true)"
    if [[ -n "$country" ]]; then
      echo "${country,,}"
      return
    fi
  fi
  echo "unknown"
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
  else
    printf "%s=%s\n" "$key" "$value" >> "$ENV_FILE"
  fi
}

default_name="relay-$(hostname | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
default_region="$(detect_region)"

echo "Wabi Relay Setup Wizard"
echo

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  echo "[setup] Created $ENV_FILE from template."
else
  echo "[setup] Reusing existing $ENV_FILE."
fi

read -r -p "Origin URL (example: https://chat.example.com): " origin_url
origin_url="${origin_url%/}"
if [[ -z "$origin_url" ]]; then
  echo "[setup] Origin URL is required." >&2
  exit 1
fi

read -r -p "Public relay URL (must be publicly reachable): " public_url
public_url="${public_url%/}"
if [[ -z "$public_url" ]]; then
  echo "[setup] Public relay URL is required." >&2
  exit 1
fi

read -r -p "Relay name [$default_name]: " relay_name
relay_name="${relay_name:-$default_name}"

read -r -p "Relay region [$default_region]: " relay_region
relay_region="${relay_region:-$default_region}"

set_env_value "RELAY_ORIGIN_URL" "$origin_url"
set_env_value "RELAY_PUBLIC_URL" "$public_url"
set_env_value "RELAY_NAME" "$relay_name"
set_env_value "RELAY_REGION" "$relay_region"

rm -f "$ENV_FILE.bak"

echo
echo "[setup] Saved relay configuration to $ENV_FILE"
echo "[setup] Next step:"
echo "  docker compose up -d --build"
