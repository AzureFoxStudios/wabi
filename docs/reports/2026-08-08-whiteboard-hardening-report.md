# 2026-08-08 — Whiteboard Collab Hardening + Export/Quality + Cleanup (Wave 5, Phases 6–8)

Finalization pass over the Phase 0–4 whiteboard work. Tightens collab correctness
(patch coalescing, reconnect gating, conflict recovery), fixes export/renderer
quality (DPR-correct blend compositing, image-failure safety, SVG export), and
cleans up dead imports.

Scope respected: only `boardSync.ts`, `boardSocket.ts`, `boardStore.ts`,
`boardRenderer.ts`, `export.ts` were modified. `coords.ts`, `layers.ts`,
`tools.ts` were verified but needed no change. `mathRecognition.ts`,
`mathTemplates.ts`, `mathRender.ts`, all `.svelte` files, and `core/**` were
untouched.

---

## 1. Patch protocol batching (`boardSync.ts`)

**Found:** `emitUpdatePatch` sent one `whiteboard:patch` per mutation. Move/resize
drags call `boardStore.updateElement(..., { recordHistory: false })` on every
pointer move (tools.ts `createMoveInteraction`/`createResizeInteraction`), so a
single drag spammed N patches.

**Changed:**
- Added a per-board pending buffer: `Map<boardId, Map<elementId, { changes, timer }>>`.
- `emitUpdatePatch` merges changes for the same element id into one entry; only
  the first call schedules a 50ms flush timer (`PATCH_COALESCE_MS`). Merged
  changes are sent once the timer fires or when `flushSnapshotSave` runs
  (`flushPendingUpdates` called at the top of `flushSnapshotSave`).
- `clearPendingUpdates(boardId)` drops buffered patches (used on disconnect,
  conflict, and session destroy).

**Author stamping — SKIPPED, verified:** the socket layer already stamps the
author server-side. `core/crates/wabi-server/src/socketio/whiteboard_ops.rs`
`on_whiteboard_patch` attaches `"userId": "user-<id>"` to the
`whiteboard:patch` broadcast (verified lines 369–383). Adding a client-side
`author` would be redundant and could be spoofed; the transport already carries
`userId` on every `WhiteboardPatchPayload`.

## 2. Reconnect correctness (`boardSocket.ts` + `boardSync.ts`)

**Found:** the reconnect path did re-join active boards (`connected` →
`rejoinActiveBoards()` → server re-pulls the doc and emits `whiteboard:joined`),
but `boardSyncReady` was only reset on `onLeft` / session destroy. During a
disconnect/reconnect window components could keep drawing on stale state.

**Changed:**
- Added `onDisconnect?: () => void` to `WhiteboardEventHandlers`; wired the
  existing `connected` store subscription in `subscribeWhiteboardEvents` to fire
  it when the socket transitions to disconnected (fires on `io server/client
  disconnect`, ping timeout, transport close — the SocketManager sets
  `connected = false` on every transition away from `connected`).
- In `createSyncSession`, `onDisconnect` now sets `boardSyncReady.set(false)`
  and drops coalesced patches (the server doc wins after the fresh join).
  `onJoined` remains the only place that sets `boardSyncReady.set(true)` — always
  after a fresh `whiteboard:joined` that re-hydrates via `setDocument`.
- Double-join guard: `joinWhiteboardChannel` now no-ops when the board is already
  in `activeBoards` (was emitting a duplicate `whiteboard:join`). Added
  `rejoinWhiteboardBoard(boardId)` which always emits, used by the
  VERSION_CONFLICT recovery path (which must re-pull even while active).
  `rejoinActiveBoards` was refactored onto the shared `emitWhiteboardJoin`.

## 3. Conflict safety (`boardSync.ts`)

**Found:** VERSION_CONFLICT already re-joined, but the debounced snapshot timer
was left running and pending patches were not cleared, so stale local state
could still be flushed after the server doc was re-pulled. No loop protection on
the re-join.

