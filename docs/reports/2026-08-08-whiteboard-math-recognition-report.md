# 2026-08-08 — Whiteboard Stroke-to-LaTeX Recognizer (Wave 4b, Phase 5.2)

The "insane" self-built piece: a pure client-side handwriting → LaTeX recognizer
with zero ML infrastructure, network, DOM, or Web Workers. Opt-in only; the
recognition UI is wired by a later wave. This wave is the pure algorithm +
data, unit-testable in isolation.

## Files

| File | Change |
|------|--------|
| `frontend/src/lib/whiteboard/mathTemplates.ts` | **NEW.** Curated template bank (`MATH_TEMPLATES`, 93 symbols) generated programmatically at module load from tiny shape primitives. Also hosts the shared normalization pipeline (`normalizePointsToVector`) so templates and input strokes are normalized identically. |
| `frontend/src/lib/whiteboard/mathRecognition.ts` | **NEW.** The full pipeline: `normalizeStroke`, `matchSymbol` (k-NN), `segmentStrokes`, `parseStructure`, `recognizeStrokes`, plus a self-contained `runMathRecognitionTests()` (28 checks, pure TS). |

No other whiteboard files touched (`boardRenderer.ts`, `tools.ts` unchanged —
the recognizer needed no helpers there).

## Architecture

```
Stroke[] ──► segmentStrokes ──► Stroke[][]
                 │ (time / spatial gap heuristics)
                 ▼
             groups → one symbol each
                 │
                 ▼
             normalizeSymbolStrokes        (per stroke: resample 64 → centroid → indicative-angle rotate → unit box)
                 │
                 ▼
             matchSymbol (k-NN, k=5)  ──► top candidate → RecognizedSymbol{symbolId, latex, bbox, confidence}
                 │
                 ▼
        parseStructure (spatial grammar over bboxes)
                 │
                 ▼
        RecognitionResult{latex, confidence, symbols, partial}
```

### Stage 1 — symbol recognition (Detexify-style k-NN)

- **Normalizer** (`normalizePointsToVector`, shared by templates + input):
  1. Resample to **64 arc-length-even points** (linear interpolation along
     cumulative path length).
  2. Translate the **centroid to the origin**.
  3. **Rotate to the indicative angle** (line from centroid to first point,
     canonicalized to +y). Rotation is *skipped* for extreme-aspect shapes
     (width/height outside [1/3, 3]) so axis-aligned line symbols (`-` vs `|`)
     keep their orientation instead of collapsing into identical vectors.
  4. Scale to a **unit bounding box** (max dimension = 1, computed *after*
     rotation, since rotation can stretch a diagonal to an axis).
  - Degenerate strokes (single point / zero extent) → `null`.
- **Feature vector**: the 64 `(x,y)` pairs (128 dims) **plus one extra dim per
  stroke = the stroke's relative path length** (length ÷ max stroke length in
  the symbol). The length dim is the fix for a subtle normalization weakness:
  without it, any vertical+horizontal two-stroke symbol (`+`, `t`, `L`) all
  normalize to the identical feature (length is scaled away). With it they
  separate cleanly.
- **Matching** (`matchSymbol`, k=5): stroke-by-stroke in writing order, summed
  squared-Euclidean distance; unmatched strokes (count mismatch) add a flat
  penalty (`EXTRA_STROKE_PENALTY = 16`) per stroke. Each stroke pair is
  compared against both the template stroke and its **180° negation** (min),
  which makes recognition robust to strokes drawn in reverse direction.
- **Confidence**: `1 / (1 + dist/best)` with a floor on `best` (=1) so a
  near-perfect match behaves, multiplied by an absolute-quality term
  `1/(1 + best·0.4)`. Result: clean match ≈ 0.4–1.0, poor match → below the
  `PARTIAL_CONFIDENCE = 0.3` bar.

### Template bank (93 symbols, generated programmatically)

Shape primitives: `L` (line), `P` (polyline), `A` (arc), `B` (cubic Bézier),
`DOT`. Every template is a composition of a handful of primitives — no
hand-written point dumps. Breakdown:

| Category | Count | Examples |
|----------|-------|----------|
| Digits | 10 | `0–9` (multi-stroke for `4`, `8`; S-curve for `3`) |
| Lowercase | 22 | `a b c d e f g h i k m n p r s t u v w x y z` (`d` included for `\,dx` handling) |
| Uppercase | 20 | `A B C D E F G H I L M N O P R S T U V W` |
| Operators | 12 | `+ − × ÷ = ≠ < > ≤ ≥ ± ∓` |
| Greek | 15 | `α β γ δ ε θ λ μ π σ φ ω Δ Σ Π` |
| Symbols | 14 | `∫ ∑ √ ∞ → ( ) [ ] { } | · ∂` |

### Segmentation (`segmentStrokes`)

