# Hermes: Updating Tim And Iyoku

A teaching-oriented walkthrough for pushing the current local Wabi tree out to the two remote hosts. If you just want the commands, read `TIM_IYOKU_UPDATE_RUNBOOK.md` instead — that doc is the canonical runbook. This one explains the *why* and the things that bite.

## The two hosts and what they're for

- **`tim@100.96.11.45`** — live rebuild target. After a sync, tim rebuilds its docker stack so the running services pick up the new code.
- **`Iyoku@100.104.166.42`** — synced staging machine. Receives the tree but does **not** rebuild docker by default. Used for ad-hoc testing of the native Rust binary (`target/release/wabi-server`).

Both hosts keep the project at `~/Desktop/Wabi/` (note the capital W). The local source-of-truth is `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/`.

## Preflight

```bash
ssh tim@100.96.11.45      'echo ok; ls -d ~/Desktop/Wabi'
ssh Iyoku@100.104.166.42  'echo ok; ls -d ~/Desktop/Wabi'
```

If either fails, fix SSH/Tailscale before going further — there is no recovery path from a half-applied sync.

## Sync the tree

From `/home/Ronin/Desktop/Wabi/dotronin-worktree/wabi/`:

```bash
rsync -az --delete \
  --exclude 'data/' \
  --exclude 'uploads/' \
  --exclude '.git' \
  --exclude 'target/' \
  --exclude 'node_modules' \
  --exclude 'spacetimedb/target' \
  ./ tim@100.96.11.45:~/Desktop/Wabi/

rsync -az --delete \
  --exclude 'data/' \
  --exclude 'uploads/' \
  --exclude '.git' \
  --exclude 'target/' \
  --exclude 'node_modules' \
  --exclude 'spacetimedb/target' \
  ./ Iyoku@100.104.166.42:~/Desktop/Wabi/
```

Why each exclude matters:

| Exclude | Why it must be excluded |
|---|---|
| `data/` | Holds live SpacetimeDB state and STDB CLI/server config. `--delete` without this wipes STDB identity and the owner JWT, leaving you with `TokenError(InvalidSignature)` and an un-republishable database. **Never remove this exclude.** |
| `uploads/` | Owned by the containerized backend's user; rsync fails with `Permission denied` if you try to overwrite. It's also user-generated content — you don't want your local copy to clobber the remote anyway. |
| `target/` | Multi-GB Rust build cache. Useless to ship; the remote rebuilds inside docker (tim) or uses a separately-copied binary (Iyoku). |
| `node_modules` | Recreated by the build. Shipping it is slow and platform-mismatched. |
| `spacetimedb/target` | Same as `target/`, for the STDB module's own build cache. |
| `.git` | History isn't needed on the remote and would balloon the sync. |

## Rebuild tim

```bash
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose up -d --build'
```

`docker compose` re-uses cached layers where it can; rebuilds the backend image when source under `backend/` changes. Expect 1–10 minutes depending on what moved.

## Verify

```bash
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose ps'
ssh tim@100.96.11.45 'curl -fsS http://127.0.0.1:8080/health'
ssh tim@100.96.11.45 'curl -I http://127.0.0.1:3000'

ssh Iyoku@100.104.166.42 'ls ~/Desktop/Wabi/PROJECT_DOCS/02-deployment/TIM_IYOKU_UPDATE_RUNBOOK.md && echo synced-ok'
```

A green `/health` on tim is the success signal. If it's red, jump to the gotchas below before doing anything else.

## Gotchas (real ones that have bitten us)

- **Shadow install (`/home/tim/Desktop/Wabi/` vs `/home/tim/wabi/`).** Both lowercase to the same docker compose project name `wabi`. If both directories exist, containers silently get bind-mounts from whichever was last `docker compose up`'d — keys drift, tokens go stale, everything dies with `InvalidSignature`. If `docker inspect <wabi-container>` shows a `wabi/` (lowercase) mount, somebody re-created the shadow. Delete it before debugging anything else.
- **STDB token / fingerprint mismatch.** After a republish, the publisher's JWT in `data/stdb-publisher-config/cli.toml` must be copied into `.env` as `WABI_STDB_AUTH_TOKEN`. Symptom: backend logs `TokenError(Error(InvalidSignature))` on `/state-plane/healthz`. Recovery steps are in `TIM_IYOKU_UPDATE_RUNBOOK.md` ("STDB Token/Fingerprint Gotcha").
- **Wiping STDB state.** If you `rm -rf data/spacetimedb/`, you **must** also wipe `data/stdb-publisher-config/`. They're a matched pair; orphaning one leaves an identity the counterpart can't authenticate, and republish returns `403 Forbidden ... not authorized`.
- **Iyoku does not rebuild docker.** The compose file is synced but no `up -d --build` runs. If you want updated behavior on Iyoku, you're either restarting an existing service manually or running the native `wabi-server` binary (Iyoku's intended use case).

## A note on the Rust / cargo install path

The cargo workspace at `core/crates/wabi-server/` builds a `wabi-server` binary that is the eventual replacement for the Node backend. It's not yet wired into the docker stack — `docker-compose.yml` builds the TypeScript backend (`WABI_RUNTIME` defaults to `node`). A `cargo install --path core/crates/wabi-server` path is feasible because the bin target is there, but it isn't documented and isn't part of the update flow today. Treat it as a TODO; don't try to run it from this guide.

## Rollback

If the rebuild on tim breaks the live stack:

```bash
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose down'
# fix the cause locally, resync, then:
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose up -d --build'
```

No data loss: `data/` is excluded from sync and from `down`.

## When in doubt

`TIM_IYOKU_UPDATE_RUNBOOK.md` is the canonical commands-only doc. If this guide and the runbook disagree, the runbook wins and this file is stale — please update it.
