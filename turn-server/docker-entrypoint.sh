#!/bin/sh

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
