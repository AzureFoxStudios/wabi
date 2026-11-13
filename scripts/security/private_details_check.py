#!/usr/bin/env python3
"""Keep operator-private network details out of tracked docs and scripts.

Fails when a tracked file in the scanned folders contains
  private_ipv4   an address in 10/8, 172.16/12, 192.168/16, 100.64/10
                 (Tailscale/CGNAT) or 169.254/16 (link-local)
  public_ipv6    a full IPv6 literal outside 2001:db8::/32, link-local,
                 unique-local and loopback
  tailnet_name   a Tailscale MagicDNS name (<host>.<tailnet>.ts.net)
  home_path      /home/<name> or /Users/<name> for a name that is not a
                 generic placeholder (operator, user, ...)

unless the exact value is listed for that file in
`scripts/security/private-details-allowlist.json` with a reason. Use the
documentation ranges instead: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24,
2001:db8::/32, `wabi.example`, and `operator` as a user name.

Scope (kept small so it stays fast): docs/, scripts/, frontend/scripts/,
.github/ and files at the repository root, including single-file .gz evidence
under those paths. Application source and tests are NOT scanned: they use
private ranges on purpose (address classification, SSRF guards).

It does not detect credentials, e-mail addresses, machine nicknames, host names
outside .ts.net, or anything inside images, PDFs or tar archives.

    python3 scripts/security/private_details_check.py
    python3 scripts/security/private_details_check.py --root /path/to/tree
"""
from __future__ import annotations

import argparse
import gzip
import ipaddress
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ALLOWLIST = "scripts/security/private-details-allowlist.json"
SCAN_PREFIXES = ("docs/", "scripts/", "frontend/scripts/", ".github/")
MAX_BYTES = 8 * 1024 * 1024
PRIVATE_V4 = [ipaddress.ip_network(n) for n in
              ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16")]
SAFE_V6 = [ipaddress.ip_network(n) for n in ("2001:db8::/32", "fe80::/10", "fc00::/7", "::1/128")]
GENERIC_USERS = {"operator", "user", "username", "you", "me", "runner", "wabi", "app", "node",
                 "ubuntu", "root", "example", "name", "your-user", "youruser", "spacetime"}

# Boundaries are digits/dots only, so values glued to words ("host10.0.0.1") still match.
IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?!\.\d)")
IPV6 = re.compile(r"(?<![\w:.])((?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}"
                  r"|(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})(?![\w:])")
TAILNET = re.compile(r"\b((?:[a-z0-9-]+\.)+ts\.net)\b", re.I)
HOME = re.compile(r"(?<![$~])(/home/|/Users/|[A-Z]:[\\/]+Users[\\/]+)([A-Za-z0-9._-]+)")


def findings(text: str):
    for m in IPV4.finditer(text):
        try:
            ip = ipaddress.IPv4Address(m.group(1))
        except ValueError:
            continue
        if any(ip in n for n in PRIVATE_V4):
            yield "private_ipv4", m.group(1), m.start()
    for m in IPV6.finditer(text):
        value = m.group(1)
        try:
            ip = ipaddress.IPv6Address(value)
        except ValueError:
            continue
        # Require a real global address: avoids clock times and hex-pair noise.
        if value.count(":") >= 3 and ip.is_global and not any(ip in n for n in SAFE_V6):
            yield "public_ipv6", value, m.start()
    for m in TAILNET.finditer(text):
        name = m.group(1).lower()
        if name.count(".") >= 3:  # host.tailnet.ts.net; bare tailscale/ts.net mentions are fine
            yield "tailnet_name", m.group(1), m.start()
    for m in HOME.finditer(text):
        user = m.group(2)
        if user.lower() not in GENERIC_USERS and not user.startswith(("$", "<", "{", "%")):
            yield "home_path", m.group(1) + user, m.start()


def tracked(root: pathlib.Path) -> list[str]:
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True)
    return [p for p in out.stdout.decode().split("\0") if p]


def in_scope(path: str) -> bool:
    return path.startswith(SCAN_PREFIXES) or "/" not in path


def read_text(path: pathlib.Path) -> str | None:
    try:
        raw = path.read_bytes()
        if path.suffix == ".gz":
            if path.name.endswith((".tar.gz", ".tgz")):
                return None
            raw = gzip.decompress(raw)
        if len(raw) > MAX_BYTES or b"\0" in raw[:4096]:
            return None
        return raw.decode("utf-8")
    except (OSError, UnicodeDecodeError, gzip.BadGzipFile, EOFError):
        return None


def load_allowlist(root: pathlib.Path) -> dict[str, set[str]]:
    p = root / ALLOWLIST
    if not p.exists():
        return {}
    data = json.loads(p.read_text())
    allowed: dict[str, set[str]] = {}
    for entry in data.get("allowed", []):
        if not entry.get("reason"):
            raise SystemExit(f"{ALLOWLIST}: every entry needs a reason ({entry.get('path')})")
        allowed.setdefault(entry["path"], set()).update(entry["values"])
    return allowed


def scan(root: pathlib.Path, files: list[str] | None = None) -> tuple[list[dict], list[str]]:
    allowed = load_allowlist(root)
    hits, used = [], set()
    for rel in files if files is not None else tracked(root):
        if not in_scope(rel) or rel == ALLOWLIST:
            continue
        text = read_text(root / rel)
        if text is None:
            continue
        for kind, value, offset in findings(text):
            if value in allowed.get(rel, ()):
                used.add((rel, value))
                continue
            hits.append({"path": rel, "line": text.count("\n", 0, offset) + 1, "kind": kind, "value": value})
    stale = [f"{path}: {value}" for path, values in allowed.items() for value in values
             if (path, value) not in used]
    return hits, stale


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(HERE.parents[1]), help="repository root (for tests)")
    args = ap.parse_args()
    root = pathlib.Path(args.root)
    hits, stale = scan(root)
    for h in hits:
        print(f"{h['path']}:{h['line']}: {h['kind']}: {h['value']}")
    for s in stale:
        print(f"note: allowlist entry no longer needed: {s}")
    if hits:
        print(f"\n{len(hits)} private-detail finding(s). Replace them with documentation values "
              f"(192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32, wabi.example, "
              f"operator) or, for a deliberate generic example, add the exact value for that file "
              f"to {ALLOWLIST} with a reason.", file=sys.stderr)
        return 1
    print("private-details: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
