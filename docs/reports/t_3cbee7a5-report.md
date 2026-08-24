# t_3cbee7a5 — Raster stroke undo checkpoints

Commit: 629ac47 (implemented by orchestrator/Hermes after hy3-free worker died mid-task; log frozen ~35min with no commit).

## What

- `rasterLayers.ts`: parallel raster undo stack (independent of the vector element stack). `beginRasterStroke(layerId)` snapshots the pixels under the current dirty bounds before the first dab; entries where the region was previously blank store rect-only (pixels=null) so fresh strokes never cost 64MB copies. Cap: 30 entries / 8MB, oldest evicted. `rasterUndo()` putImageData (or clearRect for blank regions), re-expands dirty bounds over the restored region, and bumps layer revision via `updateLayerSilent` — no vector-stack push, no patch emission.
- `tools.ts`: both raster tool entry points (`createRasterBrushTool`, `createRasterEraserTool`) call `beginRasterStroke` before their first dab.
- `WhiteboardCanvas.svelte`: Ctrl/Cmd+Z routes to `rasterUndo()` when the active layer is mode==='raster' AND the raster stack has entries; otherwise falls through to vector undo/redo as before. Raster redo is OUT OF SCOPE (documented below).

## Walkthroughs

- **paint → erase → undo ×3**: each stroke start snapshots the then-current dirty region. Undo #1 restores pre-erase pixels (putImageData), undo #2 restores pre-paint-2 pixels, undo #3 hits a blank-region entry → clearRect of that rect. Each undo re-dirties the restored region so the next snapshot-save commits corrected pixels and bumps revision.
- **Stack cap**: >30 entries or >8MB total evicts oldest (whole-entry shift). Evicted strokes are permanently un-undoable (same semantics as vector stack eviction).
- **Why blank-region entries avoid 64MB copies**: a stroke on never-before-touched bitmap area has nothing to restore — clearRect of the rect reproduces "before" exactly at zero pixel-copy cost.

## Caveats / deferred

- **Raster redo not implemented** (Ctrl+Shift+Z on a Paint layer falls through to vector redo, which is a no-op if only raster strokes happened). Entries ARE retained in rasterRedoStack internally for future wiring.
- Interleaving raster + vector undo is best-effort stack order (each stack independent); documented in card body as out of scope.
- Toolbar Undo button still routes to vector undo only — keyboard path covers the primary flow; button wiring noted as follow-up.

## Verification

- svelte-check: 0 errors (172 pre-existing warnings)
- STATIC_BUILD vite build: succeeds
