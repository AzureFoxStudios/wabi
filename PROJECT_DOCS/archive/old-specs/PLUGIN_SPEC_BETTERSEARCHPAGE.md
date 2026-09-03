# Plugin Spec - BetterSearchPage

## Metadata
- Plugin Name: `BetterSearchPage`
- Source Link(s):
  - `https://betterdiscord.app/plugin/BetterSearchPage`
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entry)
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `4`
- Usage Frequency (1-5): `3`
- Differentiation (1-5): `3`
- Implementation Effort (1-5, higher is harder): `2`
- Runtime Risk (1-5, higher is riskier): `2`
- Weighted Score (0-100): `78`
- Letter Grade (`A/B/C/D/F`): `B+`
- Decision: `Build Later (implemented)`

## Problem Statement
When users search through long channel history, key controls (result count, history scan controls) are easy to lose while scrolling.

## Current Wabi Baseline
Wabi had header search input and dynamic match filtering, but result controls were tied to the header area and not anchored in the scroll context.

## Functional Requirements
1. Add an Add-ons toggle for BetterSearchPage behavior.
2. Show search result controls in a sticky toolbar above search results while scrolling:
  - match count
  - loading older-history indicator
  - full-history scan/stop action
  - status feedback text.
3. Keep existing header search input behavior intact.

## Non-Functional Requirements
- Performance:
  - Reuse existing search/filter state; no new heavy query loops.
  - Sticky toolbar should not trigger expensive layout thrashing.
- Security/privacy:
  - No new backend APIs.
  - No telemetry required.
- Accessibility:
  - Toolbar controls remain keyboard accessible buttons/text.
- Platform scope (Web/Desktop/Android):
  - Frontend-only behavior on all runtimes.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/components/Chat.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `BetterSearchPage` ON/OFF.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm search state and full-history backfill controls in chat header path.
- [x] Define sticky-toolbar insertion point in message pane.

### Phase 1 - MVP
- [x] Add toggle and sticky result toolbar rendering.
- [x] Route existing full-history controls to toolbar when enabled.

### Phase 2 - Harden
- [x] Preserve parity behavior when toggle is disabled (header controls still work).
- [x] Keep scroll-safe sticky placement and mobile-friendly sizing.

### Phase 3 - Polish
- [x] Add runtime copy/status alignment with existing i18n search messages.

## Test Plan
- Manual:
  - Enable BetterSearchPage and run searches in channels with long history.
  - Scroll results and confirm toolbar remains visible.
  - Start/stop full-history backfill from toolbar.
  - Disable BetterSearchPage and confirm controls return to header-only mode.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `betterSearchPageEnabled` from `displayEnhancements.ts`.
- Remove Add-ons toggle from settings.
- Remove sticky toolbar path and restore header-only result controls in `Chat.svelte`.

## Open Questions
1. Should sticky search controls become default-on and non-toggle after more usage feedback?
