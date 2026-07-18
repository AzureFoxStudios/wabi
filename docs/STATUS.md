# Wabi (`~/wabi`) — Documentation Status

**Last audited:** 2026-07-18

## Current architecture (as of 2026-07)
- This repo (`/var/home/Ronin/wabi`) is a **standalone WabiDB** application: `wabi-server` (Axum + Socket.IO) with the embedded **`wabidb`** crate as its state engine.
- **SpacetimeDB / "STDB" has been fully removed** from this repo. See `docs/STDB_REMOVAL.md` (2026-07-11) for the timeline. Live source confirms: no STDB SDK/module/dependency. The only intentional remaining references are localized i18n mesh-config labels (`mesh_stdb_url`, "SpacetimeDB connection") in `frontend/src/lib/i18n/locales/*.json`, kept deliberately per STDB_REMOVAL.md.
- Frontend: SvelteKit app under `frontend/`. Token system in `frontend/src/styles/tokens.css`.

## Archived docs (2026-07-18)
The following were moved to `~/Desktop/archive-2026-07-18/` because they describe the **old `dotronin-worktree`** frontend (not this repo) or the pre-removal STDB world:

- `OPENCODE_CSS_FINISH.md`, `OPENCODE_CSS_FINAL.md` — explicitly say *"Focus on dotronin-worktree only. Do NOT touch wabi/Wabi."*
- `PROJECT_DOCS/CSS_REFACTOR_PROGRESS/` (entire dir, 2026-05-10/11 checkpoints)
- `PROJECT_DOCS/CSS_AUDIT_REWRITE_PLAN.md`, `PROJECT_DOCS/REORGANIZATION_PLAN.md` (Apr/May)
- Stray duplicate copies under `~/`, `~/Documents/wabi-business-roofing/`, `~/wabi.broken/`, `~/backups/`, `~/Desktop/wabi-from-ronin/`

## Docs that ARE still valid (kept in place)
- `docs/STDB_REMOVAL.md` — authoritative record of the STDB → Wabidb removal.
- `WABI_AUDIT_2026-07-17.md`, `DESIGN_AUDIT_2026-07-13.md`, `UI_PHASE_*.md`, `DEPLOYMENT_READY.md`, `INSTALL.md`, `docs/SECURITY-MODEL.md`, `docs/adapter-status.md` — recent (Jul), post-removal.
- The 2026-06-22 `BACKEND_AUDIT.md`, `BACKEND_FEATURE_INVENTORY_AUDIT.md`, `REVIEW_NOTES.md`, `wabi-project-documentation.md`, `CONFIG_IN_DB_DESIGN.md` — each opens with a **"Historical note… predates the STDB → Wabidb rip"** banner and points to `PROJECT_DOCS/01-architecture/ARCHITECTURE.md`. They are intentionally retained as historical context, not as current-state docs.

## Note on the "wabi" name collision
There is a *separate* SpacetimeDB-backed "wabi" project under `~/Documents/wabi-business-roofing/` (with `spacetimedb/wabi_state_bridge`, `stdb_bindings_out/`). That is a **different codebase** from this one. Conversations about "spacetimedb missing from package.json" / `stdb_bindings/` refer to *that* project, not `~/wabi`.
