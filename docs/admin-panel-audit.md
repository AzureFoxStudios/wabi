# Admin Panel Audit — wabi.chat

**Auditor:** Hermes Agent  
**Date:** 2026-05-02  
**Site:** https://wabi.chat  
**Test account:** Guest (AuditBot)

---

## Executive Summary

The admin/moderation system is **severely incomplete**. Functions exist in the frontend (`banUser`, `kickGroupMember`) but are **never wired to any UI button**. The backend has **no handlers** for `ban-user` or `kick-group-member`. The `AdminTab` component exists but has **no discoverable access path** — no button opens it.

---

## Accessing the Admin Panel

**How to open:** The `AdminTab` component exists at `frontend/src/lib/components/AdminTab.svelte` and is rendered by `WorkspacePanelHost.svelte` when `panel.component === 'admin'`. The opener function is `showAdminTab()` in `layoutStore.ts` (calls `openRightPanel('admin')`).

**Finding:** No visible button or shortcut in the default UI triggers `showAdminTab()`. The admin panel appears to be accessible but undiscoverable — you need to know the code function exists.

---

## Button Audit Table

| Button | Location | Action | Confirmation? | Issues |
|--------|----------|--------|---------------|--------|
| Channel settings (⚙️) | Left sidebar, channel group | Opens channel settings panel | No | Panel opens but limited options |
| Create channel | Left sidebar, channel header | Opens channel creation flow | No | Works |
| ☆ (pin channel) | Left sidebar, channel row | Toggles pinned status | No | Works |
| View pinned messages | Left sidebar, channel row | Opens pinned messages modal | No | Works |
| User context menu (People tab) | Right panel, People tab | Shows user options | No | **No ban/kick options** — only: Send Message, Voice Call, Video Call, Screen Share, Request Payment, Record Cash Trade, View Profile |
| Add Reaction | Message hover | Opens emoji picker | No | Works |
| Reply | Message hover | Opens reply composer | No | Works |
| @mention | Message hover | Opens mention autocomplete | No | Works |
| Pin Message | Message hover | Toggles pin | No | Works |
| More (⋯) | Message hover | Opens `MessageContextMenu` | N/A | **No delete/edit options visible** in guest mode |
| Add media (📎) | Message composer | Opens file picker | No | Works (stub — backend upload now wired) |
| User Settings | Bottom-left sidebar | Opens settings | No | Works |
| Mute / Deafen | Bottom-left sidebar | Voice controls | No | Works |
| Create DM | Right panel, DMs tab | Opens DM creation | No | Works |
| Create group | Right panel, DMs tab | Opens group creation | No | Works |

---

## Moderation Buttons — All MISSING

### Expected but NOT FOUND:

| Button | Expected Location | Status |
|--------|-------------------|--------|
| **Ban User** | User context menu or People list | **NOT IMPLEMENTED** — `banUser()` exists in socket-manager.ts but no UI calls it |
| **Kick User** | User context menu or channel settings | **NOT IMPLEMENTED** — `kickGroupMember()` exists but no UI calls it |
| **Make Mod** | User context menu | **NOT IMPLEMENTED** — `assignRole()` exists but not in any context menu |
| **Remove Mod** | User context menu | **NOT IMPLEMENTED** — `removeUserRole()` exists but not in any context menu |
| **Make Admin** | User context menu | **NOT IMPLEMENTED** |
| **Delete Channel** | Channel settings | **NOT IMPLEMENTED** |
| **Edit Channel** | Channel settings panel | Partial — channel name/description editing may exist |
| **Role Management** | AdminTab | **AdminTab exists but has no visible access button** |

---

## AdminTab Contents (from code inspection)

`AdminTab.svelte` (1411 lines) contains:

### Users Section
- User list with role badges (owner/admin/mod/member/guest)
- Searchable by username or handle
- Sortable by role priority
- `setUserRoleLevel()` — changes user role via `assignRole()` / `removeUserRole()`
- Role display name editing
- **No ban button**

