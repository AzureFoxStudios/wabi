# Whiteboard Math Element + KaTeX Tool (Phase 5.1 / Wave 4a)

**Date:** 2026-08-08
**Scope:** Σ (math) tool for the whiteboard — place a LaTeX formula, live-preview it, commit it as a `MathElement`, render on canvas, survive reload.

## Files

| File | Change |
|------|--------|
| `frontend/src/lib/whiteboard/mathRender.ts` | **NEW** — KaTeX → canvas bridge (`renderMathToCanvas`, `measureMathElement`, `preloadMathElement`) |
| `frontend/src/lib/whiteboard/katex-assets.d.ts` | **NEW** — ambient types for Vite `?raw` CSS / `?url` font imports (support file, listed per instructions) |
| `frontend/src/lib/whiteboard/boardRenderer.ts` | Add `case 'math'` to the draw switch in `renderElements`, `drawElementsToCtx` and `renderDrawPreview` + `renderMath` helper. `renderElements` signature unchanged; additive only. |
| `frontend/src/lib/whiteboard/tools.ts` | `MathPlacement` + `onMathPlacement` + `createMathTool` + `buildMathElement`; registered `math` in `getToolHandler`. `ToolHandler.id` widened to `ToolType \| 'math'`. |
| `frontend/src/lib/components/WhiteboardToolbar.svelte` | Σ tool button + inline LaTeX editor overlay (input + live KaTeX preview + Commit/Cancel; Enter commits, Esc cancels), styled with design tokens. |
| `frontend/package.json` / `frontend/package-lock.json` | No diff — `katex@0.18.1` was already a declared dependency (verified via `npm install katex`; lockfile already recorded it). Included in commit for completeness. |

## Render approach

KaTeX 0.18.1's `renderToString` has **no** `output: 'svg'` mode (its option enum is `html | mathml | htmlAndMathml` — confirmed against `node_modules/katex/dist/katex.mjs`), so the planned `output: 'svg'` path is not available. Adapted:

1. `katex.renderToString(latex, { output: 'html', throwOnError: false, strict: 'ignore' })`.
2. Serialize the HTML into a **standalone SVG** via `<foreignObject>`:
   - KaTeX stylesheet inlined in a `<style>` node (`katex/dist/katex.min.css?raw`), with all `@font-face` `url(fonts/…)` rewritten to Vite-bundled woff2 asset URLs (all three formats collapse to woff2), XML-escaped once at module load.
   - Inner `<div xmlns="…xhtml">` carries `color` (KaTeX glyphs inherit `currentColor`-style CSS color), `font-size` (matches the measured size) and a 2px glyph pad.
3. The SVG is loaded into an `<img>` from a `data:image/svg+xml;charset=utf-8,…` URL and drawn with `ctx.drawImage` at its natural size.
4. **Size** comes from measuring the rendered HTML in a hidden off-screen host div (`getBoundingClientRect`, synchronous) at the target font size, so element `width`/`height` (hit-testing, selection, export) match the drawn glyph. Default font size is 32 canvas px.
5. **Errors:** parse errors are detected via the `katex-error` class; those render as the raw LaTeX in a monospace font (`drawFallback`) and `measureMathElement` falls back to `latex.length * fontSize * 0.5` / `fontSize * 1.4`.

The `opacity` param of `renderMathToCanvas` is multiplied into the caller's `ctx.globalAlpha`; `boardRenderer.renderMath` divides the pre-applied element alpha back out first so element×layer opacity isn't double-counted.

## Cache strategy

Two module-level `Map`s (per task, keyed on LaTeX + fontSize, capped at 50 entries, oldest evicted on overflow):

- `renderInfoCache` keyed `latex\0fontSize` → the expensive part (KaTeX parse + layout measure). Color-neutral, so any color reuses it.
- `imageCache` keyed `latex\0fontSize\0color` → loaded `<img>` elements (color is baked into the SVG, so distinct colors get distinct images, but they reuse the same parse).

`preloadMathElement(latex, fontSize)` (called from `buildMathElement`, i.e. after commit) warms both caches so the first canvas frame is instant. Since `<img>` decode is async even for data URLs, the image's `onload` calls `boardStore.bumpVersion()` once to trigger a re-render, so the first frame never sticks on the monospace fallback.

## Interaction flow

Σ tool selected → click canvas → `createMathTool.onPointerDown` fires `onMathPlacement` (registered by the toolbar) → centered modal editor opens with a text input + live KaTeX preview (`renderToString` imported directly in the component; the canvas draw path stays in `mathRender.ts`) → Enter/Commit builds the element via `buildMathElement` + `boardStore.addElement`; Esc/Cancel/backdrop-click discards. Elements are plain `{ type: 'math', latex, fontSize } + ElementBase`, so they persist, undo, sync, select/move and export via the existing generic element pipeline (no type-specific stripping in `boardUndo`/`boardSync`/transport).

## Verification

From `frontend/`:

- `npm run check` → **7 errors / 80 warnings** (baseline before this work: 8 errors / 80 warnings). All 7 are pre-existing/peer-owned: 6 `bun:test`/`bun` module-resolution errors + the peer's `i18n` en.json type error. **Zero new errors**; warning count back at baseline (5 a11y warnings introduced then fixed with the backdrop-button/`tabindex`/programmatic-focus pattern).
- `npm run build` → succeeds; KaTeX fonts emitted as bundled assets (woff2) and the inlined stylesheet confirmed present in the built chunk.

## Notes / deviations from plan

- `output: 'svg'` replaced by the `foreignObject` serialization (KaTeX doesn't support it in 0.18.1); still a fully self-contained SVG `<img>` per the plan's intent.
- Cache keys include color for the image map (color is baked into the SVG fill), while the parse/measure cache stays `latex\0fontSize` as specified.
- `ToolType` (defined in `boardStore.ts`, which is out of scope) was not extended; `'math'` is carried via `ToolType | 'math'` in `tools.ts` and cast at the `boardStore.setTool` boundary. No keyboard shortcut (WhiteboardCanvas tool map is out of scope) — Σ is button-only.
- `frontend/src/lib/whiteboard/katex-assets.d.ts` added (ambient types for Vite `?raw`/`?url` imports) — support file required for typechecking, listed per commit instructions.

Not implemented (future wave): stroke recognition (Phase 5.2).
