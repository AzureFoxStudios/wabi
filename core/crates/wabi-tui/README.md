# Wabi TUI

Full-screen terminal client for **admin / power users**.

Indigo-styled multi-screen shell:

| Screen | Key | Purpose |
|--------|-----|---------|
| Chat | `1` | Channels, messages, compose |
| Users | `2` | Directory + admin password/lockout ops |
| Server | `3` | Health, connection, admin stats |
| Logs | `4` | Local event log |

## Build / run

```bash
cargo build -p wabi-tui --release
./target/release/wabi-tui

# or
cargo install --path core/crates/wabi-tui
wabi-tui
```

## Config

`~/.config/wabi/config.toml` (mode `0600`)

```toml
server_url = "https://wabi.chat"
username = "ronin"
# token is written after login
fps = 20          # UI redraw target; e-ink try 1–5
poll_secs = 3     # active-channel message poll
```

Env overrides: `WABI_TUI_FPS`, `WABI_TUI_POLL_SECS`.

E-ink quick preset inside the app: `:eink` (2 fps, 8s poll) or:

```bash
WABI_TUI_FPS=2 WABI_TUI_POLL_SECS=8 ./target/release/wabi-tui
```

## Keys

**Global**

| Key | Action |
|-----|--------|
| `Tab` / `1-4` | Switch screens |
| `:` | Command palette |
| `l` | Login |
| `r` / `F5` | Refresh current screen |
| `?` | Help |
| `q` | Quit |
| `Esc` | Dismiss popup / cancel |

**Chat**

| Key | Action |
|-----|--------|
| `j` / `k` | Channels |
| `i` | Compose |
| `PgUp` / `PgDn` | History |
| `Space` | Cycle focus (channels / messages / detail) |
| `/` | Start `:filter …` |

**Users** (admin/owner)

| Key | Action |
|-----|--------|
| `j` / `k` | Select user |
| `p` | Reset password (temporary) |
| `c` | Clear login lockout |

**Server**

| Key | Action |
|-----|--------|
| `s` | Switch server URL |
| `o` | Logout (drop token) |

## Commands (`:`)

```
:chat :users :server :logs
:filter <text>     channel name filter
:ufilter <text>    user filter
:goto <name>       jump to channel
:fps <n>           UI FPS (0.2–60); e-ink 1–5
:poll <secs>       chat poll interval
:eink              2 fps + 8s poll preset
:refresh :logout :help
```

## Debug

Logs go to `$TMPDIR/wabi-tui.log` (not stderr).

```bash
RUST_LOG=debug ./target/release/wabi-tui
tail -f /tmp/wabi-tui.log
```

## Status

- Login + bearer auth
- Channels / messages / send (3s poll)
- Users directory
- Admin: stats, reset password, clear lockout
- Command palette + multi-screen shell
- No WebSocket yet (poll-based live updates)
