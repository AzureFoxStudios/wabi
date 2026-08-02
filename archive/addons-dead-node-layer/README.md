# Archived dead Node addon layer (A5, 2026-08-01)

Moved out of the live tree. Not part of the build.

Canonical addons live at `core/addons/*/plugin.json` (Rust) and are
exposed via `GET /api/addons`.

Contents:
- `packages/` — old `.wabip` / `.wabi-plugin` install packages
- `source/` — old Node/TS plugin source (never compiled into wabi-server)

Do not restore into `addons/` without a new design that uses the
canonical plugin schema and never remote-imports frontend code.
