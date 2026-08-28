---
name: wabi-theme-development
description: "Use when adding/editing Wabi themes or ambient effects. Map + checklists."
version: 2.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [wabi, theme, palette, colors, ambient, design-tokens]
    related_skills: [wabi-frontend-polish, aoe4-theme-extraction, wabi-deploy]
---

# Wabi Theme Development

Add, tune, or audit **Wabi frontend** themes (not Hermes CLI skins in `~/.hermes/skins/`).

## When to use

- New or edited color preset / ambient effect
- “Make themes feel unique”, spice embers/space/sakura/matrix, etc.
- Settings Appearance theme-picker rules (progressive disclosure, cards)
- Login ambient must stay coupled to full themes

## When not to use

| Need | Go to |
|------|--------|
| Tim/binary deploy | `wabi-deploy` / `wabi-deploy-debug` |
| Global CSS token refactor | `wabi-frontend-polish` + `tokens.css` |
| Extract colors from external HTML | `aoe4-theme-extraction` |
| Hermes TUI/desktop skins | hermes theme skills / `~/.hermes/skins/` |

## 30-second map

| Concern | File |
|---------|------|
| Preset colors + ambient | `frontend/src/lib/theme/palettes.ts` → `ALL_PALETTES` |
| `BasePalette` + `buildTheme()` | `frontend/src/lib/theme/buildTokens.ts` |
| `THEMES` / aliases / exports | `frontend/src/lib/theme/themes.ts` |
| CSS vars / frost / `--bg-effect-*` | `frontend/src/lib/theme/themeManager.ts` |
| Ambient host + register | `frontend/src/lib/effects/AmbientBackground.svelte` |
| Effect interface | `frontend/src/lib/effects/types.ts` |
| Built-in effects | `frontend/src/lib/effects/built-in/*.ts` |
| Appearance UI | `…/settings/AppearanceSettingsTab.svelte` + `settings-appearance.css` |
| Login ambient | `frontend/src/lib/components/Login.svelte` (full theme from `ALL_PALETTES`) |

Repo: `/var/home/Ronin/wabi` (or `$WABI_ROOT`).

## Decision tree

```
Need to…?
├─ Colors / copy / ambient params on existing preset
│    → palettes.ts only (+ identity map if signature changes)
│    → references/new-theme-checklist.md
├─ New preset reusing an existing effect
│    → palettes.ts + ALL_PALETTES + themes.ts export
│    → uniqueness: references/theme-identity-map.md
├─ Brand-new ambient effect
│    → four wires: built-in + AmbientBackground register + palette + (themeManager rarely)
│    → references/new-effect-checklist.md
│    → tune: references/effect-tuning-recipes.md
├─ Settings picker / segments / Tune theme / cards
│    → references/settings-taste-rules.md
│    → Effect-specific controls can live under progressive disclosure when an effect supports distinct modes/presets; example: Joker/Balatro state toggle (title/blind/shop) in EffectsTab.svelte using a segmented control that overrides speed/intensity/size live. New state toggles should be gated on `selectedEffect === 'joker'` so they do not pollute the generic effect UI.
└─ Multi-color Joker/Spire/Matrix/Warp naming or stash recovery
     → references/joker-spire-matrix-warp-themes-2026-08-06.md
```

## Hard rules (always)

1. **Half-wire is a ship blocker.** New `ambient.effect` id must exist in registry **and** on ≥1 palette.
2. **Dark themes need a signature ambient.** Do not default new dark presets to `effect: 'none'` (only `light` / `high-contrast` intentionally none).
3. **Blue family must split at a glance:** `blue`=grid, `warp`=streaks, `storm`=overcast, `synapse`=neural, `space`=stars void — see identity map.
4. **Joker not Balatro** in product UI (`balatro.ts` filename OK if `id`/`name` are joker).
5. **Login:** random **full** palette from `ALL_PALETTES` — never a detached effect-only list while presets carry `none`.
6. **Settings:** theme grid primary; Custom in grid; effects/customizer/font under progressive disclosure.
7. **Perf:** particle caps; prefer sprite cache over per-frame gradients; destroy clears canvas; host pauses when tab hidden.
8. **Visual verify:** real browser only. Headless Chromium cannot paint Wabi.
9. **Deploy:** not this skill. Code-ready ≠ live on Tim.

## Token recolor gotcha (short)

When replacing hex with semantic tokens: **do not alias an undefined token to a different resolved color** (e.g. gray `#666` must not become lavender `--text-muted`). Prefer `--text-heading` over undefined `--text-primary`. Legacy block in `tokens.css` can win — preserve rendered colors.

## Verify

```bash
cd frontend
bun run check
STATIC_BUILD=1 bun run build
rg "id: 'my-id'|effect: 'my-effect'|register\\(new " src/lib/theme src/lib/effects
```

Update `references/theme-identity-map.md` when adding presets/effects.

## References

- `references/theme-identity-map.md` — all 14 themes + registered effects
- `references/new-theme-checklist.md` — palette skeleton + steps
- `references/new-effect-checklist.md` — AmbientEffect + four wires
- `references/effect-tuning-recipes.md` — stars / embers / fireflies / host perf
- `references/settings-taste-rules.md` — Appearance UX rules
- `references/joker-spire-matrix-warp-themes-2026-08-06.md` — naming + multi-color + stash^3
- `references/media-backgrounds.md` — animated GIF/WEBP + video-loop backgrounds, upload endpoint
- `references/aoe4-color-palette.md` — external extraction companion
