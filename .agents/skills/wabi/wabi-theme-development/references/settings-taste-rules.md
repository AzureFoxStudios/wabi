# Settings taste rules (Appearance)

Durable UX rules for theme-related Settings. Not a ship log.

## Files

- `frontend/src/lib/components/settings/AppearanceSettingsTab.svelte`
- `frontend/src/styles/components/settings-appearance.css`
- Customizer / effects: `ThemeCustomizer.svelte`, `effects/EffectsTab.svelte`
- Preview: `ThemePreview.svelte` (derive from real theme colors)

## Hierarchy

1. **Primary:** theme preset grid (all `THEMES` / built-ins with identity).
2. **In-grid:** **Custom** card that opens customizer — not a buried section below.
3. **Secondary:** “Tune theme” (or equivalent) disclosure for effects, per-panel colors, uniform font.

Do not stack Customizer + Effects + Font as equal permanent sections.

## Theme cards

- Per-card `--card-accent` from theme accent.
- Colored **top-edge** glow; stronger when active.
- Active: ring + SVG checkmark (not text `✓` alone).
- Optional ambient glow overlay if theme has effect ≠ none.

## Controls

| Kind | UI |
|------|-----|
| 2–4 fixed options | **Segmented** pill buttons |
| Boolean | Toggle |
| Long / dynamic lists | Select OK |

## Copy

Human language descriptions (“How tightly messages pack together”), not telegraphic labels only (“Spacing density”).

## Preview fidelity

- Surfaces from actual theme (`bgSecondary` / raised / sunken), not generic gray panels.
- Badges/status from theme success/danger tokens — no hard-coded Discord greens/reds that fight the palette.
- Prefer showing ambient influence where possible (frosted surfaces over canvas).

## Login coupling (related, not Settings)

- `Login.svelte` picks a **full** random palette from `ALL_PALETTES`.
- Never reintroduce a detached hard-coded effect name list while palettes set `ambient: none`.
- `onMount` may be `async` for dynamic import.
- Login chrome must stay translucent enough that ambient canvas is visible.

## Do not confuse

**Settings polish ≠ new theme content.** Layout/copy changes do not add palettes. If asked “did themes ship?”, check `ALL_PALETTES` + effect registry + binary bake — not Appearance CSS alone.
