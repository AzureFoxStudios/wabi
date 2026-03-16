# Whiteboard MVP Plan

## Goal

Add a shared whiteboard tab to Wabi where multiple users in the same session can:

- draw basic shapes and freehand strokes
- select, move, resize, and delete items
- paste images or clipboard files onto the canvas
- pull a screenshot into the board and annotate it during a call or lesson
- annotate pasted images with the same drawing tools
- see each other's changes quickly in the same tab

This first tier should feel like a lightweight Excalidraw-style board, not a full design tool.

## Non-negotiables

- build from a blank slate inside Wabi's Svelte stack
- end state is zero React runtime code and zero Excalidraw runtime code in the app
- treat Excalidraw as a feature benchmark, not as an embedded dependency
- default everything to private unless a future product decision explicitly makes something shareable
- obvious encryption requirements are mandatory, not polish

## Product Scope

### In scope for tier 1

- shared board tab inside the existing app shell
- room-scoped collaboration, not global broadcast
- vector elements: pen, line, rectangle, ellipse, arrow, text
- selection, transform, z-order, delete, duplicate
- board viewport: pan and zoom
- paste/upload image nodes
- screenshots pasted from clipboard
- image annotation using normal drawing tools on top of placed images
- presence signals: active users, cursor color, last editor
- autosave and board restore

### Explicitly out of scope for tier 1

- complex shape libraries
- offline merge/reconciliation across long disconnects
- advanced permissions beyond normal room access
- export pipelines beyond PNG / JSON
- nested pages, frames, comments, or version history UI
- true system-wide desktop overlay over other apps outside Wabi

### Adjacent follow-on scope after tier 1

- in-call presenter overlay over a shared screen or focused media tile
- one-click "Capture to whiteboard" action in the call UI
- presenter freeze-frame workflows for teaching, feedback, and live critique
- desktop-only transparent overlay window as a later Tauri mode

## Why the current code is not enough

Current state in repo:

- `frontend/src/lib/components/DrawingBoard.svelte` is a disabled placeholder.
- `backend/src/server.ts` still has an `excalidraw-update` socket event, but it broadcasts to every connected client.

That means the old path is both feature-incomplete and architecturally wrong for a multi-board shared tab.

## Excalidraw stance

The downloaded Excalidraw repo is useful as a reference archive, not as the implementation base.

What to do:

- use Excalidraw as the parity target for tools, UX quality, and edge cases
- use its repo as a checklist for expected behaviors, shortcuts, import/export expectations, and polish
- port only isolated ideas or algorithms if they are genuinely useful and can live as framework-agnostic TypeScript
- keep attribution and license notices if any code is actually ported

What not to do:

- do not drop the React monorepo into Wabi
- do not mount React islands just for whiteboarding
- do not preserve the old disabled Excalidraw path
- do not let "temporary" React glue survive into the final app

## Recommended architecture

### Frontend

Build a Svelte-native whiteboard surface instead of restoring the old React/Excalidraw mount.

Recommended modules:

- `frontend/src/lib/whiteboard/boardStore.ts`
- `frontend/src/lib/whiteboard/boardTypes.ts`
- `frontend/src/lib/whiteboard/boardSync.ts`
- `frontend/src/lib/whiteboard/boardRenderer.ts`
- `frontend/src/lib/components/WhiteboardTab.svelte`

Why:

- avoids reintroducing React just for one feature
- keeps state handling aligned with the rest of the Svelte app
- makes clipboard/image flows easier to wire into existing upload helpers

### Real-time transport

Use Socket.IO first because Wabi already uses it heavily.

Do not keep using one global `excalidraw-update` event.

Use board-scoped events instead:

- `whiteboard:join`
- `whiteboard:snapshot`
- `whiteboard:patch`
- `whiteboard:presence`
- `whiteboard:cursor`
- `whiteboard:leave`

Each board needs a stable `boardId`, and users should join a Socket.IO room keyed by that ID.

### Persistence

Tier 1 should persist full board snapshots on a short debounce instead of trying to persist every operation.

Recommended storage model:

- one board metadata record
- one latest board document JSON blob
- optional image attachment records pointing at existing Wabi upload storage

This is enough for MVP and keeps recovery simple.

## Security and privacy baseline

This feature should ship private-by-default.

### Required baseline

