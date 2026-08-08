# B6 Fix — OpenCode Dispatch Report

## Model
opencode/deepseek-v4-flash-free

## Status: SUCCESS

## Changes

### Backend (core/crates/wabi-server/src/)

1. **api/admin.rs** — Added `list_users` endpoint (GET /api/users):
   - New `RegisteredUserRow` struct (user_id, username, profile_picture, color)
   - Calls `state.wdb.list_users()` to fetch all registered users
   - Requires auth (`AuthUser` extractor)
   - Returns JSON array (not SPA HTML fallback)

2. **api/routes.rs** — Registered `/users` GET route → `admin::list_users`

3. **socketio/presence.rs** — Fixed avatar persistence race condition:
   - `build_user_view` signature changed to accept explicit `profile_picture`, `username_font`, `bio`, `status_message` params instead of re-reading from store
   - `on_update_profile` now:
     - Reads current user BEFORE the write
     - Merges the update patch into the pre-write snapshot (mirroring WdbAdapter update_user semantics)
     - Passes merged values to `build_user_view`
   - Root cause: `update_user` writes through async projection dispatcher; a post-write `get_user()` read could race the dispatcher and return the stale pre-update row (without `profilePicture`). Clients then merged the stale view over the optimistic local value, causing the avatar to revert.

### Frontend (frontend/src/lib/components/business/)

1. **KanbanBoardImpl.svelte** — Fetch `/api/users` with auth bearer token
2. **TaskPanel.svelte** — Same fix: fetch `/api/users` with auth token

## Verification
- `cargo check -p wabi-server` ✓ (Finished, only pre-existing warnings)
- `cargo test -p wabi-server` ✓ (2 passed, 0 failed)
- `bun run check` ✓ (6 pre-existing bun:test errors, 0 new)
- `bun run build:only` with `STATIC_BUILD=1` ✓ (adapter-static, index.html written)

## Remaining Issues (not addressed)
- Cloudflare beacon CORS block: cosmetic, injected by CF edge proxy. CSP now allows 'unsafe-eval' which fixes the Svelte store runtime.
- Profile settings / avatar editor ("Why can't I click on my pfp to open my profile?"): the profile hero avatar is not clickable — only the "Update Avatar" button in the actions column opens the editor. This is a UI/UX issue, not a data persistence issue.
