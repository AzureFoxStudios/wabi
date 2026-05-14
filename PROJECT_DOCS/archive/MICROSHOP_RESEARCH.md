# Microshop Research Notes

Wabi's whiteboard could evolve into a hybrid vector+raster image editor ("microshop")
taking the best from Photoshop, Krita, and Clip Studio Paint.

---

## Part 1: Photoshop Brush Engine

### Dab Stamping Model
- PS brushes are **stamp-based**: a brush tip shape (dab) is stamped at intervals along the cursor path
- **Spacing** = % of brush diameter between stamps. Default 25%. Lower = smoother but slower. 1% = very smooth, very expensive
- Engine interpolates cursor positions and places dabs at spacing intervals along the vector between samples

### Brush Tip Shapes
- **Round (parametric)**: Defined mathematically. Hardness 0-100% controls Gaussian falloff. 100% = hard circle, 0% = soft gaussian edge
- **Sampled (custom)**: Grayscale image up to 2500x2500. Black = full paint, White = transparent, Gray = proportional
- Creating custom: Edit > Define Brush Preset. Color is discarded, converted to grayscale alpha mask

### Flow vs Opacity (CRITICAL DISTINCTION)
- **Opacity** = per-STROKE maximum. Stroke renders to temporary buffer, composited at opacity% when pen lifts. Crossing same pixel twice in one stroke doesn't exceed opacity cap
- **Flow** = per-DAB deposit. Each dab deposits flow% of its full value. Overlapping dabs accumulate within a stroke. Slow = denser, Fast = lighter
- Combined: Opacity 100% + Flow 10% gives natural paint buildup. Opacity 50% + Flow 100% gives flat semi-transparent stroke
- **Wash mode** (PS default): opacity caps stroke buffer. **Build-up mode** (Krita): opacity is per-dab, no cap
- Krita uses **Alpha Darken** blending mode internally for wash mode to prevent re-darkening on cross-over

### Brush Dynamics / Transfer
- Input signals: Pen Pressure, Pen Tilt, Pen Rotation, Stylus Wheel, Fade (step countdown), Speed
- Output parameters (each independently controllable): Size, Opacity, Flow, Angle, Roundness, Scatter
- Each has: Jitter slider (randomness 0-100%), Control dropdown (input source), Minimum value floor

### Texture Brushes
- A pattern modulates dab opacity via blend mode (Multiply, Subtract, etc.)
- **Texture Each Tip OFF**: texture is static relative to canvas, applied to whole stroke
- **Texture Each Tip ON**: texture applied per-dab independently, creates buildup. Essential for pencil/charcoal effects

### Scatter
- Displaces dabs perpendicular to stroke path
- "Both Axes" adds displacement along stroke direction too
- **Count**: multiplies dabs per spacing step (Count 3 = 3 dabs at each position)
- **Count Jitter**: randomizes count per step

### Dual Brush
- Two tips combined: primary = mask/container, secondary = stamped within primary's shape
- Only pixels where both tips overlap produce paint
- Secondary has independent Diameter, Spacing, Scatter, Count

### Smoothing / Stabilizer
- **Pulled String**: Brush trails behind cursor at string-length distance. Magenta dead zone circle. Great for precise line work
- **Stroke Catch Up**: stroke catches cursor when you stop
- **Adjust For Zoom**: scales smoothing radius by zoom level
- CSP has both **Stabilization** (real-time delay filter) and **Post Correction** (smooths path after drawing)

---

## Part 2: Clip Studio Paint — Hybrid Vector + Raster

### Vector Layer Architecture
- Each stroke = independent Bezier path object with: path segments, control points, pressure data, brush parameters
- Strokes are NEVER merged — overlapping strokes remain separate objects
- Vectors are internal-only (not SVG). Only preserved in .clip format. Rasterized on export

### Vector Eraser (killer feature)
- **Erase Touched Areas**: removes portions of path where eraser touches
- **Erase Up to Intersection**: erases from touch point back to nearest intersection with another vector stroke. Incredibly powerful for inking
- **Erase Whole Line**: single touch deletes entire stroke object

