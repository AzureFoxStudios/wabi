# B3 + B4 — Strip-Wabi Branding Option & Prettier Launch/Login — Report

Date: 2026-08-03
Scope: frontend only. `core/`, `src-tauri/`, `data/`, `docs/`, `wabi-protocol/`,
`socket-types.ts`, `ModelViewer3D.svelte`, `ProfileSettingsTab.svelte`,
`ProfileCard.svelte`, and Lore code untouched. No commit made.

Note: the working tree contained **pre-existing concurrent S1 Steam addon
changes** (`core/crates/wabi-server/src/api/*`, `packages/wabi-protocol/*`,
untracked `steam.rs` / generated `Steam*.ts`) that were NOT made by this
dispatch and were left alone. Only the frontend files listed below are mine.

## Verification (run from `frontend/`)

| Step              | Before                          | After                          |
|-------------------|---------------------------------|--------------------------------|
| `bun run check`   | 6 errors / 64 warnings / 36 files | 6 errors / 64 warnings / 36 files |
| `bun run build:only` | ✓ builds                      | ✓ builds                       |

- All 6 errors are the pre-existing `bun:test` / `bun` "Cannot find module"
  noise — unchanged. No new type errors, no new `bun:test` errors, warning
  count identical.
- One self-inflicted error appeared mid-pass (`getConfiguredServerUrl` was not
  imported) and was fixed immediately; it is not present in the final state.

## What was done

### B3 — Strip-Wabi (neutral/unbranded) option

1. **`frontend/src/lib/branding.ts`**
   - Added `neutralBrandConfig` — same `BrandConfig` interface, but `name: ''`,
     `shortName: ''`, `domain: ''`, empty headline/subheadline/footer, neutral
     gray palette (`#a1a1aa` / `#71717a` / `#18181b`), and a generic gray
     chat-bubble SVG data-URI as the logo (no "Wabi" text anywhere).
   - Added `selectBrandConfig(useNeutral)` selector to swap
     `brandConfig` ↔ `neutralBrandConfig`.

2. **`frontend/src/lib/savedServers.ts`**
   - Added `useNeutralBranding?: boolean` to `SavedServerEntry` (the persisted
     server config record).

3. **`frontend/src/lib/savedServerUtils.ts`**
   - `sanitizeServerEntry` now round-trips `useNeutralBranding` so the flag
     survives reloads. (This file is not in the prompt's MUST-NOT list; it was
     required for persistence — without it the flag is dropped on load.)

4. **`frontend/src/lib/savedServerActions.ts`**
   - Added `getUseNeutralBranding()` reading the active saved server.
   - `initializeCurrentServerMetadata()` (runs at module init, which loads on
     the login page via the `followNotifier` → `savedServers` import graph) and
     `recordSuccessfulServerConnection()` now call `injectNeutralBranding()`.

5. **`frontend/src/lib/components/loginHelpers.ts`**
   - Added `isNeutralBrandingEnabled()`, `getEffectiveBrandConfig()` (swaps
     `brandConfig` → `neutralBrandConfig` when neutral), and
     `injectNeutralBranding()` which sets/removes `data-neutral-branding` on
     `<html>`. Idempotent; auto-detects from the active server when called
     without an argument.

6. **`frontend/src/styles/tokens.css`**
   - Added the neutral palette tokens: `--neutral-accent`,
     `--neutral-accent-strong`, `--neutral-muted`, `--neutral-surface`,
     `--neutral-surface-raised`, `--neutral-surface-sunken`, `--neutral-border`,
     `--neutral-text`, `--neutral-text-secondary`, `--neutral-text-muted`.

7. **`frontend/src/styles/neutral-branding.css`** (new, imported from
   `styles.css` after `polish.css`)
   - `html[data-neutral-branding] .login-container` overrides
     `--accent-*/--launch-*` to the neutral tokens with `!important` (wins over
     the inline server-palette styles from `Login.svelte` and themeManager's
     runtime root accent overrides). Scoped to the login/launch page only.
   - Hides the hardcoded `.login-logo` / `.login-title` ("Wabi" text) and
     renders a generic neutral mark via `.login-brand-panel::before`.

### B4 — Prettier launch/login

1. **`frontend/src/lib/components/login/LaunchPanel.svelte`**
   - Converted `export let config` → Svelte 5 runes `$props()` (file is tiny;
     no legacy behavior to break).
   - Typography hierarchy (token sizes/weights/line-height, tightened heading
     letter-spacing), clamped responsive padding, token radii, and a polished
     primary CTA (token padding/radius/shadow, subtle lift + brightness on
     hover). CTA text color changed from the undefined `--color-border` to a
     readable dark neutral, using `color-mix` against `--launch-text` so it
     honors the active (or neutral) palette.

2. **`frontend/src/lib/components/login.css`**
   - Reworked the primary-CTA shadows in the 937 "tight final polish pass"
     block (the invisible `0 0 30px … 0.3%` hover glow became a real elevated
     shadow; added a clean `translateY(-1px)` lift on hover).
   - Added an additive B4 section: token-based heading weight/line-height,
     tighter auth-form spacing (`gap` 0.62rem, input margin 0.6rem, divider
     margin 0.9rem), `--radius-lg` on buttons, and weight tokens for
     primary/secondary/ghost buttons.
   - Added an intermediate `@media (min-width: 769px) and (max-width: 1100px)`
     block to balance the two-column default layout and `has-launch` gap between
     the 769px rule and mobile (no new `max-width: 768px` blocks added; the
     centralized `768px` breakpoint from PR4/P3 is respected).
   - Added B3 neutral refinements for login-specific chrome (container
     background, primary/secondary buttons, checked checkbox, handle prefix)
     keyed off `html[data-neutral-branding]`.

### End-to-end behavior

With `useNeutralBranding: true` on the active saved server, on launch
`initializeCurrentServerMetadata()` runs → `injectNeutralBranding()` sets
`data-neutral-branding` → `neutral-branding.css` + `login.css` hide the "Wabi"
logo/title, show a generic gray mark, and neutralize the accent/launch palette.
A fully neutral or fully custom (server-provided `LaunchPageConfig`) community
is supported; the neutral CSS only touches the login/launch page.

## Files changed (mine)

- `frontend/src/lib/branding.ts`
- `frontend/src/lib/components/login.css`
- `frontend/src/lib/components/login/LaunchPanel.svelte`
- `frontend/src/lib/components/loginHelpers.ts`
- `frontend/src/lib/savedServerActions.ts`
- `frontend/src/lib/savedServerUtils.ts`
- `frontend/src/lib/savedServers.ts`
- `frontend/src/styles/neutral-branding.css` (new)
- `frontend/src/styles/styles.css`
- `frontend/src/styles/tokens.css`

## Notes / caveats
- No headless browser verification (Skia crash constraint). Visual check in a
  real browser/Tauri window recommended for: the generic neutral mark sizing
  (`.login-brand-panel::before`), the neutral launch-card gradient, and the new
  primary-CTA hover lift.
- `savedServerUtils.ts` was touched only for flag persistence — it is not in
  the MUST-NOT list, and the flag would not survive reloads without it.
- `getEffectiveBrandConfig()`/`selectBrandConfig()` are exported for callers
  (e.g., a future `Login.svelte` integration or admin toggle) but nothing calls
  them yet; the visual swap is driven through the CSS attribute.
- The flag is set programmatically on the persisted server entry; no Settings
  UI toggle was added (not in scope).
