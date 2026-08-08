# Worker A — Forum "+" Button Placement Report

**Date:** Aug 04 2026
**Background:** Place symmetric round "+" buttons in both Forum column headers (Categories + Threads).

## Files changed
- `frontend/src/lib/components/ForumChannel.svelte`
- `frontend/src/styles/components/forum.css`

No changes to `src-tauri/`, `lib/tauri-*.ts`, or category add/rename logic.

## What changed

### 1. `forum.css`
- `.forum-add-category-btn` restyled to match `.forum-new-thread-btn` geometry: `28px × 28px`, `border-radius: var(--radius-full)`, `font-size: 16px`, `font-weight: 700`, `line-height: 1`, `display: inline-flex` + centered. Kept its neutral transparent/`--border-subtle` styling (NOT accent-filled). Added `transform` to the transition.
- `.forum-add-category-btn:hover` now also scales (`transform: scale(1.05)`) to mirror the thread button hover.
- `.forum-post-list-header` updated to match the Categories header styling: `--font-size-xs`, uppercase, `letter-spacing: 0.05em`, `--text-muted`, `gap: var(--space-2)`; keeps flex row, space-between, centered, `flex-shrink: 0`.

### 2. `ForumChannel.svelte`
- Removed the `.forum-new-thread-btn` button from the Categories pane header (`.forum-category-header-actions` now holds only the add-category button).
- Add-category button label changed from `+ Tag` to `+` (still `title="Add category"`, still toggles `addCategoryMode`).
- Added a header row at the top of `.forum-post-list` (before the empty-state / `{#each}`):
  - Label renders `{activeCategory || 'Threads'}` (category name when a filter is active, else "Threads").
  - `.forum-new-thread-btn` shown there only `{#if canCurrentUserPost}`, wiring `handleNewThread`, `title="New Thread"`.

Add-category input / rename-pencil flows were not touched and still work.

## Verification
`cd /var/home/Ronin/wabi/frontend && bun run check` (run from frontend):

- `svelte-check found 6 errors and 71 warnings in 37 files`
- The **6 errors** are all pre-existing `bun:test`/`bun` module-resolution failures in test files (`storage-salt.test.ts`, `dmCrypto.test.ts`, `dmRatchet.test.ts`, `dmRecovery.test.ts`, `run-crypto-tests.ts`, `layoutSchema.test.ts`) — none in ForumChannel.svelte.
- **No new errors and no new warnings introduced** in `ForumChannel.svelte` or the forum CSS.