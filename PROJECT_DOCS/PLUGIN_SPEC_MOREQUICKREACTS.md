# Plugin Spec - MoreQuickReacts

## Metadata
- Plugin Name: MoreQuickReacts
- Source Link(s):
  - `https://betterdiscord.app/plugin/MoreQuickReacts`
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `3`
- Usage Frequency (1-5): `4`
- Differentiation (1-5): `2`
- Implementation Effort (1-5, higher is harder): `2`
- Runtime Risk (1-5, higher is riskier): `1`
- Weighted Score (0-100): `67`
- Letter Grade (`A/B/C/D/F`): `C+`
- Decision: `Build (Core by + rule)`

## Problem Statement
Users need faster reaction workflows than opening a full emoji picker for every message.

## Current Wabi Baseline
Wabi already supports reaction add/remove, context-menu reaction entry, and reaction rendering.

## Functional Requirements
1. Provide fast one-click quick reactions directly in message actions.
2. Reuse existing reaction toggle behavior (add/remove on repeat click).
3. Keep full picker access available (quick-react is additive, not replacement).

## Non-Functional Requirements
- No backend schema changes for MVP.
- Minimal visual noise on mobile.
- No new auth/security surface in Phase 1.

## Wabi Integration Points
- `frontend/src/lib/components/MessageList.svelte`
  - message hover action bar
  - reaction toggle functions
  - emoji list resolution

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm existing reaction data/flows can be reused.
- [x] Define quick-reaction candidate strategy.

### Phase 1 - MVP
- [x] Add quick-reaction strip to message action bar.
- [x] Seed quick choices from existing reactions + curated defaults.
- [x] Route quick clicks through existing reaction toggle path.

### Phase 2 - Harden
- [x] Add per-user enable/disable setting.
- [x] Add guardrails for very large emoji sets.

### Phase 3 - Polish
- [x] User-customizable quick-reaction list.
- [x] Optional telemetry for quick-strip adoption.

## Test Plan
- Manual:
  - Hover message and confirm quick-reaction strip appears on desktop.
  - Click quick reaction twice to confirm add then remove.
  - Confirm existing "Add Reaction" picker still works.
  - Confirm mobile action tray does not become overcrowded.
  - Disable quick reactions in Settings and confirm quick strip hides while full picker still works.
  - Add/remove custom quick emojis in Settings and confirm they appear in hover strip candidate list.
  - Trigger quick strip and full picker flows, then verify local usage counters update in Settings.

## Rollback Plan
- Revert `MessageList.svelte` quick-strip additions; reaction baseline behavior remains unchanged.

## Current Implementation Snapshot (2026-02-26)
- Added quick-reaction strip to message hover actions.
- Candidate ordering:
  - top existing reactions on the message
  - curated defaults (`thumbs up`, `heart`, `joy`, `fire`, `eyes`)
  - fallback to available emoji inventory
- Quick clicks call existing `toggleReaction` flow.
- Added per-user settings in `Settings > Add-ons > MoreQuickReacts`:
  - ON/OFF toggle for quick strip
  - custom quick emoji set management (add/remove/clear)
  - bounded custom list size (`12`) and dedupe guardrails
- Added large-emoji guardrails in quick candidate resolver:
  - alias/fallback scans now use a bounded emoji pool to avoid full-set scans on large packs.
- Added lightweight local usage telemetry:
  - quick-strip click count
  - full picker open count
  - quick-strip share and counter reset controls in settings.
- Added mobile long-press action tray polish:
  - quick strip is now surfaced in mobile action tray with bounded horizontal layout.
