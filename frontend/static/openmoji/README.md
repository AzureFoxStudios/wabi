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

Display names and artist credits in the committed `emojis.json` catalog come from
[OpenMoji 15.1.0 metadata](https://github.com/hfg-gmuend/openmoji/blob/15.1.0/data/openmoji.json),
by [OpenMoji contributors](https://openmoji.org/about/), under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Wabi adds these fields without changing emoji IDs, shortcodes, URLs or ordering.
Regenerate from `frontend/` with `node scripts/enrich-openmoji-catalog.mjs`;
add `--check` to verify without writing. The command verifies a pinned SHA-256,
never changes image assets, and fails if an existing ID has no matching metadata.
This is maintenance-time only; displaying/searching emoji needs no external call.
