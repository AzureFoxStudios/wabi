#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
FRONTEND_ENV_FILE="$ROOT_DIR/frontend/.env"

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    # Fallback: timestamp + pid hash-ish string
    printf '%s' "$(date +%s)-$$-wabi-secret-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo fallback)"
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-Y}"
  local reply
  if [[ "$default" == "Y" ]]; then
    read -r -p "$prompt [Y/n]: " reply
    reply="${reply:-Y}"
  else
    read -r -p "$prompt [y/N]: " reply
    reply="${reply:-N}"
  fi
  [[ "$reply" =~ ^[Yy]$ ]]
}

echo "Hey! Let's set up your Wabi server."
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but not found on PATH."
  exit 1
fi
echo "  [ok] Docker found"

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required but not available."
  exit 1
fi
echo "  [ok] Docker Compose found"
echo

read -r -p "Do you have a domain pointed at this server? (example: chat.example.com, or 'no'): " DOMAIN_INPUT
if [[ -z "${DOMAIN_INPUT:-}" || "${DOMAIN_INPUT,,}" == "no" ]]; then
  DOMAIN="localhost"
  FRONTEND_URL="http://localhost:3000"
  PUBLIC_URL="http://localhost:3000"
else
  DOMAIN="${DOMAIN_INPUT#http://}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%%/*}"
  FRONTEND_URL="https://$DOMAIN"
  PUBLIC_URL="https://$DOMAIN"
fi

PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
if [[ -n "$PUBLIC_IP" ]]; then
  echo "Detected public IP: $PUBLIC_IP"
  ask_yes_no "Does this look right?" "Y" >/dev/null || true
fi

echo
echo "Choose setup mode:"
echo "  1) Normal (Recommended) - SQLite, simplest setup"
echo "  2) Community - Postgres for larger/more active servers"
read -r -p "Pick 1 or 2: " MODE_CHOICE
MODE_CHOICE="${MODE_CHOICE:-1}"
if [[ "$MODE_CHOICE" == "2" ]]; then
  WABI_MODE="community"
  DB_MODE="postgres"
  POSTGRES_DB="wabi"
  POSTGRES_USER="wabi"
  if command -v openssl >/dev/null 2>&1; then
    POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  else
    POSTGRES_PASSWORD="$(generate_secret | tr -dc 'A-Za-z0-9' | cut -c1-48)"
  fi
  DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
else
  WABI_MODE="normal"
  DB_MODE="sqlite"
  POSTGRES_DB=""
  POSTGRES_USER=""
  POSTGRES_PASSWORD=""
  DATABASE_URL=""
fi

echo
echo "Choose backend runtime:"
echo "  1) Node (Default)"
echo "  2) Bun"
read -r -p "Pick 1 or 2: " RUNTIME_CHOICE
RUNTIME_CHOICE="${RUNTIME_CHOICE:-1}"
if [[ "$RUNTIME_CHOICE" == "2" ]]; then
  WABI_RUNTIME="bun"
else
  WABI_RUNTIME="node"
fi

if ask_yes_no "Enable TURN voice/video relay?" "Y"; then
  TURN_ENABLED="true"
else
  TURN_ENABLED="false"
fi

read -r -p "Optional Giphy API key (Enter to skip): " GIPHY_KEY

JWT_SECRET="$(generate_secret)"
TURN_SECRET="$(generate_secret)"

cat > "$ENV_FILE" <<EOF
FRONTEND_URL=$FRONTEND_URL
PUBLIC_URL=$PUBLIC_URL
NODE_ENV=production
PORT=8080

# Setup mode selected by scripts/setup.sh
WABI_MODE=$WABI_MODE
WABI_RUNTIME=$WABI_RUNTIME
DB_MODE=$DB_MODE
DATABASE_PATH=/app/data/chat.db
DATABASE_URL=$DATABASE_URL
POSTGRES_DB=$POSTGRES_DB
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

JWT_SECRET=$JWT_SECRET

DATA_DIR=/app/data
PLUGINS_DIR=/app/plugins
STATIC_DIR=/app/frontend/build

TURN_EXTERNAL_IP=${PUBLIC_IP:-127.0.0.1}
TURN_REALM=$DOMAIN
TURN_SHARED_SECRET=$TURN_SECRET
TURN_CREDENTIAL_TTL_SECONDS=3600

MEDIA_LOCAL_ENHANCED_ENABLED=true
MEDIA_SRT_GATEWAY_ENABLED=false
MEDIA_SRT_GATEWAY_URL=
MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS=45000
MEDIA_GATEWAY_KEY=

OPENMOJI_VERSION=15.1.0
EOF

cat > "$FRONTEND_ENV_FILE" <<EOF
VITE_SOCKET_URL=
VITE_GIPHY_API_KEY=$GIPHY_KEY
VITE_TURN_SERVER=${PUBLIC_IP:-127.0.0.1}
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
VITE_ENABLE_GOOGLE_STUN=true
VITE_ENABLE_RELAYS=false
EOF

echo
echo "Wrote:"
echo "  - $ENV_FILE"
echo "  - $FRONTEND_ENV_FILE"
echo
COMPOSE_CMD="docker compose -f docker-compose.yml"
if [[ "$WABI_MODE" == "community" ]]; then
  COMPOSE_CMD="$COMPOSE_CMD -f docker-compose.community.yml"
fi
if [[ "$WABI_RUNTIME" == "bun" ]]; then
  COMPOSE_CMD="$COMPOSE_CMD -f docker-compose.bun.yml"
fi
echo "Start $WABI_MODE mode with $WABI_RUNTIME runtime:"
echo "  $COMPOSE_CMD up -d --build"

if [[ "$TURN_ENABLED" == "true" ]]; then
  echo "Enable TURN profile too:"
  echo "  $COMPOSE_CMD --profile turn up -d --build coturn"
fi
