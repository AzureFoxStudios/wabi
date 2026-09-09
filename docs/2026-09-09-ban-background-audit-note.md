# Dev note — verify ban/unban broadcast wiring (2026-09-09)

Shipped today: server-wide ban/unban (`admin-ban-user` / `admin-unban-user` socket
commands + `user-banned` / `user-unbanned` broadcasts) and a theme-agnostic
background image setting. Frontend ban state is tracked in a module store
(`bannedUserIds` set in `frontend/src/lib/presenceStore.ts`).

## AUDIT THIS FIRST — broadcast listener attach point

The ban/unban UI depends on the `bannedUserIds` set staying live from the
`user-banned` / `user-unbanned` broadcasts. Current wiring (verified 2026-09-09):
`attachUserBanListeners(sock)` in `frontend/src/lib/presenceStore.ts` is called
**inside `banUser` / `unbanUser` themselves** (best-effort, idempotent), so the
set is live from the moment the first command runs. It is NOT attached at
boot/reconnect, so broadcasts that arrive before any ban/unban command are not
heard — meaning a peer's ban won't flip the UI to "Unban" until this client
runs its own ban/unban (or reloads).

Things to confirm during audit:
1. Whether boot-time attach is needed: call `attachUserBanListeners(getSocket())`
   once where the app wires other socket listeners (same spot
   `assign-role-success` / `assign-role-error` are registered), and re-attach on
   reconnect if listeners are re-wired per connection.
2. Ban state hydration from an initial source (server snapshot / member list)
   so buttons show Ban vs Unban correctly before the first broadcast.
3. `banUser` / `unbanUser` correlate acks by requestId (pattern copied from
   `serverRoleCommands.ts`) and reject when the socket is disconnected.

## Background-image refactor notes

- Backend: `background_image` lives at the TOP level of the user layout
  container (not inside `theme`), whitelisted in
  `core/crates/wabi-server/src/api/user.rs` `save_theme`.
- Legacy `custom_theme.backgroundImage` is read as a migration fallback only;
  top-level wins. Nothing deletes the legacy field yet — a future cleanup may.
- Editor + live CSS-var application live in `BackgroundImageEditor.svelte` /
  `themeManager.ts` (`applyBackgroundImageVars`); blur now applies on the
  `.chat-container::before` image layer (`styles/components/chat-core.css`).

## Verification done at ship time

- `bun run check`: 0 errors. `cargo check -p wabi-server --features addons`: clean.
- Deployed `192717b4`, serving `start.D13jYjQ4.js`; `admin-ban-user` confirmed in
  live binary strings; health 200.
