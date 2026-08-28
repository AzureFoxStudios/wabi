# Tim binary swap (verified 2026-08-06 design-polish ship)

## Paths

- Tim project: `/home/tim/Desktop/Wabi` (not `/root/Desktop/Wabi`)
- SSH: `root@100.96.11.45` or `tailscale ssh root@tim-predator-g3-572`
- Bind-mount: `target/release/wabi-server` → container `/wabi-server`
- Host health: `:3001` (container internal `:3000`); tunnel caddy `:8088`

> **TRAP (2026-08-08):** the container ONLY reads `target/release/wabi-server`. A
> `~/Desktop/Wabi/wabi-server` file also exists and is NEVER mounted — shipping a `.new`
> binary there (or to `~/wabi-server.new` then moving it to the Desktop root) is a
> **silent no-op**: SHA matches, `/health` stays 200, container keeps the old binary, and
> new routes/features never appear. Verify the mount with
> `docker inspect $(docker ps -q -f name=wabi-server) --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{end}}'`
> and ship to `target/release/wabi-server.new`. Full detail + Lore addon env enablement:
> `references/lore-addon-deploy-and-binary-path.md`.

## Tailscale auth

Print **one** bare `https://login.tailscale.com/a/<hash>` then wait. Do not re-probe — each attempt mints a new URL.

## Stash concurrent WIP before STATIC_BUILD

`STATIC_BUILD=1 bun run build` embeds **on-disk** `frontend/src`. Concurrent session half-edits (theme/*, effects/*, MessageContent, …) will ship if present.

```bash
git stash push -m "other-session-wip-pre-deploy" -- <exact foreign paths>
# rebuild + ship …
git stash pop
```

## Build

```bash
cd /var/home/Ronin/wabi/frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build
# must see index.html + _app/immutable/assets/0.<hash>.css (adapter-static)
cd .. && cargo build --release -p wabi-server
LOCAL_SHA=$(sha256sum target/release/wabi-server | awk '{print $1}')
```

## Ship (split scp from compose-up)

Hermes may block a single shell that ends with `docker compose up -d` as a long-lived server. Always split:

```bash
scp target/release/wabi-server root@100.96.11.45:/home/tim/Desktop/Wabi/target/release/wabi-server.new

ssh root@100.96.11.45 'cd /home/tim/Desktop/Wabi && \
  test "$(sha256sum target/release/wabi-server.new | awk "{print \$1}")" = "'"$LOCAL_SHA"'" && \
  docker compose stop wabi-server && \
  rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock && \
  mv -f target/release/wabi-server.new target/release/wabi-server && \
  chmod +x target/release/wabi-server && \
  docker compose up -d wabi-server'
```

Both locks required. Deeper `wabidb/.lock` is the engine lock.

## Proof

1. Binary SHA matches local
2. `docker ps` wabi-server healthy
3. `curl :3001/health` and `:8088/health` ok
4. `curl :3001/` HTML 200 contains **new** `0.<hash>.css`
5. Same CSS hash on `https://wabi.chat/`

SHA without CSS hash change is incomplete ship proof.

**2026-08-10 session addition:** When peer/concurrent sessions rebuild the shared tree, both local and Tim binaries may silently change. SHA match proves *identity* but not *content*. To prove the content you intend is in the build you're shipping:

```bash
# Before scp — confirm the feature marker is in YOUR binary
strings target/release/wabi-server | grep -c 'wabidbDmSessionKey\|resolveWabidbSessionKey'

# After deploy — confirm the marker is in the RUNNING binary
ssh root@100.96.11.45 'strings ~/Desktop/Wabi/target/release/wabi-server | grep -c "wabidbDmSessionKey"'
```

This catches the case where the local binary changed between build and deploy check (peer session rebuilt) — the marker count tells you the wabidb relay code is compiled in, even if you can't compare against a pre-swap baseline. Also: TURN credentials endpoint returning 401 (without auth) is correct behavior, not an error — only 404 or 500 indicates a problem.

## Note on wabi-deploy skill

`wabi-deploy` may be user-owned (`hermes curator adopt wabi-deploy` before agents can patch it). Keep this recipe under `wabi-deploy-debug` when adopt is blocked.
