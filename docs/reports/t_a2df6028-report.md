# t_a2df6028 — RAF-batched whiteboard element updates

Commit: `0405a628a250e37cbacaf7d7ec44e884cc558821`

## What changed

Added `boardStore.updateElementsBatch(entries, { recordHistory })` — a batched
primitive implemented as `updateElementsBatch` in `boardElements.ts`. It performs a
single elements-array copy, applies every partial with the existing merge semantics
(layerId resolution via `resolveWhiteboardLayerId` + `updatedAt` bump), and emits one
`'update'` patch per element (shape `{ id, changes: partial }`) so the existing
`boardSync.emitUpdatePatch` coalescing by element id and `applyRemotePatch` case
`'update'` keep working unchanged.

The three gesture interactions in `tools.ts` were refactored to:

- accumulate target positions/points into a `pending` buffer during `onPointerMove`
  (move now tracks an absolute baseline per element instead of chaining incremental
  deltas, so each frame is self-contained),
- flush once per animation frame via `requestAnimationFrame` — if no RAF is scheduled,
  one is scheduled; it calls `updateElementsBatch` once with everything pending and
  clears the buffer,
- on `onPointerUp` cancel any pending RAF and flush synchronously so the final position
  lands before gesture end.

Preserved exactly: single `pushHistoryCheckpoint` at gesture start (`didStartMove` /
`didStartResize` / `didStartRotate` flags), `recordHistory: false` on the batched
updates, stroke point remapping formulas, resize clamp to min 8 units, rotate 15-degree
shift snapping. Renderer, raster layers, and sync code were untouched.

## Expected reduction ratio (20-element selection drag)

Before: each `pointermove` (~120/sec) called `updateElement` once per selected element,
so `20 × 120 = 2400` store updates/sec, each cloning the full elements array + bumping
version. After: at most one RAF flush per frame (~60/sec) applying all 20 elements in a
single array copy → `60` store updates/sec.

- Store mutations per second: `2400 → 60` → **~40× fewer** state transitions
  (and ~40× fewer full elements-array clones; one clone per batch instead of 20 per
  event).
- `bumpVersion` calls: `2400 → 60` per second (~40× fewer).
- Remote-sync patches: unchanged in count (coalesced per element in `emitUpdatePatch`),
  but produced from one transition instead of 20.

The win is proportional to selection size N: for the 20-element case the per-event
fan-out of N `updateElement` calls collapses to a single batched `updateElementsBatch`.

## Why undo still restores pre-gesture state

`pushHistoryCheckpoint()` (invoked once at gesture start via the `didStart*` flags)
captures a full undo snapshot of the elements/layers/activeLayerId as they were before
the first move. Every batched flush uses `recordHistory: false`, so no additional undo
entries are pushed during the drag — the undo stack still holds exactly one entry for the
whole gesture. Undo therefore pops that single checkpoint and restores the pre-gesture
element state; redo restores the final dragged state. The RAF batching changes only when
state is written, not what history is recorded.

## Verification

- `npx svelte-check --tsconfig ./tsconfig.json`: 0 errors (warnings pre-existing).
- `STATIC_BUILD=1 npx vite build`: succeeds.