**Changed:**
- On VERSION_CONFLICT the server doc wins: `clearPendingUpdates(boardId)` +
  `cancelSnapshotSave(boardId)` + `boardStore.markClean()` before re-joining.
  (`setDocument` already sets `isDirty: false` and rebuilds elements/layers from
  the payload — verified boardStore.ts `setDocument`.)
- Re-join loop guard: `conflictRejoinAt` sliding window — at most 3 re-joins
  within 10s. Beyond that, `boardSyncError` is set to the persistent
  `'Sync failed — reload the board.'` and no further re-joins are attempted.
- Session `destroy()` now also calls `clearPendingUpdates`.

## 4. Renderer quality (`boardRenderer.ts`)

### DPR fix (real bug, fixed)
**Found:** `getLayerCanvas` sizes each layer's offscreen canvas at
`CSS size × dpr` backing pixels, but `drawElementsToCtx` drew element geometry
into it with only `scale(viewport.zoom)` — **no dpr scale**. On a dpr-2 display
the layer raster occupied the top-left CSS-pixel-sized region of the backing
store at 1:1, then `ctx.drawImage(off.canvas, 0, 0, canvasW, canvasH)` stretched
that low-res region to fill the composited canvas → blur + content offset for
blended layers (and exports).

**Fix:** `drawElementsToCtx(ctx, els, viewport, dpr = 1)` now applies
`ctx.scale(dpr, dpr)` *first*, then `scale(zoom)`, then `translate(-vp)` — the
exact transform the main canvas uses (`baseCtx.scale(dpr)` in the render loop,
then zoom/translate), so offscreen layer pixels match screen device pixels.
Call sites:
- offscreen layers: `drawElementsToCtx(off.ctx, els, viewport, dpr)` (device-res
  rasterization).
- orphaned elements drawn straight onto the already-dpr-scaled main ctx:
  `drawElementsToCtx(ctx, orphaned, viewport, 1)`.
- export path calls `renderLayersWithBlend(..., dpr = 1)` on a full-resolution
  canvas, so output is crisp and self-contained.

### Image failure safety
`renderImage` now wraps `ctx.drawImage` in `try/catch` (a tainted/failed
cross-origin image can throw and previously would take down the whole render
loop) and falls back to a dashed placeholder box via the new
`drawImagePlaceholder`. The loading-state placeholder path is unchanged.

## 5. Export correctness (`export.ts`)

### PNG now uses `renderLayersWithBlend`
**Found:** `exportBoardAsPng` called `renderElements`, so per-layer blend modes
and per-layer opacity were dropped from exports.

**Changed:** switched to `renderLayersWithBlend(ctx, elements, viewport, layers,
width, height, 1)` with the export viewport `{ x: bounds.x - padding,
y: bounds.y - padding, zoom: 1 }`. The export canvas is sized at full export
resolution (bounds + 2×32px padding; no dpr downscaling), matching the live
render loop's canonical compositing path.

### `exportBoardAsSvg` (new)
`export function exportBoardAsSvg(boardDocument: BoardDocument): void` — builds a
dependency-free, deterministic SVG string:
- `<svg>` sized to the same bounds+padding as the PNG export, white background.
- Elements sorted by (layer order, zIndex); hidden layers excluded; orphaned
  elements (unresolved layerId) render at the bottom; each visible layer wrapped
  in a `<g opacity="…">`, each element in a `<g opacity="…">` when its own
  opacity < 1.
- Shapes: `<polyline>` per stroke (points scaled/translated to the export bbox),
  `<line>` for lines, `<rect>` (with `rx` for borderRadius), `<ellipse>`,
  `<line>` + `<polygon>` head(s) for arrows (respects `arrowHead` end/both).
- `<text>` with `<tspan>` per line for text elements (fontSize/fontFamily/
  textAlign honored); `<image href>` for image elements (best-effort — protected
  images need auth, noted as an XML comment).
- Math elements: skipped as an XML comment and rendered as a muted-gray LaTeX
  `<text>` fallback so the content isn't lost.
- All text XML-escaped; coords rounded to 3 decimals (`fmtNum`) for
  determinism. Download via the existing `downloadBlob` helper as
  `<boardId>.svg`.

## 6. Zoom/handle correctness (`coords.ts`)

