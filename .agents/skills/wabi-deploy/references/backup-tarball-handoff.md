# Wabi Backup Tarball Handoff (no deploy)

Use when the user asks to "back up wabi and send to Tim (or another host), don't deploy — just a backup." This captures the FULL working tree INCLUDING uncommitted changes, then ships a single tarball.

## Why not `git archive` / `git bundle`

`git archive` and `git bundle` only capture committed state. Ronin's tree routinely has hours of uncommitted API/wabidb/UI work in progress. A backup that drops that is worthless. Use `tar` of the working tree instead. (`git bundle` is the right tool ONLY if the user explicitly wants a git-history artifact.)

## Size reality check

The wabi tree is ~36G but that is almost entirely build artifacts:
- `target/` ≈ 29G (Rust debug+release)
- `src-tauri/target/` ≈ 6.8G
- `frontend/node_modules/` ≈ 258M, `frontend/build/` ≈ 28M

Real source + live `data/` (WabiDB state, ~600M including .git) is ~350–400M compressed. Exclude the build dirs.

## Build the local tarball

```bash
cd /var/home/Ronin/wabi
TS=$(date +%Y%m%d-%H%M%S)
OUT="/var/home/Ronin/backups/wabi-backup-${TS}.tar.gz"
tar --exclude='./target' \
    --exclude='./node_modules' \
    --exclude='./frontend/node_modules' \
    --exclude='./frontend/build' \
    --exclude='./src-tauri/target' \
    --exclude='./.svelte-kit' \
    -czf "$OUT" .
ls -lh "$OUT"
# Verify entry count + spot-check
tar -tzf "$OUT" | wc -l
tar -tzf "$OUT" | head
```

`.git` is NOT excluded above — keep it so the backup is restorable as a full checkout. If you want a source-only (no history) backup, add `--exclude='./.git'`.

Keep `data/` IN the tarball — it carries live WabiDB state (small) and is the point of a backup.

## Ship to Tim (Tailscale SSH)

scp to `tim@100.96.11.45`. This will hit the Tailscale web-auth checkpoint the FIRST time per session — see `references/tailscale-ssh-auth.md` for how to extract and surface the `login.tailscale.com/...` URL BEFORE reporting any failure.

```bash
# User must authorize the auth link first; then:
scp -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no \
  "$OUT" tim@100.96.11.45:/home/tim/
```

scp to a raw IP (100.x) triggers a client-side command-approval prompt even after SSH auth clears. The user must click **allow** on that prompt. If it comes back "BLOCKED", that is the consent guard, not a network failure — re-issue the SAME command once the user says they are watching / send it.

## Verify integrity (mandatory)

```bash
# local
sha256sum "$OUT"
# remote
ssh tim@100.96.11.45 "sha256sum /home/tim/$(basename $OUT)"
```

SHAs must match. Report both sizes and the SHA so the user can confirm.

## Notes
- This is archive/handoff only — no build, no restart, no deploy.
- Drop location: Tim's home `/home/tim/` unless the user names a path.
- The tarball stays in `/var/home/Ronin/backups/` too; ask whether to keep or remove the local copy.
