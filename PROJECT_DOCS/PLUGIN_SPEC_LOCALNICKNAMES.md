# Plugin Spec - LocalNicknames (Wabi Extension)

## Metadata
- Plugin Name: `LocalNicknames`
- Source Link(s):
  - User-directed Wabi translation extension while porting nickname-related plugin behavior.
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Problem Statement
Users want private nickname overrides for people they interact with, without changing shared server/profile identity data.

## Current Wabi Baseline
Wabi supported canonical name rendering (`RemoveNicknames`) but not per-user private nickname overrides.

## Functional Requirements
1. Add an Add-ons toggle for local nickname behavior.
2. Persist per-user local nicknames on device only.
3. Allow set/clear nickname actions from user surfaces.
4. Render local nickname overrides in key people surfaces:
  - chat message headers
  - user popouts
  - user-list rows.

## Non-Functional Requirements
- Performance:
  - lightweight local map lookup keyed by stable user identity.
- Security/privacy:
  - no backend sync or remote writes.
  - all nickname data remains local to device storage.
- Accessibility:
  - set/clear actions exposed as regular menu/popout buttons.
- Platform scope (Web/Desktop/Android):
  - frontend-only behavior on all runtimes.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/localNicknames.ts`
  - `frontend/src/lib/components/MessageList.svelte`
  - `frontend/src/lib/components/UserPopout.svelte`
  - `frontend/src/lib/components/UserListTab.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `LocalNicknames` ON/OFF.
    - clear-all action for local nickname map.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm stable user identity key strategy (`dbUserId` fallback to runtime `id`).
- [x] Confirm existing user surfaces where names are rendered.

### Phase 1 - MVP
- [x] Add local nickname store with sanitization/guardrails.
- [x] Add add-on toggle and set/clear interactions from user list context menu.

### Phase 2 - Harden
- [x] Wire nickname rendering into chat/user popout/user list.
- [x] Add clear-all settings action and key sanitization.

### Phase 3 - Polish
- [x] Add local-identity hint in popout when nickname differs from account username.

## Test Plan
- Manual:
  - Set nickname for a user via user list context menu.
  - Verify nickname appears in chat headers and popout title.
  - Clear nickname and verify canonical username returns.
  - Use settings clear-all and verify map resets.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `localNicknamesEnabled` from `displayEnhancements.ts`.
- Remove local nickname store and rendering hooks from user/message surfaces.
- Remove settings toggle and clear action.

## Open Questions
1. Should local nicknames also apply to DM list headers in a future UX pass?
