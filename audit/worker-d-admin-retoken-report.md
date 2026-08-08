# Worker D — Admin Re-Token Report

Both dispatched workers (D, D1) died on deepseek 503 (queue full). The scoped swaps were
finished in-session by Hermes and independently verified. This is the consolidated report.

## Replacements made (in-session)

### admin-center-stage.css
- `var(--text-primary, #e8e8e8)` -> `var(--text-heading, #e8e8e8)` — 5 sites (lines 7, 44, 113, 548, 925). `--text-primary` is NOT defined in tokens.css nor set per-theme by themeManager (its SEMANTIC_MAP aliases `--text-heading`/`--text-body` TO `--text-primary`, but nothing ever defines `--text-primary` itself), so those 5 sites were pinned to the static `#e8e8e8` fallback on every theme. `--text-heading` IS defined (tokens.css:48/291) and set per-theme, and carries the same `#e8e8e8` fallback — zero visual change on the default theme, now theme-reactive on the other 7.
- `var(--border-visible, #444)` / `var(--border-visible, #333)` -> `var(--border-strong)` — 3 sites (lines 316, 652, 924). `--border-visible` was undefined (silent no-op borders). `--border-strong` is defined (tokens.css:75).

### admin-tab.css
- `rgba(255, 183, 77, 0.45)` -> `rgba(var(--color-warning-rgb), 0.45)` and `rgba(255, 183, 77, 0.12)` -> `rgba(var(--color-warning-rgb), 0.12)` — line 137 warning-button hover. Raw warning-amber literals replaced with the per-theme `--color-warning-rgb` token (defined tokens.css:69/304).

## Verified clean (no change needed)
- Zero undefined `--accent-*` tokens (no `--accent-red/blue/green/purple/color`).
- Zero `--color-{info,success,danger,warning}-hover` or `--modal-text-*` usages.
- Zero font drift — no raw font-family / Space Grotesk / Space Mono in scope.
- `--accent-warning-soft` IS defined (tokens.css:90) — not undefined as initially suspected.
- `#2dd4bf` in FrontendMetadataPanel.svelte is user-data (accent-color input placeholder) — correctly NOT tokenized.

## Deliberately preserved fallbacks (do NOT "fix" these later)
- `var(--text-disabled, #666)` — 14 sites. `--text-disabled` is intentionally left UNDEFINED:
  the only defined candidate, `--text-muted`, resolves to lavender `#9999ff`, NOT gray `#666`.
  Defining or swapping it would visibly change 14 admin text elements and violate the
  preserve-resolved-colors rule. The `var(--token, #fallback)` pattern here matches the
  codebase's own convention (Done §4's fixed code uses the same pattern, e.g.
  `var(--surface-app, #0d0d1a)`). If a future theme pass wants per-theme disabled text,
  define `--text-disabled: #666` (exact current color) in the tokens.css LEGACY block —
  never alias it to `--text-muted`.
- `var(--text-inverse, #fff)` / `#f8fafc` fallbacks — `--text-inverse` IS defined and
  theme-reactive; the fallback only fires if the token is absent. Convention-consistent.

## Related gradient-rule fix (same rule as Done §4, applied to forum.css)
forum.css had 13 pre-existing uses of `var(--accent-primary)` (a CSS gradient) in
`color:` / `border-color:` positions — silently transparent text/borders on every theme.
Property-scoped sed: color/border usages -> `--accent-primary-color`; the three
`background:` usages (lines 44, 57, 611) keep the gradient `--accent-primary` as intended.
No `box-shadow`/`outline` gradient usages found.

## Gate results
- `bun run check` -> 6 errors / 71 warnings — identical to pre-work baseline (all 6 are
  pre-existing bun:test module-resolution issues elsewhere). Zero new errors.
- `bun run build` -> passed (adapter-node ✔ done).
- `cargo check -p wabi-server` -> clean (pre-existing warnings only).
- `git diff -- frontend/src/styles/tokens.css` -> EMPTY (tokens.css untouched; a
  `--text-disabled` line was briefly considered then deliberately reverted — see above).
- Nothing committed.
