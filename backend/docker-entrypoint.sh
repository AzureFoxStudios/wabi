#!/bin/sh
set -e

# Auto-generate secrets on first run if not provided via environment.
# Persists generated values to $DATA_DIR/.wabi-auto-secrets so they
# survive container restarts.

DATA_DIR="${DATA_DIR:-/app/data}"
SECRETS_FILE="$DATA_DIR/.wabi-auto-secrets"

generate_secret() {
  head -c 32 /dev/urandom | base64 | tr -d '\n'
}

# Ensure data directory exists (should already from Dockerfile, but be safe)
mkdir -p "$DATA_DIR"

if [ -z "$JWT_SECRET" ]; then
  if [ -f "$SECRETS_FILE" ]; then
    # Re-use previously generated secrets
    . "$SECRETS_FILE"
    export JWT_SECRET TURN_SHARED_SECRET
  else
    # First run — generate and persist
    JWT_SECRET="$(generate_secret)"
    TURN_SHARED_SECRET="$(generate_secret)"
    cat > "$SECRETS_FILE" <<EOF
JWT_SECRET="$JWT_SECRET"
TURN_SHARED_SECRET="$TURN_SHARED_SECRET"
EOF
    chmod 600 "$SECRETS_FILE"
    export JWT_SECRET TURN_SHARED_SECRET
    echo "[entrypoint] Generated secrets and saved to $SECRETS_FILE"
  fi
else
  echo "[entrypoint] Using provided JWT_SECRET from environment"
fi

# If TURN_SHARED_SECRET is still empty but JWT_SECRET was provided,
# generate TURN secret separately
if [ -z "$TURN_SHARED_SECRET" ]; then
  if [ -f "$SECRETS_FILE" ] && grep -q TURN_SHARED_SECRET "$SECRETS_FILE"; then
    . "$SECRETS_FILE"
    export TURN_SHARED_SECRET
  else
    TURN_SHARED_SECRET="$(generate_secret)"
    export TURN_SHARED_SECRET
    echo "[entrypoint] Generated TURN_SHARED_SECRET"
  fi
fi

exec node dist/server.js "$@"
