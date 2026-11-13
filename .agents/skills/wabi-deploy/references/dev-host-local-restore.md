# <dev-host> Local Restore / Local Server Notes

Use when Ronin asks to restore/update <dev-host>'s `<wabi-root>` from Ronin so Wabi can be run locally on <dev-host> for frontend/design review.

## Safety Rules

- Treat any folder named `wabi from ronin` as protected active extraction/dead-code-removal work.
- Do not delete, overwrite, `git reset`, `git clean`, or `rsync --delete` into that protected folder without explicit confirmation.
- Before restoring `<wabi-root>`, create a full backup on <dev-host>:

```bash
ssh <user>@<dev-host> 'cp -a <wabi-root> <wabi-root>.pre-restore-$(date +%Y%m%d-%H%M%S)'
```

## Restore Shape

For authoritative restore from Ronin:

```bash
rsync -az --delete \
  --exclude='node_modules/' \
  --exclude='frontend/node_modules/' \
  --exclude='target/' \
  --exclude='frontend/.svelte-kit/' \
  --exclude='frontend/build/' \
  --exclude='data/' \
  --exclude='uploads/' \
  --exclude='logs/' \
  --exclude='*.log' \
  --exclude='.env' \
  <wabi-root>/ <user>@<dev-host>:<wabi-root>/
```

Use normal `rsync --delete` for cleanup. Do not route delete semantics through `parsyncfp`; its own help warns delete options do not work correctly because parallel rsyncs do not coordinate deletion.

## Verification

After sync:

```bash
ssh <user>@<dev-host> 'cd <wabi-root> && git status --short | wc -l && grep -n "__WABI_SW_VERSION__" frontend/vite.config.ts'
ssh <user>@<dev-host> 'cd <wabi-root> && PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH" command -v cargo && command -v bun'
```

Then start the local server/dev process only after verifying the repo state. If <dev-host> stops answering SSH/Tailscale mid-restore, diagnose reachability first (`tailscale ping`, then SSH with a short connect timeout) and report the restore as unverified until it responds.
