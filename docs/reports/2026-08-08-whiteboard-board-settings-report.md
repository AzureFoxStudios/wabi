# Whiteboard Board Settings UI — Wave 6b (Phase 4.1)

**Date:** 2026-08-08
**Scope:** Owner-facing control to change board policy (`access` / `writeAccess`).
**Phase 4.1** of the whiteboard program — completes the policy story started in
Phase 4 (`feat(whiteboard): desktop-only policy gates + read-only mode + badge`).

## Files touched

| File | Change |
|------|--------|
| `frontend/src/lib/components/WhiteboardBoardSettings.svelte` | **NEW** — board policy settings popover |
| `frontend/src/lib/components/WhiteboardTab.svelte` | Mounts the popover; owner-gated gear button in the tab chrome |
| `docs/reports/2026-08-08-whiteboard-board-settings-report.md` | This report |

No changes to `boardStore.ts` — `setWhiteboardPolicy(policy)` already existed
(marked dirty + bumps version, persisted via the normal debounced snapshot
path) and the `policy` derived store was already exported. Read the policy via
`get(policy)` on open.

## Owner-check approach

The whiteboard has **no per-board owner id** — not in `WhiteboardPolicy`,
`WhiteboardDocument`, or the channel view (`Channel` has no `ownerId`). The
server's real gate is **channel membership** (`can_access_channel` in
`whiteboard_ops.rs` / `api/whiteboard.rs`), which any authenticated member
passes; there is no server-side owner check on policy writes today.

The app's established owner signal is `currentUser.highestRole === 'owner'`
(the Wabi instance owner — the same pattern used by `ChannelSidebar.svelte` for
persist-message toggles and `StorageSettings.svelte` for sidecar clearing). It
is readily available client-side via `currentUser` from `$lib/socket`.

**Decision:** gate the gear button behind `$currentUser?.highestRole === 'owner'`.
This matches the app's existing owner-only conventions and is the simplest
correct option given no per-board owner id exists. The server's membership
check remains the real enforcement; this gate is a UI courtesy.

## UI structure

`WhiteboardBoardSettings.svelte` — props `{ open: boolean; onClose: () => void }`.

- **Popover** (absolute, top-right below the tab chrome, `z-index: 40`),
  `role="dialog"` + `aria-modal="true"`, backed by a full-shell backdrop
  (`z-index: 39`) that closes on click. Escape (`svelte:window`) also closes.
  Backdrop uses the same `svelte-ignore` a11y pattern as `BaseModal.svelte`.
- **Board access** — two segmented buttons: "Anyone with channel access"
  (`access: 'open'`) / "Desktop app only" (`access: 'desktop_only'`), with a
  live description line that updates to match the draft.
- **Who can edit** — two segmented buttons: "Anyone" (`writeAccess: 'anyone'`) /
  "Desktop only" (`writeAccess: 'desktop'`), with matching description line.
- **Save** (primary, `--accent-primary`) → `boardStore.setWhiteboardPolicy({
  access, writeAccess })` then `onClose()`. **Cancel** (ghost) → `onClose()`
  without saving.
- Note: "Changes sync to all users on the next save." (policy persists via the
  existing 2s-debounced snapshot path in `boardSync.ts`.)
- Draft state resets from the live `$policy` each time the popover opens, so
  Cancel always discards unsaved selections.
- Styled with design tokens only (`--surface-raised`, `--radius-lg`,
  `--text-heading/secondary/muted`, `--accent-primary`, `--space-*`,
  `--font-size-*`), blur backdrop, mirrors the segmented-control styling of
  `settings-controls.css` (`.segmented`) but self-contained as scoped styles.

`WhiteboardTab.svelte`:

- Gear button in `.whiteboard-topbar-actions` (reuses the site's Feather
  `settings` gear SVG path from `Settings.svelte`), owner-gated, `aria-label`,
  `aria-expanded`, `aria-haspopup="dialog"`.
- `<WhiteboardBoardSettings open={boardSettingsOpen} onClose=... />` mounted at
  the end of `.whiteboard-shell` — independent of the recognition-UI flow
  (`recognitionDraft` / `WhiteboardMathRecognize` untouched).
- Forbidden files untouched: `WhiteboardToolbar.svelte` was clean on `git
  status` (only mobile/PWA files dirty), `WhiteboardCanvas`, math modules,
  board sync/socket/types, core/** all untouched.

## Save flow

```
Save → setWhiteboardPolicy({access, writeAccess})     (boardStore: dirty + version++)
     → isDirty store flips → boardSync.isDirty subscription schedules snapshot
     → (2s debounce) flushSnapshotSave → getSnapshotDocument() serializes policy
     → saveWhiteboardSnapshot → server whiteboard:snapshot → persist + fan out
     → other clients re-render gate/badge on next snapshot/join
```

## Verification

From `/var/home/Ronin/wabi/frontend`:

```
npm run check
svelte-check found 7 errors and 88 warnings in 44 files
```

Zero **new** errors. All 7 errors are pre-existing:
- 6 × `Cannot find module 'bun:test'`/`'bun'` (known bun-only type errors)
- 1 × `LoreChannelShell.svelte:234` `File` not assignable to `string` (pre-existing lore work, untouched)

Both files I touched report no warnings or errors. No UI/CSS changes affect
`src-tauri/` or `lib/tauri-*.ts`.
