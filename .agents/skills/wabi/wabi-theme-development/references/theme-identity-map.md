# Theme identity map (disk truth)

Regenerate from `palettes.ts` + `AmbientBackground.svelte` when adding themes.
Repo root: `/var/home/Ronin/wabi` (or `$WABI_ROOT`).

## 16 presets

| UI name | palette `id` | ambient `effect` | Signature | Notes |
|---------|--------------|------------------|-----------|--------|
| Nebula | `dark` | `constellations` | Purple nebula / indigo default | `DEFAULT_PALETTE` |
| Daylight | `light` | `none` | Warm parchment + amber | No ambient OK (readability) |
| Midnight Blue | `blue` | `cyberpunk-grid` | Abyssal navy + cyan grid | Blue family #1 |
| High Contrast | `high-contrast` | `none` | Pure black + electric amber | A11y; no ambient OK |
| Forest | `forest` | `fireflies` | Deep emerald + firefly motes | |
| Embers | `ember` | `embers` | Hot coals, ground glow, flares | Two-tone color/color2 |
| Sakura | `sakura` | `sakura` | Pink petal fall | Uniqueness bar (motion); flutter+breathe remix 2026-08-23 |
| Space | `space` | `stars` | Deep void + lifecycle fade stars | Not constellations |
| Joker | `joker` | `joker` | Red/blue paint swirl | **Never label Balatro**; speed=1 = authentic game pace (GAME_PACE=0.2 baked into balatro.ts) |
| The Spire | `spire` | `spire` | Night climb / peak | |
| Matrix | `matrix` | `matrix` | Green digital rain | Uniqueness bar (glyphs); glitch-flicker remix 2026-08-23 (color2=#c8ffcf) |
| Warp Speed | `warp` | `warp` | Hyperspace radial streaks | Blue family #2 |
| Storm | `storm` | `storm` | Overcast steel + indigo | Blue family #3 |
| Synapse | `synapse` | `synapse` | Neural cyan/indigo | Blue family #4; signal-packet remix 2026-08-23 |
| Longcat | `longcat` | `longcat` | Pixelated neon ribbon tail winding through dark | Playful neon pink/cyan |
| Diamonds | `diamonds` | `shimmer` | Ice-blue jewels on velvet; pulsing glint sweep + starburst sparkles | Added 2026-08-23 |

Aliases (old stored ids → current): see `THEME_ALIASES` in `themes.ts` (`midnight-blue`→`blue`, etc.).

## Registered ambient effects

| effect id | class | file | notes |
|-----------|-------|------|--------|
| `constellations` | ConstellationsEffect | `constellations.ts` | |
| `synapse` | SynapseEffect | `synapse.ts` | |
| `stars` | StarsEffect | `stars.ts` | lifecycle fade-in/out |
| `sakura` | SakuraEffect | `sakura.ts` | |
| `embers` | EmbersEffect | `embers.ts` | prefer sprite cache |
| `fireflies` | FirefliesEffect | `fireflies.ts` | forest |
| `cyberpunk-grid` | CyberpunkGridEffect | `cyberpunk-grid.ts` | |
| `storm` | StormEffect | `storm.ts` | |
| `joker` | JokerEffect | `balatro.ts` | file name legacy; id=`joker` |
| `spire` | SpireEffect | `spire.ts` | |
| `warp` | WarpEffect | `warp.ts` | WebGL + CPU |
| `matrix` | MatrixRainEffect | `matrix.ts` | glitch-flicker via color2 |
| `longcat` | LongcatEffect | `longcat.ts` | 2D neon ribbon tail |
| `shimmer` | ShimmerEffect | `shimmer.ts` | Diamonds; gem sprites + glint band |
| `none` | — | — | skip canvas |

Shared helpers: `webgl.ts`, `cpu.ts` (not effects).

## Uniqueness glance test

Before shipping a palette, answer:

1. **Accent family** — does it collide with nearest neighbor? (especially blue/cyan/indigo cluster)
2. **Motion language** — grid vs rain vs petals vs rising sparks vs radial streaks vs neural pulses vs stars breath
3. **Surface temperature** — warm ash / cold void / parchment / pure black / emerald

Fail if two dark themes share both a similar accent *and* a similar ambient.

## Blue family split (mandatory)

| id | must read as |
|----|----------------|
| `blue` | submerged navy + neon **grid** |
| `warp` | **outward streaks**, calm center |
| `storm` | **overcast** steel, muted pulses |
| `synapse` | **neural** cyan/indigo network |
| `space` | near-black void + **stars** only (no grid) |

## Pending vs live

Code may be ahead of Tim binary. Skill encodes **repo contracts**. Do not claim “live on wabi.chat” without bake+deploy proof. Deploy is out of scope for this skill.
