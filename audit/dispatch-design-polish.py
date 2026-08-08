#!/usr/bin/env python3
"""Dispatch the design-polish worker for ONE screen (review gate per screen).

Usage: python3 dispatch-design-polish.py [1-6]
   1 Chat surface | 2 Server rail + sidebar | 3 DM list/thread |
   4 Settings/Appearance | 5 Command palette/modals | 6 Empty states

Default: 1. Each run does exactly one screen, writes audit/design-polish.log,
and leaves the report in audit/design-polish-report.md for human review.

Model: set MODEL=<name> to override. Recommended runner for taste work is
Hermes with kimi-k3 (MoA aggregator); the opencode default is deepseek flash.
"""
import os, subprocess, sys

SCREENS = {
    1: "Chat surface (message list + composer + channel header)",
    2: "Server rail + channel sidebar + user card",
    3: "DM list + DM thread",
    4: "Settings/Appearance tabs",
    5: "Command palette / modals",
    6: "Empty states everywhere",
}

screen = int(sys.argv[1]) if len(sys.argv) > 1 else 1
if screen not in SCREENS:
    print(f"invalid screen {screen}; pick 1-6")
    sys.exit(1)

with open("/var/home/Ronin/wabi/audit/prompt-design-polish.md", "r", encoding="utf-8") as f:
    prompt = f.read()

scope_override = (
    f"\n\n# SCOPE FOR THIS RUN (overrides the scope section)\n"
    f"Only screen: {SCREENS[screen]}\n"
    f"Polish this ONE screen, report, stop. Do not start other screens.\n"
)
prompt += scope_override

model = os.environ.get("MODEL", "opencode/deepseek-v4-flash-free")
log = open("/var/home/Ronin/wabi/audit/design-polish.log", "w")
p = subprocess.Popen(
    ["opencode", "run", prompt, "--model", model],
    cwd="/var/home/Ronin/wabi",
    stdout=log,
    stderr=subprocess.STDOUT,
)
print(f"[dispatch] design-polish screen {screen} ({SCREENS[screen]}) pid={p.pid} model={model}", flush=True)
rc = p.wait()
log.close()
print(f"[done] design-polish screen {screen} rc={rc}", flush=True)
