# Plugin Spec - UserNotes

## Metadata
- Plugin Name: `UserNotes`
- Source Link(s):
  - `https://betterdiscord.app/plugin/UserNotes`
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
- Letter Grade (`A/B/C/D/F`): `B`
- Decision: `Build Later+ (implemented)`

## Problem Statement
Users need a private place to remember context about specific people (follow-ups, preferences, moderation notes) without exposing that data publicly.

## Current Wabi Baseline
User popout could display a previously saved note value but had no write/edit path, so the feature was incomplete in practice.

## Functional Requirements
1. Add a local-only user note store keyed by user ID.
2. Allow editing notes in user popout for non-self profiles.
3. Provide explicit `Save` and `Clear` actions with user feedback.
4. Add an Add-ons toggle to enable/disable user-note UI.

## Non-Functional Requirements
- Performance:
  - Small local payloads and direct localStorage access only.
  - Bounded note size (`max 400` chars).
- Security/privacy:
  - Notes remain local to the current device.
  - No backend persistence or transmission.
- Accessibility:
  - Textarea and buttons remain keyboard accessible.
  - Character counter shown for limit visibility.
- Platform scope (Web/Desktop/Android):
  - Frontend-only behavior, shared across runtimes.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/userNotes.ts`
  - `frontend/src/lib/components/UserPopout.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `UserNotes` ON/OFF.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm current popout note display behavior and missing write path.
- [x] Define local storage schema and note length guardrail.

### Phase 1 - MVP
- [x] Add local note helpers (`get/set/clear`) and sanitize behavior.
- [x] Add popout textarea + save/clear controls.
- [x] Add Add-ons runtime toggle.

### Phase 2 - Harden
- [x] Enforce note length cap and normalized text writes.
- [x] Handle user switching and missing/invalid local data safely.

### Phase 3 - Polish
- [x] Add user feedback status text and character counter.

## Test Plan
- Manual:
  - Open another user's popout, add note, save, and reopen popout.
  - Clear note and verify persisted removal.
  - Toggle UserNotes off and verify note editor hides.
  - Reload app and confirm note persists locally.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `userNotes.ts` helper module.
- Remove UserNotes UI block from `UserPopout.svelte`.
- Remove `userNotesEnabled` toggle from settings/displayEnhancements.

## Open Questions
1. Should local user notes eventually support optional account-scoped sync with explicit encryption controls?
