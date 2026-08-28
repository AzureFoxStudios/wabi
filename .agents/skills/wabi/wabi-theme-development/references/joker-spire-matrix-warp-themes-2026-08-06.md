# Joker / Spire / Matrix / Warp themes (2026-08-06)

## Shipped presets

| Theme UI name | Palette `id` | Ambient `effect` | Notes |
|---------------|--------------|------------------|--------|
| **Joker** | `joker` | `joker` | Was “Balatro” in WIP — **always display as Joker**. Paint swirl (WebGL + CPU fallback). Multi-color: `color` / `color2` / `color3`. |
| **The Spire** | `spire` | `spire` | Night climb vibe |
| **Matrix** | `matrix` | `matrix` | Digital rain |
| **Warp Speed** | `warp` | `warp` | Hyperspace streaks |

Files:
- `frontend/src/lib/theme/palettes.ts` — `jokerPalette`, `spirePalette`, `matrixPalette`, `warpPalette` in `ALL_PALETTES`
- `frontend/src/lib/theme/themes.ts` — `jokerTheme`, `spireTheme`, `matrixTheme`, `warpTheme` exports
- `frontend/src/lib/theme/themeTypes.ts` — `AmbientConfig.color2` / `color3`
- `frontend/src/lib/theme/themeManager.ts` — sets `--bg-effect-color2` / `--bg-effect-color3`
- Effects: `built-in/balatro.ts` exports **`JokerEffect`** with `id = 'joker'` (filename may stay `balatro.ts`); `spire.ts`, `matrix.ts`, `warp.ts`; shared `webgl.ts` / `cpu.ts`
- `AmbientBackground.svelte` registers all four; Joker watermark class `.joker-watermark`

## Naming rule

Ronin: **Balatro → Joker** in the product UI. Never ship a theme card labeled “Balatro”. Internal file `balatro.ts` is OK if the class/id/name are Joker.

## Stash recovery (how this almost stayed unshipped)

Theme WIP was parked in `git stash` as `wip-unrelated-before-ui-ship` while settings UX shipped. **Settings polish ≠ theme content.** When the user asks “did you fix the themes from the audit?”, check:

1. `git stash list` + `git stash show --include-untracked --name-only stash@{N}`
2. Tracked: `git checkout stash@{N} -- frontend/src/lib/theme/* frontend/src/lib/effects/*.svelte …`
3. **Untracked built-ins** live on **`stash@{N}^3`** (third parent of a `-u` stash):  
   `git checkout 'stash@{N}^3' -- frontend/src/lib/effects/built-in/…`
4. Rename Balatro→Joker before commit; `STATIC_BUILD=1 bun run build` + release binary bake.

Do not leave multi-color ambient themes half-applied (palette without effect registration, or effect without `color2`/`color3` CSS vars).

## Login ambient

Login may randomize effects including `joker` / `spire` / `matrix` / `warp`. Prefer coupling to full theme presets long-term; if seeding effects alone, keep the same id strings as `AmbientBackground` registry.
