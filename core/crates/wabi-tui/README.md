# Wabi TUI

Full-screen terminal client for **admin / power users**.

Multi-screen shell (themes: indigo default, plus `ember`, `forest`, `mono`,
`slate`, `violet`):

| Screen | Key | Purpose |
|--------|-----|---------|
| Chat | `1` | Channels (grouped by category), messages, compose |
| Users | `2` | Directory + admin password/lockout ops |
| Server | `3` | Health, connection, admin stats, privacy contract |
| Logs | `4` | Local event log |
| Lore | `5` | Lore repos (channel = repo) browser |

## Build / run

```bash
cargo build -p wabi-tui --release
./target/release/wabi-tui

# or
cargo install --path core/crates/wabi-tui
wabi-tui
```

First run asks for a server URL, then a login. Credentials are kept in the
config file below; an expired session drops the token and re-prompts.

## Live updates

Realtime via Socket.IO (`[LIVE]` in the footer): new messages, typing
indicators, instant sends. If the socket is down, the client falls back to
polling the active channel (`[POLL]`) without manual action.

## Config

`~/.config/wabi/config.toml` (mode `0600`)

```toml
server_url = "https://wabi.chat"
username = "ronin"
# token is written after login
fps = 20          # UI redraw target; e-ink try 1–5
poll_secs = 3     # active-channel message poll (fallback when live is down)
theme = "violet"  # indigo | ember | forest | mono | slate | violet
```

Env overrides: `WABI_TUI_FPS`, `WABI_TUI_POLL_SECS`, `WABI_TUI_THEME`.

E-ink quick preset inside the app: `:eink` (2 fps, 8s poll) or:

```bash
WABI_TUI_FPS=2 WABI_TUI_POLL_SECS=8 ./target/release/wabi-tui
```

## Keys

**Global**

| Key | Action |
|-----|--------|
| `Tab` / `1-5` | Switch screens |
| `:` | Command palette |
| `l` | Login |
| `r` / `F5` | Refresh current screen |
| `?` | Help |
| `q` | Quit |
| `Esc` | Dismiss popup / cancel |

**Chat**

| Key | Action |
|-----|--------|
| `j` / `k` | Channels (Direct pinned on top, then categories) |
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

**Lore**

| Key | Action |
|-----|--------|
| `j` / `k` | Repos (left) / files (right) |
| `Space`, `h` / `l` | Cycle focus panes |
| `v` | Preview selected text file (≤64 KiB) |
| `r` | Refresh repo state |

## Commands (`:`)

```
:chat :users :server :logs :lore
:filter <text>     channel name filter
:ufilter <text>    user filter
:goto <name>       jump to channel
:login             open the login form
:fps <n>           UI FPS (0.2–60); e-ink 1–5
:poll <secs>       chat poll interval
:eink              2 fps + 8s poll preset
:lore new <name>   lore channel + repo in one step (admin)
:lore push <dir>   stage a local folder into the repo (1 commit)
:lore import <git> import a git repo/url (admin)
:lore health       lore addon status
:refresh :logout :help
```

## What the TUI shows honestly

- **E2EE rooms are not decrypted here.** This client holds no room keys.
  Messages in operator-blind rooms render as a placeholder, the chat header
  carries an `E2EE` mark, and the Detail pane shows the server's own privacy
  facts for the channel (retention label, `server-readable` vs
  `operator-blind E2EE`). Retention labels are labels — a short retention is
  not confidentiality.
- **Failed sends stay failed.** An optimistic message that the server
  rejects is tagged `[not sent]` until you resend; confirmed sends are
  reconciled against the server copy in place.
- **Surfaces the terminal can't host** (voice, stage, whiteboard, wiki,
  forum, gallery, planner, incident, reception) say so instead of rendering
  a fake empty stream. Lore channels deep-link into the repo browser.
- The Server screen renders the member-visible **privacy contract** from
  `GET /api/privacy` when the server provides it.

## Debug

Logs go to `$TMPDIR/wabi-tui.log` (not stderr).

```bash
RUST_LOG=debug ./target/release/wabi-tui
tail -f /tmp/wabi-tui.log
```

## Status

- Login + bearer auth, live Socket.IO feed with automatic poll fallback
- Channels grouped by category (`position`/`parentId`), Direct pinned on top
- Messages: send with optimistic echo + server reconciliation, typing
  indicator (in and out), unread counters
- Users directory; admin: stats, reset password, clear lockout
- Lore repo browser: create/push/import/preview
- Privacy contract display (server-wide + per channel)
- Not in the TUI (by design, for now): presence, history paging beyond the
  initial window, edit/delete/reactions/pins/threads, DM creation, and any
  E2EE cryptography
