#!/bin/sh
set -e
umask 077
mkdir -p /var/log/turnserver

# A TURN shared secret must be operator-generated; a known default would let
# anyone mint TURN credentials for this server.
if [ -z "${TURN_HMAC_KEY:-}" ]; then
    echo "ERROR: TURN_HMAC_KEY is not set. Generate one and put it in .env:" >&2
    echo "  openssl rand -base64 32" >&2
    exit 1
fi

# Validate selected infrastructure before writing any generated configuration.
# In particular, never advertise a baked-in IP from an earlier deployment or
# allow an environment value to inject extra coturn directives.
python3 - /etc/coturn/turnserver.conf.template /etc/coturn/turnserver.conf <<'PYCODE'
import ipaddress, os, re, sys

def fail(message):
    raise SystemExit("ERROR: " + message)

def scalar(name, default=None):
    value = os.environ.get(name, default)
    if not value or any(ord(c) < 33 or ord(c) > 126 or c in '#\\"' for c in value):
        fail(name + " must be a nonempty scalar without whitespace or config delimiters")
    return value

external_ip = scalar("TURN_EXTERNAL_IP")
parts = external_ip.split('/')
if len(parts) not in (1, 2):
    fail("TURN_EXTERNAL_IP must be an IP address or a public/private IP pair")
try:
    addresses = [ipaddress.ip_address(part) for part in parts]
except ValueError:
    fail("TURN_EXTERNAL_IP must contain valid IP addresses")
if any(address.is_unspecified or address.is_multicast for address in addresses) or len({address.version for address in addresses}) != 1:
    fail("TURN_EXTERNAL_IP must contain usable same-family IP addresses")

values = {
    "TURN_EXTERNAL_IP": external_ip,
    "TURN_REALM": scalar("TURN_REALM", "localhost"),
    "TURN_HMAC_KEY": scalar("TURN_HMAC_KEY"),
}

with open(sys.argv[1]) as template:
    text = template.read()

def repl(m):
    name = m.group(1)
    if name not in values:
        fail("TURN template contains an unsupported placeholder")
    return values[name]

rendered = re.sub(r"\$\{(\w+)(?::-[^}]*)?\}", repl, text)
with open(sys.argv[2], "w") as output:
    output.write(rendered)
PYCODE

exec turnserver -c /etc/coturn/turnserver.conf "$@"
