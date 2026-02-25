# Plugin Spec - ZipPreview

## Metadata
- Plugin Name: ZipPreview
- Source Link(s): `https://betterdiscord.app/plugin/ZipPreview`
- Wabi Target Version: `0.4.x+`
- Status: `Planned`

## Plugin Grade
- User Impact (1-5): `5`
- Usage Frequency (1-5): `4`
- Differentiation (1-5): `4`
- Implementation Effort (1-5, higher is harder): `3`
- Runtime Risk (1-5, higher is riskier): `2`
- Weighted Score (0-100): `88`
- Letter Grade (`A/B/C/D/F`): `A`
- Decision: `Build Now`

## Problem Statement
Users share `.zip` files and cannot inspect contents quickly. They need lightweight visibility (file list and sizes) without downloading/extracting manually.

## Functional Requirements
1. Detect ZIP attachments in chat message UI.
2. Parse ZIP metadata (central directory) and show:
   - entry list/path
   - compressed/uncompressed size
   - total entries
3. Show failures clearly for invalid or unsupported archives.

## Non-Functional Requirements
- Performance:
  - No full extraction for MVP.
  - Max parsing time budget (target <= 2s for normal archives).
- Security/abuse limits:
  - hard cap on archive bytes fetched
  - hard cap on entry count rendered
  - skip encrypted/unsupported features with explicit message
- Accessibility:
  - keyboard accessible expand/collapse
  - readable labels for counts/sizes
- Platform scope (Web/Desktop/Android):
  - Web + Desktop MVP
  - Android after MVP stability

## Wabi Integration Points
- Frontend files/components:
  - message attachment rendering in chat UI
  - optional reusable `ZipPreviewPanel` component
- Backend endpoints/services:
  - none required for Phase 1 if attachment URL already accessible
- Settings exposure:
  - later phase: enable/disable preview + strict limit tuning

## Phase Plan
### Phase 0 - Discovery
- [ ] Locate exact attachment render path in current chat component.
- [ ] Define parser library/approach (native parser vs small dependency).
- [ ] Lock initial limits (size, entries, timeout).

### Phase 1 - MVP
- [ ] ZIP attachment detection.
- [ ] Metadata parse from fetched bytes.
- [ ] Basic tree/list UI with expand/collapse.
- [ ] Error/fallback states.

### Phase 2 - Harden
- [ ] Metadata caching keyed by attachment URL/hash.
- [ ] File name search/filter.
- [ ] Stronger malformed archive handling.

### Phase 3 - Polish
- [ ] Optional inline preview for safe text/image entries.
- [ ] Sorting options and iconography.
- [ ] Settings controls and user-facing docs.

## Test Plan
- Unit:
  - parser on small/large/malformed zip fixtures
  - size and entry cap enforcement
- Integration:
  - render in chat attachment list with async loading
- Manual:
  - open/close preview
  - edge case archives
  - desktop packaged app smoke test

## Rollback Plan
- Feature flag toggle to disable ZIP preview panel entirely.
- Keep attachment display fallback unchanged.

## Open Questions
1. Should parser run in main thread or Web Worker for large archives?
2. Do we want backend-assisted parsing for very large files later?
3. Should previews support password-protected archives (likely no)?