**Verified — no change needed:**
- `getSelectionHandles` computes handle positions in **screen space** via
  `boardToScreen`; the `size` argument is unused inside (render-only). The 8px
  draw size lives in `renderHandles` (boardRenderer.ts) and is a constant screen
  rect — never multiplied by zoom. At zoom 0.1–10 handles stay 8px on screen and
  separate (spacing scales with zoom as expected).
- `hitTestHandle(handles, sx, sy, 12)` (tools.ts `createSelectTool`) is a plain
  screen-space `<= half` box test against the 8px handle centers — 12px hit
  tolerance is constant screen space, not zoom-scaled. Correct.
- `clampZoom` (0.1–10) is **applied**: `boardStore.zoomTo` delegates to
  `boardViewport.zoomTo`, which clamps inline with `Math.max(0.1, Math.min(10,
  zoom))`. (`boardViewport.ts` is outside the allowed scope, so the existing
  inline clamp was left as-is rather than rewired to the shared `clampZoom`
  helper — behavior is identical.)

## 7. Cleanup

- **Unused imports removed:** `boardSocket.ts` → `get` from `svelte/store`;
  `boardStore.ts` → `generateElementId`, `createLayerId`,
  `DEFAULT_WHITEBOARD_LAYER_ID`, `resolveWritableWhiteboardLayerId`,
  `sortWhiteboardLayers`. All other imports across the 8 files verified in use
  (svelte-check reports zero whiteboard warnings).
- **BoardState dedup — assessed, not applied:** the canonical `BoardState` lives
  in `boardStore.ts`. Local copies exist in `boardElements.ts`,
  `boardLayerOps.ts` (identical element/layer/undo subsets),
  `boardSelection.ts` ({elements, layers, selection}) and `boardViewport.ts`
  ({viewport}) — all are **structurally-compatible subsets** of the canonical
  type, so `import type { BoardState } from './boardStore'` would typecheck
  (type-only imports are erased, so no runtime cycle even though boardStore
  imports these modules at runtime). Those four files are **outside the allowed
  scope** for this pass and the scoped commit, so the dedup was left as a
  documented recommendation rather than applied. The `toState()` cast in
  boardStore.ts intersects all four local types, which keeps the current
  call sites valid.
- **`as unknown as` transport casts — assessed, kept:** `toTransportElement` /
  `fromTransportElement` (elementTypes.ts) bridge `BoardElement` ↔ the loose
  `WhiteboardElement extends Record<string, unknown>` wire type via
  `{ ...el } as unknown as …`. A full typed mapping buys nothing (the wire type
  is intentionally open so unknown element fields round-trip), and
  `elementTypes.ts` is outside the allowed scope. Left as-is.

## Verification

- `bun run check` (from `/var/home/Ronin/wabi/frontend`):
  - Before: 7 errors (6 × `Cannot find module 'bun:test'/'bun'` + 1 peer i18n
    type mismatch), 80 warnings.
  - After: **6 errors (only the known `bun:test`/`bun` declaration errors; the
    peer i18n error did not reproduce this run), 80 warnings — identical warning
    count, zero new errors, zero whiteboard warnings.**
- `node --experimental-strip-types` import of `export.ts`: **fails on module
  resolution**, not DOM. Node ESM requires explicit `.ts`/extension-ful paths and
  cannot resolve the repo's extensionless relative imports or `$lib/` aliases
  (`boardRenderer` → `$lib/authSession`/`$lib/serverUrl`). This is a resolution
  limitation, not a DOM-at-module-scope problem — visual inspection confirms
  `export.ts` module scope is import/function declarations only; all DOM usage
  (`document`, `URL`, `Blob`) is inside function bodies that run only when a
  export is invoked.
- No whiteboard unit tests exist (`bun test src/lib/whiteboard` finds none), so
  there is no test suite to regress.

## Files changed (scoped commit)

`boardSync.ts`, `boardSocket.ts`, `boardStore.ts`, `boardRenderer.ts`,
`export.ts` (+ this report). `coords.ts`, `layers.ts`, `tools.ts`: verified,
no change.
