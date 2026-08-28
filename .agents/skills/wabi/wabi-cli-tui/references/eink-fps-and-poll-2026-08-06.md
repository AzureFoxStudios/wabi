# TUI FPS + e-ink (2026-08-06)

## Why

Full redraw every ~50ms wastes power and ghosts on e-ink. Power users need a **set FPS**.

## Config (`~/.config/wabi/config.toml`)

```toml
fps = 20          # default snappy; e-ink try 1–5
poll_secs = 3     # active-channel message poll only
```

Env wins: `WABI_TUI_FPS`, `WABI_TUI_POLL_SECS`.

## In-app

- `:fps 2` — UI frame budget
- `:poll 8` — network poll seconds
- `:eink` — preset 2 fps + 8s poll (persists via `config.save()`)

## Main loop shape

```
loop {
  poll_bg();                    // try_recv → dirty = true
  if dirty || frame_due { draw; dirty = false; }
  poll(keys, remaining_budget); // keys mark dirty
}
```

`Config::frame_ms()` = clamp(1000/fps, 16..=5000).  
`Config::poll_ms()` drives chat auto-refresh (was hardcoded 3000).

## Do not

- Hardcode 50ms redraw forever.
- Slow key handling — only full paint is rate-limited.
- Poll every channel every tick — active channel only.
