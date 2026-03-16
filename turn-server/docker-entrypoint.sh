#!/bin/sh

SECRETS_FILE="${WABI_SECRETS_FILE:-/wabi-data/.wabi-auto-secrets}"

if [ -z "${TURN_SHARED_SECRET}" ] && [ -f "${SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SECRETS_FILE}"
  export TURN_SHARED_SECRET
fi

# Substitute environment variables in the config template
envsubst < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf

# Log the configuration (without sensitive data)
echo "=== Coturn Configuration Generated ==="
echo "External IP: ${TURN_EXTERNAL_IP}"
echo "Realm: ${TURN_REALM}"
if [ -n "${TURN_SHARED_SECRET}" ]; then
  echo "TURN shared secret: configured"
else
  echo "TURN shared secret: MISSING"
fi
echo "======================================"

# Start coturn with the generated configuration
exec turnserver -c /etc/coturn/turnserver.conf
