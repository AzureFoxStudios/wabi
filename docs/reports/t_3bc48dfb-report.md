# Report: t_3bc48dfb — Remote-cursor easing redraws overlay canvas only

## Commit

`d931f81` — `perf(whiteboard): cursor easing redraws overlay canvas only`

(Only `frontend/src/lib/components/WhiteboardCanvas.svelte` was committed.)

## What changed

`WhiteboardCanvas.svelte` had a single combined `render()` that redrew **both**
the base canvas (background color, grid via `renderGrid`, and full layer
compositing via `renderLayersWithBlend` / `renderElements`) and the interaction
canvas (draw preview, selection box/handles, remote cursors) on every
`requestAnimationFrame`.

The render loop was split:

- `renderBase()` — background fill, grid, and layer compositing onto `baseCanvas`.
- `renderOverlay()` — interaction preview, selection box/handles, remote cursors onto `interactionCanvas` (everything that used to run after the base section).
- `render()` now only dispatches to `renderBase()` / `renderOverlay()` based on
  two independent dirty flags (`baseDirty`, `overlayDirty`).
- `requestRender()` sets **both** flags (unchanged behavior for element / layer /
  viewport / selection / showGrid changes).
- `requestOverlayRender()` sets **only** `overlayDirty`.
- `stepCursors()` now calls `requestOverlayRender()` instead of `requestRender()`.

The single `animFrameId` + `renderScheduled` scheduling pattern was reused (one
RAF), and the perf logging was preserved with the same 60-sample sampling
pattern: base renders log as `[WhiteboardPerf] render`, overlay renders log as
`[WhiteboardPerf] overlay` (separate `overlaySamples`/`overlayTotalMs` counters).

All subscription / unsubscription lifecycle (`onDestroy` cleanup) and the
text-editing overlay, import HUD, and drag/drop handlers are untouched. Tools,
store, sync, and renderer code were not modified.

## Why cursor animation frames no longer run grid drawing or `renderLayersWithBlend`

`stepCursors()` is invoked from `requestAnimationFrame`, and it now calls
`requestOverlayRender()`, which sets only `overlayDirty = true` (leaving
`baseDirty` false). When the scheduled `render()` runs, the `baseDirty` guard is
false, so `renderBase()` is **not called at all** — the `baseCanvas` 2D context
is never obtained, never `save()`/scaled/`clearRect()`'d, `renderGrid` is never
invoked, and `renderLayersWithBlend`/`renderElements` are never invoked. Only
`renderOverlay()` runs, redrawing the interaction canvas (cheap: clear +
cursor shapes). The base canvas is left exactly as it was; nothing under the
moving cursors changed.

Result: a collaborator moving their cursor now triggers ~60 `renderOverlay()`
frames/sec on the interaction canvas instead of ~60 full board
`renderBase()`+`renderOverlay()` composites/sec — grid drawing and layer
compositing are skipped entirely on cursor-only frames.
