# Boot shell logo flicker lock (2026-08-06)

## Symptom
Splash flickers server icon ↔ Wabi logo (or neutral ↔ Wabi).

## Root cause chain
1. HTML painted default Wabi `src` immediately.
2. Early body script applied saved-server brand.
3. Layout `applyBranding(default Wabi)` overwrote custom/neutral again.

## Fix (shipped)
1. **No default logo src** in `app.html`; logo `opacity:0; visibility:hidden` until `#wabi-boot-shell[data-boot-ready='1']`.
2. Early brand from `localStorage wabi.savedServers.v1` → `__WABI_BOOT_BRAND__` → `__applyWabiBootBrand`.
3. **Lock** after first real apply (`data-boot-locked=1`). Late default-Wabi snapshots are ignored unless `{ force: true }`.
4. `applyBootShellBrand` / `applyBranding` merge: never drop custom logo because bare Wabi config arrived late.
5. Layout onMount: `injectNeutralBranding(isNeutralBrandingEnabled())` only — do not call bare `applyBranding(brandConfig)`.

## Hide Wabi
- Saved-server `useNeutralBranding` + Server Switcher edit checkbox.
- Preserve flag on `recordSuccessfulServerConnection`.
- Neutral: generic mark, empty title (`data-empty`), gray `--boot-accent`.

## Naming
Boot shell ≠ Launch panel. Boot = `#wabi-boot-shell` in `app.html`.