- boards are scoped to a room, DM, group, or workspace context and are never globally broadcast
- every read, write, upload, and attachment fetch is authenticated and authorized
- board snapshots and uploaded images are private unless a future explicit sharing feature is added
- transport uses HTTPS and WSS only in production
- stored board documents and attachments must be encrypted at rest using the backing store or provider capabilities
- attachment delivery should use signed URLs, authenticated fetches, or another non-public access layer
- server logs and analytics must not casually dump board contents or attachment URLs

### Product stance

Do not rely on obscurity, guessable URLs, or "we forgot to lock it down later."

Private should be the default behavior from the first usable build.

### End-to-end encryption

Full E2EE is a separate design track, not something to hand-wave into MVP.

For tier 1, the minimum acceptable standard is:

- authenticated private access
- encryption in transit
- encryption at rest
- strict room-scoped authorization

If later we want true E2EE whiteboards, that should be treated as a dedicated project with its own tradeoff review.

## Data model

### Board document

```ts
type WhiteboardDocument = {
  boardId: string;
  version: number;
  updatedAt: number;
  elements: WhiteboardElement[];
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
};
```

### Element types

```ts
type WhiteboardElement =
  | StrokeElement
  | ShapeElement
  | TextElement
  | ImageElement;
```

Each element should include:

- `id`
- `type`
- `x`, `y`, `width`, `height`
- style fields like stroke, fill, opacity, roughness-lite if desired
- `createdBy`
- `updatedAt`
- `zIndex`

For strokes, store points as simplified arrays so sync payloads stay small.

For images, store:

- upload id or file URL
- natural width and height
- optional crop metadata later, but not in tier 1

## Sync strategy

### MVP approach

- send live patches for local edits
- debounce full snapshot persistence to backend
- on join, send the latest snapshot first
- for conflicts, last-write-wins at element level

This is not perfect, but it is the right first tradeoff.

Avoid CRDT work in tier 1 unless the MVP fails under real usage.

### Patch granularity

Use operation-shaped patches:

- create element
- update element
- delete element
- reorder elements
- replace document snapshot

That keeps packets smaller than shipping the whole board on every pointer move.

## Images and clipboard files

### Required user flow

1. User pastes an image from clipboard or drops a file.
2. Frontend uploads the file through existing Wabi upload/media infrastructure.
3. Backend returns a durable attachment reference.
4. Frontend inserts an `ImageElement` with dimensions and URL.
5. Other users receive the image node through normal board sync.

### Important constraint

Do not embed raw base64 image payloads inside board snapshots for shared boards.

That will make snapshots large, slow, and hard to persist.

## Capture to whiteboard

### Why this matters

This is the right bridge between calling and whiteboarding.

An art teacher or presenter should be able to:

1. watch a screen share or lesson material
2. capture the current frame or use a normal OS screenshot
3. drop that image into the board
4. annotate it with arrows, pen marks, and notes
5. let everyone in the room see the same markup

Clipboard paste already covers the manual path. A dedicated capture button is the QoL path.

### Recommended MVP-adjacent flow

- add a `Capture to whiteboard` action near the screen share controls in the call shell
- capture the current visible screen-share frame first, not arbitrary desktop regions
- upload the captured image through normal Wabi media storage
- insert it as an `ImageElement` on the active board
- focus the whiteboard tab or open a side-by-side whiteboard panel
- keep the image as a normal board element so follow-up edits reuse the same sync path

### Important constraint

Store captured frames the same way as pasted or dropped images: as uploaded attachments referenced by `ImageElement`.

Do not inline captured screenshots inside the board snapshot document.

## Rendering approach

Use a layered canvas model:

- base canvas for committed elements
- interaction canvas for current drag/draw preview
- DOM overlay for text editing and selection affordances

Reason:

- performs better than one DOM node per shape
- still allows usable text editing
- supports image rendering cleanly

## Presenter overlay modes

Treat "overlay" as two separate products so scope stays clear.

### Mode A: in-app presenter overlay

This is the near-term recommendation.

- render a whiteboard annotation layer above the shared screen inside Wabi
- keep strokes synced to the same room-scoped board model
- allow a presenter to toggle markup on and off without leaving the call
- optionally let viewers open the same board in a tab for fuller editing
- if this starts as presenter-only markup, keep it local-first because the screen share already carries it visually to everyone else
- only sync overlay strokes later if we need shared editing, board history, replay/export, or viewer-side toggles

This fits the current call UI much better than a desktop-wide overlay and directly supports teaching or critique sessions.

### Mode B: desktop presenter overlay

This is a later Tauri-only mode.

