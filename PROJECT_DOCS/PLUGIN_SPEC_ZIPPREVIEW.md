# Plugin Spec - ZipPreview

## Metadata
- Plugin Name: ZipPreview
- Source Link(s): `https://betterdiscord.app/plugin/ZipPreview`
- Wabi Target Version: `0.4.x+`
- Status: `In Progress (Phase 2)`

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
- [x] Locate exact attachment render path in current chat component.
- [x] Define parser library/approach (native parser vs small dependency).
- [x] Lock initial limits (size, entries, timeout).

### Phase 1 - MVP
- [x] ZIP attachment detection.
- [x] Metadata parse from fetched bytes.
- [x] Basic tree/list UI with expand/collapse.
- [x] Error/fallback states.
- [x] Fixture smoke validation on malformed/oversized/split ZIP samples.

### Phase 2 - Harden
- [x] Metadata caching keyed by attachment URL/hash.
- [x] File name search/filter.
- [x] Stronger malformed archive handling.

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

## Current Implementation Snapshot (2026-02-25)
- Frontend integration:
  - `frontend/src/lib/components/MessageList.svelte`
  - `frontend/src/lib/components/ZipPreviewPanel.svelte`
  - `frontend/src/lib/zip/zipPreview.ts`
- Smoke coverage:
  - `frontend/scripts/zip-preview-fixture-smoke.ts`
  - command: `bun run check:zip-preview`
- MVP limits currently enforced:
  - max archive bytes for preview: `25 MB`
  - max rendered entries: `200`
  - fetch timeout: `4 seconds`
- Hardening implemented:
  - LRU-style in-memory cache with TTL (`url + size` key)
  - in-panel filename search/filter with result count
  - parser checks for multi-disk/split archives and central-directory inconsistencies
  - retry action in panel error state without full remount
- Explicitly unsupported in MVP:
  - encrypted attachments
  - ZIP64 preview parsing
