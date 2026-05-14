# CSS Refactor — Phase 2: Component CSS Extraction

## Status: PARTIAL — Shared classes created, component migration not started

## What Was Accomplished (via OpenCode agent)

### New Shared Component CSS Files Created
| File | Size | Classes Added |
|------|------|---------------|
| `src/styles/components/cards.css` | 3,095 bytes | .card, .card-elevated, .card-compact, .surface, .surface-panel, .surface-modal, .surface-chat, .surface-tooltip, .surface-input, .overlay |
| `src/styles/components/badges.css` | 3,237 bytes | .badge, .badge-notification, .badge-status (online/away/busy/offline), .badge-role (owner/admin/mod), .badge-tag (muted/NSFW/bookmarked), .badge-chip |
| `src/styles/components/tooltips.css` | 4,899 bytes | .tooltip (with directional arrows), .popover, .glimpse-popout |
| `src/styles/components/inputs.css` | 3,117 bytes | .input, .input-sm, .input-lg, .input-with-icon, .input-group, .input-hint, .input-error |

### Updated Files
| File | Change |
|------|--------|
| `src/styles/styles.css` | Added imports for cards.css, badges.css, tooltips.css |

### Token Usage
All new classes use semantic tokens with fallback chains:
```css
background: var(--surface-app, var(--bg-primary, #1a1a2e));
```

## What's NOT Done
The 10 Svelte components were NOT modified. They still contain:
- ~55,000 lines of scattered CSS
- ~2,400 hardcoded rgba() and #hex values
- No usage of the new shared classes

## Next Step
To actually use these shared classes, someone needs to:
1. Read each component's `<style>` block
2. Identify patterns that match shared classes (buttons, cards, badges, inputs)
3. Add class attributes to DOM elements
4. Remove redundant CSS from component `<style>` blocks
5. Replace remaining hardcoded values with token references

## Remaining Work Estimate
- Phase 2 (component migration): Significant — requires modifying 10 large Svelte files
- Phase 3 (remaining 88 components): Large batch job
- Phase 4 (business hub): Low priority per Ronin
- Phase 5 (polish): Accessibility, mobile, scrollbar cleanup
- Phase 6 (artist features): Future

## Decision Needed
Ronin: The shared CSS infrastructure is built. Do you want me to:
1. Start manually migrating the top components one by one
2. Run another OpenCode pass focused on component modification
3. Pause here and review what's been done
4. Change strategy entirely
