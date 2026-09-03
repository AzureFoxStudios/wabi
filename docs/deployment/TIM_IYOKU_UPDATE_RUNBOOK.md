# Tim And Iyoku Update Runbook

This runbook is the fastest reliable path for syncing the current Wabi tree to `tim` and `Iyoku`, and for rebuilding the live stack on `tim`.

## Hosts

- `tim@100.96.11.45`
- `Iyoku@100.104.166.42`

## Remote Path

Both machines use:

- `~/Desktop/Wabi`

## Quick Connect

```bash
ssh tim@100.96.11.45
ssh Iyoku@100.104.166.42
```

## Sync Current Tree

From the local machine:

```bash
cd /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi
rsync -az --delete --exclude 'data/' ./ tim@100.96.11.45:~/Desktop/Wabi/
rsync -az --delete --exclude 'data/' ./ Iyoku@100.104.166.42:~/Desktop/Wabi/
```

This mirrors the current local worktree onto both hosts and removes files on the remote that no longer exist locally, while preserving deployment data.

## Rebuild Live Stack On Tim

After syncing, rebuild and restart the live stack on `tim`:

```bash
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose up -d --build'
```

## Verify Tim

Check container state:

```bash
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && docker compose ps'
```

Check backend health:

```bash
ssh tim@100.96.11.45 'curl -fsS http://127.0.0.1:8080/health'
```

Check frontend response:

```bash
ssh tim@100.96.11.45 'curl -I http://127.0.0.1:3000'
```

## Verify Iyoku

Iyoku is currently a synced machine, not the live rebuilt host in this runbook. Verify the tree landed:

```bash
ssh Iyoku@100.104.166.42 'cd ~/Desktop/Wabi && test -f docs-history branch: CODEBASE_CLEANUP_STATUS.md && echo ok'
```

## Current Cleanup Reference

At the end of the cleanup campaign, the verified state was:

- `backend/src/server.ts`: `4703` lines
- backend tests pass
- backend build passes
- frontend check passes with `0 errors / 0 warnings`
- cleanup campaign complete

## Notes

- `tim` is the live rebuild target in this runbook.
- `Iyoku` receives the synced tree, but does not require a live rebuild unless explicitly requested.
- If the live stack on `tim` exposes startup regressions after a rebuild, fix locally first, resync, then rerun `docker compose up -d --build`.
- Do not delete or overwrite `data/` during code sync. It contains SpacetimeDB state, uploads, and local SpacetimeDB CLI/server config.

## STDB Token/Fingerprint Gotcha

The local SpacetimeDB token used by the backend must match the local SpacetimeDB server signing key.

Required persistent paths on `tim`:

```text
data/spacetimedb/
data/spacetimedb-config/
data/stdb-publisher-config/
```

`docker-compose.yml` should mount both:

```text
./data/spacetimedb:/var/lib/spacetimedb:z
./data/spacetimedb-config:/home/spacetime/.config/spacetime:z
```

If backend logs show `TokenError(Error(InvalidSignature))`:

1. Confirm `data/spacetimedb-config/` is mounted into the `spacetimedb` service.
2. Update the publisher CLI fingerprint without restarting SpacetimeDB:

```bash
docker compose run --rm --no-deps --entrypoint spacetime stdb-publisher server fingerprint --yes wabi-local
```

3. Regenerate a local server-issued token:

```bash
docker compose run --rm --no-deps --entrypoint spacetime stdb-publisher login --server-issued-login wabi-local --no-browser
```

4. Copy the new `spacetimedb_token` from `data/stdb-publisher-config/cli.toml` into `.env` as `WABI_STDB_AUTH_TOKEN`.
5. Restart backend:

```bash
docker compose up -d --force-recreate backend
```

This fixes runtime auth. It does not grant the regenerated identity ownership of an already-published database, so `stdb-publisher` may still be unable to republish until database ownership is explicitly recovered or the database is intentionally recreated.
