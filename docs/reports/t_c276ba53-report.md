# t_c276ba53 — Lazy right-sized raster bitmaps

Commit: ae764e2 (edit by hy3-free worker, commit + verification by orchestrator after worker hung on the commit step ~10min).

## What
- RASTER_WIDTH/RASTER_HEIGHT 4096 → 2048: 16MB per Paint layer instead of 64MB (4x reduction).
- paintRasterDab guard skips dabs whose center falls outside bitmap bounds.
- Crop/commit/hydration math flows through the constants — no other changes needed.

## Memory math
- Before: 4096×4096×4B = 64MB per layer bitmap (plus same-size stamp allocations avoided via stamp cache).
- After: 2048×2048×4B = 16MB per layer. Board with 3 Paint layers: 192MB → 48MB.

## Legacy assets
Saved boards with 4096-based committed assets hydrate through the legacy full-bitmap path (drawImage to RASTER_WIDTH/HEIGHT), which now downscales 4096px assets slightly to 2048. Acceptable softness; crop-offset path unaffected (offsets are board-space and still honored).

## Verification
- svelte-check: 0 errors (173 warnings, all pre-existing)
- Worker confirmed baseline build green; working-tree build failure it saw was from an out-of-scope uncommitted ChannelSidebar.svelte change in the shared tree, not this edit.
