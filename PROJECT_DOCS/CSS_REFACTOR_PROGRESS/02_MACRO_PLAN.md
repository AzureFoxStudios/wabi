# CSS Refactor — Macro Plan

## Philosophy
Start from scratch where possible. Keep backward compatibility during transition. Artist customization is the north star. Document everything in this folder so context compression doesn't lose state.

## Current Architecture (What We Have)
1. **app.css** — 995 lines, defines `--color-background-primary` AND `--bg-primary` (two naming conventions)
2. **themes.ts** — 1155 lines, 14 themes × 84 properties = 1,176 hardcoded values, no derivation
3. **themeManager.ts** — 122 lines, iterates theme object, camelCase→kebab-case, sets CSS vars on `:root`
4. **98 component .svelte files** — ~55,000 lines of scattered CSS, hardcoded rgba() values, no shared classes

## Target Architecture (What We Build)
1. **Base Palettes** — ~20 colors per theme, not 84
2. **Derivation Engine** — generates all current CSS var names from palettes (backward compat)
3. **Semantic Token Layer** — `--surface-app`, `--surface-sidebar`, etc. (future-facing)
4. **Shared Component CSS** — extracted `.btn`, `.card`, `.panel`, `.surface` classes
5. **Artist Customization** — user-uploaded themes, background videos, particle effects

## Execution Strategy

### Phase 0: Token Foundation (NOW)
- Create `frontend/src/styles/tokens.css` with unified naming
- Create `frontend/src/lib/theme/palettes.ts` — 14 base palettes
- Create `frontend/src/lib/theme/buildTokens.ts` — derivation function
- Update `themeManager.ts` to use derivation
- **Goal:** All 14 themes render identically, but now derived from palettes

### Phase 1: themes.ts Refactor
- Rewrite `themes.ts` to use palettes + buildTokens
- Delete 1,000+ lines of duplicated hardcoded values
- Verify pixel-perfect match for all 14 themes

### Phase 2: Component CSS Extraction (Top 10)
- Extract shared patterns from biggest offenders
- Settings.svelte → `components/settings.css`
- MessageList.svelte → `components/messages.css`
- Chat.svelte → `components/chat.css`
- ChannelSidebar.svelte → `components/sidebar.css`
- MainLayout.svelte → `layout.css`
- CallModal/CallView → `components/calls.css`

### Phase 3: Remaining Components
- Batch-process remaining 88 components
- Extract `.btn`, `.input`, `.card`, `.panel` shared classes
- Replace hardcoded rgba() with token references

### Phase 4: Business Hub Merge (P3)
- Merge `business/theme.css` into main system
- Only if minimal work required

### Phase 5: Polish
- Accessibility, mobile, scrollbar cleanup
- Remove old app.css entirely

### Phase 6: Artist Features (Future)
- Theme sharing backend
- Background video support
- Safe custom CSS subset

## Critical Rule: Backward Compatibility
During Phases 0-2, ALL existing CSS variable names that components use must continue to work. We derive them from palettes, we don't rename them. This prevents breaking the UI during the refactor.

## Notes Structure
- `01_AUDIT.md` — Current state (done)
- `02_MACRO_PLAN.md` — This file
- `03_PHASE_0_TOKENS.md` — Token system implementation notes
- `04_PHASE_1_THEMES.md` — themes.ts refactor notes
- `05_PHASE_2_COMPONENTS.md` — Top 10 component extraction
- etc.

## Next Action
Start Phase 0: Build the new token system + palettes + derivation engine. Update themeManager.ts to use it. Verify all 14 themes still look right.
