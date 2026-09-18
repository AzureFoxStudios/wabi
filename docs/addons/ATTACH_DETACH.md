# Attaching and detaching add-ons (KISS reference)

Wabi add-ons are **compile-time attached** and, where a runtime switch exists,
**runtime-toggled**. There is no package installer: the server binary is
self-contained, and `GET /api/addons` is the single source of truth for what a
given server can actually do right now.

Settings → Add-ons shows exactly this: every add-on the server reports, whether
it is on, how it is attached (`build: --features …` / `always compiled`), and
which runtime switch applies.

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
| Tailcat | always compiled | in-app: `POST /api/tailcat/enable` (owner, explicit confirm) | Disabled by default = no subprocess, no listener, zero footprint |
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
runtime unload. Client-only entries (youtube-sync, spotify-sync,
translator-assist) are always reported as available; backend-backed entries
(steam) follow the server inventory.

## Rules for new add-ons

1. Core must not statically import, auto-start, render, or advertise add-on code.
2. Prefer a cargo feature + a runtime env switch; report both in `GET /api/addons`.
3. Report **runtime truth** in `enabled` (can this process serve it right now?),
   and use `compiled` / `cargo_feature` / `runtime_env` to describe how it is
   attached.
4. `cargo check -p wabi-server` with no features must stay green: the lean core
   is the default.
