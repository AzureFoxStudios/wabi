# Joker / Balatro state presets (EffectsTab)

## Pattern

The Joker effect supports gameplay-state presets beyond a generic speed slider.
In `frontend/src/lib/effects/EffectsTab.svelte`, when `selectedEffect === 'joker'`, expose a segmented control for:

- Title
- Blind
- Shop

## Preset values (2026-08-23 recalibration)

Speeds are **relative to authentic in-game pace** — `GAME_PACE = 0.2` is baked
into `balatro.ts` (all shader time advances at 0.2x), so `speed: 1` now reads
like the actual game. Old absolute values (0.55/0.9/0.45) ran ~5x hot and were
refrozen as relative multipliers.

| state   | speed | intensity | size |
|---------|-------|-----------|------|
| title   | 1.15  | 0.70      | 1.0  |
| blind   | 1.60  | 1.00      | 1.1  |
| shop    | 0.80  | 0.45      | 0.9  |

## Persistence (added 2026-08-23)

State round-trips through theme prefs under the `theme_ambient` key:
EffectsTab `save()` → `themeStore.setThemeAmbient()` → POST `/api/user/theme`
(backend whitelist in `core/crates/wabi-server/src/api/user.rs::save_theme`
includes `"theme_ambient"`). On load, `loadFromCurrentTheme()` re-applies the
saved override, including `state.joker`. Previously the tab saved an `ambient`
key that the backend silently dropped — nothing persisted.

## Implementation shape

```svelte
{#if isJoker}
  <div class="setting-item">
    <div class="setting-info">
      <span class="setting-label">Balatro state</span>
      <span class="setting-description">Title screen, blind select, or shop</span>
    </div>
    <div class="segmented-control">
      <button type="button" class="segment" class:active={balatroState === 'title'} on:click={() => applyBalatroState('title')}>Title</button>
      <button type="button" class="segment" class:active={balatroState === 'blind'} on:click={() => applyBalatroState('blind')}>Blind</button>
      <button type="button" class="segment" class:active={balatroState === 'shop'} on:click={() => applyBalatroState('shop')}>Shop</button>
    </div>
  </div>
{/if}
```

Live-only unless the save path stores state alongside `ambient`. `applyBalatroState` mutates `effectSpeed`, `effectIntensity`, `effectSize`, then calls `applyEffect()`.

## Shader reference

Community-verified Balatro background shader reference: https://github.com/Azkun/balatroShader
Our `frontend/src/lib/effects/built-in/balatro.ts` already matches the public fragment-shader shape.
