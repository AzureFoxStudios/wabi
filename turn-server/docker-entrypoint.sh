#!/bin/sh
set -e
mkdir -p /var/log/turnserver

# A TURN shared secret must be operator-generated; a known default would let
# anyone mint TURN credentials for this server.
if [ -z "${TURN_HMAC_KEY:-}" ]; then
    echo "ERROR: TURN_HMAC_KEY is not set. Generate one and put it in .env:" >&2
    echo "  openssl rand -base64 32" >&2
    exit 1
fi

# Replace ${VAR} and ${VAR:-default} placeholders with current env values.
python3 - <<'PYCODE'
import os, re, sys
path = "/etc/coturn/turnserver.conf"
tmpl = "/etc/coturn/turnserver.conf.template"

defaults = {
    "TURN_EXTERNAL_IP": "27.130.13.202",
    "TURN_REALM": "wabi.chat",
    "WABI_AUTOGEN_PATH": "/wabi-data/.wabi-autogen",
}

text = open(tmpl).read()

def repl(m):
    name = m.group(1)
    return os.environ.get(name, defaults.get(name, m.group(0) or ""))

open(path, "w").write(re.sub(r"\$\{(\w+)(?::-[^}]*)?\}", repl, text))
PYCODE

exec turnserver -c /etc/coturn/turnserver.conf "$@"
