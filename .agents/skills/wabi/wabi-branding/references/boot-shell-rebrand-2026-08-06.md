# Boot shell redesign + hide-Wabi (2026-08-06)

## Naming

| Name | File / surface | When |
|------|----------------|------|
| **Boot shell** | `#wabi-boot-shell` in `frontend/src/app.html` | First paint → app ready ("Starting …") |
| **Login** | `Login.svelte` + `login.css` | After boot, not signed in |
| **Launch panel** | `login/LaunchPanel.svelte` | Login + server launch-page config |

Do not call the splash "Launch."

## Visual (shipped)

- Accent-tinted halo + ring spin; logo fade-in then soft breathe (less bounce)
- `--boot-accent` CSS var on shell
- `data-boot-brand=wabi|neutral|custom`
- Neutral: hide inverted Wabi logo, show generic mark; title `data-empty=true`
- `prefers-reduced-motion` kills loops

## Early brand (before paint)

1. Head script reads `localStorage['wabi.savedServers.v1']`, last-connected entry.
2. Sets `window.__WABI_BOOT_BRAND__ = { neutral, brandName, logoUrl, accent }`.
3. Body script `applyBootBrand()` applies to logo/title/shell attrs.
4. Exposed: `window.__applyWabiBootBrand`, event `wabi:boot-brand`.

## Hide Wabi / custom brand

- **Saved server flag:** `useNeutralBranding: true` on entry (persisted in `wabi.savedServers.v1`).
- **UI:** Server Switcher → click server name (edit) → checkbox **"Hide Wabi branding (boot + login)"** → `setUseNeutralBranding(url, bool)`.
- **Also preserves flag** on `recordSuccessfulServerConnection` (was previously dropped).
- **App path:** `injectNeutralBranding()` → `applyBootShellBrand(...)`; layout `applyBranding(selectBrandConfig(neutral), { neutral })`.
- Custom: launch/frontend metadata brandName + logoUrl + accent without neutral.

## Files

- `frontend/src/app.html` — shell markup/CSS + early brand scripts
- `frontend/src/lib/branding.ts` — `applyBootShellBrand`, `applyBranding(config, {neutral})`
- `frontend/src/lib/components/loginHelpers.ts` — inject updates boot
- `frontend/src/lib/savedServerActions.ts` — `setUseNeutralBranding`
- `ServerSwitcherPanel.svelte` + switcher CSS — toggle UI

## Pitfalls

- Boot still sticky if JS crashes before hide — never throw in brand apply.
- Neutral logos must not get `filter: invert(1)` (custom/neutral brands).
- Head script cannot touch body DOM — only set `__WABI_BOOT_BRAND__`; body applies.
- Login strip-Wabi CSS (`data-neutral-branding`) is separate from boot mark; inject both.