# New theme checklist (palette-only or reuse existing effect)

## Paths (from Wabi repo root)

- Palette: `frontend/src/lib/theme/palettes.ts`
- Type + derive: `frontend/src/lib/theme/buildTokens.ts` (`BasePalette`, `buildTheme`)
- Registry: `frontend/src/lib/theme/themes.ts` (`ALL_PALETTES` → `THEMES`)
- Runtime CSS: `frontend/src/lib/theme/themeManager.ts` (usually no edit)
- Identity: `references/theme-identity-map.md` (update when adding)

## Do not touch unless asked

- `src-tauri/`, backend crates, deploy
- `tokens.css` global refactor (use `wabi-frontend-polish`)
- Detached effect lists in `Login.svelte` (login already uses full `ALL_PALETTES`)

## Skeleton (dark theme — must have ambient)

```typescript
export const myThemePalette: BasePalette = {
  id: 'my-theme',           // kebab-case; unique
  name: 'My Theme',         // product UI name
  description: 'One sentence: surface mood + motion.',
  bgBase: '#0a0a12',
  bgRaised: '#141428',
  bgSunken: '#05050a',
  bgPrimary: 'linear-gradient(160deg, #05050a 0%, #141428 100%)',
  textPrimary: '#e8e8ff',
  textSecondary: '#b0b0e0',
  textMuted: '#8888b0',
  accent: '#7c6af0',
  accentSecondary: '#a78bfa',
  statusOnline: '#22c55e',
  statusAway: '#f59e0b',
  statusBusy: '#ef4444',
  statusOffline: '#6b7280',
  success: '#22c55e',
  info: '#3b82f6',
  warning: '#f59e0b',
  danger: '#ef4444',
  ambient: {
    effect: 'constellations', // MUST be registered id — see identity map
    color: '#7c6af0',
    color2: '#a78bfa',        // if effect supports multi-color
    intensity: 0.55,
    size: 1,
    speed: 1,
    frostOpacity: 0.85,
    frostBlur: 10,
  },
};
```

**Never default new dark themes to `effect: 'none'`.** Only `light` and `high-contrast` intentionally use none.

## Steps

1. **Uniqueness** — open identity map; pick accent + effect that don’t collide with blue family / nearest neighbor.
2. **Add palette** in `palettes.ts` next to peers.
3. **Append** to `ALL_PALETTES` array (picker + login random pool both use this).
4. **Named export** in `themes.ts` (keeps direct imports working):
   ```typescript
   export const myThemeTheme = allThemes.find(t => t.id === 'my-theme')!;
   ```
   Note: `THEMES` already rebuilds from `ALL_PALETTES.map(buildTheme)` — export is convenience + consistency.
5. **If renaming an id**, add `THEME_ALIASES` entry so old prefs resolve.
6. **If ambient effect is brand-new**, stop — follow `new-effect-checklist.md` first (four wires).
7. **Update** `theme-identity-map.md` row.
8. **Verify:**
   ```bash
   cd frontend && bun run check
   STATIC_BUILD=1 bun run build
   rg "id: 'my-theme'|myThemePalette" src/lib/theme
   ```
9. Visual: user real browser only. Headless Chromium cannot paint Wabi.
10. Deploy only on explicit user “deploy” — use deploy skills, not this checklist.

## Contrast

Check roughly WCAG AA (4.5:1) for `bgBase` vs `textPrimary` and usable accent on `bgBase`.

## Settings / cards

No Appearance code required for a new preset if it lands in `ALL_PALETTES` / `THEMES`. Cards derive accent from theme. If Custom card or Tune theme regresses, see `settings-taste-rules.md`.
