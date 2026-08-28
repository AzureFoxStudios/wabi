# User Registry & Login Triage — probe commands, code locations, fix shapes

From the 2026-08-06 investigation: "void" account could not log in, was not in the
admin user registry, and appeared in no offline list. Root findings below.

## The three login-401 messages (exact strings)

Probe: `curl -s -X POST https://wabi.chat/api/auth/login -H 'Content-Type: application/json' -d '{"username":"void","password":"wrongpw123"}'`

| Response body | Meaning |
|---|---|
| `{"error":"Invalid username or password","type":"Unauthorized(...)"}` | User row missing **or** bcrypt verify failed. Disambiguate with `GET /api/users`. |
| `"This account is guest-only. Use 'Join as Guest' or register a new account with a password."` | Row exists, `password_hash` is EMPTY (guest account created via `/api/auth/guest`). |
| `"Account banned: {reason}. Contact server admin."` | User is in `data/wabi-server/blacklist.txt` (checked AFTER successful verify in `handle_login`). |

Login flow (core/crates/wabi-server/src/api/auth.rs `handle_login`):
`get_user_by_username` (case-insensitive lowercase index) → missing ⇒ generic 401 →
empty hash ⇒ guest-only 401 → `bcrypt::verify` → fail ⇒ generic 401 → blacklist check
(needs `state.get_blacklist()` configured) → JWT. No login-lockout system exists
server-side (the frontend `clear-login-lockout` call is a no-op endpoint).

## Existence check that settled it

`GET /api/users` (core/crates/wabi-server/src/api/admin.rs `list_users`) returns the
FULL registered directory from `wdb.list_users()` — userId, username, profilePicture,
color. Any valid token works (member or guest). "void" was listed as userId 8 with a
profilePicture ⇒ real account that had logged in before; generic 401 ⇒ wrong password,
not a broken account. Blacklist.txt and revocations.json were clean ⇒ nothing server-side
blocking login.

## The roster gap (why registered users vanish from every list)

