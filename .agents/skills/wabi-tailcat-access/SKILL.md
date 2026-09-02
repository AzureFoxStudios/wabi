---
name: wabi-tailcat-access
description: Wabi Tailcat private-access addon — architecture, ops semantics, and change rules for the token-dialed WireGuard transport (core/addons/tailcat). Use when working on private access, pipe ingress tagging, member keys, or the tailcat subprocess lifecycle.
---

# Wabi Tailcat private access

Family/friend instances reach a home-hosted wabi-server through tailcat's userspace WireGuard
pipes. Canonical design + spike/E2E evidence: `docs/plans/2026-09-01-tailcat-private-access.md`.
Ops handoff: `PROJECT_DOCS/02-deployment/HERMES_TAILCAT_HANDOFF.md`.

## Architecture (one paragraph)

`core/addons/tailcat/backend` (`wabi-tailcat`, unconditionally compiled like mesh, runtime-gated)
manages a `tailcat serve --json --allow=... <pipe_port>` subprocess plus a **loopback tagging
forwarder** on `pipe_port` (default `server_port + 1`) that proxies to the real server port and
injects `x-wabi-pipe-auth` (startup-generated secret) + `x-wabi-pipe-client` headers. State lives
in `<data_dir>/tailcat/{settings.json,keys.json,audit.jsonl}` — file-backed like
`admin_policies.json`, deliberately NOT wabidb-event-sourced (instance-local ops settings; avoids
postcard-record dual-decode risk). Members register per-device client pubkeys against their Wabi
account (`POST /api/addons/tailcat/keys`); the listener allow-lists them. Tauri commands
(`src-tauri/src/tailcat.rs`) do genkey/printpub/socks on the desktop side.

## Hard rules

1. **The pipe is transport, never auth.** Wabi auth always gates membership. No exceptions.
2. **Flags before positional args** when spawning tailcat (`serve --json --allow=... <port>`);
   the mock in the integration test enforces this — keep it enforced.
3. **Ingress tagging is the rate-limit contract**: `handle_guest` keys on
   `rate_limit_key()` (validated token → `pipe:<client addr>`, else peer IP). Any new per-IP
   policy must use the same helper or pipe members collapse into one 127.0.0.1 bucket.
4. **Change latency tiers are a contract**: keys/audience = instant; ports = subprocess bounce
   only; **nothing ever requires a wabi-server restart**. Decisions persist; listener
   auto-respawns on boot (`main.rs` → `state.tailcat.init()`).
5. **ON = cognitive friction** (`{"confirm":true}` required); **OFF = instant kill-switch**.
6. **Beyond-localhost service targets are a rejected direction** (tailcat's `exit-node` exists;
   we do not use it).
7. Clients dial the **pipe port** (`server.tailcat:<pipePort>` from `/connect`), not the public
   server port.

## Where things are

- Manager/subprocess/backoff/addr-capture: `core/addons/tailcat/backend/src/lib.rs`
- Forwarder (hyper, WS tunneling, token injection): `.../src/forwarder.rs`
- Persistence/audit: `.../src/store.rs`
- Routes: `core/crates/wabi-server/src/api/tailcat.rs` (admin-gated via `admin_auth`; members
  self-register keys; `/connect` returns address + pipePort for key holders)
- Rate-limit keying: `core/crates/wabi-server/src/api/auth.rs` (`handle_guest`)
- Frontend: `frontend/src/lib/api/tailcat.ts`, admin `TailcatPanel.svelte` (Runtime section),
  member `TailcatConnectionCard.svelte` (Settings → Server)
- Tests: `wabi-tailcat` unit (4), `wabi-server` integration
  `tests/tailcat_private_access_contract.rs` (3, hardened mock binary)

## Desktop client (Tauri) specifics

- Binary resolution: `WABI_TAILCAT_BINARY` env → bundled sidecar (`src-tauri/binaries/tailcat-<triple>`,
  fetched by `scripts/fetch-tailcat-sidecar.sh`, required for src-tauri builds) → PATH.
- `tailcat_connect {address, pipePort}` runs the SOCKS tunnel + local forwarder
  (`tailcat_proxy.rs`) and returns `{socksPort, proxyPort}`; the frontend switches the server URL
  to `http://127.0.0.1:<proxyPort>` via `setConfiguredServerUrl` (works because `tauri.localhost`
  is allowlisted in `serverUrl.ts`) and restores the prior URL on disconnect.
- Self-hosted DERP: set `WABI_TAILCAT_DERPMAP_URL` server-side (passed as `--derpmap-url`).

## Measured cross-NAT baseline (2026-09-02, ironin→Tim)

Relay floor ALWAYS works (~390 KB/s via DERP(tok), ~0.8s cold connect); direct punch happened
1/10 within the 10s `--until-direct` budget from a containerized-NAT client to a public-IP
server. Do not promise "always direct" — relay is the floor, derper self-hosting is the
reliability lever.

## Gotcha: reqwest + SOCKS

`tailcat_proxy.rs`'s reqwest client MUST keep default features ON (TLS). With
`default-features = false` (no `__tls`), reqwest's plain-HTTP connector path never sets
`enforce_http(false)` on its inner HttpConnector, so EVERY SOCKS proxy dial fails with
`invalid URL, scheme is not http` (reqwest 0.13.3, hyper-util enforce_http). TLS never actually
runs — the tailcat target is plain http — but the feature must be present for the connector to be
built correctly. Verified live in the 2026-09-02 client-path smoke.

## Changing this area

- Run: `cargo test -p wabi-tailcat -p wabi-server` and `cd frontend && bun run check`.
- Upstream tailcat is v0.x with **no API/CLI stability promises** — re-pin deliberately and
  re-run the real-binary E2E (reproduction commands in the plan doc) after any version bump.
- `WABI_TAILCAT_BINARY` env overrides the binary path (PATH default).
