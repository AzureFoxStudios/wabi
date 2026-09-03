# Post-OS Recovery Checklist

This is the practical recovery order for bringing Wabi back after an OS reinstall.

Current backup set on this machine:
- `E:\Wabi-backup-20260401-115553`

Current branch state at backup time:
- `main` matched `origin/main`
- `Shaplooba` matched `origin/Shaplooba`
- both pointed at commit `6c79f05f223589f5c2bd17e7871107f2b94c2493`

## 1. Decide What You Actually Want To Restore

If you are fine starting with a fresh beta database, restore:
- repo code
- dirty working tree changes
- env files and local config

You can skip restoring:
- old Spacetime local database state
- old build caches
- old temporary folders

For the current stage of Wabi, a fresh DB is usually the cleaner choice.

## 2. Restore The Repo

Preferred, if GitHub is reachable:

```powershell
cd C:\Users\Willp\Documents\GitHub
git clone https://github.com/AzureFoxStudios/wabi.git Wabi
cd Wabi
git checkout Shaplooba
```

If GitHub is unavailable, use the backup bundle:

```powershell
cd C:\Users\Willp\Documents\GitHub
git clone E:\Wabi-backup-20260401-115553\wabi-all-refs.bundle Wabi
cd Wabi
git branch -a
git checkout Shaplooba
```

If you want a clean baseline instead of the current branch work:

```powershell
git checkout main
```

## 3. Restore The Dirty Working Tree

The flash drive backup includes:
- `snapshot-files`
- `tracked-working-tree.patch`

Primary restore method:
- copy the contents of `E:\Wabi-backup-20260401-115553\snapshot-files\` over the repo root

Secondary fallback:

```powershell
git apply --reject --whitespace=nowarn E:\Wabi-backup-20260401-115553\tracked-working-tree.patch
```

Use `snapshot-files` first. The patch is only a fallback.

## 4. Restore Env Files And Local Config

These were copied into the backup root because they are ignored by Git:
- `local-env-root.env`
- `local-env-frontend.env`
- `local-env-backend.env`
- `local-wabi.config`
- `local-wabi-profile.txt`

Restore them like this:

```powershell
Copy-Item E:\Wabi-backup-20260401-115553\local-env-root.env .env -Force
Copy-Item E:\Wabi-backup-20260401-115553\local-env-frontend.env frontend\.env -Force
Copy-Item E:\Wabi-backup-20260401-115553\local-env-backend.env backend\.env -Force
Copy-Item E:\Wabi-backup-20260401-115553\local-wabi.config wabi.config -Force
Copy-Item E:\Wabi-backup-20260401-115553\local-wabi-profile.txt .wabi-profile -Force
```

If secrets changed during reinstall, edit the `.env` files before startup.

## 5. Reinstall Tooling

Minimum useful stack:
- Git
- Node.js
- Bun

Likely needed for your normal workflow:
- Docker Desktop
- Rust toolchain
- Visual Studio C++ build tools
- Tauri prerequisites

Only restore SpacetimeDB tooling if you still want to run the local Spacetime mode right away.

## 6. Reinstall Dependencies

At repo root:

```powershell
bun install
```

Backend:

```powershell
cd backend
bun install
cd ..
```

Frontend:

```powershell
cd frontend
bun install
cd ..
```

If Bun gives you trouble on Windows for a specific surface, `npm install` is the fallback because `package-lock.json` also exists in root, `frontend`, and `backend`.

## 7. Start Clean

For a normal fresh beta recovery, do not restore the old local Spacetime DB.

Let Wabi recreate fresh runtime state instead.

That means you can ignore these old local-only items:
- `spacetimedb/.local-data-test`
- `spacetimedb/.local-data`
- `tauri-app/src-tauri/target`
- `spacetimedb/wabi_state_bridge/target`
- `.tmp`

If you do want a fresh DB, just launch normally after restoring code and env files.

## 8. Optional Local-Only Extras

The flash drive also contains extra local-only archives:
- `local-only-uploads.zip`
- `local-only-fresh-reset-20260306-114957.zip`
- `local-only-tauri-app-source-no-target.zip`
- `local-only-wabi-pre-cloudflare-20260306-105719.zip`
- `local-only-wabi-pre-cloudflare-20260306-105924.zip`

These are optional. Restore them only if you know you need them.

## 9. First Verification Pass

Run these after restore:

```powershell
git status --short --branch
```

```powershell
cd frontend
cmd /c npm run check
cd ..
```

If you want a production-style bundle test:

```powershell
cd frontend
cmd /c "set NODE_OPTIONS=--max-old-space-size=4096&& npm run build"
cd ..
```

The larger heap helps this repo build more reliably on Windows.

## 10. What Not To Waste Time On

Do not spend effort restoring the old live beta database unless it contains something specific you cannot recreate.

At the current 3-person beta stage, the safer default is:
- restore code
- restore env/config
- start with a fresh DB
- recreate only the content you actually care about
