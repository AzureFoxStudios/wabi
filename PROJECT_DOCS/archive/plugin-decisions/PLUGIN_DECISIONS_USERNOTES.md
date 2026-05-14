# Plugin Decisions - UserNotes

## 2026-02-28
### Decision: Keep notes local-only and per-device
- Reason:
  - Matches private-note expectations and avoids backend schema/policy expansion.
- Consequence:
  - Notes do not sync between devices by default.

### Decision: Use explicit Save/Clear actions instead of autosave-on-keystroke
- Reason:
  - Reduces accidental writes and makes persistence intent clear.
- Consequence:
  - Users explicitly commit note updates.

### Decision: Apply strict note-length guardrail (`max 400`)
- Reason:
  - Prevents unbounded localStorage growth and keeps popout UI compact.
- Consequence:
  - Very long note drafts are truncated to bounded length on save.

### Decision: Gate user-note editor behind Add-ons toggle
- Reason:
  - Keeps feature optional and consistent with other plugin translations.
- Consequence:
  - Disabling toggle hides editor without deleting saved local notes.
