# 2026-08-08 — Whiteboard Brush Engine (Wave 2a, Phase 1)

Real brush feel for the pen tool: pressure-aware variable width, Catmull-Rom
stroke smoothing, hardness (soft edges), and a compact brush settings UI.

Persistence/socket layer was out of scope — `boardStore.ts` was touched only to
grow the `BoardStyle` type (the one allowed boardStore edit).

## Files changed

| File | Change |
|------|--------|
| `frontend/src/lib/whiteboard/tools.ts` | Added exported pure helpers `smoothStrokePoints(points, tension=0.5, segments=6)` (centripetal Catmull-Rom, sampled 6×/segment) and `strokeWidthAt(pressure, size, minSize=0.4)`. Pen tool now thins input to ~1.5px in board space, smooths the **live preview** and the **committed** stroke identically (WYSIWYG). `makeBase` now copies `opacity`, `hardness`, and `brushPreset` from style into every new element. Removed the old `simplifyPoints`/raw-polyline commit path. |
| `frontend/src/lib/whiteboard/boardRenderer.ts` | `renderStroke` uses pressure-driven width, round caps/joins (already present), and hardness-driven soft edges. When any point carries pressure, width varies via a deterministic per-segment **filled-quad** strip (no alpha overlap seams); otherwise the legacy quadratic-through-midpoints path is kept for old strokes. `shadowBlur = (1 - hardness) * size * 2` when `hardness < 0.999`, else 0. `shadowBlur`/`shadowColor` are always reset after the stroke so they don't leak into other elements. Imports `strokeWidthAt` from `./tools` (no import cycle). |
| `frontend/src/lib/whiteboard/whiteboardCanvasHelpers.ts` | Event factory: mouse pointer types report pressure 0.5 by spec, so mouse input is now coerced to pressure `1` (full width, preserving prior behavior). Pen/touch use real pressure, clamped to [0,1], falling back to `1` when no pressure is reported. |
| `frontend/src/lib/whiteboard/elementTypes.ts` | `DEFAULT_STYLE` extended additively with `opacity: 1` and `hardness: 1`; default `strokeWidth` bumped 2 → 4 to match the new size slider's documented default. |
| `frontend/src/lib/whiteboard/boardStore.ts` | `BoardStyle` gained `opacity: number` and `hardness: number` (required fields; both default to 1 via `DEFAULT_STYLE` in `defaultState()`). No other boardStore changes. |
| `frontend/src/lib/components/WhiteboardToolbar.svelte` | New compact brush settings row shown only for the pen tool: Size (1–64px, default 4 → `style.strokeWidth`), Hardness (0–100% → `style.hardness`), Opacity (10–100% → `style.opacity`). Uses design tokens (`--surface-raised`-adjacent mixes, `--text-muted`, `--accent-primary`, `--radius-sm`). Shape tools keep the old width-preset buttons. |

## Width mapping formula

```
width(p) = size * (minSize + (1 - minSize) * p)
  size    = element.strokeWidth (the "Size" slider, px)
  minSize = 0.4 (constant, configurable later)
  p       = normalized pressure, clamped to [0,1]; undefined → 1
```

Reference widths (size = 4): p=0 → 1.6px, p=0.5 → 2.8px, p=1 → 4px.
Rendered radius per sample = `width(p) / 2`.

## Smoothing approach

- **Input thinning:** new pen points are appended only when ≥ 1.5px (board space)
  from the last kept point.
- **Centripetal Catmull-Rom** (knot spacing = `distance^0.5`) evaluated in cubic
  Hermite form, so uneven input spacing doesn't produce loops/overshoot.
- **Tension** scales the tangent vectors (`1 - tension`): default 0.5 for soft
  rounding; 0 = classic Catmull-Rom, 1 = straight segments.
- **Sampling:** 6 interpolated points per input segment (within the 4–8 target).
- **Pressure** is linearly interpolated along each segment; both endpoints are
  clamped to exact input points so the stroke starts/ends under the cursor.
- Both the committed element and the interaction preview call
  `smoothStrokePoints` on the same raw points → identical geometry.

## Notes / decisions

- **Variable-width render:** chose per-segment filled quads over overlapping
  circles because overlapping fills create visible darker seams when element
  opacity < 1 (globalAlpha). Quads are deterministic and opacity-correct.
- **Mouse strokes:** coerced to pressure 1 so mouse drawing matches the old
  full-width behavior instead of the spec's default 0.5 → 70% width.
- **Old persisted strokes:** hardness is backward compatible (undefined → 1).
  Legacy strokes baked with pressure 0.5 will render at ~70% width via the
  pressure path — acceptable, and this wave's persistence layer runs in parallel.
- **Toolbar CSS:** `.wb-brush-settings` must not share a static class with the
  `{:else}` branch element — Svelte 5 prunes branch-specific classes in that
  case (verified in the compiler output); giving the two branches distinct
  classes keeps the rule in the build.
- No exported function names changed; two new exports added
  (`smoothStrokePoints`, `strokeWidthAt`) for unit-testability (pure functions).

## Verification

`bun run check` (from `frontend/`):

```
svelte-check found 7 errors and 80 warnings in 44 files
```

Identical to the pre-change baseline — 6 × `bun:test`/`bun` module-not-found
errors (known, ignore) + 1 pre-existing `i18n/index.ts` type error. No new
errors and no new warnings were introduced by these files. Pure-function sanity
checks (`strokeWidthAt` mapping/clamping, smoothing determinism, single/two/three
point handling, finite pressure output) pass in a standalone Node harness.