- open a separate transparent always-on-top window
- allow drawing over other desktop apps or websites outside Wabi
- likely require click-through toggles, hotkeys, and OS-specific window behavior

This is the fun "party trick" mode, but it should not block the shared whiteboard MVP.

## Permissions and board lifecycle

Tier 1 can inherit existing channel/tab access rules, but the whiteboard path must enforce them strictly on every board and attachment operation.

Recommended board lifecycle:

- a board belongs to one channel, DM, group, or shared workspace tab
- first open creates the board if it does not exist
- subsequent opens restore the latest snapshot

Moderation for MVP:

- anyone who can access the room can edit the board
- add read-only/lock states later if needed
- do not expose public board links or public image URLs by accident

## Delivery plan

### Current grounded state

As of the current implementation pass:

- Phase 0 is complete.
- Phase 1 is in progress and already has a working native Svelte board surface mounted inside chat.
- The board currently has room-scoped sync, snapshot persistence, a floating toolbar, pen/line/rect/ellipse/arrow/text/select/pan tools, local undo/redo, cursor broadcast, and channel-level whiteboard switching.
- Image paste support is started in the whiteboard canvas, but attachment hardening and UX polish still belong to follow-on work.
- The current image import path still uses the generic upload pipeline, so private board-scoped attachment handling is not finished yet.
- The frontend build and `svelte-check` both pass after cleaning the pre-existing `Settings.svelte` parse issue.

### Phase 0: groundwork

- define board IDs and routing model
- add backend board room events
- add persistence schema and API
- remove the old disabled Excalidraw path and related server event/state
- define the whiteboard security model before shipping any usable board UI

### Phase 1: single-board collaboration

- whiteboard tab component
- pen, rectangle, ellipse, arrow, text
- select/move/delete
- socket join/snapshot/patch flow
- autosave

### Phase 2: image support

- paste image from clipboard
- drag/drop image file
- upload integration
- image nodes on canvas
- drawing over images
- replace the generic upload URL flow with private board-safe attachment rules before calling image support complete

### Phase 3: call integration

- add `Capture to whiteboard` in the call controls
- import the current shared-screen frame as an `ImageElement`
- open or focus the linked board from the call UI
- support quick annotate-and-return workflows for lessons and reviews

### Phase 4: polish

- cursor presence
- undo/redo per client with server-safe snapshot fallback
- export PNG / JSON
- fill the highest-value Excalidraw parity gaps that matter in real usage
- performance pass for larger boards

### Phase 5: presenter overlay extensions

- local-first in-app annotation overlay above shared screens
- presenter-only markup toggle and clear controls
- only add shared overlay sync if real product needs appear beyond what screen share already shows
- investigate desktop-wide Tauri overlay as a separate mode

## Technical risks

- current server event style is broad and large-file friendly, but not optimized for high-frequency drawing patches
- image upload latency can make paste feel slow unless optimistic placeholders are used
- frame capture from live video can vary by browser/runtime and needs fallbacks
- text editing on canvas is always awkward, so keep the MVP text tool minimal
- feature ambition can drift if "Excalidraw parity" is interpreted as "ship everything before launch"
- copying too much from the React codebase will slow delivery and violate the zero-React end state
- a desktop-wide overlay will be platform-specific and should stay isolated from core board logic
- if boards get large quickly, element-level indexing or viewport culling will be needed
- privacy mistakes around attachments are easy to make if upload access rules are bolted on late

## Recommended acceptance criteria for tier 1

- two users in the same shared tab can draw and see updates within one second
- pasted images appear for all connected users without manual refresh
- screenshots pasted from clipboard behave the same as uploaded images
- board state survives reload and reconnect
- users in other rooms do not receive the board's events
- a board with at least 200 mixed elements remains usable on desktop

## Immediate next implementation slice

Continue from the current cleaned baseline in this order:

1. Harden Phase 1 interactions.
Fix selection edge cases, resize polish, remote snapshot reconciliation, and keyboard/tool affordances until the current board feels dependable.
2. Finish Phase 2 image handling.
Move whiteboard image ingestion off the generic upload URL path and onto the private attachment rules we actually want long-term, then add optimistic placeholders and import polish.
3. Add call capture integration.
Wire `Capture to whiteboard` into the call UI so presenters can freeze a frame into the active board without leaving the call flow.
4. Decide whether in-app presenter overlay starts before export/polish.
Treat presenter overlay as local-first by default; only add shared overlay data if we later need editing/history/export beyond what the screen share itself already communicates.
