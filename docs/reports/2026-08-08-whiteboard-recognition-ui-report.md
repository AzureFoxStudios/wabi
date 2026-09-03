# Whiteboard Recognition UI — select strokes → recognize → preview → accept/edit/dismiss (Phase 5.5 / Wave 6a)

**Date:** 2026-08-08
**Scope:** Opt-in UX that wires the pure stroke→LaTeX recognizer (`mathRecognition.ts`, verified in Wave 4b) into the whiteboard: select strokes, hit "Recognize as math", preview the parsed formula live in the modal (confidence badge + editable LaTeX), then accept (replaces strokes with a `MathElement`), edit, or dismiss.

## Files

| File | Change |
|------|--------|
| `frontend/src/lib/whiteboard/recognitionUi.ts` | **NEW** — pure bridge logic: `RecognitionDraft`, `extractStrokeSelection`, `buildMathElementFromRecognition`, `formatConfidence`. No DOM/stores/network. |
| `frontend/src/lib/components/WhiteboardMathRecognize.svelte` | **NEW** — glass modal: title, confidence badge, live KaTeX preview, LaTeX textarea, partial-warning note, Accept/Dismiss buttons; Enter=accept, Esc=dismiss; textarea focused on mount. Svelte 5 runes (`$props`/`$state`/`$derived.by`/`$effect`), styled with design tokens. |
| `frontend/src/lib/components/WhiteboardTab.svelte` | Wire the action: import recognizer + `recognitionUi` + modal; state `recognitionDraft`/`selectedForRecognition`; "Recognize as math" button in the topbar (visible when selection has ≥1 stroke element, hidden in read-only / desktop-gate states); accept handler deletes the strokes then adds the built `MathElement`; modal mounted as an absolute overlay inside the tab shell. This was the only existing component touched. |
| `frontend/src/lib/whiteboard/mathTemplates.ts` | **Additive only** — `contributeTemplate(strokes, latex, symbolId?)` pushes a template into `MATH_TEMPLATES` at runtime and persists it to `localStorage['wabi:math:templates']`, re-merged into the bank at module load. ~30 lines appended after the existing bank; no existing export changed. |
| `frontend/src/lib/whiteboard/mathRecognition.ts` | No diff. A `contributeTemplate` re-export was considered but is **not needed** — the hook lives in `mathTemplates.ts` and the recognizer already consumes the shared `MATH_TEMPLATES` array by reference, so runtime contributions are picked up immediately. (Listed in the commit per instructions.) |

## Interaction flow

1. User selects one or more stroke elements (selection is a `Set<string>` of ids; strokes are the only recognized element type).
2. The topbar "Recognize as math" button appears when `selectedStrokeCount > 0` (derived from `$selection` + `extractStrokeSelection(get(boardStore))`).
3. Click → `handleRecognizeMath`: `extractStrokeSelection(get(boardStore))` → `recognizeStrokes(strokes.map(s => ({ points: s.points })))` → stores the strokes and a `RecognitionDraft { latex, confidence, partial }`.
4. `WhiteboardMathRecognize` renders as an absolute overlay (`inset:0`, `z-index:40`) above the canvas:
   - Live preview via `katex.renderToString(edited, { output:'html', throwOnError:false, strict:'ignore' })` in a `{@html}` div — re-renders as the user edits the textarea.
   - Confidence badge (`formatConfidence`: High ≥0.7 / Medium ≥0.4 / Low), color-coded (success/warning/danger tokens).
   - A note when `partial` is true: "Some symbols were uncertain — check the LaTeX below before accepting."
   - `onkeydown` on the panel calls `event.stopPropagation()` so canvas key handling never sees Enter/Esc; Enter (no Shift) = accept, Escape = dismiss.
   - Textarea is focused on mount via `$effect`.
5. Accept → `handleAcceptRecognition(edited)` → `boardStore.deleteElements(strokeIds)` then `boardStore.addElement(buildMathElementFromRecognition(strokes, trimmed))` → clears the draft. Dismiss → clears the draft with no mutation.

## Element construction (`buildMathElementFromRecognition`)

