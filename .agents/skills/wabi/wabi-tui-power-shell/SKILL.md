---
name: wabi-tui-power-shell
description: "Use when extending Wabi Rust TUI FPS or admin screens."
version: 1.0.0
metadata:
  hermes:
    tags: [wabi, tui, cli, ratatui, eink]
    related_skills: [wabi-cli-tui, rust-tui-app]
---

# Wabi TUI power shell

Crate: `core/crates/wabi-tui`.

## Screens

| Key | Screen |
|-----|--------|
| 1 | Chat |
| 2 | Users (admin `p` reset password, `c` clear lockout) |
| 3 | Server (health, stats, switch URL, logout) |
| 4 | Logs |

## E-ink / FPS (load-bearing)

- Config: `fps`, `poll_secs` in `~/.config/wabi/config.toml`
- Env wins: `WABI_TUI_FPS`, `WABI_TUI_POLL_SECS`
- Commands: `:fps N`, `:poll N`, `:eink` (preset 2 fps + 8s poll)
- Main loop: `poll_bg` → paint only if `dirty` **or** frame budget due → event poll for remaining budget
- Do **not** hardcode 50ms full redraw forever
- Keys always wake; only full paint is rate-limited
- Chat poll = active channel only

## Build

```bash
cargo build -p wabi-tui --release
./target/release/wabi-tui
```

## Pitfalls

- Still poll-based (no WebSocket) as of 2026-08-06
- Global `l` = login; use Space for chat pane cycle
- Filtered list: `.get(i).map(|u| (*u).clone())`
- Never log to stderr on alternate screen — `$TMPDIR/wabi-tui.log`

## Overlap

Overlaps `wabi-cli-tui` (older umbrella). Prefer updating that skill when patch works; this captures FPS/e-ink + power-shell cleanly. Curator may consolidate.
