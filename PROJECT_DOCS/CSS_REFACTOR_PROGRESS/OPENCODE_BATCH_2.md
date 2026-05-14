# OpenCode Task: Batch Component CSS Migration — Batch 2
## Context
We are in Phase 2 of the CSS refactor for Wabi frontend.
Your job: migrate hardcoded colors in the next 4 components to use semantic tokens.

## Rules
1. ONLY touch <style> blocks — never touch <script> or template markup
2. Replace hardcoded hex colors with var(--token) references from tokens.css
3. Replace rgba(...) hardcoded values with rgba(var(--token-rgb), alpha) or var(--token-with-alpha)
4. Keep the exact same visual output
5. Do NOT change class names or selectors

## Semantic Color Mappings
- #fff, #ffffff → var(--text-inverse) or var(--surface-app)
- #5865f2 (blurple) → var(--accent-primary)
- #111827 (dark) → var(--surface-app) or var(--surface-base)
- #ef4444 (red) → var(--color-danger) or var(--accent-danger)
- #2f2200 (dark brown) → var(--surface-base) or var(--bg-primary)
- #000, #000000 → var(--surface-app) or black
- #fecaca (light pink) → var(--accent-danger-soft) or var(--color-danger-bg)
- #f8fafc (very light gray/white) → var(--surface-app) or var(--surface-base)
- #bbf7d0 (light green) → var(--accent-success-soft) or var(--color-success-bg)
- #cbd5e1 (light blue-gray) → var(--text-secondary) or var(--border-default)
- #fda4af (pink) → var(--accent-secondary) or var(--color-danger)
- #bffdf2 (light cyan) → var(--color-info-bg) or var(--accent-info-soft)
- Generic dark backgrounds → var(--surface-elevated), var(--surface-panel)
- Generic light text → var(--text-body), var(--text-heading)
- Generic muted text → var(--text-muted)
- Borders → var(--border-default), var(--border-subtle)
- Shadows → var(--shadow-sm), var(--shadow-md), var(--shadow-lg)

## Files to modify (in order of priority)
1. frontend/src/lib/components/CallModal.svelte — 44 hardcoded hex, 93 rgba
2. frontend/src/lib/components/MediaAlbumsTab.svelte — 12 hardcoded hex, 71 rgba
3. frontend/src/lib/components/ServerSwitcherPanel.svelte — 10 hardcoded hex, 79 rgba
4. frontend/src/lib/components/MainLayout.svelte — 7 hardcoded hex, 19 rgba

## Verification
After each file, run `npx tsc --noEmit` to ensure no TypeScript errors.
Commit after all 4 files are done.

## DO NOT
- Touch any .ts or .js files
- Change class names or HTML structure
- Delete CSS rules
- Modify shared component CSS files in src/styles/components/
