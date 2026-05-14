#!/usr/bin/env bash
set -euo pipefail

# Wabi Setup Wizard
# Generates .env and Caddyfile for a self-hosted Wabi deployment.
# Run from the wabi project root, or let the script find it.

WABI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${WABI_DIR}/scripts/lib/container-runtime.sh"

# ---------------------------------------------------------------------------
# Colors (disable when piped / non-interactive)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'  DIM=$'\033[2m'
  GREEN=$'\033[0;32m'  YELLOW=$'\033[1;33m'  RED=$'\033[0;31m'
  CYAN=$'\033[0;36m'  RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

ok()   { printf "  ${GREEN}[ok]${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}[!]${RESET}  %s\n" "$1"; }
bad()  { printf "  ${RED}[x]${RESET}  %s\n" "$1"; }
ask()  { printf "\n  ${BOLD}%s${RESET} " "$1"; }

# ---------------------------------------------------------------------------
# Sanity check: are we in a wabi project?
# ---------------------------------------------------------------------------
if [[ ! -f "${WABI_DIR}/docker-compose.yml" ]]; then
  bad "Can't find docker-compose.yml in ${WABI_DIR}"
  echo "  Run this script from the wabi project directory."
  exit 1
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo "  ${BOLD}Wabi Setup${RESET}"
echo "  Let's get your server ready to go."
echo ""

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
echo "  Checking a few things first..."
echo ""

if detect_compose_runtime; then
  ENGINE_V=$(get_container_engine_version)
  COMPOSE_V=$(get_compose_version)
  ok "${CONTAINER_RUNTIME_LABEL} installed (${ENGINE_V})"
  ok "Compose available via '${COMPOSE_DISPLAY}' (${COMPOSE_V})"
else
  bad "No supported container runtime was found"
  echo ""
  echo "  Wabi runs inside Docker or Podman containers."
  echo "  Install Docker: ${BOLD}https://docs.docker.com/engine/install/${RESET}"
  echo "  Or install Podman: ${BOLD}https://podman.io/docs/installation${RESET}"
  echo "  Then retry, or set ${BOLD}WABI_CONTAINER_RUNTIME=docker${RESET} or ${BOLD}WABI_CONTAINER_RUNTIME=podman${RESET}."
  exit 1
fi

