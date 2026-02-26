# Feature Spec - Shared Media Albums

## Metadata
- Feature Name: Shared Media Albums
- Inspiration Notes:
  - Line "albums" workflow
  - Discord-style media browsing discoverability
- Wabi Target Version: `0.4.x+`
- Status: `In Progress (Phase 2)`
- Track: `Core`

## Product Goal
Create one consistent media experience across desktop/web/mobile where users can browse, upload, and manage persistent shared albums in-channel.

## Problem Statement
Current attachment flow is message-first and transient to browse at scale.
Users need a persistent, collaborative "album" surface to find media quickly and keep important visuals organized.

## Core Behavior
1. Channel/DM can have one or more named albums.
2. Multiple users (with permission) can upload media into an album.
3. Album contents persist and are viewable independent of message scroll position.
4. Unified browsing UI across desktop/mobile:
   - grid/list toggle
   - sort by newest/oldest/name
   - fast preview
5. Media item supports:
   - preview
   - open original
   - download
   - copy link

## Permissions and Policy
- Album creation: channel policy controlled.
- Upload/delete/edit metadata: role + channel permission checks.
- Visibility follows channel membership.
- Optional retention policy override per album (if server policy allows).

## Data Model (Initial)
- `albums`
  - `id`
  - `scope_type` (`channel` | `dm`)
  - `scope_id`
  - `name`
  - `created_by`
  - `created_at`
- `album_items`
  - `id`
  - `album_id`
  - `attachment_id`
  - `uploaded_by`
  - `uploaded_at`
  - `caption` (optional)

## Wabi Integration Points
- Frontend:
  - `frontend/src/lib/components/Chat.svelte` (entrypoint button and context)
  - new album views/components under `frontend/src/lib/components/`
- Backend:
  - add album CRUD endpoints
  - integrate attachment upload pipeline with album item linking
  - enforce permission checks in existing auth/policy layer

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm initial album UX flow for desktop with mobile-compatible structure.
- [x] Define initial permission matrix (owner/item-owner/moderator delete guards).
- [x] Confirm initial storage/index strategy with backend album/item endpoints.

### Phase 1 - MVP
- [x] Create/list albums in a channel/DM.
- [x] Upload media directly to selected album.
- [x] Browse album media grid with preview.
- [x] Role-checked delete for album items.
- [x] Add message context-menu action to add attachments to albums.

### Phase 2 - Harden
- [x] Client-side pagination for album item browsing.
- [x] Search/filter and sort by filename/date in album UI.
- [ ] Abuse controls (rate limits, size caps, moderation actions).

### Phase 3 - Polish
- [ ] Drag-drop reorder/view preferences.
- [ ] Better mobile gestures and album navigation.
- [ ] Optional pinned "featured album" per channel.

## Test Plan
- Unit:
  - permissions and policy checks
  - album item lifecycle and retention behavior
- Integration:
  - upload -> album link -> browse flow
  - membership changes and access revocation
- Manual:
  - desktop/mobile parity
  - large album performance
  - moderation edge cases

## Rollback Plan
- Gate by feature flag.
- If disabled, album endpoints/UI hidden; standard attachment flow unchanged.

## Open Questions
1. Should albums be per-channel only, or support shared cross-channel collections?
2. Do we allow non-image media (video/audio/docs) in MVP or image-only first?
3. Should album uploads also post a chat event message by default?

## Current Implementation Snapshot (2026-02-25)
- Frontend:
  - `frontend/src/lib/components/MediaAlbumsTab.svelte`
  - `frontend/src/lib/components/MessageContextMenu.svelte`
  - `frontend/src/lib/components/MessageList.svelte`
- Backend/API:
  - album + item endpoints via `frontend/src/lib/api.ts` integration
- Active behavior:
  - persistent albums scoped to channel/DM
  - upload + list + delete paths with ownership/mod guardrails
  - search/sort/view-mode toggle + pagination in album browser
  - add-to-album action from message context menu (single or multi-file messages)
- Remaining hardening focus:
  - abuse controls and rate limits
  - deeper mobile UX pass
