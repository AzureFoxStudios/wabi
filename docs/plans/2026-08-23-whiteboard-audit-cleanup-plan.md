# Whiteboard Cleanup Plan — Audit Follow-up (2026-08-23)

Audit of `frontend/src/lib/whiteboard/` + `Whiteboard*.svelte` on this date.
Verdict: architecture is sound (two-canvas + per-layer blend compositing is the
right shape); pan/zoom lag comes from one cache-key mistake, raster layers are
~80% done, toolbar carries ~350 lines of dead CSS from the old vertical strip.

No day estimates. Tasks only. Order matters within each phase.

---

## P0 — Performance

### T1. Board-space layer raster cache (fixes pan/zoom lag) — THE fix
- File: `frontend/src/lib/whiteboard/boardRenderer.ts`, `renderLayersWithBlend()` (~line 233).
- Bug: layer offscreen `contentKey` includes `viewport.x:y:zoom` → every
  wheel-tick re-rasterizes EVERY visible vector layer at canvas×DPR size.
- Fix:
  - Render layer content in BOARD space into an offscreen sized to the
    layer's content bbox (+ margin), not the screen canvas.
  - Cache key = content identity ONLY (`el.id:updatedAt:zIndex:opacity:locked`),
    plus layer metadata (`opacity` excluded — applied at composite time,
    `blendMode`, `visible`) and DPR. Viewport must NOT be in the key.
  - At composite time: `drawImage(off, boardToScreen(bbox))` with viewport
    transform. Pan/zoom then costs one blit per cached layer.
  - Recomposite (not re-rasterize) when only opacity/blendMode change.
- Verify: with `localStorage.wabi.whiteboard.perf='1'` perf logging on, avg
  render ms during continuous zoom must stay flat vs element count growth;
  visually confirm no stale pixels after move/resize/reorder/undo.

### T2. Cursor animation redraws interaction canvas only
- File: `frontend/src/lib/components/WhiteboardCanvas.svelte`, `stepCursors()`.
- Bug: remote-cursor easing calls `requestRender()` at 60fps → redraws base
  canvas (grid + all layer compositing) even though nothing under changed.
- Fix: split render into `renderBase()` (grid + layers) and
  `renderOverlay()` (interaction canvas). Cursor RAF calls overlay only.
  Element/layer/viewport subscriptions call both.
- Verify: with ≥1 remote cursor moving, base-canvas render counter (perf log)
  does not tick per frame.

### T3. One store update per frame for drag/resize/rotate
- File: `frontend/src/lib/whiteboard/tools.ts`
  (`createMoveInteraction`, `createResizeInteraction`, `createRotateInteraction`).
- Bug: N selected elements × every pointermove = N state clones + version bumps
  + patch emissions per event.
- Fix: accumulate deltas in the interaction; flush a single merged
  `updateElements` batch once per `requestAnimationFrame`. Keep the existing
  `recordHistory:false` semantics and the single history checkpoint at gesture
  start. Patch coalescing (50ms, `boardSync.emitUpdatePatch`) stays.
- Verify: move a 20-element selection; store-update count per second drops by
  ~an order of magnitude; undo still restores pre-gesture state exactly.

### T4. Raster commit crops to dirty rect before upload
- File: `frontend/src/lib/whiteboard/rasterLayers.ts` (`commitRasterLayer`,
  add dirty-rect tracking to `paintRasterDab/paintRasterSegment`).
- Bug: every stroke end uploads a full 4096×4096 PNG (mostly empty pixels);
  hits the 2MB snapshot / upload budget fast.
- Fix: track min/max painted bounds since last revision; crop via a temp
  canvas at stroke end; upload the cropped PNG; persist crop offset +
  dimensions on the layer (`assetOffsetX/Y` or equivalent — extend
  `WhiteboardLayer` in `boardTypes.ts` + `layers.ts` normalizer + wire
  contract doc). Hydration draws the crop back at its board offset.
- Verify: paint one small dab → uploaded blob dimensions ≈ brush area, not
  4096²; reload rehydrates the dab at the correct board position.

### T5. Lazy, right-sized raster bitmaps
- File: `rasterLayers.ts` (`getLayerBitmap`).
- Bug: eager 4096×4096 canvas per Paint layer = 64MB RAM each, allocated on
  first touch regardless of need.
- Fix: allocate at a sane default (2048² or fit-to-viewport×zoom ceiling),
  document the ceiling in the wire contract; grow-on-demand only if painting
  approaches the edge (or clamp painting to bitmap bounds for v1 — acceptable).
- Verify: open a board with 3 Paint layers; heap delta reasonable; painting
  near bitmap edge behaves predictably (clamped, no silent drop).

