# Plugin Spec - SpotifyControls

## Metadata
- Plugin Name: `SpotifyControls`
- Source Link(s):
  - `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md` (Round 1 grading entry)
- Wabi Target Version: `0.4.x+`
- Status: `Done`

## Plugin Grade
- User Impact (1-5): `3`
- Usage Frequency (1-5): `3`
- Differentiation (1-5): `2`
- Implementation Effort (1-5, higher is harder): `3`
- Runtime Risk (1-5, higher is riskier): `2`
- Weighted Score (0-100): `62`
- Letter Grade (`A/B/C/D/F`): `C`
- Decision: `Build Later (implemented)`

## Problem Statement
Users share Spotify links in chat, but playback controls are not immediately available inline.

## Current Wabi Baseline
Wabi rendered generic link previews for most URLs but did not provide Spotify-specific playback controls.

## Functional Requirements
1. Add an Add-ons toggle for SpotifyControls behavior.
2. Detect supported Spotify links in message text.
3. Render inline playable controls for supported Spotify links.
4. Keep fallback behavior for unsupported/invalid URLs.

## Non-Functional Requirements
- Performance:
  - Reuse existing URL extraction path; no background polling.
- Security/privacy:
  - Use Spotify embed URL surface only; do not require user OAuth in Wabi.
  - Keep standard external-link safety attributes.
- Accessibility:
  - Embed remains keyboard accessible via native iframe controls.
- Platform scope (Web/Desktop/Android):
  - Frontend-only behavior on all runtimes with embed availability.

## Wabi Integration Points
- Frontend files/components:
  - `frontend/src/lib/components/MessageList.svelte`
  - `frontend/src/lib/components/Settings.svelte`
  - `frontend/src/lib/displayEnhancements.ts`
  - `frontend/src/lib/spotifyControls.ts`
  - `frontend/src/lib/components/plugins/SpotifyControlsEmbed.svelte`
- Backend endpoints/services:
  - None required.
- Settings exposure:
  - Add-ons:
    - `SpotifyControls` ON/OFF.

## Phase Plan
### Phase 0 - Discovery
- [x] Confirm URL extraction/render order in `MessageList`.
- [x] Define supported Spotify URL shapes.

### Phase 1 - MVP
- [x] Add toggle and Spotify URL parser.
- [x] Render inline Spotify embed component in message timeline.

### Phase 2 - Harden
- [x] Validate hostname/path and reject unsupported URL shapes.
- [x] Keep clean fallback to generic link preview for non-matching URLs.

### Phase 3 - Polish
- [x] Add compact card styling and open-in-Spotify link affordance.

## Test Plan
- Manual:
  - Send Spotify links (track/album/playlist/artist/show/episode).
  - Verify embed controls render when add-on is ON.
  - Disable add-on and verify Spotify links revert to generic link preview.
  - Verify invalid Spotify-like URLs do not break message rendering.
- Build/validation:
  - `bun run check`
  - `bun run build:only`

## Rollback Plan
- Remove `spotifyControlsEnabled` from `displayEnhancements.ts`.
- Remove Spotify detection/embed path from `MessageList.svelte`.
- Remove add-on toggle from settings.

## Open Questions
1. Should future iterations support provider cards beyond Spotify under a unified media-link framework?
