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
rsync -az --delete ./ tim@100.96.11.45:~/Desktop/Wabi/
rsync -az --delete ./ Iyoku@100.104.166.42:~/Desktop/Wabi/
```

This mirrors the current local worktree onto both hosts and removes files on the remote that no longer exist locally.

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
ssh Iyoku@100.104.166.42 'cd ~/Desktop/Wabi && test -f PROJECT_DOCS/CODEBASE_CLEANUP_STATUS.md && echo ok'
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
