# CAD / 3D workspace — remaining work

Date: 2026-09-12

This document records what remains after the 2D CAD foundation, chat routing, docking, and 3D inspection pass. It is deliberately conservative: items below are **not** complete merely because the file type is recognized or a UI affordance exists.

## What this merge establishes

- CAD is a workspace family with a **2D drawing lane** and a **3D/model lane**, not a child of the 3D viewer.
- Built-in 2D support starts with read-only **ASCII DXF**: LINE, POLYLINE/LWPOLYLINE, CIRCLE, ARC, POINT, TEXT and MTEXT; layers; `$INSUNITS`; fit/pan/zoom; coordinate readout; basic snapping and two-point measurement.
- Existing GLB/glTF/OBJ/STL viewing gains a cleaner read-only inspection surface: mesh selection/isolation/visibility, display-mesh dimensions, declared-unit conversion, approximate surface measurement, section planes, standard views, better framing, and lifecycle cleanup.
- Chat and direct links recognize mesh, CAD and MMD file families. DXF can preview inline. Unsupported formats show the missing importer rather than entering a broken renderer.
- File actions are simple: the visible primary action opens the CAD/model workspace; right-click / overflow can dock it beside chat. File actions do not switch saved Wabi layouts.
- Music work remains deferred pending a separate rights/legal review and owner approval.

## High-priority CAD work still remaining

### 1. Complete local-file entry into the unified workspace

The current chat/file flow can select DXF into the workspace, but the workspace's empty-state local picker still advertises the older GLB/glTF/OBJ/STL set. Update that picker and recent-file language so users can open supported CAD drawings directly without first posting them in chat. Preserve local-only object-URL behavior and clean up object URLs when replaced/closed.

### 2. Expand 2D DXF fidelity

The built-in parser intentionally does not claim full AutoCAD compatibility. Add representative fixtures before expanding support. Candidate entities/features:

- INSERT/BLOCK expansion and nested transforms
- HATCH
- SPLINE
- ELLIPSE
- DIMENSION geometry/text
- LEADER/MLEADER
- IMAGE references
- polyline bulges as true arcs rather than straight segments
- linetypes, lineweights, colors and text styles where useful
- layouts/paper space only if there is a clear Wabi review use case

Binary DXF remains a separate decision; do not silently feed it to the ASCII reader.

### 3. DWG importer

DWG is recognized as 2D CAD but is not decoded. Choose a legally redistributable implementation and document exact license/redistribution obligations before integrating it. Keep it optional if the dependency is heavy. The UI must continue to distinguish “recognized file” from “installed importer.”

### 4. Solid-CAD import for STEP / IGES (and 3MF decision)

Add a real geometric/topological import path rather than treating solid CAD as triangles with an edit button. Reuse the Wabi 3D viewport for display, but keep the CAD model authoritative in the CAD engine. Initial acceptance should cover:

- STEP/STP and IGES/IGS import from real fixtures
- units and assemblies/components
- exact edge/face/component selection mapping back to CAD topology
- exact measurement where the kernel can guarantee it
- section views driven by CAD geometry where appropriate
- large-file limits/cancellation and malformed-input handling

3MF should be explicitly classified: it may be useful as a manufacturing mesh/package format, but supporting it does not equal solid-parametric CAD support.

### 5. First dependable edit → save → reopen path

Do not begin by cloning FreeCAD. Pick a deliberately small edit set backed by a proven geometry engine, for example transform/simple primitive/sketch-extrude/hole operations. Requirements:

- original source preserved
- explicit draft versus published revision
- undo/cancel
- save/export failure cannot overwrite the source
- exported file reopens in an independent CAD application with expected units/geometry
- optional Lore revision only after local save/export is dependable

### 6. 2D editing

After the reader is stable, define a separate 2D editing milestone: line/polyline/arc/circle, snapping, layers, dimensions and annotations. Editing should operate on an explicit document model, not by mutating rendered SVG elements.

## 3D/model work still remaining

- Verify the new inspection tools in the full browser app with real GLB/glTF/OBJ/STL fixtures, including skinned/animated models, very large models, malformed models and dependent glTF resources.
- Native/Tauri parity: the desktop native renderer does not automatically gain browser inspector tools. Decide which controls belong in native versus embedded web rendering and test both honestly.
- Consider orthographic drafting views as a separate feature; current standard views remain perspective.
- Persistent review anchors/comments need stable object/face/revision identities before publication. Do not migrate comments to a different revision silently.
- Transfer of camera/selection/measurement state between inline preview, dock and center workspace is not implemented yet.
- Multiple independent model documents/tabs are not implemented; the current model store has one active selection.

## MMD / character-animation sibling extension

MMD remains a sibling of CAD over shared 3D infrastructure, not a CAD dependency. Future work: PMX/PMD model loading, VMD/VPD motion/pose support, morphs, IK/physics, animation/camera timeline, representative fixtures, and clear audio/content boundaries. It must not bypass the deferred music/legal review by bundling unreviewed audio assets.

## Add-on/dependency UX still remaining

The broader add-on dependency work is separate from this CAD merge. Before third-party CAD/MMD engines become installable, finish a canonical dependency contract with version/capability checks, disabled/missing/incompatible states, author documentation links, and explicit permission handling. Author links are information, never automatic code installation or trust certification.

## Verification / release gates

Before calling the CAD/3D feature ready to showcase broadly:

1. `bun run check`
2. static frontend build
3. Tauri build/check where applicable
4. the isolated CAD/model scripts in `frontend/scripts/`
5. real browser testing at narrow dock widths and desktop widths
6. real attachment authorization/spoiler/encryption cases
7. server/account switching and stale-source cleanup
8. file-format fixtures from independent CAD/model tools
9. confirmation that no file action changes the user's saved Wabi layout
10. confirmation that unsupported formats never claim decoding/editing support

## Explicitly deferred

- music/listening/creation add-ons until a dated legal/rights review and explicit owner approval
- payments work (separate audit/project)
- broad fabrication/slicer/Gerber tooling until the CAD foundation above is stable
