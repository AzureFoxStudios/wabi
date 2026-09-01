# Whiteboard: code paste (per-item layers) + text/font upgrade

Date: 2026-08-29
Status: implemented & verified (2026-09-01)
Scope: frontend whiteboard (`frontend/src/lib/whiteboard/`, `frontend/src/lib/components/Whiteboard*.svelte`) + one new backend route pair in `core/crates/wabi-server/src/api/whiteboard.rs`.

## Goals

1. **Paste code onto the board to draw on.** Pasting text/code (Ctrl+V) creates an element on the board instead of doing nothing. Every pasted item (code block, plain text, image) lands on **its own new layer** so each paste can be toggled/locked independently and drawn over.
2. **Real text tooling.** Text elements get measured bounding boxes (selection/hit-test accuracy), double-click re-editing, a font family picker, and uploadable custom fonts (board-scoped).

## Non-goals / deferred

- SVG export `@font-face` base64 embedding (SVG export is not wired into the UI; PNG export picks up FontFace-loaded fonts automatically). Recorded here for whenever SVG export ships.
- Font deletion UI (API keeps it possible later).
- Full opentype.js text-to-path outline conversion.

## Architecture facts this builds on

- Board documents are opaque JSON server-side (`get/put_whiteboard_doc`, 2MB cap; live patches 128KB cap) — new element types/fields need **no backend schema change**.
- Layers sync via `layer:create/update/delete` socket ops (`boardSync.ts`); `boardStore.addLayer` emits them.
- Prism.js is already a frontend dep (`markdown.ts` loads grammars: js/ts/py/java/c/cpp/csharp/go/rust/ruby/bash/json/css).
- Upload pipeline: `POST /api/whiteboard/boards/:boardId/images` → `uploads_dir` with `wbi-<scope>-...` file IDs, served auth-gated from `/boards/:boardId/files/:fileId` with extension MIME guess.

## Design

### New element type: `code`

`CodeElement` (elementTypes.ts): `type: 'code'`, `code: string`, `language: string`, `fontSize: number` (monospace stack). Rendered as a card (rounded rect + optional border) with prism-tokenized colored runs; tokenization cached per element (id + updatedAt) so the 60fps render loop never re-tokenizes. SVG export: rect + per-run tspans. Clipboard text that is not code-like pastes as a plain `text` element instead.

- Code detection: score heuristic (`looksLikeCode` in new `codePaste.ts`) — braces/semicolons/indentation/keywords/shebang; language guess from keyword hits.
- Size cap: 64KB per pasted code block (doc cap 2MB, live patch cap 128KB) — larger pastes are rejected with the existing import-error toast.
- Undo byte estimates account for `code` length.

### Paste → own layer

`WhiteboardCanvas.handlePaste` gains a `text/plain` branch. Paste flow:

1. Create layer via `boardStore.addLayer({ name, kind: 'reference', locked: true, opacity: 1, order: <current min − 1> })` — bottom of the stack so you draw *on* it from any content layer above. Name: `Code — <lang>` / `Text` / from image file name. Falls back to the active writable layer at the 32-layer cap.
2. Add the element with `layerId` = new layer.
3. Image imports (clipboard/drop without explicit reference/background mode) move to the same per-item-layer default.

### Text upgrade

- Shared metrics module (`textMetrics.ts`): line-height factor 1.3 single-sourced; `measureText` via offscreen canvas with injected measurer for testability; commit path sets real width/height.
- Double-click on a text/code element reopens the editor overlay prefilled; commit updates the element (updateElement) and re-measures.
- `BoardStyle` gains `fontFamily` + `fontId`; toolbar font picker (built-in stacks + custom fonts + "Add font…" upload) applies to style and to selected text elements.

### Custom fonts (board-scoped)

- Backend (new): `GET /api/whiteboard/boards/:boardId/fonts` (list) and `POST .../fonts` (multipart upload, `.woff2/.woff/.ttf/.otf` only, ≤10MB, `wbf-` file-ID prefix, upload-registry recorded). Served by the existing files route (extension MIME guess already handles fonts).
- Frontend (`fontAssets.ts`): per-board font list store, `FontFace` load + `document.fonts.add`, async load triggers a board re-render; `TextElement.fontId` resolves to the loaded family with fallback.