- `socketio/presence.rs` `on_join` builds the `init` payload:
  - `users` = **only `state.connected_users`** (online presence map) — line ~93.
  - `serverMembers` was **hardcoded `Vec::new()`** (line ~91, comment: "needs
    row_to_user_view signature update") — this is the actual bug.
- Frontend `UserListTabImpl.svelte`: online section = `$users`; **"Offline — N"
  collapsible section exists** but = `$serverMembers` minus online `$users` ⇒ always
  empty while serverMembers is empty. The greyed-out offline section is real UI, dead data.
- `AdminWorkspace.svelte` (`visibleUsers`, owner/admin/mod/guest counts, header
  `usersLength`) and `settings/AdminSettingsTab.svelte` (`sortedAdminUsers`) render
  `$users` ONLY ⇒ offline registered accounts invisible in admin, and stats read 0
  unless the owner is online.

### Fix shape (shipped 2026-08-06)

1. Backend `presence.rs`: populate
   `server_members` from `state.app.wdb.list_users()` mapped through
   `build_user_view(&state, user_id, username, color, profile_picture, username_font, bio, status_message)`
   (same view builder already used for profile broadcasts — produces `id="user-{id}"`,
   `dbUserId`, `highestRole`).
2. Frontend admin surfaces: merge `$serverMembers` + `$users` keyed by
   `String(u.dbUserId ?? u.id)`, online wins:
   ```ts
   const byId = new Map<string, User>();
   for (const u of $serverMembers) byId.set(String(u.dbUserId ?? u.id), u);
   for (const u of $users) byId.set(String(u.dbUserId ?? u.id), u); // online wins
   rosterUsers = [...byId.values()];
   ```
3. Verification: `cargo check -p wabi-server` clean; `bun run check` only pre-existing
   `bun:test` module-resolution errors (test files — never a regression signal).

## Dead admin endpoints (password recovery was impossible)

Frontend (`frontend/src/lib/api/auth.ts`) has called
`POST /api/admin/users/reset-password` `{targetUserId, newPassword, temporary}` and
`POST /api/admin/users/clear-login-lockout` `{targetUserId}` for a long time; the
backend had NO matching routes (grep `api/routes.rs` + `api/admin.rs` found nothing) —
every admin reset attempt 404'd. Implemented 2026-08-06 in `api/admin.rs`:

- `reset_user_password`: `admin_auth` (bearer-only — the frontend sends no
  `X-Stepup-Token`; **no stepup flow exists anywhere in the frontend**, stepup-gated
  endpoints like `revoke_user` are API-only) → min 6 chars → reject guest-only targets
  (empty hash) → `bcrypt::hash` → `wdb.update_user(user_id, UserUpdate{password_hash})`
  → `state.revoke_user(user_id)`.
- `clear_login_lockout`: honest no-op returning success (no lockout store exists).

General lesson: when a frontend admin feature "doesn't work", grep the backend for the
route BEFORE blaming the UI — the frontend may anticipate endpoints the backend never
shipped (and the admin UI flows around them are often untested).

## Server-side state files (deploy host, e.g. /home/tim/Desktop/Wabi/data/wabi-server/)

- `blacklist.txt` — `type|value|reason|expires_timestamp`, types user/ip.
- `revocations.json` — `{epoch, jtis[], users[]}`; non-empty `users` = permanent token
  ban (login-bounce gotcha, see memory 2026-07-23).
- `jwt_secret`, `admin_policies.json`, `upload_registry.json`, `wabidb/` (engine data).
- Container: single `wabi-server` on 0.0.0.0:3001→3000; wabi.chat → cloudflared → caddy :8088.

## Avatar invisibility (same root cause, second symptom)

"User X can't see other users' profile pictures" — avatars only ever traveled with
ONLINE presence: `init.users` (connected map) and `user-joined` broadcasts carry
`profilePicture`, but the offline roster was empty. So when the avatar owner's
session is offline, the viewer's client has NO entry for them at all — no name, no
placeholder, no pfp — until the owner's session joins ("it loaded but took a hot
minute" = the `user-joined` broadcast finally arrived).

Verified live with the guest socket probe (see `scripts/probe-init-payload.mjs` in
this skill): while nobody else was online, `init` delivered `users: [self only]`,
`serverMembers: 0`. Uploads themselves were healthy (200, image/jpeg, 0.1–0.36s via
CF) — always curl the avatar URLs before blaming image serving.

Fix = the same serverMembers change; `build_user_view` reads `profile_picture` from
the User row, so offline roster entries carry avatars immediately.

## Guest coverage + isRegistered chain

Ronin's requirement: roster must cover ALL members (not just the N registered) AND
guests. Verified: `wdb.list_users()` → adapter → UsersProjection with
`UsersFilter::default()` returns every row — registered, guests, bots. No filtering.
Guest rows are created by `handle_guest` → `create_user(username, None, "")`; they
land in the same users projection.

Guest discriminator on the wire: `isRegistered = !password_hash.is_empty()` — the
SAME test auth.rs uses for the "guest-only" 401. Do NOT use the stored
`is_registered` flag (User::new defaults it true, so guest rows carry true).

Chain added 2026-08-06 (10 files, +184/−19):
1. `crates/wabi-core/src/workspace/mod.rs` `UserView.is_registered: Option<bool>`
2. Regenerate TS: `cargo test -p wabi-core --features ts` → `UserView.ts`
3. `presence.rs build_user_view` (+ param, + `"isRegistered"` json) and
   `shared.rs connected_user_to_view` (reads `!db_user.password_hash.is_empty()`)
4. `frontend/src/lib/socket-types.ts` `User.isRegistered?: boolean`
5. `AdminUserList.svelte` guest badge: `{#if !user.dbUserId || user.isRegistered === false}`
6. `AdminWorkspace.svelte` guestCount: same predicate

## Regen hazards (both bit this session)

- **ts-rs regen STRIPS manual edits to generated files.** Wabi's
  `packages/wabi-protocol/src/generated/` carries hand-appended values not in the
  Rust enums: `ChannelType.ts` has `"category" | "lore"` (comment: "keep on next
  ts-rs regen") and `ChannelView.ts` has `position`/`parentId`. Running
  `cargo test -p wabi-core --features ts` silently drops them → restore
  byte-identical (watch the trailing-newline diff too) or the channel-reorder and
  lore code breaks at the type level. Also: `crates/wabi-core/tests/workspace_types.rs`
  constructs `UserView`/`ChannelView` LITERALLY — adding a struct field means
  updating that test's struct init AND its JSON assertion.
- **Parallel workers can silently wipe uncommitted changes.** A `git checkout`/
  stash by another agent in the shared workdir reverted this session's earlier
  patches (git diff showed only the newest edits). After any worker runs in the
  repo, re-verify `git diff --stat` against your expected change set before
  building on prior patches.
