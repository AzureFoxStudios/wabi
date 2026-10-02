# Local Visual Effects

Wabi is a tool, not a hosted content service. Visual effects are therefore local-first and user-owned.

## Design goal

A user should be able to import a picture or a tiny shader from their own computer and use it immediately, without creating an account, publishing it, installing a server addon, or granting access to Wabi data.

The pointer feeler is the first surface using this system. It is intentionally not a special-case package format; it is the first client of a broader visual-effects host.

## Pointer settings and built-in worlds

Appearance has a separate **Pointer Effects** section. It owns device-local
settings under the existing `wabi.mouse-feeler.v1` key. Selecting or reshuffling a
pointer effect never changes a theme's ambient background, and changing a theme
never replaces the selected pointer effect. This implementation does not add a
theme-owned pointer preset mode.

The catalog keeps three families side by side:

- **Basics:** triangles, dots, grid, sparkles, and glow without texture.
- **Little Worlds:** all 28 scattered-object worlds, including Suits, Creature
  Garden, Tabletop, Artist Desk, Notebook, Tiny Worlds and their creature/game/
  fantasy/desk companions. Scatter Climb Icons and Arcane remain distinct from
  connected Climb Route and Arcane Circle.
- **Connected Worlds:** Lattice, branching Climb Route, Arcane Circle, Rune Wall,
  Maze, Water Ripples and Sand. Water and sand are analytic visual effects,
  not physical fluid/grain simulations.

Scatter uses original outline motifs with deterministic cell seeds. Spacing,
rotation, scale, density pockets, companions and occasional larger hero motifs
vary. World coordinates stay fixed as the reveal moves or the viewport changes;
only changing the seed reshuffles the composition.

Glow strength, effect strength, radius, pattern scale, idle delay, fade, trail
length and trail strength stay independently adjustable. Density, material
detail, settle speed, response and maze curvature appear for applicable effects.
**Draw a sample sweep** runs the selected production effect across a settings
sample area without changing preferences or generating fake input events.
Physical movement starts a fresh stroke; Escape, stop, blur, hidden tabs,
disabling the effect and reduced-motion/coarse-pointer restrictions cancel it.

## Two lightweight imported effect kinds

### Image effects

Users can import PNG, WebP, JPEG, GIF, or SVG directly. No manifest is required.

- Stored locally in IndexedDB.
- Rendered as a visual texture only.
- SVG is parsed before storage and rejects scripts, event handlers, external resource references, and embedded executable content.
- Current pointer surface tiles the image beneath the reveal mask.
- Images must decode before storage and fit the dimension/pixel budget. New
  imports preserve rectangular aspect ratios; old square `tileSize` records
  remain supported. SVGs are static artwork: executable/animated content,
  external references, namespace tricks and escaped CSS resources are rejected.

### Shader effects

Users can import `.frag` or `.glsl` files directly.

Shaders do not run as JavaScript and receive no Wabi object/API access. They compile into the small WebGL surface owned by the visual host.

A shader defines:

```glsl
void mainImage(out vec4 color, in vec2 fragCoord) {
    // draw pixels
}
```

Wabi provides these uniforms:

```glsl
uniform vec2 u_resolution; // effect surface pixels
uniform vec2 u_viewport;   // Wabi viewport CSS pixels
uniform vec2 u_pointer;    // pointer position; origin bottom-left
uniform vec2 u_velocity;   // pointer velocity in CSS pixels/second
uniform float u_time;      // seconds since shader load
uniform float u_active;    // 1 while active, 0 while paused
uniform vec3 u_accent;     // current Wabi accent, normalized 0..1
uniform int u_trail_count; // 0..12 recent samples
uniform vec4 u_trail[12];  // x, y (bottom-left CSS pixels), age seconds, speed
```

The settings UI can download a starter shader containing this contract.
Imported shaders define their own pattern size and interpretation of history;
the scale and trail-strength sliders are disabled for them. Global radius,
glow/effect strength, idle/fade and supplied history duration still apply.
The fourth trail component is negative for a stroke break (`-(1 + speed)`).
Shaders return straight-alpha colors; the wrapper premultiplies RGB for WebGL
composition. The imported shader retains its last frame while the pointer layer
fades, then stops. Compile/context failures are reported in Pointer Effects.

## Storage

Imported effects use a dedicated local IndexedDB database (`wabi-local-visual-effects`). This is deliberately separate from server addons and message data.

The current record shape includes a `surface` field. Today the supported surface is `pointer`.

## Future surfaces

The same local effect records and sandbox should be able to target additional Wabi-owned rendering surfaces without changing how users import files:

- `background`
- `foreground`
- `panel`
- `avatar`
- `message`
- `voice`
- `notification`

A surface decides its allowed inputs and how it composites the effect.

## Future semantic signals

Visual effects should receive narrow signals instead of raw Wabi data whenever possible. Examples:

- message received
- mention received
- reaction added
- user speaking
- call joined

A cosmetic effect should not need message text, auth state, sockets, channel history, or filesystem/network access merely to react visually.

## Separation from canonical server addons

Do not route ordinary visual effects through `core/addons/*`.

Canonical Wabi addons are server/Rust capabilities with explicit permissions such as network and filesystem access. Local visual effects are intentionally lower privilege:

1. image: pixels/assets only
2. shader: GPU program + explicitly supplied uniforms
3. full addon: only when the feature actually needs application/server capabilities

This keeps a frog texture a frog texture instead of turning it into a privileged plugin.

## Performance rule

Pointer effects must remain feeler-sized compositor surfaces. Do not return to a full-screen masked/blended layer that repaints on every pointer event.

Shader canvases should remain small, cap device-pixel ratio, avoid style/layout reads inside the animation loop, and stop rendering when the surface becomes idle.

Built-in history is capped at 12 samples. The newest position remains exact,
including subpixel movement; older samples cover time even on high-polling mice.
Input and drawing use `performance.now()`; a fresh event is not dropped just
because its timestamp is later than a browser RAF timestamp. Long jumps and
idle gaps break strokes. Dynamic surfaces cap each backing dimension at 1024
pixels and DPR at 1.25; very distant old trail samples may be cropped to keep
that budget. Seeded connected geometry is cached independently of pointer motion.

## Verification

From `frontend/`:

```sh
npm ci --no-audit --no-fund
bun test src/lib/effects
bun run check
STATIC_BUILD=1 npm run build
node scripts/local-visual-effects-browser-smoke.mjs
node scripts/pointer-effects-browser-smoke.mjs
```

The browser suites use a headful Chromium process with isolated local test data,
compiled production Svelte components, real mouse events, Canvas/WebGL pixels,
and IndexedDB. They do not connect to a deployed Wabi server. The executable can
be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Native Tauri and physical
device acceptance remain separate from these checks.
