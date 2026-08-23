# t_b9305f6f — Raster commits upload dirty-rect crop with board-space offset

## Summary

Paint (raster) layers no longer upload the entire 4096×4096 bitmap on every
stroke end. `commitRasterLayer` crops only the dirty bounding box (accumulated
from every dab painted since the last commit, inflated by the stamp radius) to a
temp canvas and uploads that. The crop's top-left position in board space is
persisted as `assetOffsetX` / `assetOffsetY` on the layer so hydration can place
it back correctly.

## Files changed

- `frontend/src/lib/whiteboard/boardTypes.ts` — added optional `assetOffsetX` /
  `assetOffsetY` to `WhiteboardLayer`.
- `frontend/src/lib/whiteboard/layers.ts` — `normalizeWhiteboardLayer` now
  carries `assetOffsetX` / `assetOffsetY` through; absent fields normalize to
  `undefined` (legacy shape).
- `frontend/src/lib/whiteboard/rasterLayers.ts` — dirty-rect tracking
  (`rasterDirtyBounds`), `paintRasterDab` expansion, cropped `commitRasterLayer`,
  offset-aware `hydrateRasterLayer`, bounds reset after commit.

Untouched (per constraints): `tools.ts`, `boardRenderer.ts`,
`imageImports.ts`.

## How it works

- **Dirty bounds**: `expandDirtyBounds(layerId, x, y, reach)` where `reach =
  effectiveSize / 2` accumulates `min/max` x/y in board (= bitmap pixel)
  coordinates for every dab, including soft-edge radius. Resets on commit.
- **Commit**: crops `[minX,minY,maxX,maxY]` (floored/ceiled, clamped to 4096) to
  a temp canvas, uploads it, and writes `assetOffsetX/Y = minX/minY` and
  `pixelWidth/Height = crop size`. If no dirty rect exists, falls back to the
  full bitmap (offset 0,0) — preserving prior behavior.
- **Hydrate**: reads the layer from `boardStore` and, when offsets are present
  AND pixel dimensions are smaller than the bitmap, draws the image at
  `(assetOffsetX, assetOffsetY)`; otherwise stretches to the full 4096×4096
  (legacy path).

## Hydration walkthrough

### New-format layer (offsets present)
Board persisted with `assetOffsetX = 512`, `assetOffsetY = 384`,
`pixelWidth = 200`, `pixelHeight = 160`.
On `setDocument`, `hydrateRasterLayer(layer.id, assetUrl)` fetches the cropped
PNG (200×160). It looks up the layer in `boardStore`, sees numeric offsets and
`pixelWidth < 4096`, so it draws `image` at `(512, 384)` into the blank 4096
bitmap. `renderRasterLayer` then blits the full bitmap at board origin; the
stroke appears exactly where it was painted. ✓

### Legacy layer (offsets absent)
Board persisted before this change: `pixelWidth = 4096`, `pixelHeight = 4096`,
no `assetOffsetX/Y` (`undefined`).
Hydration fetches the full-bitmap PNG and, because offsets are not numbers,
takes the `else` branch and draws `image` stretched to `RASTER_WIDTH × RASTER_HEIGHT`
(0,0 → 4096,4096) — identical to the previous behavior. ✓

## Verification

- `npx svelte-check --tsconfig ./tsconfig.json`: 0 errors.
- `STATIC_BUILD=1 npx vite build`: success.

## Known limitation

The committed asset holds only the latest dirty crop (offset replaces prior
commits). A reload after multiple non-overlapping strokes in a session will
restore only the most recently committed region. The in-session working bitmap
remains authoritative; this is a consequence of the single-asset / unchanged
upload-API constraints in scope.
