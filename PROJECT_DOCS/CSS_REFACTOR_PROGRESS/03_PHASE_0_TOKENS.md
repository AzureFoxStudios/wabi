# CSS Refactor — Phase 0+1: Token System + Theme Derivation

## Status: COMPLETE — Ready for checkpoint review

## What Was Built

### New Files
| File | Lines | Purpose |
|------|-------|---------|
| `src/lib/theme/themeTypes.ts` | 83 | Shared Theme/ThemeColors/ThemeGradients types (extracted from themes.ts) |
| `src/lib/theme/palettes.ts` | 280 | 14 BasePalette definitions (~20 colors each) |
| `src/lib/theme/buildTokens.ts` | 195 | Derivation engine: `buildTheme(palette) → Theme` |
| `src/styles/tokens.css` | 230 | Semantic token layer (--surface-app, --text-body, etc.) |

### Rewritten Files
| File | Before | After | Delta |
|------|--------|-------|-------|
| `src/lib/theme/themes.ts` | 1,155 lines (1,176 hardcoded values) | 48 lines (derivation from palettes) | **-1,107 lines** |

### How It Works
1. `palettes.ts` defines 14 compact palettes (~20 colors each)
2. `buildTokens.ts` derives all 39 color properties + 13 gradients from each palette
3. `themes.ts` builds full Theme objects via `buildTheme()` and re-exports them
4. `tokens.css` creates semantic token aliases (--surface-app, --text-body, etc.)
5. `+layout.svelte` imports `tokens.css` so semantic tokens are available globally

### Backward Compatibility
- All existing imports (`import { darkTheme, DEFAULT_THEME } from './themes'`) work unchanged
- themeManager.ts still sets legacy tokens (--bg-primary, --text-primary, etc.)
- Semantic tokens in tokens.css reference those legacy tokens with fallbacks
- No component changes needed yet

### Verification
- `npx tsc --noEmit`: ZERO theme-related errors (remaining errors are pre-existing in motion/ files)
- All 14 themes export correctly
- All theme consumers (themeStore.ts, themeManager.ts) compile cleanly

## What Comes Next
### Phase 2: Component CSS Extraction (Top 10)
- Extract shared patterns from Settings.svelte, MessageList.svelte, Chat.svelte, etc.
- Create `src/styles/components/*.css` files
- Replace component hardcoded values with token references

### Phase 3: Remaining 88 components
- Batch-process smaller components
- Extract `.btn`, `.card`, `.panel`, `.surface` utility classes

### Phase 4-6: Business hub merge, polish, artist features

## Artist Customization Foundation
- Palette-based system makes adding new themes trivial (one 20-line object)
- Semantic tokens give users clear hooks for theming
- `tokens.css` provides the infrastructure for custom CSS injection later
