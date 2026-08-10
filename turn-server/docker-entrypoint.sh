#!/bin/sh
set -e

# Render turnserver.conf.template with env vars
envsubst '${TURN_HMAC_KEY} ${TURN_EXTERNAL_IP} ${TURN_REALM} ${WABI_AUTOGEN_PATH}' \
  < /etc/coturn/turnserver.conf.template \
  > /etc/coturn/turnserver.conf

echo "[coturn] rendered config:"
grep -E 'external-ip|realm|listening-port|relay-threads|min-port|max-port|static-auth-secret' /etc/coturn/turnserver.conf || true

exec turnserver -c /etc/coturn/turnserver.conf "$@"
