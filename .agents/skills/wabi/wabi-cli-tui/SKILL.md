---
name: wabi-cli-tui
description: "Use when changing the Wabi Rust terminal client (core/crates/wabi-tui): screens, commands, admin ops, live feed, FPS/e-ink."
version: 1.0.0
metadata:
  hermes:
    tags: [wabi, tui, cli, ratatui, admin]
    related_skills: [rust-tui-app, rust-axum-server, wabi-deploy-debug]
---

# Wabi CLI TUI (power-user shell)

Crate: `core/crates/wabi-tui` (workspace member). Target: admins and power users in a terminal — not a thin chat demo.

## When to use

- Revamp / expand / polish the Wabi CLI or TUI
- Admin ops from the shell (users, lockout, password reset, server health)
- Multi-screen keyboard-driven Wabi client work

## Architecture (2026-08-06)

| Module | Role |
|--------|------|
| `api.rs` | reqwest: health, login, channels, messages, users, admin stats/reset/lockout |
| `app.rs` | `Screen` × `AppMode` × `FocusPane`; single `bg_tx`/`bg_rx`; `poll_bg` + 3s poll |
| `ui.rs` | Indigo RGB palette, Tabs header, per-screen layouts, overlays |
| `config.rs` | `~/.config/wabi/config.toml` mode 0600 |
| `live.rs` | Socket.IO live feed (join, message/typing) on its own thread |
| `main.rs` | TerminalGuard Drop; tracing → `$TMPDIR/wabi-tui.log` (never stderr on alt screen) |

### Screens

| Key | Screen | Notes |
|-----|--------|-------|
| 1 | Chat | 22/58/20 channels \| messages \| detail |
| 2 | Users | Directory; admin `p` reset password, `c` clear lockout |
| 3 | Server | Health, URL, role, admin stats, switch server / logout |
| 4 | Logs | Local event log |
| 5 | Lore | `:lore` list/new/push/import/health |

### Commands (`:`)

`:chat` `:users` `:server` `:logs` `:filter` `:ufilter` `:goto` `:refresh` `:logout` `:help` `:lore` `:fps` `:poll` `:eink` `:login` `:quit`

### Admin API

- `GET /api/users`
- `GET /api/admin/stats` (may stub zeros — 403 → Info/log, not spam Error)
- `POST /api/admin/users/reset-password` — `targetUserId`, `newPassword`, `temporary`
- `POST /api/admin/users/clear-login-lockout` — `targetUserId` (currently a no-op that returns success; `api/admin.rs`)

## Build

```bash
cargo build -p wabi-tui --release
./target/release/wabi-tui
```

## Pitfalls

- One long-lived `mpsc::Sender` cloned into every spawn + `try_recv` drain each frame.
- Global `l` = login steals chat “focus right” — use `Space` for pane cycle.
- Filtered list index: `filtered_users().get(i).map(|u| (*u).clone())`.
- Never log to stderr while alternate screen is active.
- Live updates come from the Socket.IO feed in `live.rs`; the HTTP poll remains the refresh/fallback path.

## References

- `references/power-user-shell-2026-08-06.md` — key map, API map, extension backlog

**Note:** General ratatui patterns also live in `rust-tui-app` (user-owned — `hermes curator adopt rust-tui-app` before patching it).
