#!/usr/bin/env python3
"""Fix all sun->gear icon replacements across the codebase."""
import subprocess, sys, os

ROOT = "/var/home/Ronin/wabi"

SUN_ICON = '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1.51 1.51V3a2 2 0 0 1 2 2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82.33l.06.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z'

GEAR_ICON = '<path d="M12 1v6m0 10v6M4.93 4.93l4.24 4.24m-4.24 10.28l4.24-4.24M23 12h-6m0 0v6m0-6V6a6 6 0 0 0-12 0v12a6 6 0 0 0 12 0v-6"></path>'

# Files with sun icon (excluding ProfileCard.svelte which is already fixed)
files = [
    "frontend/src/lib/components/sidebar/TextChannelList.svelte",
    "frontend/src/lib/components/sidebar/ChannelSettingsModal.svelte",
    "frontend/src/lib/components/business/KanbanBoardImpl.svelte",
    "frontend/src/lib/components/TransferCenter.svelte",
    "frontend/src/lib/components/Settings.svelte",
    "frontend/src/lib/components/WorkspacePanelIcon.svelte",
    "frontend/src/lib/components/DmHub.svelte",
    "frontend/src/lib/components/AdminCenterStage.svelte",
]

count = 0
for f in files:
    path = os.path.join(ROOT, f)
    if not os.path.exists(path):
        print(f"SKIP (not found): {f}")
        continue
    with open(path, 'r') as fh:
        content = fh.read()
    if SUN_ICON in content:
        content = content.replace(SUN_ICON, GEAR_ICON)
        with open(path, 'w') as fh:
            fh.write(content)
        count += 1
        print(f"FIXED: {f}")
    elif 'M19.4 15a1.65' in content:
        # Try a more targeted approach — find the path with the sun data
        import re
        # Match the full path element that starts with the sun data
        pattern = r'<path d="M19\.4 15a1\.65 1\.65[^"]*"></path>'
        matches = re.findall(pattern, content)
        if matches:
            for m in matches:
                content = content.replace(m, GEAR_ICON)
            with open(path, 'w') as fh:
                fh.write(content)
            count += 1
            print(f"FIXED (regex): {f} — {len(matches)} occurrences")
        else:
            print(f"WARN: sun path found but exact replacement failed: {f}")
    else:
        print(f"SKIP (no sun icon): {f}")

print(f"\nTotal files fixed: {count}")
