# Profile-first branding reference

## Why folder/`brandId` is outdated

`wabi-branding` still mentioned a `frontend/static/brand/<id>/manifest.json` approach. During the Sabi work, that was superseded by a stronger pattern:

- brand config lives in TypeScript modules under `frontend/branding/<id>.ts`
- default remains `frontend/branding/default.ts`
- resolver in `frontend/src/lib/branding.ts` exposes reactive brand state
- backend stores selector in `admin_policies.json -> frontend_app_metadata.brandProfile`

Advantages:
- self-hosters add one `.ts` plus optional assets; no build magic needed beyond existing build.
- config can include copy, palette, customCss, and bootSequence in one place.

## Backend data path

- Rust: `core/crates/wabi-server/src/api/public.rs::load_frontend_app_metadata()`
- File: `<data_dir>/admin_policies.json`
- JSON shape today:
  - fields: `displayName`, `iconUrl`, `bannerUrl`, `accentColor`, `description`, `tagline`, `launchPageFallbackEnabled`
  - nested under `frontend_app_metadata`
- `get_launch_page()` maps those to `LaunchPageResponse` camelCase fields.

Additive change pattern:
- add `brandProfile` string and full palette object fields
- populate from the same metadata block
- keep legacy fields present so older frontends still work

## Frontend resolver shape (target)

`frontend/src/lib/branding.ts`:
- reactive `activeBrand` store/readable
- reactive `bootConfig` derived from active brand
- `injectCustomCss()` to apply `customCss` into document head safely

`frontend/branding/default.ts`:
- id: `default`
- mirrors current hard-coded Wabi defaults so missing profile behaves exactly like current behavior

`frontend/branding/sabi.ts`:
- id: `sabi`
- brandName: `Sabi`
- palette: dark amber/teal with cream text
- copy: no `wabi` tokens
- customCss: `sabi-*` namespaced rules only
- bootSequence: short branded reveal with accent pulse/progress

`frontend/branding/types.ts`:
- shared `BrandProfile`, `BrandPalette`, `BootSequence` interfaces

## Boot shell event contract

- event name: `wabi:boot-hide`
- exit condition: animate out boot overlay, reveal login
- must never await CSS/image network fetches
- Sabi boot component must read palette from `bootConfig`, not from global body classes.

## Self-host docs expectation

`BRANDING_SELFHOST.md` should tell operators:
1. create `frontend/branding/<name>.ts`
2. export a valid `BrandProfile`
3. set `admin_policies.json` `frontend_app_metadata.brandProfile = "<name>"`
4. optional static assets under `frontend/static/brand/<name>/`
5. preview behavior before restart by preloading profile in dev toolbar / query param if implemented
