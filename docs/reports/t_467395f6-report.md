# t_467395f6 — Active-layer mode chip in toolbar

Commit: bd9dfe6 (hy3-free worker, orchestrator-verified).

## What
- Persistent chip inside the toolbar (before tool buttons): active layer name + Vector/Paint badge.
- Reactive via $activeLayerId + $layers; accent color for vector, info-blue for raster (matches layer panel conventions).
- Lives inside .wb-toolbar so it hides with the collapsed rail. No tools disabled by mode.

## Verification
- svelte-check: 0 errors
- STATIC_BUILD build: green
- Orchestrator diff review: chip placement, reactivity, and CSS conventions all correct.
