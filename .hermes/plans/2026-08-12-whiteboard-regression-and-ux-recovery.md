# Wabi Whiteboard Regression and UX Recovery Plan

## Goal

Make the whiteboard reliable enough to use as an Excalidraw-style drawing surface before expanding brush/layer ambition. The immediate bar is:

- no uncaught runtime errors on app boot or whiteboard open;
- a usable canvas with predictable pointer input and no zero-sized surface;
- a coherent toolbar with working controls;
- layers available in the existing right-panel system rather than competing overlays;
- measurable interaction performance;
- browser-verified behavior on `www.wabi.chat` after deployment.

Do not add Photoshop-grade features during this recovery pass. Preserve the current document/wabiDB wire shape unless a regression requires a compatibility fix.

## Evidence collected

### Live browser

The deployed `www.wabi.chat` build was opened in an isolated CDP Chromium session and authenticated with the dummy owner account.

The earlier blank-board failure was verified as a layout bug:

```text
.whiteboard-stage:          140 x 439
.whiteboard-canvas-container: 140 x 0
```

Applying only `display: flex; flex-direction: column` to `.whiteboard-stage` changed the canvas to `140 x 439`. That fix was deployed and re-verified. The canvas now has nonzero dimensions.

The audit viewport was 780px wide. The current app still compresses the center workspace to roughly 140px because the channel sidebar and right panel remain open at the same time. This is a separate responsive/layout failure, not a connection failure.

### Runtime errors supplied by the user

1. `Uncaught Error: https://svelte.dev/e/each_key_duplicate`
2. `Uncaught TypeError: wr.setCanvasBgColor is not a function`
3. Cloudflare Insights CORS/SRI errors
4. Repeated `[ServerUrl] Resolved` and theme logs
5. User reports lag, unusable right panel, unclear eraser icon, and many controls that may not work.

### Source-confirmed defect

`boardStore.ts` defines `setCanvasBgColor()` as an exported function, but the `boardStore` object passed to Svelte components does not include `setCanvasBgColor`. `WhiteboardToolbar.svelte` calls `boardStore.setCanvasBgColor(...)`, which directly explains the runtime TypeError.

### Likely duplicate-key defect to reproduce first

`UserListTabImpl.svelte` uses:

```svelte
{#each groupedUsers[role] as user, i (user.id ?? "u" + i)}
```

The fallback is only unique within each role group, not across the whole rendered keyed tree. Two users without `id` can produce the same fallback key across groups. The recovery pass must reproduce the exact duplicate and replace all unstable user-list keys with one stable identity helper based on `dbUserId`, stable `id`, or a deterministic final fallback.

Do not assume this is the only duplicate-key site; run the runtime probe and inspect the full stack before editing.

### Cloudflare Insights errors

The beacon/SRI/CORS errors are external telemetry failures, not the whiteboard rendering path. They should not be allowed to obscure application errors. Inspect the deployed HTML, CSP, SRI tag, and Cloudflare injection/configuration. Prefer disabling the broken injection for this site or correcting its generated integrity behavior; do not weaken application security headers merely to silence the beacon.

## Phase 0 — Freeze scope and establish a clean baseline

1. Preserve unrelated dirty work. Current checkout contains unrelated wiki/docs changes in addition to the whiteboard change. Do not stage or revert those files.
2. Record the exact whiteboard diff and current deployed binary/UI identity.
3. Build/check the current tree before new edits.
4. Create a repeatable browser smoke path:
   - login as dummy owner;
   - open the workspace Whiteboard pill;
   - open the voice-channel whiteboard button for comparison;
   - assert both target the same channel board;
   - assert canvas and interaction canvas have nonzero dimensions;
   - collect `Runtime.exceptionThrown`, console errors, network failures, and DOM geometry.
5. Add or identify a test harness boundary for runtime probes. Do not test by reading source text.

Acceptance: baseline report distinguishes application errors, browser-extension noise, Cloudflare beacon noise, and expected informational logs.

## Phase 1 — Stop the runtime-error cascade

### 1A. Fix `setCanvasBgColor`

Files:

- `frontend/src/lib/whiteboard/boardStore.ts`
- `frontend/src/lib/components/WhiteboardToolbar.svelte`
- `frontend/src/lib/components/WhiteboardCanvas.svelte`

Choose one consistent API:

- expose `setCanvasBgColor` on the `boardStore` command object; and
- expose/read the active state through a derived `boardState` store or a dedicated `canvasBgColor` store.

Avoid mixing command-object calls with `$boardStore` state access. Add a focused store test proving the command updates the active board and does not cross-contaminate another board.

### 1B. Fix duplicate keyed-list rendering

First reproduce the error with runtime stack capture after opening the authenticated app. Then audit keyed `{#each}` blocks that render users/channels/whiteboard layers/presence.

