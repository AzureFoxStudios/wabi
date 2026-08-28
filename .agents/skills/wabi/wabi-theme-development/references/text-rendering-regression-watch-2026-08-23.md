# Text-rendering regression watch (2026-08-23) — UNRESOLVED

Status: **open**. User reported "text sort of renders in very odd ways"
after the theme/background-upload batch landed and suspects that feature
area. Not reproduced, not root-caused. This file is a TRIAGE CHECKLIST,
not a known-cause note — do not cite its candidates as facts.

## Batch under suspicion (commits 16cd7ec9 … bed1d0ea)

1. **`<VideoBackground />` (new)** — absolutely-positioned layer, first
   child of `.chat-container`, z-index 0 (`VideoBackground.svelte`,
   mounted in `Chat.svelte`). Stacking/blend mistakes here paint over or
   under text. First check: render with NO video background set — the
   component should be fully absent (`$: url = bg?.url ?? ''` gate).
2. **Effect canvas rewrites** — synapse/shimmer/matrix/constellations
   render loops changed; shimmer is brand-new. Canvas overlays blended
   over glyphs can read as blur/glow/flicker on text.
3. **Theme-token plumbing** — `themeAmbient` round-trip added to
   themeStore (`16cd7ec9`). Uniform-font vars (`--uniform-font-*`, applied
   via accessibility.css) restyle ALL text when enabled — a bad saved pref
   could ship wrong font/weight/size globally.
4. **Customizer palette-seed change (this session, 7e9dd19b)** — seed
   values only, applied on save; least likely but in the batch.

## Isolation questions (ask before touching code)

- Built-in theme or custom when it happens?
- Effects OFF → fixed?
- Login screen affected too, or chat-only?
- Was a background image/video actually uploaded before it broke?
- Any console errors?

## Verify constraint

Real browser only — headless Chromium cannot paint Wabi (durable gotcha).
