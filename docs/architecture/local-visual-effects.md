# Local Visual Effects

Wabi is a tool, not a hosted content service. Visual effects are therefore local-first and user-owned.

## Design goal

A user should be able to import a picture or a tiny shader from their own computer and use it immediately, without creating an account, publishing it, installing a server addon, or granting access to Wabi data.

The pointer feeler is the first surface using this system. It is intentionally not a special-case package format; it is the first client of a broader visual-effects host.

## Two lightweight effect kinds

### Image effects

Users can import PNG, WebP, JPEG, GIF, or SVG directly. No manifest is required.

- Stored locally in IndexedDB.
- Rendered as a visual texture only.
- SVG is parsed before storage and rejects scripts, event handlers, external resource references, and embedded executable content.
- Current pointer surface tiles the image beneath the reveal mask.

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
```

The settings UI can download a starter shader containing this contract.

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
