# CSS Refactor Phase 2 — Component CSS Extraction Task

## Context
Wabi is a self-hosted Discord alternative. Its frontend CSS is spaghetti — 98 Svelte components with ~55,000 lines of scattered CSS, hardcoded colors, no shared classes.

## What's Already Done (Phase 0+1)
- Built a derivation engine (`src/lib/theme/buildTokens.ts`) that generates full themes from compact palettes
- Reduced `themes.ts` from 1,155 lines to 48 lines
- Created semantic token system in `src/styles/tokens.css`
- All existing theme imports still work (backward compatible)

## Your Task: Phase 2 — Extract Shared Component CSS

### Goal
Extract shared UI patterns from the top 10 largest components into dedicated CSS files. Components keep only layout-specific styles. All color, spacing, shadow, border, typography should use tokens.

### Components to Process (in priority order)
1. **MainLayout.svelte** (~600 CSS lines) — App grid, panel resizing, server rail → `src/styles/layout.css`
2. **ChannelSidebar.svelte** (~2,000 CSS lines) — Channel rows, category headers, unread badges → `src/styles/components/sidebar.css`
3. **Chat.svelte** (~1,500 CSS lines) — Chat layout, input area, typing indicators → `src/styles/components/chat.css`
4. **MessageList.svelte** (~2,000 CSS lines) — Message bubbles, embeds, reactions, audio player → `src/styles/components/messages.css`
5. **Settings.svelte** (~3,000 CSS lines) — Settings modal chrome, tab switcher, form rows, color picker → `src/styles/components/settings.css`
6. **CallModal.svelte + CallView.svelte** (~1,500 CSS lines combined) — Call shell, participant grid, video container → `src/styles/components/calls.css`
7. **UserSettings.svelte** (~800 CSS lines) — Profile cards, avatar patterns → `src/styles/components/cards.css`
8. **RightPanel.svelte** (~400 CSS lines) — Panel utilities
9. **ServerSwitcherPanel.svelte** (~300 CSS lines) — Server rail styling
10. **DMTab.svelte + DMMessageView.svelte** (~600 CSS lines combined) — DM sidebar + conversation

### Rules
1. **Backward compatibility**: All existing CSS variable names must continue to work. Don't rename tokens.
2. **Semantic tokens**: Use `--surface-*`, `--text-*`, `--border-*`, `--accent-*`, `--space-*`, `--radius-*`, `--shadow-*` from `src/styles/tokens.css`
3. **Legacy fallback**: If a semantic token might not exist, add fallback: `var(--surface-app, var(--bg-primary, #1a1a2e))`
4. **Shared classes**: Extract patterns into reusable classes:
   - `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-icon`
   - `.card`, `.card-elevated`
   - `.panel`, `.panel-header`, `.panel-content`, `.panel-footer`
   - `.surface`, `.surface-raised`, `.surface-sunken`
   - `.input`, `.textarea`, `.select`
   - `.badge`, `.badge-unread`
   - `.tooltip`, `.popover`
5. **No hardcoded colors**: Replace all `rgba(...)` and `#hex` values with token references
6. **No arbitrary px**: Replace hardcoded pixel values with `--space-*` tokens where applicable
7. **Keep component styles**: Component `<style>` blocks should only contain layout/positioning rules specific to that component

### File Structure to Create
```
src/styles/
  layout.css              — App grid, panel system, resizing handles
  components/
    buttons.css           — All button variants
    cards.css             — Card surfaces
    panels.css            — Panel utilities
    inputs.css            — Form controls
    sidebar.css           — Channel sidebar patterns
    chat.css              — Chat layout surfaces
    messages.css          — Message bubble, embed, reaction
    calls.css             — Call shell, video grid
    settings.css          — Settings modal chrome
    modals.css            — Modal overlay, modal content
    badges.css            — Unread badges, status badges
    tooltips.css          — Tooltip surfaces
```

### Verification Steps After Each Component
- Search the component file for hardcoded `#hex` and `rgba()` values — should be near zero
- Search for `z-index:` — should use `--z-*` tokens or be removed if unnecessary
- Check that the component still compiles (no broken CSS selectors)

### CRITICAL: Do NOT break the app
- Make incremental changes
- Test that the component still renders correctly
- If unsure about a value, keep it with a TODO comment instead of guessing

## Reference Files
- `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend/src/styles/tokens.css` — Semantic tokens
- `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend/src/lib/theme/buildTokens.ts` — Derivation engine
- `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend/src/lib/theme/palettes.ts` — Base palettes
- `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/PROJECT_DOCS/CSS_AUDIT_REWRITE_PLAN.md` — Full audit plan
- `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/PROJECT_DOCS/CSS_REFACTOR_PROGRESS/03_PHASE_0_TOKENS.md` — Phase 0 notes

## Deliverables
1. All new CSS files in `src/styles/components/`
2. Updated component `.svelte` files with extracted CSS
3. Updated `src/styles/tokens.css` if new tokens are needed
4. Report: list of extracted classes, remaining hardcoded values per component, notes on any breaking changes avoided

## Work Directory
/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/frontend
