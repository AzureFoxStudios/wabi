# Pointer Worlds recovery — 2026-09-15

## Scope and provenance

This branch starts from current `main`,
`800716d7aa10312f631ed8805fed7c46cd89eebb`. It reconciles the pointer expansion
with that source instead of applying an older whole-tree patch.

The requested `wabi-connected-worlds-input-fixed.zip` was not mounted and the
referenced conversation did not expose downloadable attachment metadata. The
saved **wabi-connected-worlds-input-fixed.html** preview was available. Its
embedded trail, demo, field generators, material shaders and renderer were
recovered as typed modules and integrated into the current Svelte 5 components.
Preview SHA-256:
`7eb31409ab14ee82b8aa758b8167b75bd6839344b45d10f42d36b8f533d1f8d9`.

The conversation retained the full 28-name Little Worlds catalog, but the
original SVG artwork was unavailable. The branch recreates that library using
original font-independent outline motifs. It does not claim byte-for-byte
restoration of the missing artwork.

## Resulting behavior

- All existing basic choices and local imports remain available. Existing
  preferences migrate under the same storage key, including explicit zero
  strength values. Importing still selects the imported effect and preserves
  the current on/off state.
- All 28 Little Worlds share a deterministic scatter generator with mixed
  scale/rotation, irregular spacing, density pockets, companion clusters and
  rare larger motifs. Scatter Climb Icons and Arcane remain separate choices.
- All seven Connected Worlds use the recovered generation/rendering code.
  Climb Route branches and reconnects between dungeon room types; Maze retains
  traversable connectivity. Water and Sand expose reactive, settling wakes.
- Shared history keeps the newest physical input exact and bounds historical
  samples and canvas size. Fade/idle controls affect the live reveal; history
  duration/strength and material settling affect the wake separately.
- Appearance owns an explicit Pointer Effects section outside theme background
  controls. The sample sweep uses the production host and yields to real input
  without linking real and artificial strokes.

## Reliability fixes reconciled

- Settings do not manufacture activity. Blur, hidden documents, pointer/motion
  preference changes and teardown cancel pending frames and active demos.
- Local effect reads use generation/disposal fences before allocating object
  URLs or applying results. Errors are visible when settings open later.
- Image imports decode and enforce dimension/pixel limits before saving,
  preserve aspect ratios, and validate/sanitize static SVG content.
- Shader paths cache locations, clean partial compile/link/buffer failures,
  premultiply output, handle context loss and preserve the paused fade frame.
- Fresh physical input is not rejected as a future sample relative to the
  animation-frame timestamp. Subpixel movement updates the current position.

## Validation and boundaries

Reproducible commands and browser harness descriptions are in
[Local Visual Effects](../architecture/local-visual-effects.md#verification).
The dependency installation uses the committed npm lockfile, Node 22 and the
CI-pinned Bun 1.3.14. Final validation:

- Focused logic tests: **29 passed**, 12,616 assertions.
- Frontend check: **0 errors**, 168 existing warnings; no pointer-component
  diagnostics.
- Static build: passed; `frontend/build/index.html` produced.
- Headful Chromium 149: **129 integration checks** and **28 import/shader
  reliability checks** passed.
- The dedicated Pointer effects browser checks workflow runs both browser
  harnesses on relevant PRs and saves synthetic screenshots as CI artifacts.

The focused tests cover catalog/preference compatibility, deterministic scatter
and overlapping viewports, bounded history, demo cancellation, route/maze
connectivity, renderer lifecycle and failure paths. The headful browser suites
exercise compiled production Svelte components, actual mouse events, pixels,
shader compilation, imports/IndexedDB, settings and demo integration.

Screenshot inspection includes every built-in pattern at elevated inspection
strength plus representative scenes at the unchanged default strength. The
test workspace is isolated from accounts and deployed servers. These checks
are not native Tauri, Firefox or physical-device acceptance.

This is branch/PR work; opening the PR is not a merge or a deployment.
