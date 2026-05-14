# Plugin Decisions - SpotifyControls

## 2026-02-28
### Decision: Implement SpotifyControls as link-driven inline embeds
- Reason:
  - BetterDiscord-style account-attached transport controls are not a direct fit for Wabi architecture.
  - Inline embeds preserve core user value (playback controls) without invasive integrations.
- Consequence:
  - Users get practical in-chat playback for shared links with minimal complexity.

### Decision: Scope to validated `open.spotify.com` URL patterns
- Reason:
  - Keeps parser predictable and avoids redirect/network resolution overhead.
- Consequence:
  - Unsupported Spotify URL variants fall back to normal link preview behavior.

### Decision: Keep feature fully frontend and toggle-gated
- Reason:
  - No backend behavior is needed for URL parsing/embed rendering.
- Consequence:
  - Easy rollback path and no server-side privacy impact.
