# Plugin Spec - CustomStatusPresets

## Metadata
- Plugin Name: CustomStatusPresets
- Source Link(s):
  - `https://betterdiscord.app/plugin/CustomStatusPresets`
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entry)
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `4`
- Usage Frequency (1-5): `3`
- Differentiation (1-5): `3`
- Implementation Effort (1-5, higher is harder): `2`
- Runtime Risk (1-5, higher is riskier): `2`
- Weighted Score (0-100): `72`
- Letter Grade (`A/B/C/D/F`): `B`
- Decision: `Build Later`

## Problem Statement
Users who switch presence states throughout the day repeat the same status actions. They need fast, reusable status shortcuts instead of redoing each change manually.

## Current Wabi Baseline
Wabi supported direct status switching (`active` / `away` / `busy`) but had no preset model, no quick preset application path, and no persistent preset management controls.

## Functional Requirements
1. Allow users to define reusable status presets with a label and target presence.
2. Allow users to apply presets directly from the sidebar status popup.
3. Persist presets locally with guardrails and expose management controls in Add-ons settings.
4. Surface currently active preset context in the sidebar profile area.

## Non-Functional Requirements
- Performance:
  - Local-only state updates; no additional network polling.
  - Bounded list size to avoid UI bloat.
- Security/abuse limits:
  - Local storage only.
  - Sanitize preset label/note content and lengths.
  - Cap preset count (`12`) to constrain payload growth.
- Accessibility:
  - Preserve existing button-based status interactions.
  - Keep preset labels readable and truncated safely where needed.
- Platform scope (Web/Desktop/Android):
  - Web + desktop parity through shared Svelte frontend.
  - No backend/runtime-specific dependencies.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/customStatusPresets.ts`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/components/ChannelSidebar.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons section:
    - `CustomStatusPresets` ON/OFF
    - preset add/remove/reset
    - quick apply action.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm Wabi status update path and sidebar interaction points.
- [x] Define Wabi-native translation (preset shortcuts) independent of Discord-specific UI assumptions.

### Phase 1 - MVP
- [x] Add persisted preset store with label + status + optional note.
- [x] Add preset management controls to Add-ons settings.
- [x] Add quick preset apply entries to sidebar status popup.

### Phase 2 - Harden
- [x] Add preset count cap and input sanitization.
- [x] Ensure active preset state clears when manual status is chosen.
- [x] Add fallback/default handling for malformed local data.

### Phase 3 - Polish
- [x] Show active preset note/label under sidebar user tag.
- [x] Add reset path to restore default presets.

## Test Plan
- Manual:
  - Add presets with unique labels/statuses; verify persistence across reload.
  - Apply preset from sidebar popup; verify presence updates.
  - Manually choose status; verify active preset state clears.
  - Remove/reset presets and verify expected list/state behavior.
  - Disable add-on toggle and confirm preset block is hidden from sidebar popup.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `customStatusPresets` store wiring from `Settings.svelte` and `ChannelSidebar.svelte`.
- Remove `customStatusPresetsEnabled` toggle from `displayEnhancements.ts`.
- Status switching reverts to baseline direct `active/away/busy` controls.

## Open Questions
1. Should custom status presets sync per-account (server-side) instead of local-only in a later phase?
2. Should preset notes be visible to other users in popouts/profile surfaces, or remain self-only?
