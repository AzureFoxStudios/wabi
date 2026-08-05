# Design Polish — Screen 1: Chat Surface (worker report)

Extracted from audit/design-polish.log on 2026-08-05. Gate: bun run check = 6 pre-existing bun:test errors, 0 new.

Done. Verification gate passed (6 pre-existing `bun:test` errors, 0 new; no warnings in touched files; all braces balanced). Here's the punch list.

## Chat Surface — Token Polish Punch List

### Token violations fixed (measured → token)

| Area | Violation (file:line) | Rule | Before → After |
|---|---|---|---|
| chat-core | z-index 20/1/0 (36/48/55) | hardcoded z | `--z-sticky` / `--z-base` |
| chat-core | `border-radius: 999px` (224) | off-scale radius | `--radius-full` |
| chat-core | `font-size: 0.66/0.68rem` | drift | `--text-xs` |
| chat-core | file-gallery `padding: 8px 12px`, 12px corners | off-scale | `--space-2/3`, `--radius-lg` + `--radius-none` |
| chat-header | z-index 2 (21) | hardcoded z | `--z-sticky` |
| chat-header | h2 1.05rem, surface-label 0.68rem | drift | `--text-lg` / `--text-xs` |
| chat-header | compactable transitions 0.24s/0.28s/0.22s, gap 0.4rem | raw durations | `--duration-normal`, `--space-1` |
| chat-composer | z 25/10/20 (49/128/202) | hardcoded z | `--z-sticky`/`--z-popover`/`--z-dropdown` |
| chat-composer | radii 6px/8px/0.6rem/0.4rem | off-scale | `--radius-md`/`--radius-lg` |
| chat-composer | font sizes 0.85/0.8/1.25/0.72/1.1/1.5/0.68/0.78/0.9rem | drift | `--text-base/sm/xl/xs/lg/2xl` |
| chat-search | z-index 3 (24/132) | hardcoded z | `--z-sticky` |
| chat-search | radii 10px (3×), font 0.72rem | off-scale + drift | `--radius-md`, `--text-xs` |
| chat-upload | radii 14px/10px/9px/999px/8px | off-scale | `--radius-lg/md/full` |
| chat-upload | font 1.65/0.66/0.74/0.85/0.76/0.72rem | drift | `--text-2xl/xs/base/sm` |
| chat-workspace | 999px/12px, gaps 0.4/0.18rem, font 0.78/1.25rem | off-scale/drift | `--radius-full/lg`, `--space-1`, `--text-sm/xl` |
| chat-compression | z-index 30 (16) | hardcoded z | `--z-dropdown` (keeps modal above composer at `--z-sticky`) |
| chat-compression | radii 12px/8px (5×) | off-scale | `--radius-lg/md` |
| chat-compression | font 0.95/0.8/0.73/0.74/0.72/0.75/0.78rem | drift | `--text-lg/sm/xs` |
| ml-core | z-index 0 (174) | hardcoded z | `--z-base` |
| ml-core | 999px, 11px/2rem/13px/15px/0.64–0.86rem | off-scale/drift | `--radius-full`, `--text-xs/3xl/sm/lg/base` |
| ml-actions | `padding: 5px`, font 1/0.75/0.8rem, 0.2s/0.18s | off-scale/drift | `--space-1`, `--text-lg/xs/sm`, `--duration-fast/instant` |
| ml-badges | 999px (6×), 0.64/0.62/0.68/0.72rem | off-scale/drift | `--radius-full`, `--text-xs` |
| ml-replies | 999px, gaps 6/5px, 12px | off-scale | `--radius-full`, `--space-2/1`, `--text-sm` |
| ml-reactions | 6px/12px, 0.2s | off-scale | `--radius-sm/lg`, `--duration-normal` |
| ml-spoiler | 4px, 0.875rem, z 1 | off-scale/drift | `--radius-sm`, `--text-base`, `--z-base` |
| ml-markdown | 999px, 0.4rem, 0.18s | off-scale | `--radius-full/md`, `--duration-fast` |
| ml-translated | 8px, 0.65rem | off-scale/drift | `--radius-md`, `--text-xs` |
| ml-directions | 12/9999/10px, font 0.68–0.96rem, 0.18s | off-scale/drift | `--radius-lg/full/md`, `--text-xs/sm/base/lg`, `--duration-fast` |
| ml-media | 8px (4×) | off-scale | `--radius-md` |
| ml-attachments | 9999/14/10/8/4px (6×), 0.72/0.7rem, 0.2/0.3s | off-scale/drift | `--radius-full/xl/md/sm`, `--text-xs/sm`, `--duration-normal/slow` |
| ml-lightbox | 10/8/20/7px, 0.75/0.9rem, 0.15/0.2s | off-scale/drift | `--radius-md/sm/full`, `--text-sm/base`, `--duration-fast/normal` |
| ml-mobile | 4/8px (8×), 0.7/0.8/2rem (7×) | off-scale/drift | `--radius-sm/md`, `--text-xs/sm/3xl` |
| chat-mobile | 10/12px, 0.96/0.84/0.7/0.68rem | off-scale/drift | `--radius-md/lg`, `--text-lg/base/xs` |
| styles.css tail | 12px/8px, `16px`, `gap 16px`, `150/180/120ms`, `1rem` | off-scale/drift | `--radius-lg/md/sm`, `--space-4`, `--duration-fast/instant`, `--text-lg/sm` |

### A11y fixed
- ChatComposer.svelte: emoji-picker, payment, manual-cash, send buttons gained `aria-label` (icon-only, previously `title`-only — weak for screen readers).

### Deliberate non-changes (with reason)
- `font-size: 16px` on mobile textareas — **iOS auto-zoom guard** (required, commented).
- `.gallery-file-icon-large` 4rem / `.nav-arrow` 2.5rem — display glyphs, no token equivalent.
- Cozy density numbers in styles.css tail (`2px` pad, `1.0625rem` group margin, `40px` avatar) — authoritative mock spec, sub-scale by design.
- `.customization-panel` / `.density-toggle` / `.density-btn` — **Settings/Appearance screen**, next pass.
- `chat-calls.css:19` 999px — call screen, next pass.
- `ml-mobile.css` sub-scale padding (0.2/0.78rem etc.) — deliberate mobile densification layer.

### Screens to eyeball
Channel header (hover workspace actions, mobile), composer (hover/focus ring, mention popover, media menu, char-counter), message list (cozy/compact density, hover actions, reactions, badges, spoiler, translation, gallery/album, GIF captions), video compression dialog, media lightbox toolbar.

### Self-critique
- The compression backdrop at `--z-dropdown` (200) is a compromise: it restores "above composer" after the composer rose to `--z-sticky` (100) but is semantically a modal — ideally `--z-overlay`; left low to avoid escaping the panel's stacking context. Revisit during the global z-reconciliation pass.
- I tokenized paddings like `0.48rem→var(--space-2)` (snap-to-scale ±2px). Rendering shifts ~1–2px in places — flagged, not silent.
- ~75% of remaining literal values in the chat surface are intentional sizing (heights, min-widths) — left alone.
- No screenshots taken (headless Chromium crashes on Wabi; needs a real browser/Tauri window).

Not committed, as requested.
