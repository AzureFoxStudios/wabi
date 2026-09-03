# Lore addon (optional large-asset version control)

Bridges Wabi to [Lore](https://github.com/EpicGames/lore) — Epic's binary-first version control —
for revisioned storage of large assets (video, CAD, 3D models, textures) and call recordings.

- **The external Lore CLI/server is NOT in this repo.** This crate shells out to a `lore` binary
  (default `lore://localhost:10000`) — treat Lore itself as an external dependency.
- Off by default: build `wabi-server` with `--features wabi-lore` (or `addons`), enable
  `[addons.lore]`, provide a working Lore CLI/server.
- Layout: `backend/` is the Rust crate (`wabi-lore`), `plugin.json` is the addon manifest.

**The complete guide — build, configuration, API, security, operations, code map — lives at
[`docs/addons/lore.md`](../../../docs/addons/lore.md).** This directory intentionally has no
separate doc; that one is canonical.