### Control Point Editing
- Move individual control points to reshape curves
- Add/delete control points
- Adjust line width at specific points (drag left = thinner, right = thicker)
- Adjust opacity per control point
- Line correction tools: scale width, thicken/narrow, redraw width profile

### Vector + Raster Coexistence
- Both layer types are peers in compositing stack: same blending modes, opacity, grouping, clipping
- You CANNOT paint fills or use soft painting on vector layers (strokes only)
- You CANNOT use filters on vector layers (must rasterize first, one-way)
- Vector layers rasterized on-the-fly for display at current view resolution (never pixelated on zoom)

### Rendering Pipeline
- Vector strokes re-rendered to pixels whenever view changes or stroke data modified
- Each stroke retains brush parameter reference for re-rasterization
- Cached rasterized output with dirty-rect optimization (inferred)
- Once rasterized, vector layer pixel output composites identically to raster layers

---

## Part 3: Krita Architecture (Deep Dive)

### Tile-Based Rendering

**Tile fundamentals:**
- **256x256 pixel tiles** at runtime (serialized as 64x64 chunks in .kra files for compression)
- **Sparse hash table storage**: each paint layer has its own hash table of tiles. Only tiles written to are allocated. Untouched regions reference a shared **default tile** (transparent or white)
- **Color-space agnostic**: tiles store raw bytes, pixel size determined by color space (4 bytes for 8-bit RGBA, 8 for 16-bit, 16 for 32-bit float)
- Main API: `KisTiledDataManager` with iterators and random accessors

**Copy-on-write for undo:**
- Tiles are reference-counted. Undo snapshots share unchanged tile references
- Only 3 hash tables per data manager total (centralized history)
- On modification, only the modified tile is cloned (COW). Undo keeps the old reference
- Undo data capture is **deferred to a separate thread** for performance

**Dirty tile tracking:**
- `setDirty(rect)` propagates up through layer tree — each node updates its projection, notifies parent
- Two update modes: **bottom-up** (setDirty) and **top-down** (refreshGraphAsync)
- Filters can expand dirty regions: a 4x4 convolution on a 2x2 rect produces 8x8 changeRect requiring 14x14 needRect
- OpenGL canvas supports **patch-based texture uploads** — only changed tiles re-uploaded to GPU

