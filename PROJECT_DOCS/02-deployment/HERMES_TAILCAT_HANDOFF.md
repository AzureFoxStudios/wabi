# Hermes handoff — Tailcat private access (landed 2026-09-01)

**For:** Hermes (deployment side) — what changed, what to check before/after a deploy.
**Design + evidence:** `docs/plans/2026-09-01-tailcat-private-access.md` (read that first).
**Skill for future agents:** `.agents/skills/wabi-tailcat-access/`.

## What landed

- New workspace crate `core/addons/tailcat/backend` (`wabi-tailcat`) — unconditionally compiled,
  **runtime-gated** (like mesh). Disabled = no subprocess, no listener, zero footprint.
- `wabi-server`: `AppState.tailcat` manager; routes under `/api/addons/tailcat/*`
  (status / audit / enable{confirm:true} / disable / keys / connect); init in `main.rs`.
- Guest rate limiting is now pipe-aware (per-pipe-connection keys) — `auth.rs` `handle_guest`.
- Frontend: admin panel (Admin → Runtime → "Private access"), member card in Settings → Server,
  API client `frontend/src/lib/api/tailcat.ts`.
- Tauri: `src-tauri/src/tailcat.rs` commands (`tailcat_register_key`, `tailcat_connect`,
  `tailcat_disconnect`, `tailcat_status`) — expects `tailcat` on PATH (sidecar packaging is the
  follow-up).
- State on disk: `<data_dir>/tailcat/{settings.json, keys.json, audit.jsonl, addr.txt}` — include
  in backups; nothing touches postcard-encoded WabiDB records.

## Deploy checklist

1. `tailcat` binary **v0.4.0 or newer** present on the host (PATH or `WABI_TAILCAT_BINARY=...`).
   Pin consciously: upstream is v0.x with no API stability promises.
2. Default pipe port = server port + 1 (configurable via `settings.json` → `pipe_port`).
   Make sure it's free on loopback.
3. Feature is OFF unless an admin enables it — no behavior change for existing instances.
4. Post-deploy probe (admin token): `GET /api/addons/tailcat/status` → `{"enabled":false,...}`.

## Follow-ups (2026-09-02 — all landed except the physical spot-check)

- ✅ Tauri sidecar bundling: `scripts/fetch-tailcat-sidecar.sh` installs the pinned release into
  `src-tauri/binaries/tailcat-<triple>` (gitignored). **`cargo check`/`tauri build` in src-tauri
  now requires the sidecar present — run the fetch script once per build machine.**
- ✅ Webview traffic routing: `tailcat_connect` starts the SOCKS tunnel + a local HTTP/WS
  forwarder and returns `{socksPort, proxyPort}`; the app switches its server URL to
  `http://127.0.0.1:<proxyPort>` and back on disconnect.
- ✅ Discoverability: dismissible callout on the admin overview (shows only when the tailcat
  binary is present and the feature is off).
- ✅ Self-hosted DERP: `WABI_TAILCAT_DERPMAP_URL` env → listener `--derpmap-url`; guide at
  `DERP_SELF_HOST_GUIDE.md`.
- ⬜ Cross-NAT punch spot-check from a real second network — recipe in the plan doc; needs a
  physical phone-hotspot client.
