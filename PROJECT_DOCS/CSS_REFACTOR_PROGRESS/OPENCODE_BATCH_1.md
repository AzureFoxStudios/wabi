# OpenCode Task: Batch Component CSS Migration
## Context
We are in Phase 2 of the CSS refactor for Wabi frontend. The token system is live.
Shared component CSS exists in frontend/src/styles/components/.
Your job: migrate hardcoded colors in the top 3 components to use semantic tokens.

## Rules
1. ONLY touch <style> blocks — never touch <script> or template markup
2. Replace hardcoded hex colors (#fff, #ff1493, #22c55e, etc.) with var(--token) references from tokens.css
3. Replace rgba(...) hardcoded values with rgba(var(--token-rgb), alpha) or var(--token-with-alpha)
4. Keep the exact same visual output — match colors to semantic meaning
5. If a selector has no hardcoded colors, leave it untouched
6. Do NOT change class names or selectors
7. Use these semantic mappings as a guide:
   - #fff, #ffffff → var(--text-inverse) or var(--surface-app)
   - #ff1493 (deep pink) → var(--accent-primary) or var(--text-link)
   - #22c55e (green) → var(--status-online) or var(--accent-success)
   - #60a5fa (blue) → var(--accent-info) or var(--status-online)
   - #f0b429 (yellow/gold) → var(--accent-warning) or var(--status-idle)
   - #ef5f5f, #dc2626, #d43b3b (red) → var(--accent-danger) or var(--status-dnd)
   - #ffd700 (gold) → var(--accent-warning)
   - #ff7575, #ff9d9d (light red) → var(--text-danger) or var(--accent-danger-soft)
   - #ffcc80 (orange) → var(--accent-warning-soft)
   - #5865f2 (blurple) → var(--accent-primary)
   - Generic dark backgrounds → var(--surface-elevated), var(--surface-panel)
   - Generic light text → var(--text-body), var(--text-heading)
   - Generic muted text → var(--text-muted)
   - Borders → var(--border-default), var(--border-subtle)
   - Shadows → var(--shadow-sm), var(--shadow-md), var(--shadow-lg)

## Files to modify (in order of priority)
1. frontend/src/lib/components/MessageList.svelte — 30 hardcoded hex, 67 rgba values
2. frontend/src/lib/components/ChannelSidebar.svelte — 14 hardcoded hex, 59 rgba values
3. frontend/src/lib/components/Settings.svelte — 6 hardcoded hex, 47 rgba values

## Verification
After each file, run `npx tsc --noEmit` to ensure no TypeScript errors.
Commit after all 3 files are done with message: "CSS refactor: Phase 2 component migration batch 1".

## DO NOT
- Touch any .ts or .js files
- Change class names or HTML structure
- Delete CSS rules (only replace property values)
- Modify the shared component CSS files in src/styles/components/