## Files touched

| File | Change |
|------|--------|
| `frontend/src/lib/whiteboard/elementTypes.ts` | `CodeElement`, `fontId` on text, style fields |
| `frontend/src/lib/whiteboard/textMetrics.ts` | NEW — shared measurement |
| `frontend/src/lib/whiteboard/codePaste.ts` | NEW — detection, cap, element builder |
| `frontend/src/lib/whiteboard/codeHighlight.ts` | NEW — prism → colored lines, token cache, palette |
| `frontend/src/lib/whiteboard/fontAssets.ts` | NEW — font list/load/upload |
| `frontend/src/lib/whiteboard/boardRenderer.ts` | `renderCode`, fontId resolution |
| `frontend/src/lib/whiteboard/export.ts` | SVG `code` case |
| `frontend/src/lib/whiteboard/boardStore.ts` | style fields |
| `frontend/src/lib/whiteboard/boardUndo.ts` | code byte estimate |
| `frontend/src/lib/components/WhiteboardCanvas.svelte` | paste branch, dblclick edit, per-item layers |
| `frontend/src/lib/components/WhiteboardToolbar.svelte` | font picker + upload |
| `core/crates/wabi-server/src/api/whiteboard.rs` | font routes |
| tests | `codePaste.test.ts`, `codeHighlight.test.ts`, `textMetrics.test.ts`, backend font route tests |

## Verification

- `bun run check` (frontend): **0 errors** (after also resolving pre-existing merge markers in `calling_impl_core.ts` — kept the HEAD side per the 2026-08-27 "Discord model" decision; guarded by `svelte5ReactivityTripwire.test.ts`).
- `bun test src/lib`: 230 tests, 0 fail (34 new whiteboard tests: `codePaste.test.ts`, `codeHighlight.test.ts`, `textMetrics.test.ts`).
- `cargo test -p wabi-server --lib`: 147 passed, 0 failed (10 new font-route unit tests).
- `STATIC_BUILD=1 bun run build` with `TAURI_DEBUG=1` (no minify): succeeds, `build/index.html` emitted.
- ⚠️ The **minified** static build fails in `lightningcss minify` ("Unexpected token Semicolon") — **pre-existing on this tree**, reproduces with all whiteboard CSS edits stashed. Not caused by this change. Needs a separate bisect.
- `tests/channel_lifecycle_contract.rs` fails to compile (`create_dm_channel` now takes `String`) — signature drift from the concurrent lore/wabi_store workstream, unrelated to whiteboard.

## Implementation notes & deviations

- **Serve-route fix**: `serve_whiteboard_file` now also accepts `wbf-` (font) file IDs — without this, uploaded fonts would 403 on fetch since only `wbi-` IDs passed the board-scope check.
- **Undo granularity**: a paste (layer + element) takes two undo steps — first removes the element, second removes the layer. `addElement` records its own history entry after the layer already exists, and `ensureLayer` records none. Accepted for v1.
- **Renderer caches**: code tokenization cached in `codeHighlight.ts` (LRU, char-capped); run x-offsets cached per element id+updatedAt+fontSize in `boardRenderer.ts`; `getFontEpoch()` is baked into the per-layer bitmap content key so async font loads invalidate cached rasters.
- **Custom fonts auth**: whiteboard file URLs require Authorization headers, so fonts are fetched via `fetch()` → ArrayBuffer → `FontFace` (a `FontFace` src URL could not send auth), mirroring the protected-image path.
- **Detection heuristic**: score-based (`looksLikeCode`) with prose counter-signals; language guessed from keyword profiles; non-code text pastes as a plain `text` element (also on its own layer). Cap: 64KB per paste.
- The backend route pair (`GET/POST /boards/:id/fonts`) was implemented by an opencode (muse-spark) run, then reviewed; the serve-route gap above was found in review and fixed by hand.