# ---------------------------------------------------------------------------
# Question 1: Domain
# ---------------------------------------------------------------------------
ask "Do you have a domain name pointed at this server?
  ${DIM}(like chat.example.com — if you're not sure, type 'no')${RESET}
  >"
read -r DOMAIN_INPUT

USE_DOMAIN=false
DOMAIN=""
SCHEME="http"

# Normalize input
DOMAIN_INPUT=$(echo "$DOMAIN_INPUT" | tr '[:upper:]' '[:lower:]' | xargs)

if [[ -n "$DOMAIN_INPUT" && "$DOMAIN_INPUT" != "no" && "$DOMAIN_INPUT" != "n" ]]; then
  # Strip protocol if they pasted a URL
  DOMAIN_INPUT="${DOMAIN_INPUT#https://}"
  DOMAIN_INPUT="${DOMAIN_INPUT#http://}"
  DOMAIN_INPUT="${DOMAIN_INPUT%%/*}"

  # Basic format check
  if [[ "$DOMAIN_INPUT" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]]; then
    DOMAIN="$DOMAIN_INPUT"
    USE_DOMAIN=true
    SCHEME="https"
    ok "Domain: ${DOMAIN}"
  else
    warn "'${DOMAIN_INPUT}' doesn't look like a domain name."
    echo "  Continuing in IP-only mode. You can re-run this later with a domain."
  fi
fi

# ---------------------------------------------------------------------------
# Question 2: Public IP
# ---------------------------------------------------------------------------
PUBLIC_IP=""
DETECTED_IP=""

# Auto-detect
if command -v curl &>/dev/null; then
  DETECTED_IP=$(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null || true)
elif command -v wget &>/dev/null; then
  DETECTED_IP=$(wget -qO- --timeout=5 https://ifconfig.me 2>/dev/null || true)
fi

if [[ -n "$DETECTED_IP" && "$DETECTED_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ask "Your server's public IP looks like ${BOLD}${DETECTED_IP}${RESET} — is that right? [Y/n]"
  read -r IP_CONFIRM
  if [[ -z "$IP_CONFIRM" || "$IP_CONFIRM" =~ ^[Yy] ]]; then
    PUBLIC_IP="$DETECTED_IP"
  fi
fi

if [[ -z "$PUBLIC_IP" ]]; then
  ask "What's your server's public IP address?"
  read -r PUBLIC_IP
  PUBLIC_IP=$(echo "$PUBLIC_IP" | xargs)
  if [[ -z "$PUBLIC_IP" ]]; then
    bad "A public IP is required for the server to work."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Question 3: Voice / Video (TURN)
# ---------------------------------------------------------------------------
ask "Want voice and video calling?
  ${DIM}(uses a built-in TURN service for NAT traversal)${RESET}
  [Y/n] >"
read -r TURN_INPUT

ENABLE_TURN=true
if [[ "$TURN_INPUT" =~ ^[Nn] ]]; then
  ENABLE_TURN=false
fi

# ---------------------------------------------------------------------------
# Question 4: Giphy (optional)
# ---------------------------------------------------------------------------
ask "Want GIF support? Paste a free Giphy API key, or press Enter to skip.
  ${DIM}(get one at https://developers.giphy.com)${RESET}
  >"
read -r GIPHY_KEY
GIPHY_KEY=$(echo "$GIPHY_KEY" | xargs)

# ---------------------------------------------------------------------------
# Generate secrets
# ---------------------------------------------------------------------------
echo ""
echo "  Generating secrets..."

generate_secret() {
  if command -v openssl &>/dev/null; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

JWT_SECRET=$(generate_secret)
TURN_SECRET=$(generate_secret)
ok "Secrets generated"

# ---------------------------------------------------------------------------
# Compute values
# ---------------------------------------------------------------------------
if $USE_DOMAIN; then
  BASE_URL="${SCHEME}://${DOMAIN}"
  TURN_REALM="$DOMAIN"
else
  BASE_URL="http://${PUBLIC_IP}"
  TURN_REALM="$PUBLIC_IP"
fi

if $USE_DOMAIN; then
  ALLOWED_ORIGINS="${BASE_URL},${SCHEME}://www.${DOMAIN},https://tauri.localhost,tauri://localhost"
else
  ALLOWED_ORIGINS="${BASE_URL},https://tauri.localhost,tauri://localhost"
fi

# ---------------------------------------------------------------------------
# Guard against overwriting existing config
# ---------------------------------------------------------------------------
if [[ -f "${WABI_DIR}/.env" ]]; then
  echo ""
  warn "An .env file already exists."
  ask "Overwrite it? [y/N] >"
  read -r OVERWRITE_ENV
  if [[ ! "$OVERWRITE_ENV" =~ ^[Yy] ]]; then
    echo "  Keeping your existing .env."
    echo "  If you just want a new Caddyfile, copy Caddyfile.example and edit the domain."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Ensure runtime directories exist
# ---------------------------------------------------------------------------
mkdir -p "${WABI_DIR}/data" "${WABI_DIR}/uploads" "${WABI_DIR}/plugins"

# ---------------------------------------------------------------------------
# Write .env
# ---------------------------------------------------------------------------
echo ""
echo "  Writing config files..."

cat > "${WABI_DIR}/.env" <<ENVFILE
# ===========================================================================
# Wabi Server Configuration
# Generated by setup.sh on $(date -u +"%Y-%m-%d %H:%M UTC")
# ===========================================================================

# --- Public address --------------------------------------------------------
FRONTEND_URL=${BASE_URL}
PUBLIC_URL=${BASE_URL}
ALLOWED_ORIGINS=${ALLOWED_ORIGINS}

# --- TURN server (voice / video calling) ----------------------------------
TURN_EXTERNAL_IP=${PUBLIC_IP}
TURN_REALM=${TURN_REALM}
TURN_SHARED_SECRET=${TURN_SECRET}
TURN_CREDENTIAL_TTL_SECONDS=3600

# --- Media runtime ---------------------------------------------------------
MEDIA_LOCAL_ENHANCED_ENABLED=true
MEDIA_SRT_GATEWAY_ENABLED=false
MEDIA_SRT_GATEWAY_URL=
MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS=45000
MEDIA_GATEWAY_KEY=
SFU_PROVIDER=none
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# --- Backend ---------------------------------------------------------------
PORT=8080
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
DATA_DIR=/app/data
PLUGINS_DIR=/app/plugins
PLUGINS_ENABLED=false
PLUGINS_ALLOW_INSTALL=false
WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED=false
STATIC_DIR=/app/frontend/build

# --- Deployment mode/runtime -----------------------------------------------
# normal + node keeps SQLite and the default Node.js containers.
WABI_MODE=normal
WABI_RUNTIME=node
DB_MODE=sqlite
STATE_STDB_SUBSCRIPTIONS_ENABLED=false
STATE_STDB_ENFORCE_RBAC=true
STATE_OUTBOX_PATH=
STATE_OUTBOX_REDACT_SENSITIVE=true
STATE_OUTBOX_MAX_BYTES=67108864
STATE_OUTBOX_TRUNCATE_MIN_BYTES=16777216
WABI_STDB_BRIDGE_MODE=spacetime-call
WABI_STDB_BRIDGE_SERVER=local
WABI_STDB_BRIDGE_DATABASE=
WABI_STDB_BRIDGE_REDUCER=ingest_wabi_event
WABI_STDB_BRIDGE_MAP_FILE=
WABI_STDB_BRIDGE_TIMEOUT_MS=10000
WABI_STDB_AUTH_TOKEN=
WABI_STDB_ANONYMOUS=false
WABI_STDB_ALLOW_ANONYMOUS_IN_PRODUCTION=false
STATE_PLANE_SCHEMA_VERSION=1
STATE_PLANE_SCHEMA_AUTO_APPLY=true
STATE_REDUCER_INGRESS_ENABLED=false
STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true
STATE_REDUCER_INGRESS_MAX_SKEW_MS=300000
STATE_REDUCER_INGRESS_MAX_BODY_BYTES=1048576
WEBHOOK_MAX_BODY_BYTES=65536
WEBHOOK_ALLOW_PRIVATE_TARGETS=false
WEBHOOK_ALLOWED_HOSTS=
WEBHOOK_MAX_DNS_RECORDS=16
WEBHOOK_MAX_CONCURRENT_DELIVERIES=20
WEBHOOK_MAX_EVENT_FANOUT=250

# SQLite path (optional override)
# DATABASE_PATH=/app/data/chat.db

# --- OpenMoji (emoji assets, pinned version) -------------------------------
OPENMOJI_VERSION=15.1.0

# --- Frontend build args (read by docker compose at build time) ------------
VITE_SOCKET_URL=
VITE_GIPHY_API_KEY=${GIPHY_KEY}
VITE_TURN_SERVER=${PUBLIC_IP}
VITE_TURN_PORT=3478
VITE_USE_TURNS=false
VITE_ENABLE_GOOGLE_STUN=true
VITE_VIDEO_COMPRESSION_CLIENT_METRICS=false
ENVFILE

ok ".env"

# ---------------------------------------------------------------------------
# Write Caddyfile
# ---------------------------------------------------------------------------
if $USE_DOMAIN; then
  cat > "${WABI_DIR}/Caddyfile" <<CADDYFILE
${DOMAIN} {
    # API, WebSocket, uploads, and health checks -> backend
    @backend {
        path /socket.io/* /api/* /uploads/* /health /health/*
    }
    reverse_proxy @backend localhost:8080

    # Everything else -> frontend
    reverse_proxy localhost:3000
}

gateway.${DOMAIN} {
    # SRT gateway daemon endpoint
    reverse_proxy localhost:8095
}
CADDYFILE

  ok "Caddyfile (HTTPS via ${DOMAIN})"
  ok "Gateway host added (HTTPS via gateway.${DOMAIN})"
else
  cat > "${WABI_DIR}/Caddyfile" <<CADDYFILE
:80 {
    # API, WebSocket, uploads, and health checks -> backend
    @backend {
        path /socket.io/* /api/* /uploads/* /health /health/*
    }
    reverse_proxy @backend localhost:8080

    # Everything else -> frontend
    reverse_proxy localhost:3000
}

# Optional SRT gateway host (domain required for clean HTTPS):
# gateway.example.com {
#     reverse_proxy localhost:8095
# }
CADDYFILE

  ok "Caddyfile (HTTP-only - no domain)"
  warn "SRT gateway host block left as template (set a domain, then enable gateway.example.com)."
fi
# ---------------------------------------------------------------------------
# Caddy installation helper
# ---------------------------------------------------------------------------
if ! command -v caddy &>/dev/null; then
  echo ""
  warn "Caddy isn't installed yet."
  echo ""
  echo "  Caddy is the reverse proxy that puts your whole server behind one"
  echo "  address and handles SSL certificates automatically."

  OFFERED_INSTALL=false

  # Debian / Ubuntu
  if command -v apt-get &>/dev/null; then
    ask "Want me to try installing it? [Y/n] >"
    read -r DO_INSTALL
    OFFERED_INSTALL=true
    if [[ -z "$DO_INSTALL" || "$DO_INSTALL" =~ ^[Yy] ]]; then
      echo "  Installing Caddy (this may ask for your password)..."
      (
        set -e
        sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
          | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
          | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
        sudo apt-get update >/dev/null 2>&1
        sudo apt-get install -y caddy >/dev/null 2>&1
      ) && ok "Caddy installed!" || {
        bad "Automatic install didn't work."
        echo "  Install manually: ${BOLD}https://caddyserver.com/docs/install${RESET}"
      }
    fi

  # Fedora / RHEL
  elif command -v dnf &>/dev/null; then
    ask "Want me to try installing it? [Y/n] >"
    read -r DO_INSTALL
    OFFERED_INSTALL=true
    if [[ -z "$DO_INSTALL" || "$DO_INSTALL" =~ ^[Yy] ]]; then
      echo "  Installing Caddy..."
      (
        set -e
        sudo dnf install -y 'dnf-command(copr)' >/dev/null 2>&1
        sudo dnf copr enable -y @caddy/caddy >/dev/null 2>&1
        sudo dnf install -y caddy >/dev/null 2>&1
      ) && ok "Caddy installed!" || {
        bad "Automatic install didn't work."
        echo "  Install manually: ${BOLD}https://caddyserver.com/docs/install${RESET}"
      }
    fi
  fi

  if ! $OFFERED_INSTALL; then
    echo "  Install it from: ${BOLD}https://caddyserver.com/docs/install${RESET}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "  ─────────────────────────────────────────────"
echo "  ${BOLD}You're ready! Here's what to do next:${RESET}"
echo "  ─────────────────────────────────────────────"
echo ""

STEP=1

# Step: Caddy
if command -v caddy &>/dev/null; then
  echo "  ${BOLD}${STEP}.${RESET} Start the reverse proxy:"
  echo ""
  echo "     sudo cp Caddyfile /etc/caddy/Caddyfile"
  echo "     sudo systemctl reload caddy"
else
  echo "  ${BOLD}${STEP}.${RESET} Install Caddy, then load your config:"
  echo ""
  echo "     ${DIM}https://caddyserver.com/docs/install${RESET}"
  echo "     sudo cp Caddyfile /etc/caddy/Caddyfile"
  echo "     sudo systemctl reload caddy"
fi
echo ""
STEP=$((STEP + 1))

# Step: Container runtime
echo "  ${BOLD}${STEP}.${RESET} Start Wabi:"
echo ""
if $ENABLE_TURN; then
  echo "     ${COMPOSE_DISPLAY} --profile turn up -d --build"
else
  echo "     ${COMPOSE_DISPLAY} up -d --build"
fi
echo ""
echo "     ${DIM}The first build takes a few minutes — grab a drink.${RESET}"
echo ""
STEP=$((STEP + 1))

# Step: Firewall
echo "  ${BOLD}${STEP}.${RESET} Make sure these ports are open on your firewall:"
echo ""
echo "     ${BOLD}80${RESET}     HTTP  (Caddy needs this for SSL certificates)"
echo "     ${BOLD}443${RESET}    HTTPS (your server's public traffic)"
if $ENABLE_TURN; then
  echo "     ${BOLD}3478${RESET}   TURN  (voice/video relay, TCP+UDP)"
  echo "     ${BOLD}49152-65535${RESET}  media relay range (UDP)"
fi
echo ""
STEP=$((STEP + 1))

# Step: Open it
echo "  ${BOLD}${STEP}.${RESET} Open your server:"
echo ""
if $USE_DOMAIN; then
  echo "     ${BOLD}${SCHEME}://${DOMAIN}${RESET}"
else
  echo "     ${BOLD}http://${PUBLIC_IP}${RESET}"
fi
echo ""
echo "     The first account you create becomes the admin."
echo ""

# Warnings
if ! $USE_DOMAIN; then
  echo "  ─────────────────────────────────────────────"
  warn "Without a domain you won't have HTTPS."
  echo "     Voice/video and screen sharing need HTTPS to work."
  echo "     Get a domain pointed here and re-run this script when ready."
  echo ""
fi

if ! $ENABLE_TURN; then
  echo "  ─────────────────────────────────────────────"
  echo "  ${DIM}Voice/video is disabled. To enable it later, re-run this script"
  echo "  or add the TURN variables to .env and start with --profile turn.${RESET}"
  echo ""
fi

echo "  ${DIM}Relay node setup is separate from core server setup:${RESET}"
echo "  ${DIM}  ./scripts/relay-launch.sh configure${RESET}"
echo "  ${DIM}  ./scripts/relay-launch.sh up${RESET}"
echo ""
