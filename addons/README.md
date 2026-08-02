# Add-ons (legacy top-level tree)

**Canonical addons live under `core/addons/*/plugin.json`** (Rust crates) and are
exposed by the server as `GET /api/addons` / `GET /api/addons/{id}`.

Schema: `docs/addons/plugin-schema.md`.

## What remains in this folder

Historical / experimental trees that are **not** the live Rust addon platform:

- `content/`, `media/`, `compliance/` — older layout sketches
- `payments-*` — reference / ported payment modules (server has its own payments API)

They are **not** loaded via runtime package install.

## Dead Node layer (A5 — archived)

Moved to `archive/addons-dead-node-layer/`:

- `packages/` — old `.wabip` / `.wabi-plugin` install packages
- `source/` — old Node/TS plugin sources

There is **no** `POST /api/plugins/install`, no copy-into-`plugins/` workflow, and
no remote frontend import. Frontend modules load only via static bundled
allowlists (`BUNDLED_ADDON_LOADERS` in `frontend/src/lib/addons/loader.ts`).

## Live path (do this)

1. Add or edit `core/addons/<id>/plugin.json` (canonical schema).
2. Wire the Rust crate under `core/addons/<id>/backend` and optional
   `wabi-server` Cargo feature.
3. List it from `GET /api/addons` (`core/crates/wabi-server/src/api/addons.rs`).
4. Gate UI with `hasAddonCapability('<id>')` from `$lib/addonInventory`.
