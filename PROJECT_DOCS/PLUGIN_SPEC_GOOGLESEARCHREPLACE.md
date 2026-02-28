# Plugin Spec - GoogleSearchReplace

## Metadata
- Plugin Name: `GoogleSearchReplace`
- Source Link(s):
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entry)
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `3`
- Usage Frequency (1-5): `3`
- Differentiation (1-5): `2`
- Implementation Effort (1-5, higher is harder): `2`
- Runtime Risk (1-5, higher is riskier): `1`
- Weighted Score (0-100): `62`
- Letter Grade (`A/B/C/D/F`): `C`
- Decision: `Build Later (implemented)`

## Problem Statement
Users often continue a chat search in a browser, but without a direct bridge from the in-chat query.

## Current Wabi Baseline
Wabi provided in-chat filtering and history backfill controls, but no direct way to launch the same query in a browser search engine.

## Functional Requirements
1. Add an Add-ons toggle for GoogleSearchReplace behavior.
2. Provide a `Search on Web` action in chat search UI that opens the current query externally.
3. Allow users to pick a search provider:
  - DuckDuckGo
  - Google
  - Bing
  - Brave
  - Startpage.

## Non-Functional Requirements
- Performance:
  - No additional search indexing or heavy compute.
- Security/privacy:
  - Explicit user action required before external navigation.
  - No query telemetry added.
- Accessibility:
  - Action exposed as regular button controls in search UI.
- Platform scope (Web/Desktop/Android):
  - Frontend-only behavior on all runtimes.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/components/Chat.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
  - `frontend/src/lib/searchEngineJump.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `GoogleSearchReplace` ON/OFF.
    - provider selection dropdown.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm chat search flow and control insertion points.
- [x] Confirm external-open behavior pattern already exists in app.

### Phase 1 - MVP
- [x] Add toggle and provider persistence.
- [x] Add `Search on Web` action in chat search controls.

### Phase 2 - Harden
- [x] Guard empty-query and disabled-toggle states.
- [x] Ensure safe `window.open` usage (`noopener,noreferrer`).

### Phase 3 - Polish
- [x] Add provider list that keeps defaults practical for broad users.

## Test Plan
- Manual:
  - Enable add-on and run chat search query.
  - Click `Search on Web` and verify selected provider opens with the same query.
  - Disable add-on and verify action no longer appears.
  - Switch providers and verify URL target changes correctly.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `googleSearchReplaceEnabled` from `displayEnhancements.ts`.
- Remove provider helper module usage from `Chat.svelte`.
- Remove Add-ons toggle/provider controls from settings.

## Open Questions
1. Should provider selection move to a global privacy/search section in future settings refactor?
