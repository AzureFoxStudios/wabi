# B6 Fix: Avatar persistence + KanbanBoard users endpoint

## Context
Two bugs reported by the user on wabi.chat after deploy (SHA 47aabf8f):

### Bug 1: Profile picture doesn't stick after reload
The avatar upload flow:
1. User clicks "Update Avatar" → opens avatar editor → selects image
2. `Settings.svelte` calls `uploadProfilePicture()` → `uploadProfilePictureFile(file)` from `$lib/profilePictureUpload.ts`
3. This POSTs FormData to `/api/upload-profile-picture` → backend saves file to uploads dir, returns `/uploads/{uuid}.ext` URL
4. Frontend calls `updateProfile({ profilePicture: uploadedProfilePictureUrl })` → emits socket `update-profile`
5. Backend `on_update_profile` in `socketio/presence.rs:208` persists via `wdb.update_user(db_user_id, updates)`
6. Then `build_user_view` + emits `profile-updated` + `user-updated` broadcasts
7. Frontend `currentUser.update(user => ({...user, profilePicture: url}))` updates local store

The user reports: "they don't stick, wait there was another flicker and it stuck??" — suggesting a race condition where:
- The local store update happens
- Then a WDB sync / reload overwrites the profile picture back to empty
- OR the `update-profile` socket handler has an issue with the profile picture URL sanitization/persistence

**Files to investigate:**
- `frontend/src/lib/components/Settings.svelte` (lines 197-222, `uploadProfilePicture` + `handleAvatarSelected`)
- `frontend/src/lib/profilePictureUpload.ts` (entire file — the upload + `updateProfile` call)
- `frontend/src/lib/socket.ts` (lines 53-74, `updateProfile` function)
- `core/crates/wabi-server/src/socketio/presence.rs` (lines 152-164 `sanitize_avatar_url`, lines 208-333 `on_update_profile`)
- `core/crates/wabi-server/src/socketio/shared.rs` (lines 288-312, `build_user_view` / user view building for existing users)

**Check the race condition**: After the avatar upload succeeds and the socket emits `update-profile`, something may reload the user from the WDB store (e.g., `user-updated` broadcast causes other clients to reload, or the current client's `currentUser` store gets overwritten by a `init`/`user-joined` sync that doesn't include the profile picture).

### Bug 2: KanbanBoard fails to fetch users
`KanbanBoardImpl.svelte` line 66 fetches `${getServerUrl()}/api/users` but this endpoint doesn't exist on the backend. The response is a 404 HTML page, causing `SyntaxError: JSON.parse: unexpected character`.

**Files to investigate:**
- `frontend/src/lib/components/business/KanbanBoardImpl.svelte` (line 66, the fetch call; lines 24-28 type def with `profile_picture`)
- `frontend/src/lib/components/business/TaskPanel.svelte` (line 58, same fetch)
- `core/crates/wabi-server/src/api/routes.rs` (check if `/api/users` is registered; if not, add it)
- `core/crates/wabi-server/src/api/admin.rs` (the admin routes function — add a `/users` endpoint that returns the users list)

**Options:**
- Option A: Add a GET `/api/users` endpoint to the backend that returns the list of users (with profile picture, display name, etc.)
- Option B: Change the frontend to use an existing endpoint (e.g., `/api/channels/{id}/users` or similar)

Check what the KanbanBoard needs from the users response (profile picture, username, display name) and which backend endpoint can provide it.

## Requirements
- Write a detailed report to `audit/b6-fix-report.md`
- Run `cargo check -p wabi-server` and `bun run check` and `bun run build:only`
- The fix must survive a page reload (avatar persists)
- Use Svelte 5 runes syntax (no `export let`, no `$:`)
- Do NOT touch lore-related code
- Scope: only frontend/src/lib/components/business/*, Settings.svelte, profilePictureUpload.ts, socket.ts, api/routes.rs, api/admin.rs, socketio/presence.rs, socketio/shared.rs
