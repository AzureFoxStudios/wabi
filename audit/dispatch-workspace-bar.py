#!/usr/bin/env python3
"""Dispatch OpenCode for the unified workspace-view bar task."""
import subprocess, sys

PROMPT_PATH = "/var/home/Ronin/wabi/audit/workspace-view-bar-prompt.md"
WORKDIR = "/var/home/Ronin/wabi"

with open(PROMPT_PATH, encoding="utf-8") as fh:
    prompt = fh.read()

bin_path = "/home/Ronin/.hermes/node/bin/opencode"
cmd = [bin_path, "run", prompt, "--model", "opencode/deepseek-v4-flash-free"]

print(f"Dispatching {len(prompt)}-char prompt to deepseek-v4-flash-free", flush=True)
result = subprocess.run(cmd, cwd=WORKDIR, capture_output=True, text=True, timeout=3600)
print("=== STDOUT (tail) ===")
print("\n".join(result.stdout.splitlines()[-60:]))
print("=== STDERR (tail) ===")
print("\n".join(result.stderr.splitlines()[-30:]))
print(f"exit={result.returncode}")
