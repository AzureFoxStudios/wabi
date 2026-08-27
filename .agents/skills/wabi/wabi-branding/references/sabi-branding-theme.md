# Sabi Theme Reference

Session-specific reference captured while implementing the plug-and-play alternate brand for the self-hosted task. Future branding implementations should treat this as the canonical “Sabi” example.

## Theme Concept

- **Brand name:** Sabi
- **Metaphor:** weathered elegance
- **Palette:** deep indigo → midnight gradient, translucent charcoal cards, muted vermillion/gold accents, cream text
- **Logo:** stylized parasol mark
- **Boot:** animated parasol reveal, no blocking

## New/Edited Files

- `frontend/src/lib/components/login/SabiBootScreen.svelte`
- `frontend/src/lib/components/sabi/SabiTheme.css`
- `frontend/src/lib/components/login/SabiThemePatch.svelte`
- `frontend/static/brand/sabi/manifest.json`
- `frontend/static/brand/sabi/logo.webp`, `background.webp`, `hero.webp`

## Backend

- Reuses `/api/public/launch-page`. No new endpoints.
- Config is driven via `admin_policies.json` frontend-app-metadata:
  - `displayName`, `iconUrl`, `bannerUrl`, `accentColor`, `description`, `launchPageFallbackEnabled`.

## Implementation Notes

- Boot overlay animates out on `wabi:boot-hide` into `LaunchPanel` + login.
- `launchCustomCss` is turned off; prefer namespaced `sabi-*` classes.
- `brandId` can be a query param, cookie, or admin setting.
- Default theme untouched.

## Pitfalls Encountered

- Do not namespace into global `.launch-brand` rules when multiple themes share login. Use `data-brand="sabi"` on the shell.
- Boot shell must never await CSS fetch; keep it pure CSS + animation.
- `brandId='sabi'` must not break `brandId=default` fallbacks.