New symbol boundary when **either**:
- **Time gap**: `t_cur − t_prev > 500ms` (any overlap ignored — this is the
  primary real-pen signal), **or**
- **Spatial gap**: bounding boxes don't overlap (in both axes) AND center
  distance > `2.5×` the average stroke size (`max(width,height)` per stroke).

Multi-stroke symbols (`+`, `=`, `x`, `√`, …) stay grouped because their
strokes overlap spatially; the i-dot and superscripts rely on the time-gap rule
in practice.

### Stage 2 — structure parser (`parseStructure`)

Deterministic spatial grammar, a chain of if-statements over bboxes:

1. **Rows**: symbols are clustered into horizontal rows by *vertical overlap*
   of bboxes; each row is read left-to-right.
2. **Script absorption**: a small row (height ≤ 60% of the adjacent row) whose
   x-footprint overlaps is folded into the base row so `renderRow` sees it.
3. **Fraction**: adjacent rows with overlapping x-footprints, similar
   width/height, aligned x-centers, and a small vertical gap → recursive
   `\frac{num}{den}` (handles nesting via recursion).
4. **Superscript**: small (height < 0.45× base), center-y above `base.top +
   0.35·base.h`, right of base → `x^{2}`.
5. **Subscript**: small, center-y below `base.bottom − 0.35·base.h`, right →
   `a_{1}`.
6. **Square root**: `√` consumes the rest of the row → `\sqrt{...}`.
7. **Integral**: `∫` → `\int <integrand> \,dx` when a trailing `d` (not the
   first symbol after `∫`) is found, else `\int <rest>`.
8. **Sum**: `∑` with sup/sub → `\sum_{sub}^{sup}`.
9. **Parentheses**: `(` / `[` / `{` with a depth-matched close →
   `\left(...\right)` / `\left[...\right]` / `\left\{...\right\}`.
10. **Inline operators**: `+ − × ÷ = ≠ < > ≤ ≥ ± ∓` pass through as-is.

`partial = true` when any symbol's confidence < 0.3 (caller can prompt the user
to edit); whole-result `confidence` = min symbol confidence.

## Verification

- **Self-test**: `runMathRecognitionTests()` (pure TS, no bun:test — the repo's
  svelte-check lacks the `bun:test` module, and those 6 pre-existing errors must
  not grow). Ran by bundling with esbuild and executing under Node 22:
  ```
  frontend/node_modules/.bin/esbuild src/lib/whiteboard/mathRecognition.ts \
    --bundle --format=esm --outfile=/tmp/opencode/mathrec.mjs
  node -e 'import("/tmp/opencode/mathrec.mjs").then(m => m.runMathRecognitionTests())'
  ```
  **Result: 28 passed, 0 failed.** Coverage: normalizer (unit box, degenerate
  nulls, 128-dims), segmentation (overlap/space/time-gap/empty), k-NN
  (`2`, `+`, `=`, `√`), parser (`x+y=z`, `x^{2}`, `a/b`, `a_{1}`, `\sqrt{x}`,
  `\int x \,dx`, `\sum_{i}^{n}`, `\left( x+y \right)`, `\alpha+\beta`), and
  end-to-end (`2+3=5`, `y^{2}`, `a/b`, scribble → `partial`).
- **Typecheck**: `bun run check` from `frontend/` → **7 errors / 80 warnings,
  all pre-existing** (6 bun:test module errors + 1 i18n peer error). No new
  errors from either new file.

## Known limitations (v1, by design)

- **`x` vs `×`** are the same glyph shape — they tie in distance and `x` wins
  via stable sort tie-break (template order). Real disambiguation needs
  context, which is out of scope.
- **`0`/`O`** (both circles), **`3`/`∫`** (both S-curves), **`2`/`z`** are
  near-tied; top-5 always carries the alternatives for a UI picker.
- **Segmentation** cannot perfectly separate tightly-packed symbols spatially:
  the spatial rule is conservative (`2.5×`), so symbols written close together
  with no pen pause merge. Real pen input should supply `timestamp`s; the
  500ms time-gap rule is the reliable separator. The `i`-dot also relies on the
  time rule.
- **Superscripts/subscripts** must overlap the base's vertical bbox (usual) or
  be caught by script-row absorption; a script drawn far from the base with no
  time gap can mis-segment.
- **`\sum_{i=0}^{n}`** (limits with bounds) is not handled — only a bare
  superscript/subscript pair. `dx` detection is a single trailing-`d` heuristic.
- Perfectly **single-line, single-direction input** is assumed; multi-line math
  and `\begin{matrix}`-style layouts are out of scope.

## Scope compliance

- Files created: exactly the two `frontend/src/lib/whiteboard/` modules listed
  in scope. No store/sync/socket/renderer/UI files touched.
- Pure functions only; no DOM/network/Web Workers; opt-in (nothing imports the
  recognizer until the UI wave wires it).
