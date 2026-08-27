# About tab brandable copy (2026-08-06)

Settings About must not hardcode Wabi marketing paragraphs. Hosts rebrand via brand config.

## Resolve

```ts
const brand = selectBrandConfig(isNeutralBrandingEnabled());
title = brand.name || brand.shortName || brandName || 'Community';
blurb = brand.description || brand.tagline || brand.subheadline || 'Self-hosted community chat.';
footer = brand.footerText || '';
logo = brand.logoSmallUrl || brand.logoUrl;
```

## UI

- `.about-card` with optional logo + title + blurb + footer + version
- Neutral branding: empty name OK; generic mark already on `neutralBrandConfig`

## Files

- `frontend/src/lib/components/settings/AboutSettingsTab.svelte`
- `frontend/src/styles/components/settings-about.css`

See also polish skill: `settings-space-first-mock-profile-2026-08-06.md`.