### T6. Batch grid rendering into one Path2D
- File: `boardRenderer.ts` `renderGrid()`.
- Minor: hundreds of individual beginPath/stroke calls per render. Build one
  Path2D for minor lines + one for major lines, two strokes total. Keep
  existing alpha/colors and axis labels.

---

## P0 — Raster completeness (vector AND raster both real)

### T7. Raster undo checkpoints
- Files: `rasterLayers.ts`, `tools.ts` (raster pen + raster eraser),
  `boardUndo.ts` or a parallel raster-undo stack in the store.
- Behavior: at stroke start snapshot the active raster layer's DIRTY REGION
  (not whole bitmap) onto a capped stack (reuse MAX_UNDO=50 / 4MB byte-budget
  pattern; budget counts snapshot bytes). Undo pops and blits the region back
  and marks the layer dirty → triggers T4-style re-commit.
- Out of scope: cross-layer raster+vector interleaved undo ordering guarantees
  beyond best-effort stack ordering. Note it in the skill if it bites.
- Verify: paint, erase, undo ×3 restores each step; redo works; stack cap
  evicts oldest without leaking canvases.

### T8. Active-layer mode surfaced in toolbar/chrome
- Files: `WhiteboardToolbar.svelte` (+ `WhiteboardTab.svelte` if a chip fits
  better in topbar).
- Behavior: persistent chip next to tool cluster showing active layer name +
  mode badge (`Vector` / `Paint`). Selecting Pen while a Paint layer is active
  must visibly read differently than on a vector layer. Drawing tools stay
  enabled either way (both modes support pen/eraser).
- This closes the biggest comprehension gap found in audit: users cannot tell
  why ink behaves differently between layers today.

### T9. Wire-contract + skill updates
- Update `docs/plans/2026-08-08-whiteboard-wire-contract.md` for any layer
  field additions (T4 offsets, bitmap ceiling).
- Patch skill `software-development/whiteboard-canvas`: board-space cache key
  rule (viewport must NOT be in content key — supersedes the current
  "cache invalidation must include viewport" pitfall entries), dirty-rect
  raster commits, raster undo pattern.

---

## P1 — Visual design pass (web-graphic-designer cleanup)

### T10. Toolbar CSS purge + unified metrics
- File: `WhiteboardToolbar.svelte` (1201 lines; ~350 dead).
- Delete dead blocks: `.wb-color-picker`, `.wb-color-field`, `.wb-color-text`,
  `.wb-color-label/.wb-fill-label`, unused `alignTools` array in script,
  group-label rules that fight `display:none`, duplicated section rules
  (some `wrap`, some `nowrap` — pick nowrap + horizontal scroll).
- Unify: all control hit targets 32px (today 28/30/18 mixed), one slider style
  (reuse `.wb-brush-slider`), one swatch size (18px round), consistent 8px radii.
- Shortcuts out of button corners (7px monospace noise) — tooltips only.

### T11. Chrome positioning cleanup
- Files: `WhiteboardTab.svelte` styles, `WhiteboardCanvas.css`.
- Kill magic-number stacking (`top: 4.25rem` / mobile `top: 16rem`): make the
  stage a flex column with chrome rows in-flow where possible, or introduce
  CSS custom props (`--wb-chrome-top`) consumed by toolbar/banner/panel.
- Mobile: layer panel anchored below toolbar via flow, not fixed rem offsets.

### T12. Layer panel polish (structure already right — keep inspector pattern)
- File: `WhiteboardLayerPanel.svelte`.
- Styled range/select matching brush slider aesthetics; segmented `+ Vector |
  + Paint` control; icon weight consistency (all 1.5 stroke, same viewBox);
  hover-reveal row actions instead of always-visible icon columns (keep
  visible/lock visible — hide only reorder/move-sel behind hover or inspector).
- No layout relocation: panel already lives in WorkspacePanelHost right dock.

### T13. Verification bar (applies to every phase)
- Build passes (`svelte-check`, vite build).
- Live check through real entry paths (workspace pill + voice-channel icon →
  Chat → WhiteboardTab): geometry probe (`.whiteboard-stage`,
  `.whiteboard-canvas-container`, both canvases non-zero), clean browser
  profile / SW cleared, no runtime exceptions.
- Perf receipts from `wabi.whiteboard.perf` flag before/after T1–T3.
- Deploy only on explicit "deploy" from Ronin; prove via SHA + live chunk grep.

---

## Execution notes

- Shared-tree hazard: workers commit scoped (`git add <exact paths>`), never
  `-A`; strip noise files before any commit.
- Dispatch slices small (per-task prompts), types/wire changes first (T4/T9
  before dependent worker tasks), per parallel-agent-dispatch failure modes.
- Svelte files that gain any new-syntax handler must convert ALL handlers in
  the same pass (runes mixed-syntax build blocker).
