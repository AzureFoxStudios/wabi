# Attaching and detaching add-ons (KISS reference)

Wabi add-ons are **compile-time attached** and, where a runtime switch exists,
**runtime-toggled**. There is no package installer: the server binary is
self-contained, and `GET /api/addons` is the single source of truth for what a
given server can actually do right now.

Settings → Add-ons shows exactly this: every add-on the server reports, whether
it is on, how it is attached (`build: --features …` / `always compiled`), and
which runtime switch applies.

## In-app switches (Settings → Add-ons)

Compiled-in add-ons can be turned on/off from the app by an owner/admin — no
compose edit, no rebuild:

| Add-on | Applies | Notes |
|---|---|---|
| Steam | immediately | Routes 404 while off |
| Tailcat | immediately | Uses its own manager (kill-switch semantics) |
| Lore | next restart | The Lore service attaches at startup (health check + rehydrate) |

The switch is persisted in `<data_dir>/addons.json`
(`{"switches": {"steam": true}}`) and resolved as
**env var → persisted switch → compiled default**, so an operator who sets
`WABI_STEAM_ENABLED=1` in compose keeps control.

API: `POST /api/addons/{id}/switch` with `{"enabled": true|false}` (owner/admin
session required). `GET /api/addons` reports `runtimeSwitch` per add-on so the
UI knows which rows are flippable, and `enabled` always reflects live state.

## Build-time attach / detach

```bash
# Lean core: no optional add-ons at all
cargo build --release -p wabi-server

# Curated bundle (webhooks + lore)
cargo build --release -p wabi-server --features addons

# One add-on at a time
cargo build --release -p wabi-server --features lore
cargo build --release -p wabi-server --features webhooks
cargo build --release -p wabi-server --features payments-rails

# Everything this tree can attach
cargo build --release -p wabi-server --features full
```

| Add-on | Cargo feature | Runtime switch | Notes |
|---|---|---|---|
| Lore | `lore` (alias of `wabi-lore`, in `addons`) | `WABI_LORE_ENABLED=1` (+ `WABI_LORE_MODE`, `WABI_LORE_SERVER_URL`, `WABI_LORE_BINARY_PATH`) | External Epic Games Lore CLI/service; the service is only registered after a successful health check, so `enabled` in the inventory means "reachable right now" |
| Webhooks | `webhooks` (alias of `wabi-webhooks`, in `addons`) | — | Latent: the service is unwired, so it reports `enabled: false` even when compiled |
| Payment rails | `payments` (alias of `payments-rails`) | — | Crypto / EU SEPA / US rails; frontend catalog is gated on the capability |
| Tailcat | always compiled | in-app: `POST /api/tailcat/enable` (owner, explicit confirm) | Disabled by default = no subprocess, no listener, zero footprint. Held to that by `addons_absent_contract.rs`, which fails if anything holds the pipe port while the switch is off |
| Steam | always compiled | `WABI_STEAM_ENABLED=1` (+ `STEAM_API_KEY`, `WABI_STEAM_PUBLIC_URL`) | Routes 404 while disabled |
| Server map | frontend bundle only | — | Client-side workspace, loaded from the static allowlist |
| Translator Assist | frontend bundle only | in-app toggle (client-side) | Local-first; no server proxy |

Detach = rebuild without the feature (build-time) and/or leave the runtime
switch off. Nothing in core requires an add-on to be present.

## Frontend (bundled) add-ons

Bundled frontend modules live behind a **static allowlist**
(`frontend/src/lib/addonInventory.ts`, `BUNDLED_FRONTEND_IDS`, plus the
`components/plugins/*.svelte` glob) and are never remote-imported. Detaching one
means removing it from the allowlist and rebuilding the frontend — there is no
runtime unload. Only **client-only** entries (name-styles, youtube-sync,
spotify-sync, translator-assist) belong in `BUNDLED_FRONTEND_IDS`: that set
short-circuits `hasAddonCapability()` to `true` without asking the server.
Backend-backed entries (steam, game-sync) must stay out of it and follow the
server inventory, so a server that does not compile or enable them shows none
of their UI (`addonAttachment.test.ts`).

Sheets and Present are the one frontend add-on pair that detaches at build
time: `WABI_WORKSPACE_ADDONS` (default: neither) resolves them to
`addonUnavailable.ts`, so an unpackaged tool contributes no bytes at all.

## Orphaned add-on material (not attached to any build)

| Path | State | Action needed |
|---|---|---|
| `core/addons/persistence-disk` | 408-line JSONL disk-persistence crate, no `plugin.json`, not a workspace member, not linked into `wabi-server` | Either wire it as an optional feature (per-channel disk persistence) or delete it — today it compiles nowhere |
| `core/addons/server-map` | Frontend workspace only. Its `backend/` holds a `wabi-server-map` crate that is **not** a workspace member and is linked nowhere, although `plugin.json` still declares it | Fix the manifest to match (`"backend": null`) or delete the crate. The workspace UI is imported directly by core panels and is the largest add-on in the bundle — see `DETACH_AUDIT.md` weld point B |
| `core/addons/mesh` | Legacy. The `wabi-mesh` crate is not a workspace member; `src/mesh.rs` and `src/api/mesh.rs` are not declared in any module tree, so none of it compiles. `WABI_MESH_ENABLED` is still parsed, and is read only when refusing a restore | Delete, do not revive. It is not a deployment option |

The retired `wabi-mesh` coordinator is detached from every build — no crate in
the workspace, no routes, no state, no inventory entry (a unit test in
`api/addons.rs` keeps it unadvertised) — though the source directory and two
orphan modules are still in the tree. Multi-node work goes through helper nodes
(`/api/nodes`), WabiDB replication, or `WABI_SERVER_ROLE=anchor`.

## Rules for new add-ons

1. Core must not statically import, auto-start, render, or advertise add-on code.
2. Prefer a cargo feature + a runtime env switch; report both in `GET /api/addons`.
3. Report **runtime truth** in `enabled` (can this process serve it right now?),
   and use `compiled` / `cargo_feature` / `runtime_env` to describe how it is
   attached.
4. `cargo check -p wabi-server` with no features must stay green: the lean core
   is the default.
5. A switched-off add-on starts nothing — no listener, no task, no subprocess —
   and answers a clear "not enabled on this server", never a 500 and never a
   hang. `core/crates/wabi-server/tests/addons_absent_contract.rs` enforces
   both on the default build.
6. `python3 scripts/check-default-build-addons.py` (CI, ~2 s) fails if an
   optional add-on crate becomes a normal dependency of `wabi-server`.

What each add-on costs, which ones are welded in, and what a prebuilt download
should contain: `docs/addons/DETACH_AUDIT.md` (measured 2026-11-13).
