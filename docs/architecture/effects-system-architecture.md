# Effects System Architecture

**Status:** Planned  
**Generated:** 2026-07-01  
**Related:** offline-first-architecture.md, PLAN.md (Task Block L)

---

## Overview

A pluggable ambient-effects system for Wabi's theme layer. Effects are canvas-based background decorations — constellations, synapse grids, aurora, sparkles, etc. — that sit behind the app UI and respond to the active theme.

The system has three layers:

```
Layer 1: CSS Ambient Glows (zero JS, pre-hydration)
Layer 2: Canvas/WebGL Effects (per-theme, opt-in)
Layer 3: Effect Plugin System (user-imported custom effects)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Effects Registry (effects/registry.ts)              │
│  ├─ Built-in: constellations, synapse, aurora, ...   │
│  ├─ Custom: user-imported modules                    │
│  ├─ register(effect: AmbientEffect): void            │
│  ├─ get(id: string): AmbientEffect | undefined       │
│  ├─ list(): AmbientEffect[]                          │
│  └─ remove(id: string): void                         │
├─────────────────────────────────────────────────────┤
│  Effect Plugin Interface (effects/types.ts)           │
│  ┌───────────────────────────────────────────────┐   │
│  │ interface AmbientEffect {                      │   │
│  │   id: string                                   │   │
│  │   name: string                                 │   │
│  │   description: string                          │   │
│  │   init(canvas: HTMLCanvasElement,              │   │
│  │        config: EffectConfig): void             │   │
│  │   render(deltaTime: number,                    │   │
│  │          config: EffectConfig): void            │   │
│  │   resize(width: number, height: number): void  │   │
│  │   destroy(): void                              │   │
│  │   defaultConfig: EffectConfig                  │   │
│  │ }                                              │   │
│  └───────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│  Theme Integration                                    │
│  ├─ BasePalette.ambient → default effect per theme   │
│  ├─ themeManager.ts emits --bg-effect-* CSS vars      │
│  ├─ User can override per-theme or globally           │
│  └─ Persisted alongside theme preferences             │
├─────────────────────────────────────────────────────┤
│  CSS Layer (zero JS, works before hydration)          │
│  ├─ body background uses --bg-effect-* tokens          │
│  ├─ radial-gradient accent glows positioned per theme│
│  └─ --bg-effect-intensity: 0 disables (light themes) │
├─────────────────────────────────────────────────────┤
│  AmbientBackground.svelte                              │
│  ├─ Full-viewport <canvas>, pointer-events: none      │
│  ├─ Reads --bg-effect-* from documentElement          │
│  ├─ Observes data-theme changes (MutationObserver)     │
│  ├─ Instantiates effect from registry                 │
│  ├─ Runs RAF loop at 20-30fps                          │
│  ├─ Respects prefers-reduced-motion                   │
│  └─ Mounted in +layout.svelte behind all content       │
├─────────────────────────────────────────────────────┤
│  Settings UI (EffectsTab.svelte)                       │
│  ├─ Sub-section of Appearance tab                      │
│  ├─ Effect selector dropdown (all registered)          │
│  ├─ Color picker (overrides palette default)           │
│  ├─ Intensity / Size / Speed sliders                   │
│  ├─ Live preview canvas                                │
│  ├─ "Apply to all themes" toggle                       │
│  └─ "Import Effect" button → file picker               │
└─────────────────────────────────────────────────────┘
```

---

## Data Flow

### Theme → Effect Mapping

```
palettes.ts                          themes.ts
  darkPalette: {                       darkTheme:
    ambient: {                           ambient: {
      effect: 'constellations',            effect: 'constellations',
      color: '#a855f7',                    color: '#a855f7',
      intensity: 0.3,                     intensity: 0.3,
    }                                    }
  }                                    }

      │                                      │
      ▼                                      ▼
buildTokens.ts                       themeManager.ts
  buildTheme(palette) → Theme          applyTheme(theme):
    passes ambient through               sets --bg-effect-effect,
                                         --bg-effect-color,
                                         --bg-effect-intensity
                                              │
                                              ▼
                                    tokens.css
                                      --bg-effect-* defaults
                                      (with fallbacks)
                                              │
                                              ▼
                              AmbientBackground.svelte
                                reads computed CSS vars
                                → look up effect in registry
                                → init() + RAF loop
```

### Effect Import Flow (Custom)

```
User clicks "Import" in EffectsTab
  → file picker (.ts / .js)
  → dynamic import() or blob URL
  → validate module exports AmbientEffect class
  → register() in effects registry
  → persist source to IndexedDB (offline survival)
  → appears in selector dropdown immediately
```

---

## Effect Plugin Interface

### `src/lib/effects/types.ts`

```ts
export interface EffectConfig {
  color: string;       // CSS color, defaults to theme accent
  intensity: number;   // 0.0–1.0
  size: number;        // multiplier, 0.5–2.0
  speed: number;       // multiplier, 0.5–2.0
  [key: string]: unknown; // custom params per effect
}

export interface AmbientEffect {
  id: string;
  name: string;
  description: string;

  /** Called once when effect is activated */
  init(canvas: HTMLCanvasElement, config: EffectConfig): void;

  /** Called each frame (RAF). deltaTime in ms. */
  render(deltaTime: number, config: EffectConfig): void;

  /** Called on window resize. canvas.width/height already updated. */
  resize(width: number, height: number): void;

  /** Cleanup — cancel timers, remove listeners, free GPU resources */
  destroy(): void;

  /** Default config shown when user first selects this effect */
  defaultConfig: EffectConfig;
}
```

