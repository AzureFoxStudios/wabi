# Ironin Local Restore / Local Server Notes

Use when Ronin asks to restore/update ironin's `~/Documents/wabi` from Ronin so Wabi can be run locally on ironin for frontend/design review.

## Safety Rules

- Treat any folder named `wabi from ronin` as protected active extraction/dead-code-removal work.
- Do not delete, overwrite, `git reset`, `git clean`, or `rsync --delete` into that protected folder without explicit confirmation.
- Before restoring `~/Documents/wabi`, create a full backup on ironin:

```bash
ssh ironin@100.80.172.12 'cp -a ~/Documents/wabi ~/Documents/wabi.pre-restore-$(date +%Y%m%d-%H%M%S)'
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
  /var/home/Ronin/wabi/ ironin@100.80.172.12:/home/ironin/Documents/wabi/
```

Use normal `rsync --delete` for cleanup. Do not route delete semantics through `parsyncfp`; its own help warns delete options do not work correctly because parallel rsyncs do not coordinate deletion.

## Verification

After sync:

```bash
ssh ironin@100.80.172.12 'cd ~/Documents/wabi && git status --short | wc -l && grep -n "__WABI_SW_VERSION__" frontend/vite.config.ts'
ssh ironin@100.80.172.12 'cd ~/Documents/wabi && PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH" command -v cargo && command -v bun'
```

Then start the local server/dev process only after verifying the repo state. If ironin stops answering SSH/Tailscale mid-restore, diagnose reachability first (`tailscale ping`, then SSH with a short connect timeout) and report the restore as unverified until it responds.
