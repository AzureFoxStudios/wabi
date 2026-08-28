#!/usr/bin/env python3
"""
CSS cascade audit for Wabi frontend — find duplicate class definitions
across stylesheets and report which import wins.

Root-cause tool for "deploys don't change anything" / "planner looks broken
even after verified deploy": a class defined in TWO+ sheets where the later
@import wins can silently override the intended modern styling (e.g.
todo-list.css's `.kanban-board { display:grid }` stomping
kanban-board-part1.css's flex spread — 2026-08-08).

Usage:
    python3 scripts/css-cascade-audit.py            # from frontend/
    python3 ~/.hermes/skills/wabi/wabi-deploy-debug/scripts/css-cascade-audit.py

Prints every top-level class selector defined in more than one sheet, with
the sheets and the winner (later @import in styles.css at equal specificity).
Classes the component itself styles (scoped) are immune — check the
"defined elsewhere" list against each component's own <style> before
deleting a legacy duplicate.
"""
import os
import re
import sys

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Skill lives at ~/.hermes/skills/wabi/wabi-deploy-debug/scripts/ → repo is 3 up
REPO = os.path.dirname(os.path.dirname(os.path.dirname(FRONTEND)))
if os.path.isdir(os.path.join(FRONTEND, "frontend", "src", "styles")):
    STYLES = os.path.join(FRONTEND, "frontend", "src", "styles")
else:
    STYLES = os.path.join(REPO, "frontend", "src", "styles")
STYLES_CSS = os.path.join(STYLES, "styles.css")


def import_order() -> list[str]:
    order = []
    with open(STYLES_CSS, encoding="utf-8") as f:
        for m in re.finditer(r"@import\s+'\./([^']+)'", f.read()):
            order.append(m.group(1))
    return order


def top_level_selectors(path: str) -> set[str]:
    """Class selectors at any indentation, top-level rules only (no nested
    descendant selectors — those don't fight the cascade the same way)."""
    txt = open(path, encoding="utf-8", errors="replace").read()
    sels = set()
    for m in re.finditer(r"(?m)^[ \t]*\.([A-Za-z][A-Za-z0-9_-]*)[ \t]*(\{|,)", txt):
        sels.add(m.group(1))
    return sels


def main() -> int:
    if not os.path.isfile(STYLES_CSS):
        print(f"styles.css not found at {STYLES_CSS}; run from repo or fix paths.")
        return 1
    order = import_order()
    defined: dict[str, list[str]] = {}
    for rel in order:
        path = os.path.join(STYLES, rel)
        if not os.path.isfile(path):
            continue
        for sel in top_level_selectors(path):
            defined.setdefault(sel, []).append(rel)

    dups = {k: v for k, v in defined.items() if len(v) > 1}
    print(f"Classes defined in 2+ sheets: {len(dups)}\n")
    for sel in sorted(dups):
        files = dups[sel]
        idx = [order.index(f) if f in order else -1 for f in files]
        winner = files[max(range(len(idx)), key=lambda i: idx[i])]
        print(f".{sel}: {files}  -> later-wins: {winner}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
