OpenMoji Assets

OpenMoji PNG assets are generated and fetched at build time. The PNG set is not committed to Git.

Local fetch (PowerShell):
- `powershell -ExecutionPolicy Bypass -File scripts/fetch-openmoji.ps1`

Docker/Compose:
- `docker compose build` fetches OpenMoji for both backend and frontend images.
- Uses `OPENMOJI_VERSION` and optional `OPENMOJI_72_SHA256` from `.env`.

Output:
- PNG files: `frontend/static/openmoji/png/*.png` (generated)
- Manifest: `frontend/static/openmoji/manifest.json` (generated)

Notes:
- Files use uppercase Unicode codepoint names (for example `1F44D.png`).
- OpenMoji license: CC BY-SA 4.0. Keep attribution in product/legal docs.
