#!/usr/bin/env python3
"""Replace all gear icons with a clearly-toothed gear SVG."""
import os

ROOT = "/var/home/Ronin/wabi"

# The current (wrong) gear icon we used last time
WRONG_GEAR = 'd="M12 1v6m0 10v6M4.93 4.93l4.24 4.24m-4.24 10.28l4.24-4.24M23 12h-6m0 0v6m0-6V6a6 6 0 0 0-12 0v12a6 6 0 0 0 12 0v-6"'

# A proper gear with visible teeth — classic 6-spoke gear with teeth around the rim
# This is the standard gear: hexagon + circle + teeth rays
PROPER_GEAR = 'd="M12 7V3m0 18v-4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4m10 0h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"'

# Even simpler — a clearly recognizable gear:
# circle + rays
# Or use a hexagon-based gear
GEAR_SIMPLE = 'd="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 4a8 8 0 0 1-8 8 8 8 0 0 1-8-8 8 8 0 0 1 8-8 8 8 0 0 1 8 8Z"'

# The best approach: use a gear with obvious teeth pattern
# Standard Lucide settings cog icon
LUCIDE_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 16v4M4.93 4.93l2.83 2.83M18.36 18.36l2.83-2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83M18.36 5.64l2.83 2.83"/>'

# Actually, the user said even the gear looks bad. Let me use a really obvious gear:
# A circle with 6 prominent teeth + inner circle
OBVIOUS_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2l1.7 5.2h5.2l-4.2 3.1 1.6 5.2-4.3-3.2L5.1 15.5l1.6-5.2-4.2-3.1h5.2z"/>'

# Let's use the standard "cog" from heroicons which is the most universally recognized
HEROICONS_GEAR = '<path fill-rule="evenodd" d="M11.983 0a.75.75 0 0 1 .75.75V4.5a.75.75 0 0 1-1.5 0V.75a.75.75 0 0 1 .75-.75m5.72 2.74a.75.75 0 0 1 1.06 0l.5.5a.75.75 0 0 1-1.06 1.06l-.5-.5a.75.75 0 0 1 0-1.06M7.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M1.5 12a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2A.75.75 0 0 1 1.5 12m15.5 0a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1-.75-.75m-8.72 7.26a.75.75 0 0 1 1.06 0l.5.5a.75.75 0 1 1-1.06 1.06l-.5-.5a.75.75 0 0 1 0-1.06M4.93 4.93a.75.75 0 0 1 0 1.06L3.87 7.05a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0"/>'

files = [
    "frontend/src/lib/components/sidebar/TextChannelList.svelte",
    "frontend/src/lib/components/sidebar/ChannelSettingsModal.svelte",
    "frontend/src/lib/components/business/KanbanBoardImpl.svelte",
    "frontend/src/lib/components/TransferCenter.svelte",
    "frontend/src/lib/components/Settings.svelte",
    "frontend/src/lib/components/WorkspacePanelIcon.svelte",
    "frontend/src/lib/components/DmHub.svelte",
    "frontend/src/lib/components/AdminCenterStage.svelte",
    "frontend/src/lib/components/sidebar/ProfileCard.svelte",
]

count = 0
for f in files:
    path = os.path.join(ROOT, f)
    if not os.path.exists(path):
        continue
    with open(path, 'r') as fh:
        content = fh.read()
    
    replaced = False
    # Find all SVG icons with the current gear path and replace
    import re
    # Match the pattern: <circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 10..."></path>
    pattern = r'<circle cx="12" cy="12" r="3"\.\?\></circle><path d="M12 1v6m0 10[^\"]*"\.\?\></path>'
    
    # Simpler: just replace the specific d attribute
    if WRONG_GEAR in content:
        content = content.replace(WRONG_GEAR, OBVIOUS_GEAR)
        replaced = True
    
    if replaced:
        with open(path, 'w') as fh:
            fh.write(content)
        count += 1
        print(f"FIXED: {f}")
    else:
        print(f"SKIP (no match): {f}")

print(f"\nTotal files fixed: {count}")