Primary file:

- `frontend/src/lib/components/UserListTabImpl.svelte`

Likely helper location:

- existing user identity helper under `frontend/src/lib/` if one already exists; otherwise extract a small pure helper in an appropriate existing identity module, not an ad hoc per-component fallback.

Rules:

- prefer `dbUserId` as the durable user identity;
- otherwise stable `id`;
- never use an index as a cross-group identity;
- if data is malformed, use a deterministic collision-safe fallback and surface/diagnose the malformed record rather than silently merging rows.

Audit every user list and presence list that can receive guest/registered mixed records. Add behavior tests for duplicate/missing IDs.

### 1C. Triage Cloudflare beacon/SRI separately

Files/config to inspect before changing:

- deployed root HTML;
- server static fallback/header code in `core/crates/wabi-server/src/main.rs`;
- Cloudflare/Caddy configuration if the beacon is injected at the edge.

Acceptance:

- zero uncaught application exceptions after fresh load and whiteboard open;
- Cloudflare beacon is either cleanly disabled or has valid integrity/CORS behavior;
- no broad CSP weakening.

## Phase 2 — Make the whiteboard UI coherent

### 2A. Define one surface hierarchy

Current competing surfaces:

- workspace-view Whiteboard pill in `WorkspaceViewBar.svelte`;
- voice-channel `voice-whiteboard-btn` in `VoiceChannelList.svelte`;
- `WhiteboardToolbar.svelte` floating over the canvas;
- `WhiteboardLayerPanel.svelte` floating over the canvas;
- global `RightPanel.svelte` with its own panel-stack/drawer system;
- chat header search/call/workspace controls.

Decision for this pass:

- the workspace pill and voice-channel button remain alternate entry points to the same board;
- the canvas gets one compact primary tool strip;
- layers move into the existing right-panel workspace system;
- no second floating layer panel over the drawing surface;
- no fake call/Jam control in whiteboard chrome;
- advanced/export/debug actions move behind a clearly labeled overflow/action menu instead of occupying the drawing toolbar.

Files to inspect/modify:

