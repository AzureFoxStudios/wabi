# Plugin Spec - HideMutedCategories

## Metadata
- Plugin Name: `HideMutedCategories`
- Source Link(s):
  - `https://betterdiscord.app/plugin/HideMutedCategories`
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
- Decision: `Build Later (implemented as Wabi-native mute/hide translation)`

## Problem Statement
Users with busy workspaces need a way to reduce sidebar noise by hiding channels they have muted locally.

## Current Wabi Baseline
Wabi had no local muted-channel model and no sidebar filtering behavior for muted items.

## Functional Requirements
1. Add Add-ons toggle for HideMutedCategories behavior.
2. Add local per-channel mute state.
3. Expose `Mute Channel` / `Unmute Channel` in channel context menu.
4. Hide locally muted channels from sidebar when toggle is enabled.
5. Keep currently active channel visible even if muted.
6. Add settings action to clear muted-channel registry.

## Non-Functional Requirements
- Performance:
  - Use local arrays/set membership checks only.
  - Avoid backend calls for mute state.
- Security/privacy:
  - Mute state is local-only and not transmitted.
- Accessibility:
  - Context-menu and settings actions remain keyboard-accessible.
- Platform scope (Web/Desktop/Android):
  - Frontend-only behavior shared across runtimes.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/components/ChannelSidebar.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `HideMutedCategories` ON/OFF
    - muted-channel count
    - `Clear Muted` action.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm current sidebar/channel context menu architecture.
- [x] Define Wabi-native mute translation (local channel mute map).

### Phase 1 - MVP
- [x] Add local muted-channel settings fields and mutators.
- [x] Add context menu mute/unmute action.
- [x] Filter sidebar channel lists by muted state when enabled.

### Phase 2 - Harden
- [x] Preserve active channel visibility while hidden mode is enabled.
- [x] Add clear-muted action and bounded sanitization of muted IDs.

### Phase 3 - Polish
- [x] Add muted badges in sidebar rows when channels remain visible.

## Test Plan
- Manual:
  - Mute/unmute channels from context menu.
  - Enable HideMutedCategories and verify muted channels hide.
  - Confirm active muted channel stays visible.
  - Use `Clear Muted` in settings and verify list resets.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove mute-state fields and mutators from `displayEnhancements.ts`.
- Remove context menu mute actions + sidebar filtering from `ChannelSidebar.svelte`.
- Remove Add-ons controls from `Settings.svelte`.

## Open Questions
1. Should local muted-channel state become account-scoped sync data in future multi-device mode?
