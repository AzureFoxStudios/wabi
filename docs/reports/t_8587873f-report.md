# t_8587873f — Toolbar dead-CSS purge + unified metrics

Commit: 2473bd9 (hy3-free worker, orchestrator-verified).

## What
- Deleted: .wb-color-picker, .wb-color-field, .wb-color-text, .wb-color-label/.wb-fill-label, alignTools array, corner shortcut hints (+ .wb-tool-shortcut), duplicate section rules. All grep-verified zero references post-delete.
- Unified: icon buttons (.wb-tool-btn, .wb-width-btn) to 32px; swatches 18px; radii consistent.
- File: 1256 → 1156 lines.

## Verification
- svelte-check: 0 errors, warnings DROPPED 173 → 165 (removed unused-CSS noise)
- STATIC_BUILD build: green