### Channels Section
- `setChannelMinRole()` — sets minimum role to view channel
- Channel list filtered by type (text/voice/public)
- **No channel delete/edit**

### Role Gate Section
- `createRoleGatePost()` — creates role gate messages
- `addEmojiRoleRule()` — assigns roles based on emoji reactions
- `deleteEmojiRoleRule()` — removes emoji role rules
- Uses `role_gate` message type

### Frontend Metadata Section
- App display name, icon, banner, accent color, description
- Upload for icon and banner images
- `saveAdminFrontendAppMetadataPolicy()` — publishes to live shell

### Payment Policy Section
- Enable/disable payments
- Allow/disallow guest payments
- Allowed roles configuration
- **No ban/kick**

### Compression Panel
- Video/audio compression config
- Metrics display
- Reset metrics button

### Runtime Tuning Panel
- Thread pool size
- Heavy profiling toggle
- Requires restart to apply

---

## Banning Flow — NOT IMPLEMENTED

**User asked:** "where is that compared to backup old backend version?"

**Finding:** There is **no ban flow at all**. The `banUser()` function in `socket-manager.ts` emits `ban-user` to the socket, but:
1. No UI button triggers it
2. No backend handler (`on_ban_user`) exists in `socketio.rs`
3. No "backup old version" — because ban doesn't exist
4. No confirmation dialog
5. No ban reason field
6. No ban list view

The `banUser` function itself:
```typescript
export function banUser(targetUserId: number, reason?: string): void {
    socketManager.emit('ban-user', { targetUserId, reason: reason?.trim() || undefined });
}
```
It's a one-liner stub with no backend counterpart.

---

## Role Gating — WORKING (but limited)

From `AdminTab.svelte`:
```typescript
$: canManageRoles = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
$: canModerate = canManageRoles || $currentUser?.highestRole === 'mod';
```

Role gating IS implemented and properly gated:
- Only owner/admin can manage roles
- Only owner/admin/mod can moderate
- `canManageTargetUser()` prevents managing self or owners

---

## Message Context Menu — What's There vs What's Missing

From `MessageContextMenu.svelte`:

**Present:** Reply, Add Reaction, Translate, Download, Add to Album, Forward, Copy Quote, Copy Link, Edit (own messages only), Pin/Unpin, Copy Text, Delete (own messages only)

**Missing:** 
- **No admin delete** for mods/admins on other users' messages
- No "Report Message" 
- No "Hide User" / mute

---

## Code Reference Map

| Feature | Frontend Location | Backend Status |
|---------|-------------------|----------------|
| `banUser()` | `socket-manager.ts:3070` | **NO HANDLER** |
| `kickGroupMember()` | `socket-manager.ts:3082` | **NO HANDLER** |
| `assignRole()` | `socket-manager.ts:3062` | Implemented (`on_set_role`) |
| `removeUserRole()` | `socket-manager.ts:3066` | Implemented (`on_remove_role`) |
| `UserContextMenu` | `UserContextMenu.svelte` | N/A — no ban/kick calls |
| `AdminTab` | `AdminTab.svelte` | N/A — UI only |

---

## Summary of Issues

### Critical (nothing works)
1. **Ban user** — frontend stub exists, no backend handler, no UI button
2. **Kick user** — frontend stub exists, no backend handler, no UI button
3. **Make/remove mod/admin** — `assignRole`/`removeUserRole` exist but no UI to call them from user list

### High (accessibility)
4. **Admin panel** — exists but has no discoverable access button

### Medium (UX gaps)
5. **No confirmation dialogs** for destructive actions (even delete of own messages has no confirm)
6. **No role-based icon/color editor** in AdminTab
7. **No channel deletion** — only creation and settings

### Low
8. **No "Report message"** flow
9. **No audit log** view in AdminTab

---

## What "Works" in AdminTab

- Role display name editing ✅
- Frontend metadata (icon/banner/description) ✅
- Payment policy settings ✅
- Compression metrics ✅
- Runtime tuning ✅
- Emoji role gates (add/remove rules) ✅
- Role gate post creation ✅