- `frontend/src/lib/components/WorkspaceViewBar.svelte`
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/chat/ChatHeader.svelte`
- `frontend/src/lib/components/WhiteboardTab.svelte`
- `frontend/src/lib/components/WhiteboardToolbar.svelte`
- `frontend/src/lib/components/WhiteboardLayerPanel.svelte`
- `frontend/src/lib/components/RightPanel.svelte`
- `frontend/src/lib/docking/layoutConstants.ts`
- `frontend/src/lib/docking/layoutHelpers.ts`
- relevant panel registry/stack files found during Phase 0.

### 2B. Right-panel integration

Register a Whiteboard Layers panel in the existing `RightPanel` panel catalog/stack system. The panel should receive the active board through existing stores/context, not create a second board instance.

Required behavior:

- open/close right panel works;
- layer selection, visibility, lock, opacity, blend, reorder, assign, rename, and delete work from the right panel;
- switching workspace tabs preserves the selected board and does not remount/reset layers unnecessarily;
- right-panel resizing does not collapse the center canvas below a usable minimum;
- when the right panel is closed, the canvas expands;
- on narrow screens, the panel becomes a drawer or modal sheet rather than consuming the canvas.

Add a minimum center-width policy or responsive collapse rule. A 140px-wide whiteboard is not acceptable.

### 2C. Toolbar and icon audit

Build a button inventory for every whiteboard control:

- label/title/aria-label;
- visible geometry;
- disabled state;
- click handler;
- resulting state change;
- browser proof.

Fix the eraser icon to an unmistakable eraser shape: tilted rubber block with a separated/contrasting waste section, not a crossed abstract path. Keep text labels/tooltips available.

Reduce the toolbar to grouped controls:

- Select / Pen / Eraser / Line / Shape / Arrow / Text;
- Undo / Redo;
- color + fill only when relevant;
- context-sensitive properties;
- overflow for import/export/math/advanced settings.

Do not show irrelevant controls for the current tool. In particular, avoid putting pen settings, shape radius, dash settings, export, background, and layer commands into one always-visible horizontal strip.

### 2D. Layer naming and interaction clarity

Default names must be unique and useful (`Background`, `Content`, `Content 2`, `Reference`) instead of multiple `CONTENT` rows. Verify layer normalization does not collapse/duplicate IDs. Add visible active-layer state and one obvious lock/visibility affordance per row.

## Phase 3 — Remove lag at the architecture level

Measure before changing.

### 3A. Instrument interaction timing

Measure:

- pointer event rate;
- time spent in tool handler;
- time spent in `boardStore.updateElement`;
- render frame duration;
- number of offscreen layer rasterizations per frame;
- outbound patch count during a drag;
- Svelte component update count if practical.

Relevant files:

- `frontend/src/lib/components/WhiteboardCanvas.svelte`
- `frontend/src/lib/whiteboard/tools.ts`
- `frontend/src/lib/whiteboard/boardStore.ts`
- `frontend/src/lib/whiteboard/boardSync.ts`
- `frontend/src/lib/whiteboard/boardRenderer.ts`
- `frontend/src/lib/whiteboard/whiteboardCanvasHelpers.ts`

### 3B. Reduce render work

Current risk areas:

- `renderLayersWithBlend()` can rasterize every visible layer on every frame;
- selected move/resize paths call `boardStore.updateElement()` repeatedly;
- each update notifies derived stores and bumps version;
- pointer move also broadcasts cursors;
- the live component has an inline render loop while `whiteboardCanvasHelpers.ts` also contains a render-loop implementation. Confirm one is authoritative and remove/deprecate dead duplicate paths only after tests prove it.

Target architecture:

- interaction canvas renders live movement/preview without rebuilding every layer;
- active layer offscreen cache invalidates only when its content changes;
- static/non-active layers remain cached;
- commit one coalesced document mutation at pointer-up or controlled RAF cadence;
- patch emission remains coalesced and does not cause synchronous full-document work;
- cursor broadcast stays throttled and independent of render invalidation;
- no expensive KaTeX/image work in the pointer-move path.

Add performance regression tests/benchmarks for a 500-element board and a 5,000-point stroke. Establish a frame-time target for drawing and selection movement.

### 3C. Service worker/cache correctness

After deploy, verify the browser receives the new index/chunk graph and that the service worker is not serving stale whiteboard chunks. Capture loaded JS/CSS URLs and service-worker state in the browser smoke test.

## Phase 4 — Whiteboard feature correctness audit

Only after Phases 1–3 are green:

1. Test every toolbar control through the browser.
2. Test drawing each primitive.
3. Test select/move/resize/rotate/eraser.
4. Test undo/redo.
5. Test text/math/image import.
6. Test layer create/rename/select/visibility/lock/opacity/blend/reorder/delete.
7. Test export PNG/JSON/SVG.
8. Test reconnect, remote patch, conflict, read-only, desktop-only policy.
9. Test both workspace-pill entry and voice-channel button entry produce the same board ID.
10. Verify wabiDB persistence across reload and server restart using a non-destructive test board/channel.

Produce a button/control matrix with `works`, `broken`, `disabled-by-policy`, or `not-in-scope` rather than relying on visual confidence.

## Phase 5 — Deploy and verify

Deployment remains the final step, not part of local UI iteration:

1. Preserve unrelated dirty files.
2. Run frontend static build and verify `build/index.html` + `_app/`.
3. Build release `wabi-server`.
4. Audit Tim’s live compose/container/health.
5. Ship the binary to `target/release/wabi-server.new`.
6. Stop `wabi-server` only, remove only the two WabiDB lock files, swap binary, restart.
7. Verify local Tim health, root HTML, setup status, binary SHA.
8. Verify public `www.wabi.chat`/`wabi.chat` headers and loaded asset graph.
9. Run authenticated browser smoke including whiteboard canvas geometry, no uncaught exceptions, panel controls, and a real draw/undo/persist cycle.

## Explicit deferred scope

- Photoshop-grade brushes;
- wet-edge/bristle simulation;
- broad layer effects;
- new math-recognition features;
- collaborative cursor polish;
- large toolbar feature additions.

These are deferred until the Excalidraw floor is stable and the performance budget is measured.

## Definition of done

- Fresh app load has no uncaught application exceptions.
- `setCanvasBgColor` works or the control is removed from the UI.
- No duplicate-key errors in the tested app path.
- Canvas maintains a usable minimum width/height and expands when panels close.
- Whiteboard layers are usable in the right panel.
- Eraser is visually recognizable and functionally verified.
- Every visible whiteboard button has a tested action or is removed.
- Drawing/selection interaction meets the agreed frame-time target.
- wabiDB save/reload works.
- The deployed browser path is verified after the final binary swap.

## Current execution boundary

This file is the plan only. No production source files were modified during the planning pass. The checkout already contains unrelated dirty wiki/docs work; preserve it during implementation.

## Suggested implementation order

1. Runtime errors: `setCanvasBgColor`, duplicate keys, beacon diagnosis.
2. Right-panel/layer architecture and minimum canvas width.
3. Toolbar reduction and eraser icon/control audit.
4. Render/pointer performance instrumentation and cache invalidation.
5. Full browser control matrix and persistence/reconnect tests.
6. Static frontend build, release binary, deploy, live browser verification.
