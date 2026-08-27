# New ambient effect checklist

## Contract (`frontend/src/lib/effects/types.ts`)

```typescript
interface EffectConfig {
  color: string;
  color2?: string;
  color3?: string;
  intensity: number;
  size: number;
  speed: number;
  [key: string]: unknown;
}

interface AmbientEffect {
  id: string;              // must match palette ambient.effect
  name: string;            // product label
  description: string;
  usesWebGL?: boolean;     // true → host skips 2D context setup
  defaultConfig: EffectConfig;
  init(canvas: HTMLCanvasElement, config: EffectConfig): void;
  render(deltaTime: number, config: EffectConfig): void;
  resize(width: number, height: number): void;
  destroy(): void;         // clear canvas; no smear into next effect
}
```

## Four wires (all required)

| # | File | Action |
|---|------|--------|
| 1 | `frontend/src/lib/effects/built-in/<id>.ts` | Implement class |
| 2 | `frontend/src/lib/effects/AmbientBackground.svelte` | `import` + `effectsRegistry.register(new X())` inside `if (browser)` |
| 3 | `frontend/src/lib/theme/palettes.ts` | ≥1 theme `ambient.effect: '<id>'` + colors |
| 4 | `themeManager.ts` | Usually no change — already sets `--bg-effect-color`, `color2`, `color3`, intensity/size/speed, frost |

**Half-wire = ship blocker.** Palette without register → dead ambient. Register without palette → unreachable from picker/login.

## Templates

| Style | Copy pattern from |
|-------|-------------------|
| 2D particles | `stars.ts`, `embers.ts`, `fireflies.ts`, `sakura.ts` |
| 2D trails/glyphs | `matrix.ts` |
| WebGL + CPU fallback | `warp.ts`, `balatro.ts` (Joker) + `webgl.ts` / `cpu.ts` |

## Register snippet

```typescript
import { MyEffect } from './built-in/my-effect';
// inside if (browser) { ... }
effectsRegistry.register(new MyEffect());
```

## Performance hard rules

1. **Hard cap** particle count at init (`Math.min(N, densityFormula)`); spawners must not unbounded-grow.
2. **Avoid per-frame `createRadialGradient`** for every particle — pre-render sprites at init (see `embers.ts` / `effect-tuning-recipes.md`).
3. **rAF** is owned by `AmbientBackground.svelte` — schedule after work; respect tab visibility (already in host).
4. **destroy()** clearRect + null ctx + empty arrays so the next effect doesn’t inherit trails.
5. **resize()** rebuild particle field scaled to viewport.

## Multi-color

Set on palette ambient:

```typescript
ambient: {
  effect: 'my-effect',
  color: '#…',
  color2: '#…',
  color3: '#…',  // optional
  intensity: 0.6,
  size: 1,
  speed: 1,
}
```

`themeManager.applyTheme` maps these to CSS vars; `AmbientBackground` passes them into `EffectConfig`.

## Naming

- Product UI: safe names only (`Joker` not Balatro).
- `id` string shared by class, registry, and palette `ambient.effect`.
- Legacy filenames OK if export id is correct (`balatro.ts` → `JokerEffect`, `id = 'joker'`).

## Verify

```bash
cd frontend
rg "id = 'my-effect'|effect: 'my-effect'|register\\(new My" src/lib
bun run check
STATIC_BUILD=1 bun run build
```

Visual: real browser. Update `theme-identity-map.md` effect table.
