#!/usr/bin/env python3
"""Dispatch OpenCode worker for B6 fix (avatar persistence + KanbanBoard users endpoint)."""
import subprocess
import sys
import os

WORKDIR = "/var/home/Ronin/wabi"
PROMPT_FILE = os.path.join(WORKDIR, "audit", "b6-fix-prompt.md")

with open(PROMPT_FILE, "r") as f:
    prompt = f.read()

result = subprocess.run(
    [
        "opencode", "run",
        prompt,
        "--model", "opencode/deepseek-v4-flash-free",
    ],
    cwd=WORKDIR,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    # pty=true is handled via the shell wrapper below
)

# Write output to log
log_path = "/tmp/opencode-b6-fix-run.log"
with open(log_path, "w") as logf:
    logf.write(result.stdout)

print(f"Exit code: {result.returncode}")
print(f"Log: {log_path}")
# Print last 20 lines
lines = result.stdout.strip().split("\n")
for line in lines[-20:]:
    print(line)
