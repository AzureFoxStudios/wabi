# Plugin Spec - TimedLightDarkMode

## Metadata
- Plugin Name: `TimedLightDarkMode`
- Source Link(s):
  - `https://betterdiscord.app/plugin/TimedLightDarkMode`
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entry)
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `3`
- Usage Frequency (1-5): `3`
- Differentiation (1-5): `2`
- Implementation Effort (1-5, higher is harder): `2`
- Runtime Risk (1-5, higher is riskier): `2`
- Weighted Score (0-100): `62`
- Letter Grade (`A/B/C/D/F`): `C`
- Decision: `Backlog` -> `Implemented`

## Problem Statement
Users who prefer a light/day and dark/night workflow should not need to manually switch themes every day.

## Current Wabi Baseline
Wabi supported manual theme selection and custom theme editing, but had no time-based automatic theme switching behavior.

## Functional Requirements
1. Add Add-ons toggle for timed theme mode.
2. Allow users to set:
   - day start hour
   - night start hour
   - selected day theme
   - selected night theme.
3. Automatically apply the selected theme at runtime according to local device time.
4. Support both main window and detached-window runtime.

## Non-Functional Requirements
- Performance:
  - Lightweight scheduler with minute-boundary checks.
  - No continuous high-frequency timers.
- Security/abuse limits:
  - Local-only settings and runtime behavior.
  - No telemetry or network submission for schedule changes.
- Accessibility:
  - Explicit numeric hour controls.
  - Theme selection uses existing Settings theme names.
- Platform scope:
  - Web/desktop shared frontend behavior.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/timedThemeMode.ts`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/routes/+page.svelte`
  - `frontend/src/routes/detached/+page.svelte`
- Backend endpoints/services:
  - None.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm theme load/apply lifecycle hooks and watcher model.
- [x] Confirm detached route also initializes theme runtime.

### Phase 1 - MVP
- [x] Add persisted timed-theme settings store.
- [x] Add runtime scheduler and immediate apply path.
- [x] Add Settings controls for schedule/theme selection.

### Phase 2 - Harden
- [x] Sanitize hour/theme inputs and invalid persisted data.
- [x] Add visibility/focus wake path to avoid stale theme state after idle.

### Phase 3 - Polish
- [x] Ensure scheduler starts/stops cleanly in both app entry routes.
- [x] Keep behavior local-only and isolated from server theme preference writes.

## Test Plan
- Manual:
  - Enable feature and set day/night split around current hour; verify immediate theme switch.
  - Change day/night target themes and confirm runtime applies selected IDs.
  - Verify detached panel follows timed switching behavior.
  - Disable feature and verify scheduled switching stops.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `timedThemeMode.ts` store/scheduler module.
- Remove scheduler wiring from entry routes.
- Remove `TimedLightDarkMode` controls from Add-ons settings.

## Open Questions
1. Should timed switching support per-day schedules (weekday/weekend) in a future phase?
