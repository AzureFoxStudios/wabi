#!/usr/bin/env python3
"""Dispatch OpenCode with prompt from file. Bytes-for-bytes, no shell interpretation."""
import subprocess
import sys
import os

prompt_path = "/var/home/Ronin/wabi/audit/lore-p0-policy-engine-prompt.md"
workdir = "/var/home/Ronin/wabi"

with open(prompt_path, "r") as f:
    prompt = f.read()

bin_path = "opencode"
cmd = [bin_path, "run", prompt, "--model", "deepseek-v4-flash-free", "-y", "--dir", workdir]

print(f"Dispatching P0 policy engine to OpenCode (deepseek-v4-flash-free)...", flush=True)
print(f"Prompt length: {len(prompt)} chars", flush=True)

result = subprocess.run(cmd, cwd=workdir)
print(f"P0 dispatch exit code: {result.returncode}", flush=True)
sys.exit(result.returncode)