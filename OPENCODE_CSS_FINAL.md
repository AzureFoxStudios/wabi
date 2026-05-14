# CSS Refactor — Final Surgical Cleanup + Inline Style Migration

## Context
This is the Wabi frontend (dotronin-worktree, Rust backend). A CSS refactor is in progress. We have already completed:
- Token system (tokens.css), derivation engine (palettes.ts), themes.ts rewrite
- Generic shadow/overlay/border batch migration across ~70 components
- `app.css` decomposition
- Redundant var() nesting cleanup

## TWO TASKS TO COMPLETE

### Task A: Migrate 104 remaining RAW hardcoded rgba/hex values (28 files)
These are values NOT wrapped in any `var(...)` — the true remaining hardcoded colors.

Top files by count:
| File | Raw Values |
|------|------------|
| MapWorkspace.svelte | 16 rgba |
| ChannelSidebar.svelte | 1 hex + 10 rgba |
| ReaderTab.svelte | 8 rgba |
| ServerRail.svelte | 7 rgba |
| ServerSwitcherPanel.svelte | 7 rgba |
| WhiteboardCanvas.svelte | 1 hex + 5 rgba |
| CallView.svelte | 4 rgba |
| ConfirmDialog.svelte | 4 rgba |
| ModelViewportTab.svelte | 4 rgba |
| WhiteboardToolbar.svelte | 4 rgba |
| AdminTab.svelte | 3 rgba |
| AuthErrorBanner.svelte | 3 rgba |
| DMMessageView.svelte | 3 rgba |
| WhiteboardTab.svelte | 3 rgba |
| + 13 more files with 1-2 each |

**Strategy:** For each file, read its `<style>` block, find every raw `rgba(...)` or `#hex` not inside a `var(...)` wrapper, and wrap it with the closest semantic token + original fallback.

Available tokens: --surface-app, --surface-base, --surface-raised, --surface-sunken, --surface-modal, --surface-overlay, --surface-hover, --surface-active, --text-heading, --text-body, --text-secondary, --text-muted, --text-inverse, --text-danger, --text-warning, --text-success, --text-info, --border-subtle, --border-default, --border-strong, --accent-primary, --accent-secondary, --accent-danger-soft, --accent-warning-soft, --accent-success-soft, --accent-info-soft, --status-online, --status-away, --status-busy, --status-offline, --shadow-sm, --shadow-md, --shadow-lg, --shadow-xl, and RGB variants.

### Task B: Migrate 51 user/avatar color inline styles to CSS custom properties
Inline styles like `style="background-color: {user.color}"` should become:
- `style="background-color: var(--avatar-color, {user.color})"` with a CSS class that sets `--avatar-color` dynamically, OR
- A `.avatar` class in `frontend/src/styles/components/content.css` that uses `background-color: var(--avatar-color, var(--accent-primary))`, and elements set `style="--avatar-color: {user.color}"`

Files with user/avatar inline styles:
- CallView.svelte (5x background-color: getAvatarColor(...))
- ChannelSidebar.svelte (1x background-color: $currentUser.color)
- ColorPicker.svelte (1x background-color: {value})
- CreateDMModal.svelte (2x background-color: user.color / getStatusColor)
- CreateGroupModal.svelte (2x background-color: roleColor/color / getStatusColor)
- DMMessageView.svelte (1x background-color: otherUser.roleColor)
- GroupAvatar.svelte (1x background-color: {value})
- MessageList.svelte (multiple: user.color, getStatusColor)
- Settings.svelte (1x background-color: $currentUser.color)
- ThemePreview.svelte (2x background-color: {value})
- UserListTab.svelte (2x background-color: user.color)
- UserPopout.svelte (3x background-color: user.color / getStatusColor)
- ZipPreviewPanel.svelte (1x background-color: file.color)

## Rules
1. Wrap each raw color with `var(--token, original)` pattern. Preserve exact original value as fallback.
2. Do NOT modify TypeScript logic (props, stores, functions). Only CSS and inline style attributes.
3. Run `npx tsc --noEmit` after each batch. Must stay at exactly 10 pre-existing errors.
4. Focus on dotronin-worktree only. Do NOT touch wabi/Wabi.
5. Commit after each batch of files.

## Verification
After work: run `npx tsc --noEmit` in `frontend/` directory. Must have exactly 10 errors (all in motion/ files). Any new error = regression.
