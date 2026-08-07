#!/usr/bin/env python3
import subprocess
import sys
from pathlib import Path

ROOT = Path("/var/home/Ronin/wabi")
BIN = "/home/Ronin/.hermes/node/bin/opencode"
PROMPT = (ROOT / "audit/prompt-planner-ux-revival.md").read_text(encoding="utf-8")
MODEL = "opencode/deepseek-v4-flash-free"

cmd = [
    BIN,
    "run",
    PROMPT,
    "--model",
    MODEL,
    "-f",
    str(ROOT / "docs/plans/2026-08-06-planner-ux-critique-and-revival.md"),
    "-f",
    str(ROOT / "frontend/src/lib/components/business/PlannerWorkspace.svelte"),
    "-f",
    str(ROOT / "frontend/src/lib/components/business/BusinessSurface.svelte"),
]

print("dispatching", MODEL, "cwd", ROOT, flush=True)
r = subprocess.run(cmd, cwd=str(ROOT))
sys.exit(r.returncode)
