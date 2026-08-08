#!/usr/bin/env python3
"""Dispatch OpenCode for Reader P1 toolbar restructure."""
import subprocess, sys

PROMPT_PATH = "/var/home/Ronin/wabi/audit/reader-p1-prompt.md"
WORKDIR = "/var/home/Ronin/wabi"

with open(PROMPT_PATH, encoding="utf-8") as f:
    prompt = f.read()

opencode_bin = "/var/home/Ronin/.hermes/node/bin/opencode"
result = subprocess.run(
    [opencode_bin, "run", prompt, "-m", "opencode/deepseek-v4-flash-free"],
    cwd=WORKDIR,
    timeout=900,
)
sys.exit(result.returncode)