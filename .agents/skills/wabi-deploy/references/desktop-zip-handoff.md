# Wabi Desktop Zip Handoff

Use this when the user asks to "send the updated project as a zip" or wants the current Wabi source copied to <host>/<staging-host> desktops, not deployed live.

## Source-of-truth check

Before zipping, verify the tree is the active refactor worktree rather than an old backup:

```bash
cd <wabi-root>
pwd
git rev-parse --show-toplevel
git branch --show-current
git log -1 --oneline
wc -l frontend/src/lib/components/Settings.svelte
python - <<'PY'
from pathlib import Path
p = Path('frontend/src/lib/components/settings')
files = sorted(x.name for x in p.glob('*SettingsTab.svelte')) if p.exists() else []
print(len(files), files)
PY
git status --short | head -80
```

Healthy refactor signal from the May 2026 Wabi tree: `Settings.svelte` is a small shell (~430 lines) and `frontend/src/lib/components/settings/` contains the extracted tab components.

## Create zip

```bash
SRC=<wabi-root>
BACKUP_DIR=<wabi-root>/backups
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/wabi-refactor-current-$STAMP.zip"
mkdir -p "$BACKUP_DIR"
cd /home/<user>
zip -r "$OUT" wabi \
  -x 'wabi/frontend/node_modules/*' \
     'wabi/node_modules/*' \
     'wabi/target/*' \
     'wabi/frontend/.svelte-kit/*' \
     'wabi/frontend/build/*' \
     'wabi/frontend/dist/*' \
     'wabi/.git/*' \
     'wabi/**/.git/*' \
     'wabi/**/node_modules/*' \
     'wabi/**/target/*' \
     'wabi/**/.svelte-kit/*' \
     'wabi/**/dist/*' \
     'wabi/**/build/*'
unzip -t "$OUT"
ls -lh "$OUT"
unzip -l "$OUT" 'wabi/frontend/src/lib/components/Settings.svelte' 'wabi/frontend/src/lib/components/settings/*SettingsTab.svelte'
```

## Copy to desktops

```bash
BASE=$(basename "$OUT")
ssh <user>@<host> 'mkdir -p ~/Desktop'
scp "$OUT" <user>@<host>:~/Desktop/
ssh <user>@<host> "ls -lh ~/Desktop/$BASE"

ssh <user>@<staging-host> 'mkdir -p ~/Desktop'
scp "$OUT" <user>@<staging-host>:~/Desktop/
ssh <user>@<staging-host> "ls -lh ~/Desktop/$BASE"
```

Tailscale SSH to <host> may print an approval URL. Surface the URL to the user, wait for approval, then retry.

## Verify transfer integrity

```bash
sha256sum "$OUT"
ssh <user>@<host> "sha256sum ~/Desktop/$BASE && ls -lh ~/Desktop/$BASE"
ssh <user>@<staging-host> "sha256sum ~/Desktop/$BASE && ls -lh ~/Desktop/$BASE"
```

Checksums must match local, <host>, and <staging-host>.

## Notes

- This is a handoff/archive operation, not a live deploy.
- Exclude generated/bulky directories; include source and uncommitted work.
- Ronin is the local machine. <staging-host> is the staging remote.
