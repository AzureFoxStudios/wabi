# CSS Refactor Progress — 2026-05-11 Night Session

## Phase 0: Token Foundation ✅
- tokens.css created with semantic token system (background, text, border, accent, shadow, surface tiers)
- Theme derivation engine (deriveFromAccent) computes full palettes from single accent color
- Base values: #4f46e5 (indigo) / #1e1b24 (dark) / #f8f6ff (light)

## Phase 1: Derivation Engine ✅
- `themeManager.ts` — single-source-of-truth for runtime theme application
- `deriveFromAccent()` generates 50+ CSS variables from accent + mode preference
- `prefers-color-scheme` media query listener for system sync
- `setTheme()` writes to `:root` via CSS var injection

## Phase 2: Component Color Audit ✅
- ~788 false positives from var-stripper (fallback values counted as raw)
- Verified: `grep -rn 'rgba?([0-9., ]*)' src/lib/components/*.svelte | grep -v 'var('` → 0
- All raw colors in components wrapped in `var(--token, fallback)`

## Phase 3: Gradients + CSS Variables ✅
- `linear-gradient()` expressions migrated to use `--shadow-*` tokens
- Monolith `app.css` decomposed into `styles/` modules (base, tokens, components, animations, mobile, polish)
- Runtime-set RGB variables (e.g., `--text-inverse-rgb`) kept in `:root` block

## Phase 4: Inline Style Migration ✅ (COMMITTED 125ce52)
- 37 `style="background-color: {...}"` instances across 13 files → CSS custom properties
- `--avatar-color` for user/role-colored avatars (22 instances)
- `--banner-color` for user-colored banners (UserPopout)
- `--swatch-color` for ThemePreview swatches
- `--status-color` for `getStatusColor()` indicators
- Added corresponding CSS rules with `var(--*-color, var(--accent-primary))` fallbacks
- `ColorPicker.svelte` intentionally kept (it's the control, not an instance)
- Existing `var(--status-*)` and `var(--text-secondary)` references unchanged
- 1 pre-existing error remains (missing `maplibre-gl` dependency, not in package.json)

## Files Modified in Phase 4
- CallView.svelte, ChannelSidebar.svelte, CreateDMModal.svelte, CreateGroupModal.svelte
- DMMessageView.svelte, DMTab.svelte, GroupAvatar.svelte, GroupSettingsPanel.svelte
- MessageList.svelte, Settings.svelte, ThemePreview.svelte, UserListTab.svelte
- UserPanel.svelte, UserPopout.svelte

## Verification Commands
```bash
# Raw colors check
bun run check  # 0 errors, 19 warnings (14 unused CSS from prior code, 5 a11y)
grep -rn 'rgba?([0-9., ]*)' src/lib/components/*.svelte | grep -v 'var('  # 0
```

## Phase 5 (TBD / Design Cleanup)
No tasks defined. User mentioned Phase 5 and 6 may not exist.

## Phase 6 (TBD)
No tasks defined.

## Commit History
- e5e093e — Phase 0-1-2-3 fixes (motion types, Chat corruptions, Settings/SpringPanel CSS, RightPanel selectPanel)
- 3a0b634 — Last 4 truly raw hardcoded colors
- 2302782 — OpenCode batch 2 (Settings shadows, MessageList tokens)
- 125ce52 — Phase 4: Inline style → CSS custom property migration

## Next Steps (whenever requested)
- Address 19 svelte-check warnings (14 unused CSS from dead code, 5 a11y)
- Install missing `maplibre-gl` or stub type declarations
- Final design pass for artist-facing customization
- Merge `frontend/frontend/src/app.d.ts` (accidentally nested in e5e093e) — cleanup needed
