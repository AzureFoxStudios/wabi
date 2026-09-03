# Plugin Spec - StaffTag + TopRoleEverywhere

## Metadata
- Plugin Name: `StaffTag`, `TopRoleEverywhere`
- Source Link(s):
  - `https://betterdiscord.app/plugin/StaffTag`
  - `https://betterdiscord.app/plugin/TopRoleEverywhere`
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entries)
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
- Decision: `Backlog` -> `Implemented`

## Problem Statement
Users need quick visual context for authority and role hierarchy in conversations without opening profile panels.

## Current Wabi Baseline
Wabi had role data but role/staff visibility was inconsistent across chat and profile surfaces, and there were no explicit feature toggles for these role tags.

## Functional Requirements
1. Add independent Add-ons toggles for `StaffTag` and `TopRoleEverywhere`.
2. Show top-role badges in core user-identity surfaces.
3. Show staff marker chips (`owner` / `admin` / `mod`) where user identity is rendered.
4. Keep behavior local to existing role metadata; no new server protocol.

## Non-Functional Requirements
- Performance:
  - Pure render-time helpers from already-loaded user role data.
  - No polling or extra socket events.
- Security/abuse limits:
  - No trust model changes; this is display-only.
  - Uses server-provided role metadata only.
- Accessibility:
  - Text labels (not icon-only) for role/staff chips.
  - Respect existing color contrast tokens.
- Platform scope:
  - Shared web/desktop UI surfaces.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/displayEnhancements.ts`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/components/MessageList.svelte`
  - `frontend/src/lib/components/UserPopout.svelte`
  - `frontend/src/lib/components/UserListTab.svelte`
- Backend endpoints/services:
  - None.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm existing role data sources in message/user/popout paths.
- [x] Define role-tone styling translation in Wabi tokens.

### Phase 1 - MVP
- [x] Add Add-ons toggles for `StaffTag` and `TopRoleEverywhere`.
- [x] Render top-role + staff chips in chat headers.
- [x] Render top-role + staff chips in user popout.

### Phase 2 - Harden
- [x] Ensure fallback role labels when role definitions are missing.
- [x] Gate all render paths behind feature toggles.

### Phase 3 - Polish
- [x] Extend chips to user-list rows for better "everywhere" parity.
- [x] Apply role-tone badge styles for visual hierarchy.

## Test Plan
- Manual:
  - Toggle each feature independently and verify expected surfaces.
  - Verify owner/admin/mod receive staff chip; members do not.
  - Verify top-role labels still render when custom role display names exist.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove toggle keys and setters from `displayEnhancements.ts`.
- Remove badge/chip markup from message/popout/user-list surfaces.
- Settings reverts to prior Add-ons baseline.

## Open Questions
1. Should role chips be optionally shown in DM list and voice participant overlays?
