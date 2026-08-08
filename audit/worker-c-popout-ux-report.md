# Worker C — Mention/Popout UX Cleanup Report

Worker hit a 503 (queue full) mid-run after applying all code edits; report written by Hermes after independent verification of every edit.

## Changes verified on disk

### MessageList.svelte
- `.mention-token` click branch in `handleMarkdownContentClick` (~line 539): no longer opens the user popout. Copies the username (leading @ stripped) to clipboard via `navigator.clipboard.writeText`, shows `showToast('Copied!', 'info', 1200)` feedback. `showToast` import added (line 52). `.mention-token-place` and `[data-ref-kind]` branches untouched.

### UserPopoutActions.svelte
- Removed `onCopyUserId` prop and the "Copy User ID" context button.
- Added `user` and `onOpenSettings` props.
- Voice-actions row (own profile only): mute + deafen toggles wired to `$isMuted`/`$isDeafened`/`$isInCall` (callingStateStores) and `toggleMute()`/`toggleDeafen()` (calling.ts). Disabled when not in a call.
- Settings gear button (own profile only) -> `onOpenSettings`.
- "Share Profile" button (own profile or expanded): copies `@handle` (fallback `@username`) to clipboard with toast. Share-text bug fixed by Hermes (was duplicating username+handle).

### UserPopoutImpl.svelte
- Removed `copyUserId()` and its prop pass.
- Removed `.status-badge` decoration from the avatar ring (textual status section kept).
- Passes `{user}` and `onOpenSettings={openFullProfile}` (maps to the existing settings dispatch in ChannelSidebar).

### i18n (en.json + es.json)
- Added: `user.popout.mute`, `.deafen`, `.settings`, `.share_profile`.
- Removed stale `user.popout.copy_user_id`.

## Verification
- `bun run check` -> 6 errors / 71 warnings, identical to pre-work baseline (all pre-existing bun:test module-resolution issues elsewhere). Zero new errors in touched files.
- Nothing committed.
