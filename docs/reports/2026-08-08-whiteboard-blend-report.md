# 2026-08-08 — Whiteboard Layer Blend Modes (Wave 2b, Phase 2)

Layer compositing + UI for the blend mode field added to `WhiteboardLayer`
in the Wave 2b types layer (Phase 1, already committed): `blendMode: string`
(default `'source-over'`), `WHITEBOARD_BLEND_MODES`, and normalization in
`layers.ts`.

## Files changed

| File | Change |
|------|--------|
| `frontend/src/lib/whiteboard/layers.ts` | **Additive only.** New `BLEND_MODE_LABELS: Record<string,string>` mapping the 10 modes to display labels (source-over → "Normal", soft-light → "Soft Light", …) and `blendModeLabel(mode)` which falls back to humanizing the string (`-`/`_` → space, capitalized words). No existing export changed. |
| `frontend/src/lib/whiteboard/boardRenderer.ts` | **Additive only.** New exported `renderLayersWithBlend(ctx, elements, viewport, layers, canvasW, canvasH, dpr)` plus two private helpers. `renderElements` internals were NOT touched (a brush-engine worker edits this file in parallel). Also imports `WHITEBOARD_BLEND_MODES` from `./layers`. |
| `frontend/src/lib/components/WhiteboardLayerPanel.svelte` | Blend mode dropdown in the active-layer card ("Blend", labeled, mirrors the Opacity row) and a compact per-row select in the layer list. Options come from `WHITEBOARD_BLEND_MODES`, labels from `blendModeLabel`. Changing the mode calls `boardStore.updateLayer(id, { blendMode: mode })` — the same update path opacity/visibility already use (`setLayerOpacity` → `updateLayer`). Styling uses the panel's existing tokens (`--surface-app`, `--text-muted`, `--text-inverse` mixes). Shown for all layer kinds (simplest consistent UX; background/reference layers simply keep "Normal"). |

## Compositing approach

`renderLayersWithBlend` is the new canonical render path:

1. Group elements by `layerId`; elements whose layerId no longer resolves to a
   provided layer render first (bottom) in source-over — mirrors
   `renderElements`' layer-order-0 default.
2. Sort layers with `sortWhiteboardLayers` (ascending `order`), so rendering is
   strictly bottom-to-top.
3. For each visible layer with elements:
   - Rasterize the layer onto a cached per-layer `OffscreenCanvas` via
     `drawElementsToCtx` (elements sorted by `zIndex`, per-element `opacity`
     applied with `globalAlpha`).
   - `drawImage` the offscreen onto the main context with
     `globalAlpha = layer.opacity` and
     `globalCompositeOperation = layer.blendMode`.
   - Reset to `globalAlpha = 1`, `globalCompositeOperation = 'source-over'`
     after every layer.
4. The grid is NOT part of any layer — callers render it on the main canvas
   before invoking `renderLayersWithBlend` (the existing loop already does
   grid-then-elements).

`drawElementsToCtx` is a private copy of the element-drawing loop (no layer
filtering/opacity) so `renderLayersWithBlend` never depends on
`renderElements`' internals.

## Offscreen caching strategy

Module-level `layerCanvasCache: Map<layerId, {canvas, ctx, width, height, dpr}>`.
A cache entry is reused when the layer id matches AND the requested
`canvasW×canvasH×dpr` matches; otherwise the canvas is recreated. Full re-renders
on element/layer changes come from the existing render loop, so the cache only
avoids canvas allocation/GC churn, not redraws. Entries for layers that no longer
exist are pruned after each render.

Used `document.createElement('canvas')` rather than the `OffscreenCanvas` class
for the widest DOM/WebKit support (Tauri's WebKitGTK). The offscreen is sized in
device pixels (`width*dpr × height*dpr`) and drawn back at CSS-pixel size
(`canvasW × canvasH`) into the already-dpr-scaled main context, so output stays
crisp.

`blendMode` is defensive-checked against `WHITEBOARD_BLEND_MODES`; anything
unknown falls back to `'source-over'` (normalization in `layers.ts` already
guarantees this).

## Verification

`bun run check` from `frontend/`: **zero NEW errors**. The only errors are the
known pre-existing ones — 6× `bun:test`/`bun` module resolution in the DM-crypto
and docking test files, plus one unrelated i18n type mismatch caused by the
uncommitted `en.json` edits from the parallel PWA session (not this diff).
No whiteboard-related errors.

## Notes / decisions

- Additive-only was a hard requirement (brush worker owns `boardRenderer.ts` in
  parallel): one new export + two private helpers, no signature/behavior change
  to `renderElements`.
- Blend selector is shown for all layer kinds — background layers get a "Normal"
  dropdown too, which is harmless and keeps the panel consistent.
- `renderLayersWithBlend` is exported but the live render loop
  (`WhiteboardCanvas.svelte` / `whiteboardCanvasHelpers.ts`) is out of scope for
  this wave; switching the loop over is a follow-up.