**Memory management:**
- `KisTextureTileInfoPool` prevents memory fragmentation
- Pool sized to ~1 layer of the image (e.g., 36 MiB for 3000x3000 8-bit ARGB)
- Tiles compressed with **LZF** for disk storage and swap-to-disk
- **Lock-free hash table** (ported from Jeff Preshing's "junction" library) replaced QReadWriteLock — was spending **40% of time on lock contention** before this change

### Brush Engine (Paintop System)

**Architecture:**
- Plugin system: each brush engine = a "paintop" with 4 components: Factory, Settings Widget, Settings Object, Brush Engine (`KisPaintOp` subclass)
- `KisPainter` orchestrates painting using `KisBrush`, `KisPaintOp`, and color spaces on a `KisPaintDevice`
- `KisBrushBasedPaintOp` handles spacing calculations automatically for brush-based engines

**Dab model:**
- `paintAt()` stamps a single dab at a position
- `paintLine()` interpolates dabs along cursor path at spacing intervals
- `renderMirrorMask()` handles symmetry painting

**Brush engines available:**
- **Pixel Brush**: Standard dab stamping. Wash mode (stroke buffer + Alpha Darken) or Build-up mode (direct compositing)
- **Color Smudge**: Copies area under previous position to new position. Spacing controls sampling density
- **Sketch**: Generates lines that sketch out form organically
- **Bristle**: Simulates individual bristles
- **MyPaint**: Integrates MyPaint library

**Sensor system (dynamics):**

| Sensor | Maps to |
|--------|---------|
| Pressure | 0.0-1.0 stylus pressure |
| X-Tilt / Y-Tilt | [-60, 60] degrees → 0.0-1.0 |
| Tilt Direction | -180 to +180 degrees |
| Speed | 1.0 + 10% of movement step |
| Distance | Proportional to brush size |
| Fade | Random per stroke |
| Fuzzy | Random per dab |

All sensors mapped via **configurable curves** (transfer functions) — far more flexible than PS's single control dropdown

**Brush tip types:**
- **Auto Brush (computed)**: Procedural round/square/star with Fade (softness), Ratio, Spikes. Three mask types: Default (fastest), Soft/Gaussian (slowest), computed
- **Predefined/bitmap**: GBR (GIMP Brush), GIH (animated brush), ABR (Photoshop), PNG

**Spacing:**
- Controls dab density along stroke path
- **Auto spacing** with 0.8 optimal for inking
- Default spacing 0.1 (very dense)
- ~50ms update interval

**Flow vs Opacity in Krita:**
- Flow = per dab transparency
- Opacity = per stroke maximum (wash mode via Alpha Darken blending)
- Since Krita 4.2: flow and opacity **multiply** (not add) for subtle control

**Indirect painting (stroke buffer):**
- Each stroke has its own transaction + optional indirect painting device (temp buffer)
- Dabs paint into temp buffer first
- On stroke end, buffer merged into actual layer, undo committed
- `KisStrokesQueue` manages execution, `processOneJob()` runs per free thread

### Layer System

**Node tree hierarchy:**
- All layers inherit from `KisNode`, forming a tree rooted at `KisImage::rootLayer()`
- **Paint Layers** (`KisPaintLayer`): raster, backed by `KisPaintDevice` (tile system)
- **Group Layers** (`KisGroupLayer`): composite children separately, then composite result with rest of stack

**Compositing:**
- Bottom-to-top, like stacking papers
- Each layer maintains a **projection** (cached flattened result)
- `projectionLeaf()` represents the rendering graph (may differ from UI layer order)

**Group layer pass-through:**
- Default: group composites its children separately, result uses group's blend mode
- **Pass-through mode**: children affect layers OUTSIDE the group directly, as if group didn't exist

**Layer properties:**
- Opacity, Blending Mode, Visibility, Alpha Lock, Alpha Inheritance (= clipping mask)
- Alpha Lock: paint only within existing non-transparent pixels
- Inherit Alpha: visibility clipped to combined alpha of all layers below in same group

### Update Scheduler
- Two queues: `setDirty` (compositing jobs) and stroke jobs
- `processQueue()` checks load, runs jobs from more-loaded queue first
- **Barrier jobs**: won't start until all prior updates finish (ensures consistent state)

---

## Part 4: Masks

### Layer Masks (Transparency Masks)
- Same-size grayscale image tied to a layer
- White(255) = visible, Black(0) = hidden, Gray = proportional transparency
- Math: `final_alpha = layer_alpha * (mask_value / 255)`
- Default: full white (everything visible). User paints black to hide
- Krita calls this **Transparency Mask** — math confirmed: "alpha value multiplied by mask pixel value"
- Krita supports **Split Alpha**: extract layer's alpha into separate Transparency Mask for isolated editing

**UX shortcuts:**
- Alt+Click mask thumbnail = view mask solo as grayscale
- Shift+Click = temporarily disable mask (red X)
- Click mask thumbnail = select mask for editing (brush paints on mask)
- Click layer thumbnail = select layer for editing (brush paints on layer)

**Web implementation:**
```javascript
for (let i = 0; i < pixelCount; i++) {
    const layerAlpha = layerData[i * 4 + 3] / 255;
    const maskValue = maskData[i]; // single channel 0-255
    const finalAlpha = layerAlpha * (maskValue / 255);
}
```

### Clipping Masks
- Layer clipped to alpha of layer below. Only visible where base has pixels
- Math: `clipped_alpha = clipped_layer_alpha * base_layer_alpha`
- Multiple layers can clip to one base (clipping group)
- Krita "Inherit Alpha": clips to **combined composite alpha of ALL layers below** in same group (not just immediate neighbor)
- CSP: "Clip to Layer Below"

**Web implementation** using Canvas API:
```javascript
tempCtx.drawImage(baseLayerCanvas, 0, 0);
tempCtx.globalCompositeOperation = 'source-atop';
tempCtx.drawImage(clippedLayerCanvas, 0, 0); // only shows where base has alpha
```

---

## Part 5: Channels

### RGB Channels
- R, G, B shown as individual grayscale images where white = max, black = min for that channel
- CMYK mode: C, M, Y, K channels (subtractive — higher values = more ink = darker)
- **Alpha channels** = saved selections stored alongside color data

### Channel Operations
- Edit individual channels: painting on Red channel only modifies the R component
- Ctrl+Click channel thumbnail = load as selection
- Channel mixing/calculations for color manipulation

**Web implementation** (viewing Red channel as grayscale):
```javascript
for (let i = 0; i < pixelCount; i++) {
    const redValue = imageData.data[i * 4 + 0];
    displayData.data[i * 4 + 0] = redValue;
    displayData.data[i * 4 + 1] = redValue;
    displayData.data[i * 4 + 2] = redValue;
    displayData.data[i * 4 + 3] = 255;
}
```

---

## Part 6: Selections

### Internal Representation
- Selection IS a grayscale mask (0 = unselected, 255 = fully selected)
- Same data structure as an alpha channel
- Partial values = feathered/anti-aliased edges

### Marching Ants
- Animated border at **50% threshold** of selection mask
- Dashed line (4px dash, 4px gap) in alternating black/white
- Animation: offset shifts 1px per frame
- Only shows pixels at/above threshold — feathered region extends beyond visible ants

### Key Operations
- **Ctrl+Click layer thumbnail** = load layer alpha as selection: `selectionMask[i] = layerData[i * 4 + 3]`
- **Feathering** = Gaussian blur on selection mask
- **Add/Subtract/Intersect** = pixel math on selection masks
- **Quick Mask mode**: edit selection as painted red overlay (unselected = red tint, selected = clear)

**Quick Mask rendering:**
```javascript
for (let i = 0; i < pixelCount; i++) {
    const sel = selectionMask[i];
    if (sel < 255) {
        const overlayStrength = (1 - sel / 255) * 0.5;
        displayData[idx + 0] = lerp(displayData[idx + 0], 255, overlayStrength);
        displayData[idx + 1] = lerp(displayData[idx + 1], 0, overlayStrength);
        displayData[idx + 2] = lerp(displayData[idx + 2], 0, overlayStrength);
    }
}
```

### Painting with Active Selection
Selection modulates brush operations: `effectiveOpacity = brushOpacity * (selectionMask[pixel] / 255)`

---

## Part 7: Blending Modes (Math: a=base, b=blend, all 0-1)

### Final compositing formula
`output = (1 - opacity) * a + opacity * blendMode(a, b)`

With alpha (Porter-Duff source-over):
```
output_alpha = src_alpha + dst_alpha * (1 - src_alpha)
output_color = (src_alpha * blendResult + dst_alpha * (1 - src_alpha) * dst_color) / output_alpha
```

### Normal Group
- **Normal**: `f(a,b) = b`
- **Dissolve**: `f(a,b) = (random() < opacity) ? b : a` (not a math blend — random per-pixel)

### Darken Group
- **Darken**: `min(a, b)`
- **Multiply**: `a * b`
- **Color Burn**: `b == 0 ? 0 : 1 - min(1, (1-a)/b)`
- **Linear Burn**: `max(0, a + b - 1)`
- **Darker Color**: compare luminance, keep entire pixel with lower lum (non-separable)

### Lighten Group
- **Lighten**: `max(a, b)`
- **Screen**: `1 - (1-a)(1-b)` = `a + b - ab`
- **Color Dodge**: `b == 1 ? 1 : min(1, a/(1-b))`
- **Linear Dodge (Add)**: `min(1, a + b)`
- **Lighter Color**: compare luminance, keep pixel with higher lum (non-separable)

### Contrast Group
- **Overlay**: `a <= 0.5 ? 2ab : 1 - 2(1-a)(1-b)` (tests BASE value)
- **Hard Light**: `b <= 0.5 ? 2ab : 1 - 2(1-a)(1-b)` (tests BLEND value — overlay with a/b swapped)
- **Soft Light (W3C)**: `b <= 0.5 ? a - (1-2b)*a*(1-a) : a + (2b-1)*(g(a)-a)` where `g(a) = a <= 0.25 ? ((16a-12)a+4)a : sqrt(a)`
- **Vivid Light**: `b <= 0.5 ? ColorBurn(a, 2b) : ColorDodge(a, 2b-1)`
- **Linear Light**: `clamp(a + 2b - 1, 0, 1)`
- **Pin Light**: `b <= 0.5 ? min(a, 2b) : max(a, 2b-1)`
- **Hard Mix**: `(a + b >= 1) ? 1 : 0`

### Inversion Group
- **Difference**: `|a - b|`
- **Exclusion**: `a + b - 2ab`
- **Subtract**: `max(0, a - b)`
- **Divide**: `b == 0 ? 1 : min(1, a/b)`

### Component Group (HSL — non-separable)

Helper functions (W3C spec):
```javascript
Lum(C) = 0.299*C.r + 0.587*C.g + 0.114*C.b
SetLum(C, l) = ClipColor(C + (l - Lum(C)))
Sat(C) = max(C.r, C.g, C.b) - min(C.r, C.g, C.b)
SetSat(C, s) = scale mid channel: mid = (mid-min)*s/(max-min), max=s, min=0
```

- **Hue**: `SetLum(SetSat(b, Sat(a)), Lum(a))` — hue from blend, sat+lum from base
- **Saturation**: `SetLum(SetSat(a, Sat(b)), Lum(a))` — sat from blend, hue+lum from base
- **Color**: `SetLum(b, Lum(a))` — hue+sat from blend, lum from base
- **Luminosity**: `SetLum(a, Lum(b))` — lum from blend, hue+sat from base

### Canvas 2D Native Blend Modes
These work via `globalCompositeOperation`:
```
multiply, screen, overlay, darken, lighten, color-dodge, color-burn,
hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity
```
**NOT native** (need manual pixel math or WebGL): Linear Burn, Linear Dodge, Vivid Light, Linear Light, Pin Light, Hard Mix, Subtract, Divide

### Premultiplied vs Straight Alpha
- **Straight**: RGB = full color regardless of opacity. `(1.0, 0, 0, 0.5)` = full red at 50%
- **Premultiplied**: RGB pre-multiplied by alpha. Same pixel = `(0.5, 0, 0, 0.5)`
- Premultiplied simplifies Porter-Duff: `Co = Cs + Cd * (1 - As)` (no division)
- Compositing is **associative** in premultiplied space
- WebGL defaults to premultiplied. Canvas 2D uses premultiplied internally
- Downside: precision loss in low-alpha regions at 8-bit depth

---

## Part 8: Photopea (Web-Based PS Clone) — Architecture Reference

### Tech Stack
- **100% client-side**: JavaScript + GLSL, 100K+ lines of custom JS
- Single developer (Ivan Kutskir), started 2012
- No server processing. Offline capable once loaded
- Full PSD native format support

### WebGL Rendering (key insight)
- Layer pixel data stored in **WebGL texture memory** (GPU)
- WebGL handles: all blending modes, masking, layer styles, UI rendering
- **Performance**: 2048x1152, 10 layers + 3 effects: **850ms without WebGL → 55ms with WebGL** (15x speedup)
- Adjustment layers processed on GPU for real-time editing

### Takeaway for Wabi
WebGL compositing is essential for production-quality performance with multiple layers and blend modes

---

## Part 9: Architecture for Wabi Microshop

### Hybrid Layer Stack (CSP model)
- **Vector layers**: strokes stored as Bezier paths with pressure + brush params. Individually selectable/editable. Rasterized on-the-fly for display
- **Raster layers**: tile-based bitmap layers. Direct pixel painting with dab-stamped brushes
- Both types are peers in the compositing stack — same blending modes, opacity, grouping, clipping

### Tile System (Krita model)
- 256x256 pixel tiles in sparse hash map
- Each raster layer = sparse grid of tiles. Only allocate tiles with paint
- Shared default tile for empty regions
- **COW for undo**: reference-count tiles, clone on modification. Undo = set of tile references (memory efficient)
- **Dirty rect tracking**: mark changed tiles, propagate up layer tree, only re-composite dirty tiles
- **GPU tile upload**: only re-upload changed tiles as WebGL textures

### Brush Engine (PS model)
- Dab stamping along interpolated cursor path at spacing intervals
- Configurable tip: hardness (falloff curve), or custom grayscale bitmap (Define Brush)
- **Flow** (per-dab buildup) + **Opacity** (per-stroke cap via stroke buffer / indirect painting device)
- Dynamics: pressure/tilt/speed → size/opacity/flow/angle/scatter via configurable transfer curves
- Smoothing: pulled-string stabilizer with adjust-for-zoom
- Scatter, texture, dual brush for advanced effects

### Mask System (PS model)
- Each layer can have a grayscale mask (same tile grid as layer)
- White=show, Black=hide. Default full white
- Clipping: "clip to layer below" restricts to base alpha
- Ctrl+Click to load alpha as selection

### Channel System
- View/edit individual R/G/B/A channels as grayscale
- Alpha channels for saved selections
- Start with RGB, CMYK later

### Selection System
- Selection = grayscale mask (same resolution as document)
- Marching ants at 50% threshold
- Selection tools produce/modify the mask
- Quick Mask mode for painting selections
- Ctrl+Click layer thumbnail = load alpha as selection
- Feathering = Gaussian blur on selection mask

### Compositing Pipeline
- Store layer tiles as WebGL textures
- Composite bottom-up using fragment shaders implementing blend modes
- Use `OffscreenCanvas` in Web Worker for heavy operations
- Canvas 2D fallback for browsers without WebGL
- `requestAnimationFrame` synced rendering

### Performance Targets
- Responsive at 4000x4000 canvas with 10+ layers
- Brush stroke latency < 16ms (60fps feel)
- Undo/redo < 50ms via COW tile snapshots
- Partial re-composite on brush stroke (only dirty tiles)

---

## Part 10: Complete PS Brush Panel Features (Missing Six)

### Color Dynamics

**Foreground/Background Jitter:**
- Randomly interpolates between fg and bg colors per dab (if "Apply Per Tip" checked) or per stroke
- 0% = fg only. 100% = each dab can be anywhere between fg and bg
- Math: `color = lerp(fg, bg, random(0, jitter/100))`
- Control: Off, Fade, Pen Pressure, Pen Tilt, Stylus Wheel, Rotation

**Hue Jitter:**
- Shifts fg hue randomly per dab. Value = % of 360-degree hue wheel
- 1% = +/- 3.6 degrees. 100% = anywhere on the wheel
- Math: convert to HSB, offset H by `random(-1,1) * jitter * 3.6` degrees

**Saturation Jitter:**
- Varies fg saturation per dab in HSB space
- Math: `S_final = S_fg + random(-1,1) * jitter/100 * S_fg`

**Brightness Jitter:**
- Same as saturation jitter but on B channel

**Purity:**
- NON-random saturation override applied after all jitter. Range -100 to +100
- -100 = fully desaturated (grayscale). 0 = no change. +100 = fully saturated
- Math: `S_final = S + (purity/100) * (purity > 0 ? (100-S) : S)`

**Apply Per Tip:**
- Checked: color randomized per dab. Unchecked: randomized once per stroke

### Brush Pose (CS6+)

- Four override sliders: Tilt X (-100..+100), Tilt Y (-100..+100), Rotation (0..360), Pressure (0..100%)
- Each has an Override checkbox
- When Override enabled: tablet input for that parameter replaced by slider value
- Applied BEFORE the dynamics system — Shape Dynamics/Transfer receive the overridden value
- Use case: testing brush behavior without a tablet, or locking a parameter for consistency

### Noise

- Binary toggle (checkbox, no amount slider)
- Adds **uniform random noise** to the brush tip's alpha mask per dab
- Each dab gets a fresh noise pattern
- Most visible on soft/round brushes (smooth gradient shows noise)
- Hard brushes barely affected (already binary alpha)
- Purpose: prevents banding in soft brush gradients, adds organic texture

### Wet Edges

- Binary toggle (checkbox)
- Simulates watercolor: concentrates opacity at stroke edges, reduces center
- Modifies brush tip alpha profile: center made more transparent, edges retain opacity
- Inverts the normal dome-shaped falloff into a ring/hollow profile
- Approximate math: `alpha *= distance_from_center / max_radius`
- Works best with reduced opacity and soft/spatter brush tips
- Overlapping dabs in stroke center still accumulate, creating natural edge concentration

### Build-up / Airbrush Mode

- Two linked toggles (Options Bar airbrush icon + Brush Settings "Build-up" checkbox)
- **Disabled (default)**: paint deposited only when cursor MOVES
- **Enabled**: paint continues depositing while cursor is STATIONARY and mouse/pen held
- Internal timer fires ~every frame, depositing a dab at current position
- Each tick deposits at the **Flow** rate. **Opacity** is the ceiling
- Accumulation formula per pixel: `result = 1 - (1 - flow/100)^n`, clamped to `opacity/100`
- Low flow (10%) = slow gradual buildup. High flow (100%) = rapid fill to opacity ceiling

### Protect Texture

- Binary toggle in Brush Settings (under Texture section)
- **Enabled**: same texture pattern + scale maintained across ALL brush presets that have texture
- Switching between textured brushes keeps the same canvas grain
- Simulates consistent canvas/paper surface
- **Disabled**: each preset uses its own independent texture settings

---

## Part 11: ABR File Format (Photoshop Brush Import)

### Format Overview

ABR is **not officially documented by Adobe**. All specs below from reverse engineering (GIMP, Photopea, community parsers). All multi-byte integers are **big-endian**.

Two fundamentally different layouts:
- **Old format (v1, v2)**: PS 6.0 and PS 7.0. Sequential brush entries. ONLY stores tip images + basic params
- **New format (v6-v10+)**: PS CS+. 8BIM tagged blocks. Stores EVERYTHING (tips + full brush settings + patterns)

### Old Format (v1/v2)

**Header**: `version (uint16) + brush_count (uint16)`

**Per-brush**: `type (uint16) + data_size (uint32) + brush data`

**Computed brush (type 1)** — 14 bytes:
```
miscellaneous (uint32), spacing (uint16, 0-999),
diameter (uint16, 1-999), roundness (uint16, 0-100),
angle (int16, -180..+180), hardness (uint16, 0-100)
```

**Sampled brush (type 2)**:
```
miscellaneous (uint32), spacing (uint16), antialiasing (byte)
[v2 only: name_length (uint16) + UCS-2 name]
bounds: top, left, bottom, right (int16 each)
bit_depth (uint16, typically 8)
compression (byte): 0=raw, 1=PackBits RLE
pixel data: single-channel grayscale alpha (0=transparent, 255=opaque)
```

Width = right - left, Height = bottom - top. If RLE: scanline byte counts (uint16 per row) precede compressed data.

**v1 vs v2 difference**: v2 adds UCS-2 brush name field. That's it.

**CRITICAL**: Old format stores NO dynamics, NO scattering, NO texture, NO color dynamics. Only tip image + basic shape params.

### New Format (v6+)

**Header**: `version (uint16) + sub_version (uint16)`

**Body**: sequence of 8BIM resource blocks:
```
signature: '8BIM' (4 bytes)
key: 4-char tag ('samp', 'patt', 'desc')
data_length (uint32)
block data
```

| Block | Contents |
|-------|----------|
| `samp` | Brush tip grayscale images (linked by UUID to desc) |
| `patt` | Pattern/texture data for texture brushes |
| `desc` | ActionDescriptor with ALL brush settings |

#### `samp` Block
Each brush tip entry:
- UUID string (links to descriptor)
- Bounds (int32 each: top, left, bottom, right)
- Bit depth (uint16, typically 8)
- Compression (byte, typically 1 = PackBits RLE)
- Pixel data: single-channel grayscale alpha mask

#### `desc` Block — ActionDescriptor Format
Serialized tree structure using type-length-value encoding:

| Type Tag | Data Type |
|----------|-----------|
| `Objc` | Object (class ID + key-value pairs) |
| `VlLs` | List (ordered values) |
| `doub` | Double (8-byte IEEE 754) |
| `UntF` | UnitFloat (value + unit: `#Pxl`, `#Prc`, `#Ang`) |
| `TEXT` | Unicode string |
| `enum` | Enumeration (type ID + value ID) |
| `long` | 4-byte signed integer |
| `bool` | 1-byte boolean |
| `tdta` | Raw byte blob |

**Descriptor keys for brush settings:**
- Tip shape: `diameter`/`Dmtr`, `hardness`/`Hrdn`, `angle`/`Angl`, `roundness`/`Rnds`, `spacing`/`Spcn`, `flipX`/`flpX`, `flipY`/`flpY`, `sampledData` (UUID ref), `brushType`
- Shape Dynamics: size/angle/roundness jitter + control + minimums
- Scattering: scatter%, both axes, count, count jitter
- Texture: pattern UUID (to `patt`), scale, mode, depth, texture each tip, invert
- Dual Brush: mode, second tip ref, diameter, spacing, scatter, count
- Color Dynamics: fg/bg jitter, hue/sat/brightness jitter, purity, apply per tip
- Transfer: opacity/flow jitter + control
- Brush Pose: tilt X/Y, rotation, pressure overrides + enabled flags
- Checkbox flags: noise, wet edges, build-up, smoothing, protect texture

### PackBits RLE Decoding
```
function decode_packbits(input, output_length):
    while output.length < output_length:
        n = read_signed_byte(input)
        if n >= 0:       copy next (n+1) bytes literally
        elif n > -128:   repeat next byte (1-n) times
        // n == -128:    no-op, skip
```

### Parsing Strategy
1. Read first uint16: 1 or 2 = old format, 6-10 = new format
2. Old format: parse sequential brush entries (tip images only)
3. New format: scan for 8BIM blocks, parse `samp` (tip images), `patt` (textures), `desc` (all settings)
4. Link tip images to descriptors via UUID

### Open-Source ABR Parsers (Reference Implementations)

| Parser | Language | Notes |
|--------|----------|-------|
| **[PSBrushExtract](https://github.com/MorrowShore/PSBrushExtract)** | JS | Most comprehensive. Extracts tip PNGs + full settings JSON. All versions |
| **[jlai/brush-viewer](https://github.com/jlai/brush-viewer)** | JS/Next.js | Browser-based viewer, v6-v10. Uses Kaitai Struct |
| **[GIMP abr loader](https://gist.github.com/justint/d839e8100609c28d3617)** | C | Reference implementation. v1, v2, v6.x |
| **[lusores/ABRViewer](https://github.com/lusores/ABRViewer)** | C++ | Fast native viewer |
| **[Unity-ABR-Importer](https://github.com/EndersWilliam/Unity-ABR-Importer)** | C# | Converts to alpha textures |

### Brush Preset Contents (what a preset stores)
A v6+ ABR preset contains:
1. Brush tip shape (computed params OR sampled grayscale image)
2. ALL Brush Settings panel options (dynamics, scatter, texture, dual brush, color dynamics, transfer, pose)
3. ALL checkbox flags (noise, wet edges, build-up, smoothing, protect texture)
4. Brush name
5. Pattern data (if texture used, in `patt` block)

Does NOT store: fg/bg colors, Options Bar opacity/flow, blend mode, or tool-specific settings.

### TPL vs ABR

| | ABR | TPL (Tool Preset) |
|---|---|---|
| Scope | Brush Settings panel only | ALL tool settings (brush + options bar + tool specifics) |
| Tool | Brush tool only | Any tool |
| Extra data | - | Flow, opacity, blend mode, color, tool options |
| Conversion | - | TPL → ABR in CC 2019+ via right-click |
