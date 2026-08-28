# Wabi TUI runtime debugging — PTY probe + known crash signatures (2026-08-23)

How to diagnose `wabi-tui` crashes/flaps when the user only reports "it shows
up then immediately goes away". The file log (`$TMPDIR/wabi-tui.log`) is often
EMPTY for panics — the panic prints to stderr AFTER TerminalGuard leaves the
alternate screen, so it's visible only if you run the binary yourself under a
PTY.

## The PTY probe (works; reuse verbatim)

`terminal(command="./wabi-tui")` fails with ENXIO ("No such device or address,
os error 6") because crossterm needs a real tty — that error is NOT a bug.
`script` is not installed on Bazzite. Use a Python pty fork instead:

```python
import pty, os, select, time, re
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid(); os.close(master)
    os.dup2(slave,0); os.dup2(slave,1); os.dup2(slave,2)
    import fcntl, termios
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.execv('/var/home/Ronin/wabi/target/release/wabi-tui', ['wabi-tui'])
os.close(slave)
out = b''; start = time.time()
while time.time()-start < 12:
    r,_,_ = select.select([master],[],[],0.5)
    if r:
        try: c = os.read(master, 65536)
        except OSError: break
        if not c: break
        out += c
done,status = os.waitpid(pid, os.WNOHANG)
print("EXITED", status) if done else print("ALIVE after 12s")
clean = re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]|\r', b'', out).decode('utf-8','replace')
for l in [l for l in clean.split('\n') if l.strip()][:30]: print(repr(l[:120]))
```

A panic shows up in the captured bytes as `thread 'main' panicked at ...`.

## Crash signature 1: "Cannot start a runtime from within a runtime"

Panic site: `rust_engineio-*/src/transports/websocket_secure.rs`.
Cause: rust_engineio sync transports call `tokio::runtime::block_on`
internally. Under `#[tokio::main]`, the main thread IS a tokio worker — any
connect/emit from app code on that thread nests runtimes and panics instantly.
Fix shipped in commit `a217c92`: connect() runs on a plain OS thread and ALL
outbound emits queue through a std mpsc command channel drained by an emitter
thread that owns the Client. Never call Client methods from the main loop.

## Flap signature: "live feed connected" repeating in the :logs screen

Client connects → server drops it milliseconds later → library auto-reconnects
(`reconnect_on_disconnect` defaults true) → forever. Diagnose with a standalone
probe binary using the same builder config plus `.on_any(...)` to see the
server's rejection reason (see `/tmp/wsprobe` pattern). Verified root cause on
2026-08-23: server emits `auth-failed {"reason":"token expired"}` — stale JWT
in `~/.config/wabi/config.toml`. Immediate user fix:
`sed -i '/^token =/d' ~/.config/wabi/config.toml`, relaunch, press `l`,
log in fresh (new token is saved on LoginOk). Proper fix TODO: handle
`auth-failed` event in live.rs → BgMsg::LiveAuthFailed → clear token +
AppMode::Login instead of flapping.

## Server logs are a dead end

wabi-server container stdout is flooded with "Error: engine already running"
and `[sio]` lines are not retrievable via `docker logs`. Don't burn time on
Tim's box for client-side socket issues; probe client-side instead.

## Bisect tip

To prove a crash predates a change: `git worktree add /tmp/tui-bisect <sha>`
+ build there. But remember the ENXIO caveat — a non-tty run failing does not
reproduce a user-reported crash.