- Union bbox of the selected strokes via `getElementBBox` (`coords.ts` — verified no import cycle; it only pulls `boardTypes`/`elementTypes`).
- Position: centered on that bbox (`x = bbox.x + (bbox.width - w)/2`, same for y) using `width/height` from `measureMathElement` (`mathRender.ts`) so the element's bbox matches the rendered glyph.
- `zIndex = max(stroke zIndexes) + 1` (lifts the math element above the strokes it replaces on the same layer), `layerId`/`strokeColor`/`strokeWidth`/`createdBy` inherited from the first stroke, `opacity 1`, `fontSize 32`, `rotation 0`, `locked false`, fresh `generateElementId()`, `updatedAt: Date.now()`.
- Importing `mathRender` from `recognitionUi` is safe: `mathRender` → `boardStore` → … never references `recognitionUi`, so no cycle.

## Modal behavior

- Glass panel (design tokens `--surface-raised`, `--radius-lg`, `backdrop-filter blur`, `--accent-primary`, `--text-heading`, `--font-mono` textarea) centered over a dimmed, blurred overlay.
- Accept is disabled while the edited LaTeX is empty.
- `aria-modal`/`role="dialog"`/`tabindex="-1"`/`aria-label` for a11y; preview box is `aria-live="polite"`.
- Reduced-motion friendly (no animation).

## contributeTemplate hook (flywheel, intentionally not wired)

`contributeTemplate(strokes: number[][], latex: string, symbolId?: string)` expects **already-normalized** stroke feature vectors (i.e. output of `normalizeSymbolStrokes`), matching `SymbolTemplate.strokes`. It appends to the in-memory `MATH_TEMPLATES` and to `localStorage['wabi:math:templates']`; on the next module load the stored templates are merged back in (idempotent per `symbolId` — a re-correction replaces the older entry).

Per the task, **auto-contribution is NOT wired** into the accept path (the "user correction → system improves" hook is exported and documented, but calling it automatically on every edited accept would be surprising behavior). The natural wiring point for a future wave: in `handleAcceptRecognition`, when the edited LaTeX differs from the recognized LaTeX, run `normalizeSymbolStrokes` over the first segmented symbol group's raw points and call `contributeTemplate` with the corrected `latex`. That stays a one-line hook in `WhiteboardTab.svelte` once decided.

## Verification

From `frontend/`:

- `npm run check` → **7 errors / 88 warnings**. All 7 are pre-existing/peer-owned: 6 `bun:test`/`bun` module-resolution errors (`storage-salt`, `dmCrypto`, `dmRatchet`, `dmRecovery`, `run-crypto-tests`, `layoutSchema`) + the peer's `LoreChannelShell.svelte:234` i18n `File` vs `string` error (per instructions, ignored). **Zero new errors; zero warnings** on any touched file. (During dev the new modal emitted 5 warnings — `state_referenced_locally` init + dialog tabindex + legacy event directives — all resolved: prop read moved inside a closure, `tabindex="-1"`, and `onclick`/`onkeydown` attributes used.)
- Sanity run (`bun run` of a scratch script, not committed): recognizer self-test **28 passed / 0 failed**; `contributeTemplate` grows the bank 93→94 and round-trips through localStorage; `extractStrokeSelection` preserves selection order and skips locked elements. `buildMathElementFromRecognition` requires a DOM (its `measureMathElement` uses a hidden host div) — verified by typecheck and code path; the in-browser flow is unaffected.

## Notes / scope guardrails

- **Forbidden files untouched:** `WhiteboardToolbar.svelte`, `WhiteboardCanvas.svelte`, `boardStore.ts`, `boardSync.ts`, `boardSocket.ts`, `boardTypes.ts`, `layers.ts`, `elementTypes.ts`, `tools.ts`, `boardRenderer.ts`, `mathRender.ts`, `core/**` — none modified. `mathRecognition.ts` and `mathTemplates.ts` are additive-only.
- `WhiteboardTab.svelte` keeps its existing legacy Svelte style (`$:`/`export let`); the new modal uses Svelte 5 runes per AGENTS.md — Svelte bridges them transparently.
- No auto `contributeTemplate` wiring (see above). No changes to exported function names.
