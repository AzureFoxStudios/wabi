#!/usr/bin/env python3
"""Scan Svelte files for orphaned '>' text nodes.

A stray '>' on its own line AFTER a tag already closed renders as a literal
text node in the component (shows up visually in every surface that mounts
the component). Heuristic: flag any line whose trimmed content STARTS with
'>' while the previous non-blank line already ENDS with '>' — legitimate
multi-line attribute closers follow attribute lines (which do not end in
'>'), so only true orphans match.

Usage:  python3 scan-orphan-gt.py [root-dir]     # default: frontend/src
Validated 2026-08-21: found exactly the 1 real orphan in the Wabi tree,
zero false positives across ~all .svelte files.
"""
import pathlib
import sys


def scan(root: str) -> int:
    hits = 0
    for p in sorted(pathlib.Path(root).rglob('*.svelte')):
        lines = p.read_text(errors='replace').splitlines()
        prev_end = None  # index of last non-blank line
        for i, line in enumerate(lines):
            t = line.strip()
            if not t:
                continue
            if t.startswith('>') and prev_end is not None:
                pt = lines[prev_end].rstrip()
                if pt.endswith('>'):
                    hits += 1
                    print(f"{p}:{i + 1}")
                    print(f"    prev: {lines[prev_end].strip()[:90]}")
                    print(f"    curr: {t[:90]}")
            prev_end = i
    print(f"\norphan '>' count: {hits}")
    return hits


if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else 'frontend/src'
    sys.exit(0 if scan(root) == 0 else 1)
