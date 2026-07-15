# Wabi Frontend — Phase A Implementation Pass

**Date:** 2026-07-13
**Workdir:** /var/home/Ronin/wabi/frontend
**Scope:** Phase A only (Notes, Admin center, Center DM). No backend, no socket/crypto/calling changes, no right-panel width clamps, no commits.

## Files Changed

### A1 — Notes
- `src/lib/components/WorkspacePanelHost.svelte`
  - `notes` panel now renders `NotesWorkspace` (was `QuickScratchpad`).
  - Imports `currentUser` (from `$lib/socket`) and `getKeepNotesStorageKey` (from `$lib/notesStore`).
  - Passes `storageKey`, `title="Notes"`, `emptyMessage`, `placeholder`, `compact={true}`.
- `src/lib/components/NotesWorkspace.svelte`
  - Added `compact` prop and a `view: 'list' | 'editor'` state machine.
  - Compact mode renders a single column: card-style list (rounded cards, time + preview, active accent wash) with a back-aware editor. Clicking a note opens the editor; the `+` creates a note and opens the editor immediately; a back button returns to the list. Reader + delete actions preserved in the editor toolbar.
  - Non-compact (wide) mode keeps the original dual-pane list + splitter + editor unchanged.
  - Added `.notes-compact`, `.notes-list-cards`, `.notes-card` styles.
- `src/lib/layoutStore.ts`
  - `openNotes()` now opens the real `notes` right-panel (`openRightPanel('notes')`) and clears the stale fake-DM state, instead of faking a `__keep_notes__` DM conversation.

### A2 — Admin Center
- `src/lib/components/AdminWorkspace.svelte` (NEW)
  - Extracted the entire AdminTab data layer + panel host into a shared, section-aware component. It owns all the admin state/loaders/handlers and renders the real panels (`AdminUserList`, `RoleNamesPanel`, `ChannelAccessPanel`, `RoleGatePanel`, `EmojiRoleRulesPanel`, `PaymentAccessPanel`, `RuntimeTuningPanel`, `CompressionPanel`, `FrontendMetadataPanel`) filtered by a `section` prop (`'all' | 'users' | 'roles' | 'channels' | 'gates' | 'payments' | 'runtime' | 'branding'`).
- `src/lib/components/AdminCenterStage.svelte`
  - Removed every "Phase 2" placeholder. The left nav now drives `<AdminWorkspace section={section} />` for all non-overview sections, with OverviewSection preserved for `overview`.
  - Nav sections: overview, users, roles, channels, gates, payments, runtime, branding (dropped the placeholder-only `settings` section to avoid a mock-only admin section).
  - Shell preserved: 200px left nav, 48px topbar, content padding 22px, max-width 1200px, scrollable content.
- `src/lib/components/AdminTab.svelte`
  - Thinned to a stub that calls `layoutStore.showAdminCenterStage()` on mount (the dock `admin` panel now opens the center stage instead of dumping forms in the narrow dock). Keeps the file as a working component.

### A3 — Center DM
- `src/lib/components/MainLayout.svelte`
  - Center branch now renders a two-column layout when a DM hub or center DM is active: left ~300px conversation list (`DmHub`), right thread (`DmConversationView`) or an empty "Select a conversation" state. Selecting a conversation no longer destroys the list.
  - Added scoped `.center-dm-layout`, `.center-dm-list`, `.center-dm-thread`, `.center-dm-empty` styles (list hidden on mobile when a thread is open).
- `src/lib/components/DmConversationView.svelte`
  - Removed the two dead voice/video call buttons that had empty `on:click` handlers. Header height already ~48px. The toggle-surface and close actions remain.

## bun check result
```
svelte-check found 0 errors and 75 warnings in 32 files
```
75 warnings are pre-existing (unused vars / a11y hints across the broader app), not introduced by this pass. Build also succeeds (`bun run build` → ✓ built).

## Remaining Risks
- **Mobile center DM:** layout stacks to a single column; relies on `:has()` CSS (well-supported in current browsers) to swap list/thread. Not a focus of this phase and not visually verified on a device.
- **Mod role in center stage:** mods (view-only) only see `overview` + `users` in the nav; the role-gated sections are gated behind `canManageRoles` so they render nothing for mods (consistent with prior AdminTab behavior).
- **Notes `compact` is hard-set true** from the right-dock host; if Notes is ever surfaced in a wider context, it will still render compact until `compact` is passed false.
- The dock `admin` panel briefly shows the "Opening admin dashboard…" stub before `showAdminCenterStage()` flips the center view; this is the intended thin-stub behavior.
