# Tailcat Private Access — plan + Phase 1 spike results

**Date:** 2026-09-01
**Status:** SHIPPED — v1 + follow-ups landed (commit `69fb8d1`), deployed to Tim 2026-09-02 (binary sha `3f21da7f2a54e3d9`, verified healthy + public). Cross-NAT punch measured ironin→Tim (results below). Operator guide: `docs/features/PRIVATE_ACCESS_GUIDE.md`.
**Upstream:** [tailscale/tailcat](https://github.com/tailscale/tailcat) — pinned **v0.4.0** (tag `ce6fedc`, signed; note v0.3.0 release notes say "recommend updating for security reasons" — upstream is churning fast, 4 releases in 2 days; re-pin deliberately before any deploy)

## Goal

Family/friend instances reach a home-hosted wabi-server through Tailcat's
token-dialed WireGuard pipes — "networking without having to network."
Public/community instances are untouched. Full design rationale lives in the
approved plan (setup posture, per-member keys, event-sourced hot config,
cognitive-friction ON toggle, localhost-only services).

## Settled design decisions

1. **Informed default-on at private posture** — setup wizard asks "who is this
   server for?"; private → listener on + one legibility screen; public → off.
2. **Per-member keys, no shared tokens** — client keypairs, pubkey registered
   against the Wabi account, `--allow nodekey:…` pinning on the listener.
   Revocation drops only that member, live.
3. **Event-sourced hot config** (mesh env-var pattern explicitly rejected) —
   settings as domain events → projections → live push; every change audited
   and one-event reversible. In-memory projection maps only; no postcard
   record changes.
4. **Three-tier change latency** — instant (keys/audience/monitoring);
   listener-subprocess bounce (ports/services; wabi-server uptime never
   affected); full restart never required. Decisions persist; listener
   auto-respawns on boot.
5. **Toggle ceremony is cognitive** — ON = plain-language confirm, applies
   live; OFF = instant kill-switch.
6. **Transport-only** — pipe grants reachability, never membership; Wabi auth
   always gates.
7. **Service-entry schema** `{name, localhost target, audience}`; v1 exposes
   only wabi-server itself; **beyond-localhost targets are a rejected
   direction** (tailcat `serve exit-node` exists — we will not use it).

## Phase 1 spike — what was verified (2026-09-01, all PASS)

Setup: tailcat v0.4.0 static linux/amd64; wabi-server (release build) on
`127.0.0.1:3101` with isolated data dir; `tailcat serve 3101`; standalone
`tailcat socks --listen=127.0.0.1:1080 <addr>`; curl via `socks5h`.

| # | Check | Result |
|---|-------|--------|
| 1 | Address/token model | `tc…` blob captured via `TAILCAT_ADDR_FILE`; `--json` emits `{"listenAddr":…}` (machine-readable for the addon) |
| 2 | NAT traversal mechanics | `tailcat ping --until-direct`: first pong via DERP relay (region 304 Tokyo, 278 ms), then **direct path** (420 µs). Bootstrap→direct upgrade works. ⚠️ same-host test — real cross-network punch still worth one manual spot-check (phone hotspot) |
| 3 | HTTP through pipe | `/api/public/auth-policy` JSON ✓; SPA index 200 (23 KB, 9 ms) |
| 4 | Auth through pipe | guest create ✓ (JWT), register ✓, login ✓ |
| 5 | **127.0.0.1 collapse — CONFIRMED** | `tailcat serve` proxies to `localhost:<same port>`; all pipe clients appear as `127.0.0.1`. Guest creations 1–5 succeeded, #6 → 403 "Guest creation rate limit exceeded" (5/hour/IP). A 6-member family would exhaust the cap on evening one. **Phase 2 must tag pipe ingress** (see below) |
| 6 | Socket.io through pipe | engine.io polling handshake ✓ (sid issued, websocket upgrade offered); **websocket upgrade ✓** (`HTTP/1.1 101 Switching Protocols` with valid `sec-websocket-accept`) |
| 7 | wabidb-relay call transport | Code-verified: `callingWabidb.ts` rides the **main socket.io session** (`socket.emit('join-wabidb-call')`; comment in file: "socket.io, bypassing CGNAT without STUN/TURN"). Covered by #6. p2p WebRTC media is *not* expected to traverse SOCKS — the transport fallback chain handles this |
| 8 | Upload through pipe | 2.1 MB PNG multipart → `POST /api/upload-background-image` → 200 + stored URL (0.04 s direct path) |

### Ingress-tagging design constraint discovered

`tailcat serve <port>` forwards to **the same port on localhost** — there is no
distinct local port to distinguish pipe traffic from loopback traffic. Phase 2
options: (a) tiny local forwarder inserted between tailcat and wabi-server that
adds a `X-Wabi-Pipe: 1` header (then `ConnectInfo`-keyed policies need the
header factored into the rate-limit key), or (b) bind a second internal
wabi-server listener. Prefer (a): smaller blast radius, one code path.

### Spike caveats

- All tests ran on one host (direct path is degenerate — real WAN numbers TBD;
  DERP relay throughput when punch fails is the number to watch, and public
  DERP is rate-limited upstream).
- DERP auto-selected Tokyo (region 304) — region selection is upstream's;
  self-hosted `derper` remains the documented answer for reliability.
- Rate-limit keying on `ConnectInfo` is a *server-wide* pattern; the tagging
  fix must not break the existing per-IP limits for public instances.

## Phase 2 — v1 build (next)

Per approved plan: addon crate `core/addons/tailcat/backend` (Lore external-
binary pattern, runtime-gated), event-sourced settings + projections, admin
routes `/addons/tailcat/*`, ingress tagging, setup-wizard posture preset,
Tauri connection profile + per-member keys, docs (`docs/NETWORKING.md`,
`docs-history branch: 02-deployment`, derper guidance), integration + unit tests.

Explicitly out of scope: browser/WASM, CallTransportAdapter, mesh, Headscale,
beyond-localhost services, public-path integration.

## Phase 2 build record (2026-09-01, same day)

**Status: v1 LANDED and E2E-verified with the real tailcat v0.4.0 binary.**

### What shipped

| Piece | Where |
|---|---|
| Addon crate (manager, subprocess lifecycle, crash-loop backoff, addr capture) | `core/addons/tailcat/backend/src/lib.rs` |
| Tagging forwarder (loopback hyper proxy, WS tunneling, unforgeable pipe-auth token) | `core/addons/tailcat/backend/src/forwarder.rs` |
| Persistence + audit (settings.json / keys.json / audit.jsonl, atomic writes) | `core/addons/tailcat/backend/src/store.rs` |
| Server wiring (AppState, main init, addons catalog, `/api/addons/tailcat/*`) | `core/crates/wabi-server/src/api/tailcat.rs`, `state.rs`, `main.rs`, `api/addons.rs` |
| Pipe-aware rate-limit keying (fixes the collapse) | `core/crates/wabi-server/src/api/auth.rs` `handle_guest` |
| Admin panel + member connection card + API client | `frontend/src/lib/components/admin/TailcatPanel.svelte`, `frontend/src/lib/components/settings/TailcatConnectionCard.svelte`, `frontend/src/lib/api/tailcat.ts` |
| Tauri client commands | `src-tauri/src/tailcat.rs` |

### Deliberate deviations from the plan wording (documented decisions)

1. **Settings are file+audit backed, not wabidb event-sourced.** The codebase's own sibling
   feature (auth policy → `admin_policies.json`) uses exactly this pattern for instance-local
   operational settings; event-sourcing them would add postcard-record/dual-decode risk
   (golden rule 5) for data that never replicates or replays. All required properties hold:
   hot-apply, persisted, append-only audit (who/what/when), one-step reversible.
2. **Admin panel instead of setup-wizard posture question.** The repo has no first-run wizard
   (setup = first account claims ownership). The informed-default/legibility contract ships as
   the admin panel's confirm dialog + status surface; a wizard callout is a follow-up.
3. **Tailcat binary via PATH / `WABI_TAILCAT_BINARY`** — Tauri sidecar bundling is the
   packaging follow-up (noted in the Hermes handoff).

### E2E results (real binary, fresh instance)

- Enable contract: no-confirm → 400; `{"confirm":true}` → listener up, address captured.
- Key registration: pubkey reaches the listener `--allow` list after a ~2s bounce; revocation
  removes it. Clients dial the **pipe port** (`server_port + 1`, now returned by `/connect`).
- HTTP + **websocket 101** through the full addon path (socks → tailcat → tagging forwarder →
  server): verified.
- **Collapse fix verified live:** 7/7 guest creations through the pipe succeed (spike baseline:
  5 then 403).
- Kill-switch: `running:false` immediately; listener process confirmed dead.

### Bugs the E2E caught that mocks missed (both now regression-guarded)

1. **Flag order**: tailcat rejects `--allow` *after* the port arg (parses it as a service name
   and exits). Manager now emits flags-first; the mock binary enforces the rule so the
   integration test fails on any regression.
2. **Forwarder path double-slash**: `http://host:port/` + `/api/...` → `//api/...` → 404s.
   Fixed; forwarder unit test now asserts path preservation.

### Test inventory

- `wabi-tailcat` unit: 4 (store round-trips, audit tail, forwarder header injection + path).
- `wabi-server` integration `tailcat_private_access_contract`: 3 (lifecycle+allow-list+audit+
  persistence with hardened mock; rate-limit keying incl. spoof rejection; HTTP admin gating +
  member connect).
- Full existing suites still green (147 server lib tests + all contract tests); `bun run check`
  0 errors.

### Follow-ups (2026-09-02 pass — all landed except the physical spot-check)

1. **Tauri sidecar bundling** — DONE. `externalBin: ["binaries/tailcat"]` in tauri.conf.json;
   `scripts/fetch-tailcat-sidecar.sh` installs the pinned release for the current target triple;
   resolution order env `WABI_TAILCAT_BINARY` → resource-dir sidecar → PATH. NOTE: `cargo
   check`/`tauri build` in src-tauri now requires the sidecar present (run the fetch script once
   per machine).
2. **Webview traffic routing** — DONE and SMOKE-VERIFIED (2026-09-02, live server):
   `src-tauri/src/tailcat_proxy.rs` local HTTP/WS forwarder dialing through the tailcat SOCKS
   tunnel (reqwest socks5h → `server.tailcat:<pipePort>`). `src-tauri/examples/proxy_smoke.rs`
   proves the chain end-to-end (auth-policy 200 + engine.io sid through reqwest → forwarder →
   socks → pipe → server). Gotcha found: reqwest with `default-features = false` breaks ALL
   SOCKS proxying (`enforce_http` never disabled on the TLS-less connector path) — keep default
   features on.
   `tailcat_connect` now takes `{address, pipePort}` and returns `{socksPort, proxyPort}`; the
   connection card switches the app's server URL to `http://127.0.0.1:<proxyPort>` via the
   existing `setConfiguredServerUrl` (survives the Tauri-webview localhost rules —
   `tauri.localhost` is allowlisted in serverUrl.ts) and restores the previous URL on
   disconnect. Websockets bridge via reqwest `Response::upgrade()`; socket.io degrades to
   polling on its own if an upgrade ever fails.
3. **Setup callout** — DONE. `TailcatCallout.svelte` on the admin overview suggests enabling
   when the feature is off AND the binary is present; dismissible, never re-nags.
4. **Self-hosted derper** — DONE. `WABI_TAILCAT_DERPMAP_URL` env → listener `--derpmap-url`
   flag (flag-order contract respected); guide at
   `docs/deployment/DERP_SELF_HOST_GUIDE.md`.
5. **Cross-NAT punch spot-check** — RECIPE BELOW; requires a physical second network, so it
   stays open until someone runs it.

### Cross-NAT punch results (2026-09-02, ironin → Tim — REAL second network)

Throwaway allow-listed listener on Tim (v0.4.0, port 13001, no production exposure); client =
ironin (containerized sandbox NAT — a harder-than-typical client).

| Measurement | Result |
|---|---|
| `ping --until-direct` ×10 | 1/10 upgraded to **direct** (Tim's public socket 27.130.21.128) within the 10s budget; 9/10 served via **DERP(tok) relay** |
| Single 60s-budget run | stayed relayed for all 58 pongs |
| Cold full connection (socks + HTTP GET) | ~0.8 s through relay |
| Throughput, RELAYED (10 MB, DERP(tok)) | **~390 KB/s (≈3.1 Mbps)** — chat-class traffic is fine; big uploads work but slowly |
| Data integrity through tunnel | HTTP 200, full 10 MB, no corruption |

Interpretation: the pipe ALWAYS works (relay fallback is the floor), and punching to a
public-IP server can be immediate — but this client's NAT mostly kept it relayed, which is the
expected hard-client behavior. A typical home laptop should punch more often. Conclusions:

1. The design's assumption holds — relay is a viable floor, direct is the bonus.
2. Operators who need relay throughput/reliability should self-host derper (guide exists).
3. The phone-hotspot/CGNAT spot-check (original recipe below) remains the one untested client
   profile — optional final confirmation, not a blocker.

### Cross-NAT punch spot-check recipe (needs a real second network)

1. Home host: run wabi-server with `WABI_TAILCAT_BINARY` set; admin enable; note the `tc…` code.
2. Second network (phone hotspot + laptop with the desktop build or just the tailcat CLI):
   `tailcat ping --until-direct <code>` — expect `via DERP(...)` first, then a direct `via
   <ip>:<port>` pong within a few seconds. Record how often it stays relayed across ~10 tries.
3. Full app check through the connection card (register key → connect → chat, live events,
   upload). If media calls fall back to relay, confirm chat/socket.io still flow.
4. If punch fails BOTH directions on your ISP pair, that's the case for a self-hosted derper
   (guide above) — not a Wabi bug.

## Reproduction (spike)

```bash
# server side
wabi-server --host 127.0.0.1 --port 3101 --data-dir <isolated-dir>
TAILCAT_ADDR_FILE=addr.txt tailcat serve --json 3101
# client side
tailcat socks --listen=127.0.0.1:1080 "$(cat addr.txt)"
curl --proxy socks5h://127.0.0.1:1080 http://server.tailcat:3101/api/public/auth-policy
tailcat ping --until-direct "$(cat addr.txt)"
```
