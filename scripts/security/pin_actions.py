#!/usr/bin/env python3
"""Rewrite every GitHub Actions `uses:` to a full 40-char commit SHA.

Idempotent. The ref -> SHA table lives in `action-pins.json` next to this file;
it is deliberately a checked-in file so that a re-pin is a reviewable diff and
never a silent network-dependent mutation of CI.

Usage:
    python3 scripts/security/pin_actions.py            # apply
    python3 scripts/security/pin_actions.py --check   # verify only, exit 1 on drift
"""
from __future__ import annotations

import glob
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PINS = json.loads((pathlib.Path(__file__).parent / "action-pins.json").read_text())["pins"]
WORKFLOWS = sorted(glob.glob(str(ROOT / ".github/workflows/*.yml")) + glob.glob(str(ROOT / ".github/workflows/*.yaml")))
USES = re.compile(r"^(\s*(?:-\s+)?uses:\s*)([^\s#]+)(\s*(?:#.*)?)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


def spec_of(value: str) -> str | None:
    """Return the action-pins.json key for an already-pinned or unpinned value."""
    for key, meta in PINS.items():
        repo_ref, sha = key, meta["sha"]
        head = repo_ref.rsplit("@", 1)[0]
        if value == key or value == f"{head}@{sha}" or value.startswith(f"{head}@{sha}#"):
            return key
    return None


def main() -> int:
    check = "--check" in sys.argv
    changed, problems = 0, []
    for path in WORKFLOWS:
        p = pathlib.Path(path)
        out = []
        for lineno, line in enumerate(p.read_text().splitlines(keepends=True), 1):
            stripped = line.lstrip()
            if stripped.startswith("#"):
                out.append(line)
                continue
            m = USES.match(line.rstrip("\n"))
            if not m:
                out.append(line)
                continue
            prefix, value, suffix = m.groups()
            if "@" not in value or "/" not in value:
                problems.append(f"{p.relative_to(ROOT)}:{lineno}: unrecognised uses: {value}")
                out.append(line)
                continue
            if SHA.search(value.rsplit("@", 1)[-1]):
                key = spec_of(value)
                label = PINS[key]["label"] if key else "pinned"
                comment = f" # {label}" if "#" not in suffix else suffix.strip()
                out.append(f"{prefix}{value}{comment}\n")
                continue
            key = value
            if key not in PINS:
                problems.append(f"{p.relative_to(ROOT)}:{lineno}: no verified SHA for {value}")
                out.append(line)
                continue
            meta = PINS[key]
            head = key.rsplit("@", 1)[0]
            out.append(f"{prefix}{head}@{meta['sha']} # {meta['label']}\n")
            changed += 1
        new = "".join(out)
        if not check and new != p.read_text():
            p.write_text(new)

    if check:
        # Verify that every active uses: line is SHA-pinned.
        for path in WORKFLOWS:
            for lineno, line in enumerate(pathlib.Path(path).read_text().splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                m = re.search(r"\buses:\s*([^\s#]+)", line)
                if m and not SHA.fullmatch(m.group(1).rsplit("@", 1)[-1]):
                    problems.append(f"{pathlib.Path(path).relative_to(ROOT)}:{lineno}: unpinned {m.group(1)}")
    for problem in problems:
        print(f"ERROR: {problem}", file=sys.stderr)
    if problems:
        return 1
    print("OK: all GitHub Actions are pinned to full commit SHAs" if check else f"OK: pinned {changed} uses: lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
