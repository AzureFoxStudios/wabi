# CSS Refactor — Finish Remaining Component Migration

## Context
This is the Wabi frontend (dotronin-worktree, Rust backend). A CSS refactor is in progress. The following phases are COMPLETE:
- Phase 0: Token system (`tokens.css`, semantic tokens like `--surface-app`, `--text-body`)
- Phase 1: Derivation engine (`palettes.ts` → `buildTokens.ts` → `themes.ts`, 14 themes derived from ~20-color palettes)
- Phase 2 partial: Generic shadow/overlay/border patterns batch-migrated across ~70 components via regex
- Phase 4 partial: `style="display:none"` → `.hidden` class
- Phase 5: `app.css` decomposed (267 lines remaining, static `:root` block only)

## Remaining Work
**51 components still contain 826 hardcoded rgba/hex values** not wrapped in `var(...)`.

Top offenders by count:
| Component | Hardcoded |
|-----------|-----------|
| CallModal.svelte | 81 rgba |
| MapWorkspace.svelte | 81 rgba |
| ServerSwitcherPanel.svelte | 78 rgba |
| MediaAlbumsTab.svelte | 71 rgba |
| ChannelSidebar.svelte | 49 (1 hex + 48 rgba) |
| MessageList.svelte | 45 rgba |
| Settings.svelte | 38 rgba |
| ServerRail.svelte | 35 rgba |
| FollowingFeed.svelte | 30 rgba |
| DMMessageView.svelte | 23 rgba |
| WhiteboardCanvas.svelte | 23 (1 hex + 22 rgba) |
| FfxivReferencePanel.svelte | 21 rgba |
| ... plus 39 more |

**Also:** 74 inline `style=` attributes in 28 files (user colors, dynamic layout, etc.)

## Token System Available
All semantic tokens are defined in `frontend/src/styles/tokens.css` and set at runtime by `frontend/src/lib/theme/themeManager.ts`. Use these tokens with fallback chains:
- Surfaces: `--surface-app`, `--surface-base`, `--surface-raised`, `--surface-sunken`, `--surface-modal`, `--surface-card`, `--surface-hover`, `--surface-active`, `--surface-overlay`
- Text: `--text-heading`, `--text-body`, `--text-secondary`, `--text-muted`, `--text-link`, `--text-inverse`, `--text-danger`, `--text-warning`, `--text-success`, `--text-info`
- Borders: `--border-subtle`, `--border-default`, `--border-strong`, `--border-focus`
- Accent: `--accent-primary`, `--accent-secondary`, `--accent-glow`, `--accent-danger-soft`, `--accent-warning-soft`, `--accent-success-soft`, `--accent-info-soft`
- Status: `--status-online`, `--status-away`, `--status-busy`, `--status-offline`
- Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`
- RGB variants: `--text-inverse-rgb`, `--text-muted-rgb`, `--color-success-rgb`, `--color-info-rgb`, `--color-warning-rgb`, `--color-danger-rgb`

## Rules
1. **Replace hardcoded rgba/hex with `var(--token, fallback)` pattern.** Example: `rgba(0,0,0,0.6)` → `var(--surface-overlay, rgba(0,0,0,0.6))`
2. **Keep bespoke per-component colors semantic.** If a color represents a unique UI element (map terrain tint, call glass effect, reader sepia), create a component-specific token rather than polluting global tokens. Example: add `--call-glass-bg` to the component's `<style>` `:root` or use inline style with CSS var.
3. **Do NOT break runtime behavior.** All `var(--token, #fallback)` fallbacks must preserve original visual appearance.
4. **Do NOT modify TypeScript logic** (props, stores, functions). Only CSS in `<style>` blocks.
5. **Inline styles:** Migrate `style="background-color: {user.color}"` to use CSS custom properties where possible: `style="background-color: var(--user-color, {user.color})"` or add a `.avatar-color` class.
6. **Commit after every 3-5 files** with descriptive messages.
7. **Verify TypeScript compilation** with `npx tsc --noEmit` after each batch.
8. **Focus on dotronin-worktree only.** Do NOT touch wabi/Wabi.

## Strategy
1. Start with top 10 components by hardcoded count
2. For each component, read its `<style>` block
3. Identify what each hardcoded color represents (overlay, border, tint, glass, terrain, etc.)
4. Map to closest semantic token, or create a sensible local token
5. Replace with `var(--token, original)` pattern
6. After top 10, do a sweep of remaining 41 smaller components
7. Handle inline styles last

## Important
- The previous session used programmatic regex migration for generic patterns. What's left is **surgical** — each color needs human judgment about what it represents.
- TypeScript baseline: exactly 10 pre-existing errors in `motion/` files. Zero regressions allowed.
- The app.css `:root` block (267 lines) contains static defaults. Do not modify unless adding new tokens.

## Files to Modify
All in `frontend/src/lib/components/`:
CallModal.svelte, MapWorkspace.svelte, ServerSwitcherPanel.svelte, MediaAlbumsTab.svelte, ChannelSidebar.svelte, MessageList.svelte, Settings.svelte, ServerRail.svelte, FollowingFeed.svelte, DMMessageView.svelte, WhiteboardCanvas.svelte, FfxivReferencePanel.svelte, ModeTabsDrawer.svelte, WhiteboardLayerPanel.svelte, ReaderTab.svelte, Chat.svelte, MainLayout.svelte, RightPanel.svelte, WhiteboardTab.svelte, CallView.svelte, WhiteboardToolbar.svelte, AdminTab.svelte, ThemeCustomizer.svelte, ThemePreview.svelte, ConfirmDialog.svelte, AuthErrorBanner.svelte, ImageViewer.svelte, ZipPreviewPanel.svelte, ColorPicker.svelte, UserPopout.svelte, and all remaining.

## Entry Point
`frontend/src/styles/styles.css` imports tokens + all component CSS. This is loaded by `frontend/src/routes/+layout.svelte`.

## Verification
After work: run `npx tsc --noEmit` in `frontend/` directory. Must have exactly 10 errors (all in motion/ files). Any new error = regression.
