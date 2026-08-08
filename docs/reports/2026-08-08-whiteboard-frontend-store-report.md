# Whiteboard Frontend — Store, Sync & Socket Contract (Phase 0 frontend)

Date: 2026-08-08

Phase 0 backend work landed a typed wire contract (`boardTypes.ts`, `elementTypes.ts`, `layers.ts`):
`WhiteboardPolicy` / `DEFAULT_WHITEBOARD_POLICY` / `WhiteboardMeta` (optional `policy` / `meta` on `WhiteboardDocument`), `blendMode` on layers, `hardness` / `brushPreset` on `ElementBase`, `MathElement`. This report covers the frontend slice that consumes that contract: store state, snapshot wire-shape, and the new socket event contract (`whiteboard:joined/left/patch/cursor/ack/error`).

Scope: exactly 3 files, all under `frontend/src/lib/whiteboard/`. No changes to the types slice, no `.svelte` components, no `core/**`.

## Files

### 1. `frontend/src/lib/whiteboard/boardStore.ts`

- `BoardState` gains `policy: WhiteboardPolicy` and `meta: WhiteboardMeta` (imported from `boardTypes`); `version` already existed. `defaultState()` now inits `policy = { ...DEFAULT_WHITEBOARD_POLICY }`, `meta = { updatedAt: 0, updatedBy: 0 }`, `version = 0`.
- New `setDocument(doc: WhiteboardDocument)`: normalizes transport elements (`fromTransportElement` → `normalizeElements`), layers (`normalizeWhiteboardLayers`), `activeLayerId` (`resolveWhiteboardLayerId`), viewport; applies `policy ?? DEFAULT_WHITEBOARD_POLICY`, `meta ?? {updatedAt:0,updatedBy:0}`, `version ?? 0`; resets undo/redo + selection, sets `isDirty = false`. Preserves `activeTool`/`style`.
- New `getSnapshotDocument(): WhiteboardDocument`: serializes current state to the wire shape — `boardId`, `version`, `updatedAt`, transport `elements`, `layers`, `activeLayerId`, `viewport`, `policy`, `meta`.
- New `bumpVersion()` (`version + 1`) and `setVersion(v)`.
- Version bump wiring:
  - Element mutations `addElement`, `updateElement`, `deleteElements`, `reorderElement`, `duplicateElements` bump after their `activeStore().update(...)`.
  - Layer ops bump via the patch listener: `notifyPatch` bumps on `replace` and `layer:*` types (covers `updateLayer`/`deleteLayer`/`reorderLayer`/`assignSelectionToLayer`/`ensureLayer`/`addLayer`, plus undo/redo which dispatch `replace`).
- New exports: `setDocument`, `getSnapshotDocument`, `bumpVersion`, `setVersion`, plus derived stores `policy` and `meta`. Existing exported names unchanged.

### 2. `frontend/src/lib/whiteboard/boardSocket.ts`

- `joinWhiteboardChannel(channelId)` now emits `whiteboard:join { boardId, clientClass }` where `boardId = getChannelBoardId(channelId)` and `clientClass = isTauriRuntime() ? 'tauri' : 'web'` (imported from `$lib/tauri-platform`).
- `leaveWhiteboard`, `saveWhiteboardSnapshot`, `sendWhiteboardPatch`, `sendWhiteboardCursor` keep their names; `whiteboard:leave`/`whiteboard:snapshot`/`whiteboard:patch`/`whiteboard:cursor` payloads unchanged.
- `subscribeWhiteboardEvents` now binds the contract events: `whiteboard:joined`, `whiteboard:left`, `whiteboard:patch`, `whiteboard:cursor`, `whiteboard:ack`, `whiteboard:error`, **plus** the legacy `whiteboard:snapshot` and `whiteboard:presence` (existing callbacks preserved).
- Reconnect handling: the SocketManager destroys and rebuilds the socket on reconnect (backoff preserved). The subscriber rebinds listeners when the `socket` store changes and re-emits `whiteboard:join` for all active boards when `connected` flips true (re-join → server re-pulls the doc via a fresh `whiteboard:joined`). Active boards are tracked in a module-level `Set`, removed on `leaveWhiteboard`.

### 3. `frontend/src/lib/whiteboard/boardSync.ts`

- New exported signals: `boardSyncReady` (writable, default `false`) and `boardSyncError` (writable `string | null`, default `null`).
- `whiteboard:joined` → `boardStore.setDocument(payload.document)`, sets `boardSyncReady`, clears `boardSyncError`, and invokes the existing `handlers.onReady()` on first hydration (preserves the `WhiteboardTab` local `syncReady` contract).
- `whiteboard:ack` → `boardStore.setVersion(payload.version)`.
- `whiteboard:error` → `handleSyncError`:
  - `VERSION_CONFLICT` → readable message + re-join (`joinWhiteboardChannel(channelId)`) to re-pull.
  - `DESKTOP_REQUIRED` / `READ_ONLY` → human-readable messages.
  - any other code → `payload.message || 'Whiteboard error'`.
- Debounced snapshot persistence: `isDirty` subscription schedules `scheduleSnapshotSave(boardId)` (debounce reduced to 2s). `flushSnapshotSave` now uses `getSnapshotDocument()` (full wire shape incl. policy/meta) and `markClean()`.
- `applyRemoteSnapshot` now calls `boardStore.setDocument(doc)` (single normalize path).
- Undo/redo stays local-only: the `replace` case was removed from the patch-emission listener — undo/redo changes persist through the debounced snapshot instead of a `replace` patch.
- Patch listener still emits `create`/`update`/`delete`/`reorder`/`layer:*` patches and schedules a snapshot save.
- All component-facing exports kept with unchanged signatures: `emitCreatePatch`, `emitUpdatePatch`, `emitDeletePatch`, `emitReorderPatch`, `emitLayerCreatePatch`, `emitLayerUpdatePatch`, `emitLayerDeletePatch`, `emitLayerReorderPatch`, `emitLayerSelectPatch`, `applyRemotePatch`, `applyRemoteSnapshot`, `broadcastCursor`, `createSyncSession`, `scheduleSnapshotSave`, `flushSnapshotSave`, `cancelSnapshotSave`.

## syncReady / boardSyncError mechanism

- **syncReady**: today components gate on a local `syncReady` variable set via the `onReady`/`onPresence` handlers passed to `createSyncSession`. That contract is preserved (first `whiteboard:joined` invokes `onReady`). In addition, `boardSyncReady` is exported so non-component code can observe the same signal without the handler plumbing.
- **boardSyncError**: a plain writable store; `createSyncSession` clears it on enter and on a successful `whiteboard:joined`, and sets it from `whiteboard:error` with the code mapping above.

## Verification

`npm run check` from `/var/home/Ronin/wabi/frontend`:

```
svelte-check found 6 errors and 80 warnings in 43 files
```

Zero errors in the 3 touched files. The 6 errors are all **pre-existing** `bun:test` / `bun` module-resolution failures outside this scope (reported only, not touched):

- `src/lib/storage-salt.test.ts`
- `src/lib/dm/dmCrypto.test.ts`
- `src/lib/dm/dmRatchet.test.ts`
- `src/lib/dm/dmRecovery.test.ts`
- `src/lib/dm/run-crypto-tests.ts`
- `src/lib/docking/layoutSchema.test.ts`

The 80 warnings are pre-existing a11y / unused-property / self-closing-tag diagnostics in `.svelte` files, none in the whiteboard slice.
