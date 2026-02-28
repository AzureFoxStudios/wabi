# Plugin Spec - RemoveNicknames

## Metadata
- Plugin Name: `RemoveNicknames`
- Source Link(s):
  - `https://betterdiscord.app/plugin/RemoveNicknames`
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
- Letter Grade (`A/B/C/D/F`): `C+`
- Decision: `Backlog (implemented with Wabi-native account-name preference)`

## Problem Statement
When message payloads contain alias-style names, users may want stable account-name display for moderation clarity and identity consistency.

## Current Wabi Baseline
Message headers rendered the incoming message author label directly, which could preserve alias/nickname-style values even when stable user identity data was available.

## Functional Requirements
1. Add Add-ons toggle for RemoveNicknames behavior.
2. Resolve message author identity using stable IDs first (`userId`/`dbUserId` fallback path).
3. When enabled, render canonical account username in message headers/avatar fallback contexts.
4. Preserve user popout open behavior by using resolved identity rather than raw label text.

## Non-Functional Requirements
- Performance:
  - Reuse existing users store and lightweight identity lookup.
  - Avoid expensive per-message remote calls.
- Security/privacy:
  - No new backend APIs or persisted network metadata.
- Accessibility:
  - Keep existing username click/popout interactions unchanged.
- Platform scope (Web/Desktop/Android):
  - Frontend-only logic in shared message renderer.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/components/MessageList.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `RemoveNicknames` ON/OFF.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm message payload has both display label and stable user identity fields.
- [x] Define canonical-name fallback behavior when identity resolution fails.

### Phase 1 - MVP
- [x] Add toggle and author resolution helpers.
- [x] Apply canonical display name in message headers when enabled.

### Phase 2 - Harden
- [x] Ensure role badges/staff tags/popout click paths use resolved author identity.
- [x] Preserve graceful fallback for unknown users.

### Phase 3 - Polish
- [x] Keep behavior optional and reversible through Add-ons settings.

## Test Plan
- Manual:
  - Enable RemoveNicknames and verify message headers prefer account names.
  - Disable RemoveNicknames and verify raw message label behavior returns.
  - Click usernames to confirm popout still opens for resolved account.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `removeNicknamesEnabled` setting from `displayEnhancements.ts`.
- Remove Add-ons toggle from settings.
- Revert message header author rendering to raw `message.user`.

## Open Questions
1. Should canonical-name preference also apply to other surfaces (thread preview rows, notification toasts) in a later pass?
