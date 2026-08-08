#!/usr/bin/env python3
"""Dispatch three OpenCode workers in parallel (deepseek-v4-flash-free)."""
import subprocess, sys, time

WORKERS = [
    ("a", "/var/home/Ronin/wabi/audit/prompt-worker-a-forum-plus.md"),
    ("c", "/var/home/Ronin/wabi/audit/prompt-worker-c-popout-ux.md"),
    ("d", "/var/home/Ronin/wabi/audit/prompt-worker-d-admin-retoken.md"),
]

procs = {}
for key, prompt_path in WORKERS:
    with open(prompt_path, "r", encoding="utf-8") as f:
        prompt = f.read()
    log = open(f"/var/home/Ronin/wabi/audit/worker-{key}.log", "w")
    p = subprocess.Popen(
        ["opencode", "run", prompt, "--model", "opencode/deepseek-v4-flash-free"],
        cwd="/var/home/Ronin/wabi",
        stdout=log, stderr=subprocess.STDOUT,
    )
    procs[key] = (p, log)
    print(f"[dispatch] worker-{key} pid={p.pid}", flush=True)

for key, (p, log) in procs.items():
    rc = p.wait()
    log.close()
    print(f"[done] worker-{key} rc={rc}", flush=True)

print("ALL_WORKERS_DONE", flush=True)
