# Plugin Spec - EmojiStatistics

## Metadata
- Plugin Name: `EmojiStatistics`
- Source Link(s):
  - `https://betterdiscord.app/plugin/EmojiStatistics`
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entry)
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `3`
- Usage Frequency (1-5): `2`
- Differentiation (1-5): `2`
- Implementation Effort (1-5, higher is harder): `1`
- Runtime Risk (1-5, higher is riskier): `1`
- Weighted Score (0-100): `62`
- Letter Grade (`A/B/C/D/F`): `C`
- Decision: `Backlog (implemented as local Add-on translation)`

## Problem Statement
Users want quick visibility into their emoji catalog composition without leaving settings or opening separate tools.

## Current Wabi Baseline
Wabi had emoji management surfaces but no dedicated summary view for totals and category distribution.

## Functional Requirements
1. Add a runtime toggle for EmojiStatistics in Add-ons settings.
2. Show local emoji inventory totals (`total`, `custom`, `default/open`).
3. Show top category breakdown from the current local catalog.

## Non-Functional Requirements
- Performance:
  - Compute stats from current in-memory emoji list only.
  - Keep category list bounded (top 8).
- Security/privacy:
  - No backend calls required.
  - No telemetry required for this feature.
- Accessibility:
  - Render stats as readable text blocks in settings.
- Platform scope (Web/Desktop/Android):
  - Frontend-only behavior, shared across all runtimes.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `EmojiStatistics` ON/OFF
    - local inventory summary section.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm local emoji list is already available in settings context.
- [x] Define bounded category aggregation behavior.

### Phase 1 - MVP
- [x] Add `EmojiStatistics` toggle.
- [x] Render total/custom/default-open counts.

### Phase 2 - Harden
- [x] Normalize category keys and sort deterministically.
- [x] Cap rendered category entries.

### Phase 3 - Polish
- [x] Add no-data fallback copy.

## Test Plan
- Manual:
  - Toggle on/off and verify stats block visibility.
  - Confirm counts change when emoji inventory changes.
  - Confirm empty catalog fallback copy appears.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `emojiStatisticsEnabled` setting from `displayEnhancements.ts`.
- Remove Add-ons settings block and category aggregation from `Settings.svelte`.

## Open Questions
1. Should future versions add per-server/per-workspace segmentation instead of global local totals?