### Writing a Custom Effect

A user creates a `.ts` file exporting a class implementing `AmbientEffect`:

```ts
// my-effect.ts
export default class MyConstellations implements AmbientEffect {
  id = 'my-constellations';
  name = 'My Constellations';
  description = 'Custom star field with connecting lines';

  private ctx: CanvasRenderingContext2D | null = null;
  private stars: Array<{ x: number; y: number; phase: number }> = [];

  defaultConfig = {
    color: '#a855f7',
    intensity: 0.3,
    size: 1.0,
    speed: 1.0,
  };

  init(canvas: HTMLCanvasElement, config: EffectConfig) {
    this.ctx = canvas.getContext('2d');
    // Generate stars based on canvas size
    this.stars = Array.from({ length: 100 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  render(dt: number, config: EffectConfig) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Draw stars + connections using config.color, config.intensity, etc.
  }

  resize(w: number, h: number) {
    // Regenerate star positions for new dimensions
  }

  destroy() {
    this.ctx = null;
    this.stars = [];
  }
}
```

---

## Built-in Effects (Initial)

| Effect | ID | Renderer | Description |
|--------|----|----------|-------------|
| CSS Glows | `none` | CSS | Positioned radial gradients per theme — always active as baseline |
| Constellations | `constellations` | Canvas 2D | ~100 star points, drifting slowly, connected by fading lines |
| Synapse | `synapse` | Canvas 2D | Grid of 24 nodes with pulsing connection lines |
| Aurora | `aurora` | WebGL GLSL | Flowing color bands using Perlin noise (post-MVP) |
| Sparkles | `sparkles` | Canvas 2D | Scattered sparkle points fading in/out (post-MVP) |

---

## CSS Layer (Zero-JS Ambient)

The CSS layer is always active, even before JavaScript loads. It uses `--bg-effect-*` custom properties set by `themeManager.ts` (or `tokens.css` defaults pre-hydration).

### In `tokens.css`:

```css
--bg-effect-effect: none;
--bg-effect-color: var(--accent-primary-color, #6366f1);
--bg-effect-intensity: 0;
--bg-effect-size: 1;
--bg-effect-speed: 1;
```

### In `app.html` `<style>`:

```css
body {
  background:
    /* Top accent glow */
    radial-gradient(circle at 50% 0%,
      color-mix(in srgb, var(--bg-effect-color)
        calc(var(--bg-effect-intensity) * 50%), transparent),
      transparent 34rem
    ),
    /* Bottom accent glow */
    radial-gradient(circle at 50% 100%,
      color-mix(in srgb, var(--bg-effect-color)
        calc(var(--bg-effect-intensity) * 30%), transparent),
      transparent 28rem
    ),
    /* Base dark gradient */
    linear-gradient(180deg, var(--surface-app) 0%,
      var(--surface-sunken) 100%);
}
```

For light themes, `--bg-effect-intensity: 0` makes the glows invisible — zero overhead.

---

## Persistence

| Data | Storage | Key |
|------|---------|-----|
| Effect per theme (user override) | Theme preferences API | `ambient.effect` |
| Effect config overrides | Theme preferences API | `ambient.color`, `.intensity`, etc. |
| Custom effect source code | IndexedDB | `wabi-effects` store |
| Global vs per-theme toggle | Theme preferences API | `ambient.globalOverride` |

Custom effect sources are stored in IndexedDB so they survive reload and work offline. Built-in effects are bundled in the JS and need no persistence.

---

## File Map

### New files

| File | Purpose |
|------|---------|
| `src/lib/effects/types.ts` | `AmbientEffect`, `EffectConfig`, `AmbientConfig` types |
| `src/lib/effects/registry.ts` | Global effect registry singleton |
| `src/lib/effects/AmbientBackground.svelte` | Canvas host component |
| `src/lib/effects/EffectsTab.svelte` | Settings UI sub-section |
| `src/lib/effects/built-in/constellations.ts` | Constellations effect |
| `src/lib/effects/built-in/synapse.ts` | Synapse grid effect |
| `src/lib/effects/built-in/aurora.ts` | Aurora effect (future, WebGL) |
| `src/lib/effects/built-in/sparkles.ts` | Sparkle effect (future) |

### Modified files

| File | Change |
|------|--------|
| `src/lib/theme/themeTypes.ts` | Add `AmbientConfig`, `ambient` to `Theme` |
| `src/lib/theme/buildTokens.ts` | Add `ambient` to `BasePalette`, pass through |
| `src/lib/theme/palettes.ts` | Assign ambient config per palette |
| `src/lib/theme/themeManager.ts` | Set `--bg-effect-*` CSS vars |
| `src/styles/tokens.css` | Add `--bg-effect-*` defaults |
| `src/app.html` | Apply CSS ambient glow using tokens |
| `src/lib/components/Settings.svelte` | Add effects sub-section to Appearance |

---

## Principles

1. **CSS first** — ambient glows work before any JS loads. Canvas effects are enhancement only.
2. **No lock-in** — the plugin interface means anyone can write and import effects. Built-in effects are just pre-registered plugins.
3. **Performance conscious** — Canvas 2D at 20-30fps, WebGL only for GPU-heavy effects, `prefers-reduced-motion` kills the canvas layer entirely.
4. **Security** — Canvas 2D and WebGL are sandboxed by the browser. No `toDataURL()` readback. No network access from shader code. CSS `radial-gradient` is inert.
5. **Theme-coupled** — each theme defaults to an appropriate effect. Users override per-theme or globally. Light and high-contrast themes default to `effect: 'none'` (CSS glows only).
