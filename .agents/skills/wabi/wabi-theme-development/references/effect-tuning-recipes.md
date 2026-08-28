# Effect tuning recipes

Repo: `frontend/src/lib/effects/built-in/`. Host loop: `AmbientBackground.svelte`.

## Stars (`stars.ts`) — Space theme

**Feel:** stars breathe in/out of existence (full lifecycle), not constant twinkle soup.

```
Star { x, y, size, phase, speed, age, maxAge }
fade = sin((age/maxAge) * PI)          // smooth birth/death
twinkle = 0.55 + 0.45 * sin(phase)
alpha = fade * twinkle * ~0.8 * intensity
```

- Respawn when `age > maxAge` at a **new** position (`make(false)`).
- `resize()` rebuilds count from viewport (`make(true)` random age).
- Palette: deep void bg, cool star color, intensity ~0.85, speed slightly slow (~0.7).

## Embers (`embers.ts`) — Embers theme

**Feel:** hot coals under ash — rising sparks, white-hot core, cooler red edge, ground heat, occasional flares.

- Two-tone: `color` (orange) + `color2` (red).
- Trail: `destination-out` soft fade, then `lighter` composite for glow.
- Life fade: `sin(t * PI)` over `life/maxLife`.
- **Ground glow:** linear gradient bottom ~25% of screen, low alpha × intensity.
- **Flare bursts:** rare spawn pack from bottom with `spark=true`.
- **Hard cap** particles; don’t let bursts unbounded-grow.
- **Sprite cache (preferred):** pre-render 2–3 offscreen radial sprites at init; `drawImage` + `globalAlpha` per particle — avoid thousands of `createRadialGradient`/sec.

Palette: near-black ash bases (`#140800` family), accent orange, secondary red, intensity high, frost so UI stays readable.

## Fireflies (`fireflies.ts`) — Forest theme

**Feel:** slow warm motes in deep green dark — lazy drift, soft pulse, not embers-speed.

```
Mote { x, y, vx, vy, r, phase, speed, life, maxLife }
fade = sin((life/maxLife) * PI)
// gentle sine wobble on x; slow upward vy
```

- Radial soft glow color → color2 → transparent.
- Respawn below fold when expired.
- Cap density by viewport area.

Palette: deep emerald bases, green/gold ambient colors, low–mid intensity.

## Sakura / Matrix (uniqueness bars)

- **Sakura:** large slow petals, pink — organic fall. Don’t reuse for “space” or “embers.”
- **Matrix:** column glyph rain + trail fill — iconic green cascade. Keep near-black + `#00ff41` family unless intentional alt-matrix skin.

## Longcat (`longcat.ts`) — Longcat theme

**Feel:** pixelated neon ribbon tail winding through dark space — playful, soft, dreamy trails.

- 2D canvas only, no WebGL.
- Spring-follow chain: lead node wanders via slow Lissajous; each body node loosely follows its predecessor with wander noise.
- Trail: soft-clear fill (`rgba(10, 8, 18, 0.14–0.59)`) so motion leaves a dreamy trace instead of sharp segments.
- Width tapers by node age (`baseWidth * (1-t)^1.6`); skip segments too thin to paint.
- Gradient stroke color1 → color2 → color3 with alpha mapped to `1-t`.
- Occasional soft radial glow nodes every 7th visible segment.
- Intensity controls visible node count + clear alpha; speed scales wander + follow + clear opacity; size scales base width.
- `destroy()` hard-clear canvas + null ctx + empty nodes so it does not smear into the next effect.

Palette: deep purple-black bases, neon pink/cyan accents, mid intensity (~0.9), mid speed (~0.8).

## Host performance (do not regress)

In `AmbientBackground.svelte`:

1. Schedule next `requestAnimationFrame` **after** render work (not before skip).
2. On `visibilitychange` hidden → skip render; on show reset `lastTime`.
3. WebGL effects: `usesWebGL = true`.

## Optional perf debt (not required for palette-only)

Per-frame gradients still heavy on some effects (`spire`, `warp` streaks, `fireflies`). Apply embers-style sprite caching when touching those files for CPU complaints.

## Diagnostic

Firefox `Shift+Esc` task manager: ambient tab pegged CPU with no video decoder → canvas effect cost.
