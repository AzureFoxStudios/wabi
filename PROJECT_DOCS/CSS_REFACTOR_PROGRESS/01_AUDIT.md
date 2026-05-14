# CSS Refactor — Phase 0: Token System Audit

## 1. app.css Audit

File: `frontend/src/app.css`
Status: The original monolithic CSS file. Needs complete rewrite.

### Structure Found
- `:root` design tokens (mixed naming conventions)
- Global reset/base styles
- Scrollbar styling
- Utility classes
- Button variants (btn-primary, btn-secondary, btn-ghost, btn-danger, btn-icon)
- Input/textarea styles
- Spoiler, emoji, emote, avatar styles
- Panel utilities
- Mobile responsive queries
- Touch improvements
- Safe area support
- High contrast mode
- Uniform font mode
- Theme-specific overrides (vscode-high-contrast, slate-signal)
- Animation presets
- Reduced motion preferences

### Problems
1. Two naming conventions: `--color-background-primary` AND `--bg-primary`
2. Hardcoded hex values in `:root` that duplicate themes.ts values
3. Theme override blocks hardcoded per theme (not generated)
4. No semantic mapping layer (palette → surface → component)
5. Everything in one 995-line file

## 2. themes.ts Audit

File: `frontend/src/lib/theme/themes.ts`
Status: 14 monolithic theme objects, 84 properties each = 1,176 hardcoded values

### Structure Found
- 14 themes: dark, light, neon, pastel, midnight, solarized, dracula, nord, vscode-high-contrast, slate-signal, cyberpunk, forest, ocean, sunset
- Each has: bgPrimary, bgSecondary, bgTertiary, textPrimary, textSecondary, textTertiary, accent, accentSecondary, accentHover, modalBg, popupBg, cardBg, etc. (69 color fields)
- Plus 15 gradient properties per theme
- NO separation of base palette, semantic mapping, and component overrides

### Problems
1. Adding a theme requires editing all 84 properties by hand
2. No derivation — bgHover isn't computed from bgPrimary
3. Gradients are hardcoded strings per theme
4. Business hub uses entirely separate system

## 3. business/theme.css Audit

File: `frontend/src/lib/business/theme.css`
Status: Separate `biz-*` namespace, isolated from main theme system

### Structure Found
- `--biz-bg-primary: #0f1419`
- `--biz-accent: #f59e0b`
- `--biz-text-primary: #f1f5f9`
- And other business-specific tokens

### Verdict
P3 priority. Merge into main system after Phase 2.

## 4. Component Scoped Styles Audit

Files: 98 `.svelte` files with `<style>` blocks
Estimated: ~55,000+ lines of scattered CSS

### Key Offenders (by line count)
| Component | Total Lines | CSS Estimate |
|-----------|-------------|--------------|
| Settings.svelte | ~9,842 | ~3,000 |
| MessageList.svelte | ~5,749 | ~2,000 |
| Chat.svelte | ~4,873 | ~1,500 |
| ChannelSidebar.svelte | ~3,915 | ~2,000 |
| MainLayout.svelte | ~1,701 | ~600 |

### Patterns Found
- Every component invents its own button styles
- No shared `.btn`, `.card`, `.surface`, `.panel` classes
- Hardcoded rgba() values for borders, shadows, overlays
- Arbitrary pixel values for spacing (not using --space-* tokens)
- z-index values scattered randomly

## 5. themeManager.ts Audit

File: `frontend/src/lib/theme/themeManager.ts`
Status: Applies theme by iterating TS object keys and setting CSS vars at runtime

### Current Behavior
- Takes theme object from themes.ts
- Iterates all keys
- Sets `--{key}` on `:root`
- Handles background image overlay
- Handles animation presets

### Problems
1. Tightly coupled to old themes.ts shape
2. Sets flat properties, not semantic tokens
3. No support for CSS custom property derivation
4. No runtime theme switching animation

## 6. prism-theme.css

File: `frontend/src/lib/prism-theme.css`
Status: Separate concern for syntax highlighting

### Verdict
Leave alone. Prism theme is content-specific, not UI-specific.

## Audit Summary

### What Works
- Background image system (url, opacity, blur, position, etc.)
- Animation presets exist
- 14 themes exist (just poorly structured)
- Theme persistence backend works

### What's Broken
- Three parallel design systems
- No single source of truth for color
- 1,176 hardcoded theme values
- Component CSS is copy-pasted patterns
- No semantic token layer
- No derivation system
- Business hub is isolated

### What We Need
1. Unified token naming convention
2. Base palette + derivation system
3. Semantic mapping layer
4. Component CSS classes extracted to shared stylesheets
5. Runtime theme manager that generates semantic tokens from palettes

## Next Step
Write `02_MACRO_PLAN.md` with execution strategy, then begin creating the new token system.
