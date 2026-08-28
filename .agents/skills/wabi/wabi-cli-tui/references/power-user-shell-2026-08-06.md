# Wabi TUI power-user shell (2026-08-06)

Crate: `core/crates/wabi-tui` · binary `wabi-tui` · config `~/.config/wabi/config.toml`.

## Screens

| Key | Screen | Role |
|-----|--------|------|
| 1 | Chat | Channels, messages, detail; 3s message poll when authed |
| 2 | Users | `GET /api/users`; admin `p` reset password, `c` clear lockout |
| 3 | Server | health, connection, `GET /api/admin/stats`, switch server / logout |
| 4 | Logs | in-app ring buffer (+ file `$TMPDIR/wabi-tui.log`) |

## Keys (summary)

**Global:** Tab/1–4 screens, `:` commands, `l` login, `r`/F5 refresh, `?` help, `q` quit, Esc dismiss.

**Chat:** j/k channels, i compose, PgUp/Dn history, Space cycle panes, `/` → filter command.

**Users (admin/owner):** j/k select, p reset password (temp), c clear lockout, `:ufilter`.

**Server:** s switch URL, o logout.

## Commands

`:chat` `:users` `:server` `:logs` `:filter <t>` `:ufilter <t>` `:goto <name>` `:refresh` `:logout` `:help`

## API

- `GET /health`, `POST /api/auth/login`
- `GET /api/channels`, `GET /api/messages/{id}?limit=`, `POST /api/messages`
- `GET /api/users`
- `GET /api/admin/stats`
- `POST /api/admin/users/reset-password` — `targetUserId`, `newPassword`, `temporary`
- `POST /api/admin/users/clear-login-lockout` — `targetUserId`

## Architecture notes

- Prefer one `bg_tx`/`bg_rx` for all background HTTP.
- Indigo palette in `ui.rs` (`C_BG` `#1a1a2e`, `C_ACCENT` `#6366f1`).
- Login request id invalidates late LoginOk after Esc cancel.
- Filtered user actions: `filtered_users().get(i).map(|u| (*u).clone())`.

## Build

```bash
cargo build -p wabi-tui --release
./target/release/wabi-tui
```

## Backlog

WebSocket live feed; role promote/demote; channel purge when APIs are solid; fill real admin stats when backend stub is replaced.
