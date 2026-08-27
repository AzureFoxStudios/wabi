# Ambient loop + theme save fallback

## AmbientBackground.svelte must refresh config every frame

**Symptom:** Changing effect sliders in `EffectsTab.svelte` updates the CSS vars, but intensity/size/speed have no visible effect on the animated background.

**Root cause:** `AmbientBackground.svelte` captured `currentConfig` once at `switchEffect()` and passed that stale object into `effect.render(dt, currentConfig)` every frame. Slider writes only mutated CSS custom properties, not the cached JS object.

**Fix:** In the render loop, read the live CSS vars before each render call:

```ts
if (effect) {
  currentConfig = readConfig().config;
  effect.render(dt, currentConfig);
}
```

This makes slider changes apply immediately without restarting the effect.

## Theme save must fall back to localStorage when /api/user/theme is 404

**Symptom:** Registered users change theme/effect settings, click Save, see no error, but the preference is lost on reload. Console shows `[ThemeApi] Theme endpoint unavailable (404) — preferences not persisted`.

**Root cause:** Backend `core/crates/wabi-server/src/api/user.rs` stubs theme persistence (`theme: null` in `get_settings`, request fields dropped in `update_settings`). No `/api/user/theme` route exists yet. The frontend's `saveThemePreferences()` previously no-op'd on 404, so the change was silently dropped.

**Fix:** On 404, `saveThemePreferences()` writes to `localStorage['wabi-theme']`, merging with any existing payload and preserving `updated_at`. It also calls `markEndpointUnsupported()` so the network isn't spammed on every keystroke. The preference survives refresh until backend real persistence ships.

## Balatro/Joker effect speed defaults

The Joker shader default speed of `1.0` is extremely fast for a background ambient. Use `0.55` as the palette default. In `EffectsTab.svelte`, expose a Balatro state segmented control when `selectedEffect === 'joker'` with presets that override speed/intensity/size live.
