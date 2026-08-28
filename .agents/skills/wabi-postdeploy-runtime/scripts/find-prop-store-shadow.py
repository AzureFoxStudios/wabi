#!/usr/bin/env python3
"""Find Svelte components where export-let prop names collide with $auto-subscribe.

Run from frontend/:
  python3 scripts/find-prop-store-shadow.py
  # or: python3 ~/.hermes/skills/software-development/wabi-postdeploy-runtime/scripts/find-prop-store-shadow.py

Exit 0 always; print paths that need fixing. Empty output = clean.
"""
from __future__ import annotations

import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "src"
SKIP = {
    "props",
    "state",
    "derived",
    "effect",
    "bindable",
    "host",
    "inspect",
    "lib",
    "app",
    "env",
}

# Strip // and /* */ comments so $foo in comments does not false-positive.
COMMENT_RE = re.compile(r"//.*?$|/\*.*?\*/", re.MULTILINE | re.DOTALL)


def strip_comments(src: str) -> str:
    return COMMENT_RE.sub("", src)


def main() -> None:
    hits = 0
    for dirpath, _, files in os.walk(ROOT):
        for name in files:
            if not name.endswith(".svelte"):
                continue
            path = os.path.join(dirpath, name)
            try:
                raw = open(path, encoding="utf-8").read()
            except OSError:
                continue
            src = strip_comments(raw)
            props = set(re.findall(r"export\s+let\s+(\w+)", src))
            dollars = set(re.findall(r"\$([A-Za-z_][A-Za-z0-9_]*)", src))
            overlap = sorted(p for p in props.intersection(dollars) if p not in SKIP)
            if overlap:
                hits += 1
                print(f"{path}: {overlap}")
    if hits == 0:
        print("# clean: no export-let / $name shadows", file=sys.stderr)


if __name__ == "__main__":
    main()
