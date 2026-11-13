---
name: wabi-deploy-gates
description: "Use when verifying a release wabi-server binary before or after a swap: addon feature marker, health/readyz probes, admin 401 gate, lock-holder errors."
version: 1.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, deploy, verification, addons, wabidb]
    status: active-2026-08-26
---

# Wabi Deploy Gates

Deploy verification gates. Lock and recovery rules: `AGENTS.md` rule 9 and `docs/deployment/BACKUP_AND_RECOVERY.md`.

## Gate 1 — Addon marker on the exact artifact (MANDATORY)

A plain `cargo build --release -p wabi-server` **silently drops** the `addons`
feature (`addons = ["wabi-webhooks", "wabi-lore"]`, `default = []` in
`core/crates/wabi-server/Cargo.toml`). The build succeeds, SHA changes, all your
other string checks pass — and lore/webhooks routes are just gone from the
binary. Verified incident 2026-08-22: shipped a no-addons binary to <host>; every
pre-swap check was green because they tested wave-specific strings, not addon
strings.

Before ANY scp/swap:

```bash
strings target/release/wabi-server | grep -cF "Lore addon initialized"
# >= 1 required (fresh addon build shows ~3). 0 = plain build, STOP.
```

Never trust: the build command you ran, git history, or "it worked last time".
Check the marker on the artifact bytes you are about to ship.

**Compile-time vs runtime proof (verified 2026-08-26).** The strings gate proves
COMPILE-TIME inclusion only. After the swap,
`docker logs wabi-server | grep -cF "Lore addon initialized"` can legitimately
return **0** — the init banner is not emitted at the default log level (shipped
artifact had strings=3, post-swap logs=0, addon fully live). A zero log count is
NOT evidence of a failed addon build. Prove RUNTIME presence with the API:

```bash
curl -fsS http://127.0.0.1:8088/api/addons
# expect a lore entry: "cargoFeature":"wabi-lore", "enabled":true
```

## Gate 2 — Probe suite after swap (post-wave-3, 2026-08-21+)

Probe the host port compose maps (`${WABI_PORT_OUT:-3001}` in `docker-compose.yml`), or `127.0.0.1:8088` when the `tunnel` profile's Caddy is running.

```bash
BASE=http://127.0.0.1:3001
curl $BASE/health     # {"status":"ok",...}
curl $BASE/livez      # liveness (process up)
curl $BASE/readyz     # engine canary — proves WabiDB readable (503 if degraded)
curl $BASE/metrics    # Prometheus text; served without auth (app_router.rs), keep it off public ingress
# admin gate check — MUST be 401 unauthenticated:
curl -o /dev/null -w "%{http_code}" $BASE/api/admin/jobs/dead-lettered
```

A 200 on an admin endpoint without a token means the auth gate broke.

## Pitfall — `engine already running` (superseded lock guidance corrected)

Older text here (2026-08-22) described a PID-file lock that nothing removed and
told you to delete it. That predates the OS advisory-lock engine.

Do **not** delete `data/wabi-server/wabidb/.lock`. `AGENTS.md` rule 9: "Current WabiDB holds an OS lock on persistent `data/wabi-server/wabidb/.lock`; PID text is diagnostic and file presence does not mean a live writer. Never unlink that file to admit a writer. A root `data/wabi-server/.lock` is legacy and may be removed only after confirming every old process is stopped."

On `Error: engine already running`, find and stop the process that actually holds the lock (check every container and process on the host); do not unlink the file to force a start. See `docs/deployment/BACKUP_AND_RECOVERY.md`.

(The old "remove own lock on shutdown" card is superseded by the advisory-lock engine; existence alone is not liveness.)

## Pitfall — partial string verification gives false confidence

Checking only the strings for THIS wave's changes ("token reuse detected",
"/livez") proves those features shipped — nothing else. A binary swap can gain
your feature and silently LOSE another (see Gate 1). Keep a short standing
marker list covering every capability the host is supposed to have, and grep
all of them against the artifact before swap:

```bash
for m in "Lore addon initialized" "/livez" "token reuse detected"; do
  printf '%s: %s\n' "$m" "$(strings target/release/wabi-server | grep -cF "$m")"
done
```

