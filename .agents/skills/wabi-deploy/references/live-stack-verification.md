# Live Stack Verification — Tim / Iyoku / ironin

## Purpose

Before deploying, rebuilding, or assuming which backend is live on a remote machine, verify the actual runtime state. The repo on disk may describe a different architecture than what is currently running (e.g., checked-out code is Rust-only but Docker still runs the old Node backend).

## Quick Diagnostic

```bash
# 1. List running containers (if Docker available)
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# 2. List processes that match the project
grep -E 'wabi|docker|spacetimedb|caddy' | grep -v grep

# 3. Inspect compose config for volume mounts
# Shows if backend is a bind-mounted binary or a built container
docker compose -p wabi config 2>/dev/null | grep -A5 'volumes:' | head -30
docker compose -p wabi ps --all 2>/dev/null

# 4. Check binary on disk vs container
docker exec -it wabi-server file /wabi-server 2>/dev/null
# vs
ls -la target/release/wabi-server 2>/dev/null
```

## Interpreting Results

### Rust Binary Stack (target state)

```
NAME                     IMAGE                          STATUS
wabi-server              wabi-wabi-server               Up (healthy)
```
Host bind mount: `~/Desktop/Wabi/target/release/wabi-server` is embedded into the container as a read-only binary.

### Old Node Stack (historical state)

```
NAME                     IMAGE                          STATUS
wabi-backend             docker.io/library/node:22      Up (healthy)
wabi-frontend            docker.io/library/node:22      Up (healthy)
```

If these containers are present, the machine is still on the old Node stack. Do NOT use the Rust binary swap workflow.

## Decision Tree

```
Does "docker ps" show a container named "wabi-server"?
├── YES → Is it a bind mount from target/release/wabi-server?
│         ├── YES → Rust binary stack is live. Use swap workflow.
│         └── NO  → Inspect further; could be a different image name.
│
└── NO  → Does "docker ps" show "wabi-backend" or "wabi-frontend"?
          ├── YES → Old Node stack is live. Do not deploy Rust binary.
          └── NO  → Nothing is running. Safe to bring up new stack.
```

## Git Status Is Not Runtime Truth

The repo on disk may have:
- Deleted `backend/` directory (SQLite purge)
- Added `crates/wabi-server/`
- Massive uncommitted changes

None of this tells you what is **currently running**. Always verify `docker ps` or `ps aux` first.
