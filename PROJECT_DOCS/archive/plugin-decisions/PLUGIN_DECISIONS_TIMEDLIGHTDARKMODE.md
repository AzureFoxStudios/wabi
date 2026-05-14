# Plugin Decisions - TimedLightDarkMode

## 2026-02-28
### Decision: Keep schedule settings local-only
- Reason:
  - Theme timing is user/device preference and does not require server coordination.
  - Avoids conflicts with explicit server-saved theme choices.
- Consequence:
  - Timed mode does not sync across devices by default.

### Decision: Use minute-boundary scheduler with focus/visibility wake
- Reason:
  - Reliable theme transitions with minimal runtime overhead.
- Consequence:
  - Low-cost timer loop and immediate correction when tab/window returns to focus.

### Decision: Allow independent day/night theme IDs from full Wabi theme catalog
- Reason:
  - Users can pick non-default combinations instead of hardcoding to `light`/`dark`.
- Consequence:
  - Timed mode integrates with all current predefined themes.

### Decision: Wire scheduler in both main and detached routes
- Reason:
  - Detached chat windows should remain consistent with main app appearance rules.
- Consequence:
  - Shared scheduler startup/teardown in `routes/+page.svelte` and `routes/detached/+page.svelte`.
