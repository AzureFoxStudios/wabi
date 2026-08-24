# t_0d0ee684 — Whiteboard board-space layer raster cache

## What changed

File: `frontend/src/lib/whiteboard/boardRenderer.ts` (renderer-only; no store/sync/tool changes).

The previous `renderLayersWithBlend()` allocated one offscreen canvas **per layer sized to the
screen canvas** (`canvasW × canvasH × dpr`) and rasterized it with
`scale(dpr)·scale(zoom)·translate(-vp)`. Because `contentKey` included
`viewport.x:y:zoom`, *every* pan-step and wheel-tick invalidated the key for **every visible
layer**, forcing a full re-rasterization of all vector content at device resolution each frame —
the whiteboard's main lag source.

New design:

1. **Board-space rasterization.** Each visible vector layer is rasterized once into an offscreen
   canvas sized to that layer's **content bounding box + `LAYER_MARGIN` (256 board units on each
   side)**, at backing resolution `contentW·dpr × contentH·dpr`. Rasterization uses
   `scale(dpr)·translate(-originX,-originY)` only — the viewport is never applied
   (`rasterizeLayerToCanvas`, `getElementBBox`, `computeLayerBBox`).
2. **Content-identity cache key.** `contentKey = blendMode:dpr | <per-element id:updatedAt:zIndex:opacity:locked joined>`.
   The viewport (`x/y/zoom`) is **absent**. `getLayerCanvas` recreates the bitmap only when the
   layer id is new **or** its bbox/margin/content size/blend/dpr change.
3. **Composite by blit.** At composite time the main (already `dpr`-scaled) context is given
   `scale(zoom)·translate(-vp.x,-vp.y)`, then `drawImage(bitmap, originX, originY, contentW, contentH)`.
   Pan/zoom now changes only this transform — one blit per cached layer, zero re-rasterization.
4. **Opacity is never in the key.** Layer opacity is applied via `globalAlpha` at composite, so the
   opacity slider recomposites off the cached bitmap without re-rasterizing.
5. **Orphaned elements** (layerId not in `layers`) still render at the bottom in source-over via the
   unchanged `drawElementsToCtx(ctx, orphaned, viewport, 1)` path.
6. **Empty layers** allocate no offscreen canvas (`continue` before any cache access).
7. **Eviction.** After the loop, cache entries for layers that no longer exist **or** whose element
   set became empty are dropped. Additionally `MAX_CACHED_LAYER_BITMAPS = 8` bounds total cached
   bitmaps via least-recently-used eviction (`enforceLayerCacheCap`, `layerCacheClock`).

The `layer.mode === 'raster'` path is untouched (renders directly to the main context as before).
The `renderLayersWithBlend` signature (incl. unused `canvasW`/`canvasH`) is unchanged so
`export.ts` and `WhiteboardCanvas.svelte` need no edits.

## Why output is pixel-identical

`rasterizeLayerToCanvas` reuses the exact same element renderers (`drawSortedElements` →
`renderStroke`/`renderLine`/…) and the same `scale(dpr)` backing resolution as the old code. The
old path drew elements with `scale(dpr)·scale(zoom)·translate(-vp)` and then `drawImage(off,0,0,W,H)`
1:1. The new path draws the bitmap at `scale(dpr)·scale(zoom)·translate(-vp)` with the bitmap
anchored at its board rect. Both map a board point `bx` to device pixel `dpr·zoom·(bx−vp.x)`, so the
composited result is identical. Concretely:

- **Pan** (zoom constant): the bitmap is translated only — **bit-for-bit identical**, and no
  re-rasterization occurs.
- **Zoom = 1** (resting state): 1:1 blit — **bit-for-bit identical** to the old code.
- **Zoom change**: the cached bitmap is uniformly scaled at composite. Because it was rasterized at
  the full `dpr` backing density, this is visually equivalent to a direct `scale(dpr)·scale(zoom)`
  draw (any difference is sub-pixel antialiasing only). The zoom is intentionally kept out of the
  cache key (per the task), so continuous zoom reuses the bitmap — the documented tradeoff for
  turning zoom into a single blit.

### Export path (`exportBoardAsPng`)
Still calls `renderLayersWithBlend` with `zoom=1, dpr=1` and a synthetic viewport
`(bounds.x−padding, bounds.y−padding)`. With `dpr=1`, the bitmap is 1:1 and the viewport transform
places content at `bx − vp.x`, i.e. `(bx−bounds.x)+padding` — matching the prior export layout. The
256-unit margin only adds transparent padding; element positions are unchanged.

## Staleness analysis (how stale-pixel bugs are avoided)

| Trigger | Mechanism | Stale pixels? |
|---|---|---|
| **Element move** | New geometry → `updatedAt` changes → `contentKey` changes → layer re-rasterized. Bbox may also shift → canvas recreated if `originX/originY/contentW/H` differ. | No |
| **Resize** | Geometry/width/height change → `updatedAt` changes → re-raster; bbox change recreates bitmap. | No |
| **Reorder** (`zIndex`) | `zIndex` is in `contentKey` → re-raster in correct draw order. | No |
| **Undo / redo** | Elements are replaced/patched → `id`/`updatedAt`/geometry change → `contentKey` changes → re-raster. | No |
| **Layer opacity slider** | Opacity is **not** in `contentKey` (applied via `globalAlpha` at composite) → bitmap reused, recomposited at new alpha. No re-raster needed; no stale content. | No |
| **Blend-mode change** | `blendMode` is in `contentKey` → bitmap re-rasterized (and recreated if needed); blend is also applied at composite via `globalCompositeOperation`. Correct, no stale blend. | No |

Empty-layer and deleted-layer eviction guarantees a layer that sheds all elements cannot keep
serving a stale bitmap, and the 8-layer LRU cap bounds memory.

## Verification

- `npx svelte-check --tsconfig ./tsconfig.json` → **0 errors** (172 pre-existing warnings outside
  whiteboard scope, unchanged).
- `STATIC_BUILD=1 npx vite build` → **succeeds** (only pre-existing `INEFFECTIVE_DYNAMIC_IMPORT`
  warnings, unrelated to this change).

## Commit

- SHA: `bf5c78b`
- Committed file: `frontend/src/lib/whiteboard/boardRenderer.ts` only (report at `docs/reports/t_0d0ee684-report.md`).
