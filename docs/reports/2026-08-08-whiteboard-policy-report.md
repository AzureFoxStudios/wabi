# Whiteboard Desktop-Only Policy — Client UX + Policy Controls (Phase 4)

Date: 2026-08-08

Wave 3 client slice on top of the Phase 0 server enforcement (`on_whiteboard_join`
emits `whiteboard:error DESKTOP_REQUIRED` for `access: desktop_only` on web clients,
and reflects `writeAccess` in `capability.write`). This phase adds the client UX:
a desktop-only gate view, a read-only banner + toolbar dimming, a policy badge, and
a store action for future policy editing.

Scope: 4 files + this report. No changes to the socket/sync/type layer
(`boardSync.ts`, `boardSocket.ts`, `boardTypes.ts`, `layers.ts`, `elementTypes.ts`,
`tools.ts`, `boardRenderer.ts`, `mathRender.ts`, `core/**`). No exported function
names changed.

## Files

### 1. `frontend/src/lib/whiteboard/boardStore.ts` (additive only)

- Confirmed `BoardState.policy: WhiteboardPolicy` already exists (Phase 0) and the
  derived `policy` store is exported.
- Added `setWhiteboardPolicy(policy: WhiteboardPolicy): void`:
  `activeStore().update(...)` sets `{ ...policy }`, marks `isDirty: true`, then
  `bumpVersion()` (mirrors the `addElement` action style). Exported on `boardStore`.
  Consumers that persist policy changes through the normal dirty→snapshot path now
  have the primitive; the snapshot writer (`getSnapshotDocument`) already serializes
  `policy`.

### 2. `frontend/src/lib/components/WhiteboardToolbar.svelte`

- New `export let readOnly = false` prop.
- When `readOnly`:
  - Drawing tool buttons (`pen`, `line`, `rect`, `ellipse`, `arrow`, `text`) get
    `disabled` + a `.readonly-disabled` class (opacity 0.4, `cursor: not-allowed`,
    hover transform suppressed). `select`/`pan` stay enabled.
  - `Undo`, `Redo`, and `Import images` are disabled (mutations).
  - Color swatches, width buttons, and brush sliders are disabled (they only feed
    drawing tools) with matching dim styles.
- Policy badge: a small accent-tinted pill rendered near the toolbar edge when
  `policy.access === 'desktop_only'` or `policy.writeAccess === 'desktop'`:
  - `access === 'desktop_only'` → lock icon + **Desktop-only**
  - `writeAccess === 'desktop'` → desktop icon + **Desktop-edit**
  - Uses `--accent-primary` tint (background/border mix + text color). Additive and
    subtle; hidden otherwise.

### 3. `frontend/src/lib/components/WhiteboardTab.svelte`

- Imports `isTauriRuntime` from `$lib/tauri-platform`, `boardSyncError` from
  `boardSync`, and the `policy` derived store from `boardStore`.
- Reactive gating:
  - `desktopRequired = !!$boardSyncError && $boardSyncError.includes('desktop-only')`
    (the DESKTOP_REQUIRED message set by `handleSyncError`).
  - `readOnly = !isDesktopClient && (($policy?.writeAccess === 'desktop') || $boardSyncError?.includes('read-only'))`.
    The `policy.writeAccess === 'desktop'` branch is the primary path — the server
    sends `whiteboard:joined` (doc carries the policy) for desktop-write boards and
    only emits a READ_ONLY error in edge cases, so we key on the hydrated policy and
    fall back to the error string.
  - `isDesktopClient = isTauriRuntime()` computed once (runtime does not change
    mid-session).
- **Desktop-only gate**: when `desktopRequired`, the canvas/toolbar are NOT mounted
  (no render loop). A glass replacement panel renders instead:
  `--surface-raised` tint, `--radius-lg`, `backdrop-filter: blur`, lock icon,
  heading "This board is desktop-only", body copy explaining the Wabi desktop app is
  required, and a note that web viewing is disabled by the board owner. The generic
  error banner and the "Joining board..." pill are suppressed in this state.
- **Read-only**: canvas stays mounted; a small `--accent-primary`-tinted banner shows
  "View-only — desktop app required to edit this board"; `readOnly` is passed to both
  `WhiteboardCanvas` and `WhiteboardToolbar`.
- State clears automatically on a successful `whiteboard:joined` because
  `handleSyncError`/joined-path resets `boardSyncError` to `null`, which the
  `$boardSyncError` subscription reacts to.
- The existing syncReady gate is untouched: canvas mounts whenever a channel is
  active and hydration (`syncReady`) flows exactly as before.

### 4. `frontend/src/lib/components/WhiteboardCanvas.svelte` (minimal)

Added `export let readOnly = false` to close the pointer/keyboard escape hatches that
toolbar disabling alone cannot (canvas owns the shortcut + pointer handlers):

- `handlePointerDown`: returns early for drawing tools when `readOnly` (select, pan,
  middle-button pan, wheel zoom/pan all still work).
- `handleKeyDown`: drawing-tool shortcuts ignored in read-only (only `select` hotkeys
  pass through); `Delete`/`Backspace`, `Ctrl+Z/Y`, `Ctrl+D` blocked.
- `handlePaste`, drag/drop handlers, and `maybeProcessPendingImports` bail in
  read-only so no image imports can be placed.

No other canvas behavior changed.

## Design notes / decisions

- **Why key read-only on `policy.writeAccess` rather than the READ_ONLY error code:**
  the server only emits `READ_ONLY` in narrow cases; the normal desktop-write flow
  delivers a full document whose `policy.writeAccess === 'desktop'`. Both are checked
  so the banner is correct in every path.
- **Detection strings**: `desktopRequired`/`readOnly` match the exact messages that
  `handleSyncError` writes into `boardSyncError` (see `boardSync.ts` DESKTOP_REQUIRED /
  READ_ONLY cases). If those strings change, the gate strings must follow — documented
  here as a coupling.
- **Badge visibility**: shown to all viewers of a desktop-policy board (desktop
  clients included) so the restriction is legible; on web clients the gate/banner
  dominate the UI and the toolbar badge is additive context.

## Verification

From `/var/home/Ronin/wabi/frontend`:

```
bun run check
```

`56 errors and 80 warnings in 45 files`. **Zero errors in the 4 touched files.**
The 56 are the pre-existing known set — 6 `bun:test`/`bun` module-resolution failures
(`storage-salt.test.ts`, `dmCrypto.test.ts`, `dmRatchet.test.ts`, `dmRecovery.test.ts`,
`run-crypto-tests.ts`, `layoutSchema.test.ts`) — plus peer i18n errors and peer-session
`mathTemplates.ts` diagnostics in untracked work (`frontend/src/lib/whiteboard/mathTemplates.ts`
is not part of this change and was not touched).

## Out of scope / follow-ups

- Server-side `whiteboard:patch` currently fans out to all room members without
  re-checking the writer's `capability.write`; enforcement of the write bit on
  patch/snapshot write paths is a backend concern for a later phase.
- Policy editing UI (board settings surface) — `setWhiteboardPolicy` is the store
  primitive; no UI was added to change policy from the board itself.
- `WhiteboardLayerPanel` is not wired to `readOnly`; its add/delete/reorder actions
  are not gated (scope limit — panel file not in the allowed list).
