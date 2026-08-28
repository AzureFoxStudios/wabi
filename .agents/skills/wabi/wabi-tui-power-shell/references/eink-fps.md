# E-ink FPS recipe

```toml
# ~/.config/wabi/config.toml
fps = 2
poll_secs = 8
```

```bash
WABI_TUI_FPS=2 WABI_TUI_POLL_SECS=8 ./target/release/wabi-tui
```

In-app: `:fps 2` · `:poll 8` · `:eink`

Loop shape:

```
poll_bg()  // sets dirty on results
if dirty || frame_due { draw; dirty=false }
event::poll(remaining_frame_budget)
```

Clamp fps 0.2–60; poll_secs 0.5–120.
