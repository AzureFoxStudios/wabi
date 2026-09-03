# Plugin Decisions - CustomStatusPresets

## 2026-02-28
### Decision: Translate presets as local presence shortcuts, not Discord-style custom activity payloads
- Reason:
  - Wabi currently has a clean status model (`active` / `away` / `busy`) and no shared custom-activity schema.
  - Preset shortcuts deliver the core user value quickly without backend schema expansion.
- Consequence:
  - Presets remain local to the client for now.
  - Presence updates still use existing `updateProfile(status)` path.

### Decision: Keep preset data local-only in frontend storage
- Reason:
  - Fast delivery with zero backend migration and no server-side complexity.
  - Avoids cross-device sync and privacy ambiguity until product policy is explicit.
- Consequence:
  - Presets are per-device and do not automatically sync between installations.

### Decision: Enforce strict preset guardrails (`max 12`, label/note sanitization)
- Reason:
  - Prevent unbounded storage growth and reduce malformed input risk.
  - Keep sidebar popup UX compact and performant.
- Consequence:
  - Adds predictable limits and stable rendering behavior.

### Decision: Add explicit Add-ons ON/OFF toggle for presets
- Reason:
  - Maintains consistent operator control surface with other translated plugins.
  - Allows users to disable the feature without deleting stored preset data.
- Consequence:
  - Sidebar popup preset section is gated by settings toggle.

### Decision: Clear active preset marker when user manually sets status
- Reason:
  - Manual status change should represent explicit user intent, not stale preset state.
- Consequence:
  - Active preset context remains accurate after direct status changes.

### Decision: Show active preset note/label only in the local sidebar profile area
- Reason:
  - Improves at-a-glance self-context without introducing shared profile behavior changes.
- Consequence:
  - No external visibility changes in user popouts/modals for other users.
