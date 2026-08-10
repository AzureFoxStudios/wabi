#!/bin/sh
set -e
mkdir -p /var/log/turnserver

# Replace ${VAR} and ${VAR:-default} placeholders with current env values.
python3 - <<'PYCODE'
import os, re, sys
path = "/etc/coturn/turnserver.conf"
tmpl = "/etc/coturn/turnserver.conf.template"

defaults = {
    "TURN_HMAC_KEY": "yPldCsTKER+zUkshTyD1Kf+nHza+6tGOoV+DteD083Q=",
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
