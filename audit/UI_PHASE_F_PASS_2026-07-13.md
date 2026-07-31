# UI Phase F — PASS (2026-07-13)

P0 visual hygiene + two P0 surface-polish items. Frontend-only. Token-driven, reduced-motion safe. No backend/socket/crypto/calling logic touched. No commits made.

## Files changed

### Task 1 — Blurple hygiene (kill Discord-blue)
- `src/lib/components/message/MessageReplyPreview.svelte` — reply-line pill now `background: var(--accent-primary-color)` (was hardcoded `#5865f2`); pill geometry + `!important` layer kept so it still beats cached globals.
- `src/lib/components/context-menu/ContextMenu.svelte` — `var(--accent, #5865f2)` fallback → `var(--accent, var(--accent-primary-color))`.
- `src/lib/components/plugins/YouTubeWatchEmbed.css` — two `#5865f2` fallbacks → `var(--accent-primary-color)`.
- `src/lib/components/PinnedMessagesModal.svelte` — `var(--accent-primary, #5865f2)` fallback → `var(--accent-primary, var(--accent-primary-color))`.
- `src/styles/components/todo-list.css` — 6 `var(--accent, #5865f2)` fallbacks → `var(--accent-primary-color)`.
- `src/lib/components/CallControls.svelte`, `src/lib/components/CallParticipantTile.svelte`, `src/styles/components/call-modal-part1.css`, `src/styles/components/call-modal-part2.css` — the deeply-nested third-level `#5865f2` fallback inside `var(--accent, var(--accent-primary, #5865f2))` tokenized to `var(--accent-primary-color)`. **Cosmetic-only color-token swap; zero calling behaviour/logic touched** — required to satisfy the "ZERO `#5865f2` under src/lib" acceptance grep.

### Task 2 — Channel-sidebar micro-label recipe
- `src/styles/components/sidebar-channels.css` — appended mock §11.1 left-nav recipe: mono uppercase micro-labels for `.section-toggle-label` / `.section-header` / `.section-subheader`, plus a subtle tabular-nums `.section-count` chip (brightens on hover). Additive chrome only.

### Task 3 — Server rail identity parity
- `src/lib/components/ServerRail.css`:
  - New calm **leading-edge indicator** (`.rail-item::before`) — token accent pill on the rail's left edge; short on hover, tall on active (`:has(.active)`).
  - Active server + folder-member states retokenized from teal/blue gradients to a soft `--accent-primary-color` wash + border (honours "one accent, spare use").
  - Add/manage affordance (`.rail-manage`) gets a calm accent tint on hover.
  - Added `prefers-reduced-motion: reduce` guard disabling rail hover morph, transforms, and the leading-edge grow.
- `src/lib/components/ServerRail.svelte` — tooltip language clarified: home logo → "Wabi — open server switcher"; both `+` buttons → "Add or switch servers".

## Blurple confirmation
`grep -rln "#5865f2" src/lib` returns **only** business user-palette files (`business/validation.ts`, Calendar*, Project*) — intentionally left alone. `src/styles` (excluding the pre-existing `.bak` backup) has **zero** occurrences. Discord blue-purple is gone from all core UI.

## What Tasks 2 / 3 did
- **Task 2:** Made section labels read as scannable mono micro-labels with a quiet count chip, matching the mock's sectioned left-nav. Cozy chat message density untouched (only nav chrome). The LIVE pill from Phase C kept; its `.live-dot` motion was already reduced-motion guarded in `motion.css`.
- **Task 3:** Turned the far-left identity rail into a calm leading-edge rail — accent leading pill, single-accent active state (no more teal/blue), clearer add-server affordance, clearer tooltips, and a reduced-motion guard for its hover morph.

## Verification
- `bun run check` → **0 errors, 75 warnings** (baseline 75; not worsened).
- `bun run build` → **✓ built in ~18.6s**, done. (Only the pre-existing benign adapter notice about an unused `invoke` import.)

## Remaining risks
- **Calling-file cosmetic swaps:** `CallControls.svelte` / `CallParticipantTile.svelte` / `call-modal-part*.css` had a never-reached third-level `#5865f2` fallback tokenized. Purely visual; no calling logic, sockets, or crypto touched. Flagged because these live under the FORBIDDEN "calling" area — swap was needed for the zero-blurple acceptance grep.
- **`:has()` selector** used for the rail leading-edge active indicator; fine for the app's modern target, but no fallback bar renders on very old engines (graceful — indicator simply won't show).
- Business components (Calendar/Projects/validation) still ship `#5865f2` as an intentional user-palette default — left untouched per scope.
- `src/styles/components/ml-replies.css.bak-chat-fix-1783504674` still contains a `#5865f2` fallback; it's a backup file, not built or imported.
