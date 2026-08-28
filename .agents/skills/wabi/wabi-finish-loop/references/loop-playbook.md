# Finish-loop playbook (one page)

## Model
- Primary worker: `opencode/deepseek-v4-flash-free` (Ronin: "by far more reliable" than Laguna, 2026-08-02)
- Backup worker: `opencode/laguna-s-2.1-free` (what Ronin calls "Ling", maddening)
- NOT: `opencode/grok-4.5`, `opencode/grok-build-0.1` (Zen billing; SuperGrok OAuth ≠ Zen)
- Captain: Hermes SuperGrok — verify + deploy + finish stalls

## User cadence
Full loop / no per-chunk check-ins → chain cards silently; batch status.

## Dispatch
```text
/tmp/wabi-loop/card-<id>.md  # prompt
python subprocess: opencode run <prompt> -m opencode/deepseek-v4-flash-free -f <plan>
# on deepseek rate-limit: same with -m opencode/laguna-s-2.1-free
```

## Stall
Log bytes flat ≥5 min → kill exact PID → captain finish + write report.

**Silent-rate-limit signal:** worker prints only the opencode build banner (e.g.
`> build · deepseek-v4-flash-free`) and exits 0 with no model output. This is
distinct from a crash — the PID stays warm briefly then the process ends cleanly.
Detection: if `tee <logfile>` has ≤3 lines after 60s and no `→ Read`/`→ Edit`/`→`
shell activity, the model is not calling. Kill the python wrapper + all child
`opencode run` processes, then restart workers on an alternate model or switch
to Hermes captain for direct implementation.

## Worker harvest fixes
- `$: x: Type[] =` invalid → cast form
- ContextMenu: `open` + `on:close`
- Wire events the worker forgot

## Deploy
STATIC_BUILD=1 bun build → cargo release wabi-server → Tim binary + both locks + restart

## Channel types
See `channel-type-surfaces.md` (wiki path, projection barrier, no double header).

## Runtime diagnosis
Load `wabi-deploy-debug` (switchChannel, API SPA JSON 404, Caddy camera, tunnel http2, barrier).
