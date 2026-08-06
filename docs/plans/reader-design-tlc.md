# Reader Design TLC Plan — Wabi

**Status:** Plan (draft for Ronin review) · **Scope:** `ReaderTabImpl.svelte` + `reader-tab.css` (+ `readerWorkspace.ts` where needed)
**Date:** 2026-08-06

## Current state (audited)

Reader is a full-workspace view (registered as `READER_ADDON_ID` addon tab). It renders:
- `.reader-toolbar` — title group (kicker "Reader Mode", doc title, meta chips: words / min read / % / source), action buttons (← Back to Chat, Prev/Next page, Open File, Images, Paste MD, Paste Text, Clear, Fullscreen), secondary row (Recent select, Theme/Font/Width/Fit/Dir selects, font-size + line-height sliders)
- `.reader-stage` — document viewport with `.reader-document` (paper card) or image shell, or empty state

**Strengths to keep:** 3 themes (paper/sepia/night), serif/sans, width presets, progress persistence, fullscreen mode, image viewer, history, page estimate. The typography (`clamp` h1, letter-spacing) is already good.

**Problems (why it needs TLC):**

1. **Toolbar is dense and utilitarian.** Two stacked rows of text-labeled buttons + 6 selects + 2 sliders. Reads like a debug panel, not a reading product. The "Open File / Images / Paste Markdown / Paste Text" cluster belongs in the *empty state*, not permanently on the toolbar.
2. **No reading progress UI in the article.** Progress is a tiny % chip in the meta row only.
3. **Empty state is plain.** "Reader Mode is ready" card with 4 buttons — no visual interest, no hint of what reader is FOR.
4. **Page navigation is text buttons** ("← Prev" / "Next →") — inconsistent with the rest of the app's icon-pill language; the page indicator sits between them awkwardly.
5. **No TOC / outline** for long documents; no scroll-to-top affordance; no "back to top" during long reads.
6. **Back-to-Chat is a text link at the far right of a crowded row** — easy to miss (this is partially addressed by the new WorkspaceViewBar, but Reader should keep its own clear exit).
7. **Import flow is modal-on-modal feel** (full-surface overlay sheet) — fine functionally, but the sheet chrome is plain.
8. **Themes are hand-rolled `--reader-*` vars** that partially reuse app tokens (`--text-warning` as sepia bg is a hack) — should derive from the app theme system cleanly, including a **dark-adaptive default** (currently paper default clashes with app dark chrome).

## Design direction (v1)

**Goal:** Reader should feel like a *reading room*, not a settings dialog — a calm, typographically confident surface where the content is the hero and the controls recede.

### A. Toolbar hierarchy (the big win)
- **Row 1 (persistent chrome):** WorkspaceViewBar integration (messages/reader/3d/map/media/planner/notes pills + Messages return) + right side: minimal **icon-only** controls — font size (−/+), theme cycle, fullscreen. Title moves to the top-left of the content column instead of the toolbar.
- **Row 2 (contextual, auto-collapsing):** document title + meta chips (words · min read · % complete · source) *in the article header*, not the toolbar. Progress bar (thin accent line under the toolbar) showing scroll progress.
- **Import cluster moves to empty state only** (big friendly cards: Open File / Open Images / Paste Markdown / Load Sample). When a doc is open, the toolbar shows only: Back, Prev/Next (icon chevrons), font size, theme, fullscreen.
- **Collapse behavior:** pressing a "focus" toggle (or auto after 4s idle scroll) hides the toolbar → true distraction-free reading; a floating pill appears (like the current `reader-focus-return` but styled) to bring it back. Escape returns.

### B. Article typography & layout
- Keep the paper-card-on-stage metaphor but soften: smaller radius (16px), thinner border, deeper but softer shadow; stage bg gets a subtle radial vignette per theme.
- **First-letter / drop-cap** on `.reader-document` paragraphs for long-form prose (opt-in per theme).
- **Better heading rhythm** + `::selection` color per theme.
- **Reading progress**: fixed thin progress bar at top of the document viewport (accent color), plus the existing % in meta.
- **TOC (v1.1):** generate an outline from `h1-h3` in `renderReaderHtml` output (or scan DOM after render) → collapsible "Outline" button in the toolbar → sticky left rail in wide mode or dropdown in narrow.
- **Code blocks:** keep prism theme; add a subtle copy button on hover (small, top-right of `pre`).

### C. Empty state (make it sell the feature)
- Replace the plain card with a **two-zone layout**: left = "Start reading" (3 stacked icon buttons: Open File, Open Images, Paste Text), right = a **"What is Reader Mode?"** explainer with a sample preview card (mini rendered markdown demo) + Load Sample button.
- Kicker: "Long-form reading · distraction-free".

### D. Images mode
- Reuse the same toolbar collapse; image counter becomes a thin progress bar (n/N); keyboard arrows already work — surface a hint chip ("← → to navigate") on first open only.

### E. Theme system
- Introduce `--reader-bg/--reader-surface/--reader-text/--reader-muted/--reader-border/--reader-accent` derived from app tokens with proper semantic mapping (paper = light neutral, sepia = warm, night = app dark). **Default theme = auto** (follow app dark mode) instead of paper.
- Add a 4th theme? **Not in v1** — polish the 3 first.

## Implementation steps (bounded, order matters)

1. **P1 — Toolbar restructure** (ReaderTabImpl.svelte + reader-tab.css):
   - Move title/meta into article header; slim toolbar to icon buttons; move import cluster to empty state; add focus/collapse mode with floating return pill; add progress bar element.
2. **P2 — Empty state redesign** (same files): two-zone layout, explainer, sample preview card.
3. **P3 — Typography pass** (reader-tab.css only): radius/shadow soften, drop-cap, heading rhythm, selection color, code copy button.
4. **P4 — Images + nav polish**: icon chevrons for prev/next, progress bar in image mode, keyboard hint chip.
5. **P5 — Theme derivation**: clean token mapping + auto/dark default; verify paper/sepia/night contrast (WCAG AA on text).

## Verification
- `cd frontend && npx svelte-check --tsconfig tsconfig.json` (touched files clean)
- `STATIC_BUILD=1 bun run build`
- Ronin visual check in real browser (headless Chromium crashes on Wabi — see memory): paper + night themes, empty state, doc with headings/code/blockquote, images mode, fullscreen, collapse/focus mode, progress persistence across reload.

## Open questions for Ronin
- Drop-cap on all prose or only `.reader-document > p:first-of-type`?
- Keep "Paste Markdown/Text" in the toolbar when a doc is open, or empty-state only? (Plan: empty-state only + a "+" overflow menu in toolbar.)
- TOC rail in v1 or v1.1? (Plan: v1.1 unless he wants it now.)
- Auto-hide toolbar on idle scroll: on by default or opt-in?
