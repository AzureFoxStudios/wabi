# Card D2+D3 — Right panel + notes/DM swap

Date: 2026-07-23
Status: shipped to Tim (embedded SPA binary)

## What was wrong
1. **Bottom-right notes/DM "fast swap"**: Right panel tab trigger had `dblclick → cycleActivePanel()`, which cycled notes ↔ dms ↔ users on accidental double-clicks. Also a reactive auto-heal (`openRightPanel(first)` whenever active tab missing) could thrash.
2. **Unstyled CTAs**: `dm-hub-empty-btn` ("Start a conversation") had almost no CSS — bare button look. Notes empty CTA was weak.

## Fixes
- `RightPanel.svelte`: remove dblclick cycle; guard auto-heal so it runs once per invalid tab value
- `DmHub.svelte`: proper accent CTA styles for empty state
- `NotesWorkspace.svelte`: accent-style Create first note button

## Files
- frontend/src/lib/components/RightPanel.svelte
- frontend/src/lib/components/DmHub.svelte
- frontend/src/lib/components/NotesWorkspace.svelte

## Verify (Ronin browser)
Hard refresh → open right panel → switch Notes / DMs via drawer only (no rapid bounce on double-click) → empty DMs shows styled "Start a conversation".
