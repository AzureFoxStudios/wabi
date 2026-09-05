---
name: wabi-deploy-debug
description: Wabi production deployment and runtime debugging. Covers the Rust wabi-server binary (rust_embed static frontend), the SvelteKit build-mode mismatch (adapter-static SPA vs adapter-node SSR and why the Rust server needs index.html), Cloudflare/caddy/cloudflared tunnel WebSockets, WabiDB data-dir locks, and the selfhostability check. Use when a Wabi deploy will not boot, the login page is blank or stuck on "Starting Wabi"/"Work Offline", socket.io WS fails through Cloudflare, wabi-server restart-loops with "engine already running", or the user asks whether Wabi is still selfhostable or hardwired to wabi.chat.
version: 1.0.3
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, deploy, debug, sveltekit, cloudflare, cloudflared, wabidb, rust-embed, spa]
    related_skills: [wabi-frontend-polish]
---

# Wabi Deploy & Runtime Debug

Class-level workflow for the recurring "the deployed Wabi will not boot / login is broken / socket will not connect / is this still selfhostable" task. This is the deploy + runtime layer, NOT visual polish (that is `wabi-frontend-polish`).

The deploy stack (Tim dev server, root@100.96.11.45): a single Rust `wabi-server` binary (binds `:3000`) built with `cargo build --release -p wabi-server`, served behind a **caddy** reverse proxy (`:8088`) and **cloudflared** tunnels (`wabi-cloudflared-named` etc.) that expose `wabi.chat`. The binary embeds the frontend via `rust_embed` (`StaticAssets` = `frontend/build`), so the release build MUST run `bun run build` (adapter-static, see below) BEFORE `cargo build --release`.

## Build mode is the #1 footgun

`frontend/svelte.config.js` selects the adapter:
- `STATIC_BUILD=1` → `@sveltejs/adapter-static` with `fallback: 'index.html'` → emits a top-level `index.html` + `_app/`. The Rust `serve_static` SPA-fallback needs this `index.html`. **This is what the Rust binary requires.**
- default (no env) → `@sveltejs/adapter-node` → emits `handler.js`/`server/`/`client/` but **NO top-level `index.html`**. The Rust `serve_static` cannot serve it (404 on every route). Only use this if you also run the SSR `handler.js` somewhere — the Rust binary does NOT.

So: **the deploy pipeline is `STATIC_BUILD=1 bun run build` then `cargo build --release -p wabi-server`.** adapter-node alone 404s.

## Addon feature flag is the #2 footgun

The Lore addon is **optional** in `Cargo.toml`:
```toml
[features]
default = []
addons = ["wabi-webhooks", "wabi-lore"]
```

Building with `cargo build --release -p wabi-server` (no `--features addons`) produces a binary with **zero Lore API routes** — `GET /api/addons/lore/health` returns `not_found`. The addon code compiles but the routes are never registered.

**Fix:** `cargo build --release -p wabi-server --features addons`

Without this flag, the LoreChannelShell will show "Lore service unavailable" even with a healthy Lore server running, because the API endpoints don't exist.

## Symptom → cause map

| Symptom | Likely cause | Fix |
|---|---|---|
| `localhost:3000` not responding, `localhost:3001` healthy | Server on wrong port; `serverUrl.ts` rewrites `:3000` → `:3001` | Fix all four rewrite paths in `serverUrl.ts` to return `:3000` instead of `:3001`; rebuild frontend; restart wabi-server; hard-refresh browser |
| Every route 404, `/health` 200 | adapter-node build (no `index.html`) embedded | rebuild with `STATIC_BUILD=1` |
| Page stuck on "Starting Wabi" / blank, no API calls | boot shell never hidden OR SPA boot crash (see below) | see SPA boot crash |
| Tab crashes / "can't establish connection to wss://wabi.chat/socket.io" | cloudflared strips WS Upgrade (esp. `quic` tunnels) | polling fallback + tunnel protocol (see WS section) |
| Public `https://wabi.chat` → Cloudflare 502 on ALL routes, but Tim origin healthy | **dead tunnel edge / stale QUIC connectors** — NOT origin, NOT locks | see "Dead tunnel edge" below + `references/cloudflared-ws-and-wabidb-lock.md` |
| wabi-server restart-loops "engine already running" | stale WabiDB lock (deeper path) | remove BOTH lock files (see Locks) |
| Login flash then bounce to login; `/api/user/me` → 401 `token revoked` | Permanent ban in `data/wabi-server/revocations.json` `users: [id]` (legacy `revoke_user`) | Clear `users: []`, restart wabi-server. See `references/login-bounce-token-revocation.md` |
| Logged in but messages vanish / can't create channels; console `Join as: null` after force-reset | Socket double-connect with empty username; createChannel ignored REST; **and/or** nav calls `joinChannel` only (never sets `currentChannel`) | `references/post-login-socket-and-channels.md`. Probe REST first. Nav must use `switchChannel` (no registry gate). |
| `e.subscribe is not a function` after valid login+socket+init | Shape A undefined re-export **or Shape B `$` on plain prop** (MessageList/MsgList/MsgContent pass `$store` into prop named `*Store`) — see `references/post-login-store-crash.md` for root-cause triage. Also: **CSP `script-src` missing `'unsafe-eval'`** blocks SvelteKit runtime eval → boot IIFE dies before boot shell hides → `subscribe` error. See `references/csp-unsafe-eval-and-beacon-block.md` |
| Public `https://wabi.chat` shows old JS chunks after binary swap | CF edge cache — verify local vs live chunk hash; purge CF cache. See `references/cf-stale-js-chunk-and-diagnostic-runtime.md` |
| Gallery channel gone after reload | No `ChannelKind::Gallery` — create stored as Text | Add Gallery=9 + mappings; recreate. `gallery-channel-kind-and-upload.md` |
| Theme/addons/places: JSON.parse unexpected character | SPA fallback returns **index.html 200** for missing `/api/*` | JSON-404 `/api/*` in `serve_static` + optional stubs. `references/api-spa-fallback-and-stubs.md` |
| Calling mic/camera blocked in browser | Caddy `Permissions-Policy: camera=(), microphone=()` | Allow `(self)` + display-capture; fix CSP media/connect. `references/caddy-calling-permissions.md` |
| Gallery/forum create 500 `created but not found in projection` | Adapter `run()` returns before projection barrier | `barrier().wait_for(commit_seq)` — see `wabi-finish-loop` `references/channel-type-surfaces.md` |
| Wiki 404 on `/api/channels/.../wiki/pages` | Wrong path; nest is `/api/wiki/{id}/pages` | Fix wikiStore base URL |
| Uploaded profile picture visible only to uploader; other accounts see blank | Upload path served with `default-src 'none'` CSP, or /uploads path unmounted / 404, or client merge race clearing the value | Probe `/uploads/<file>` on Tim and CF; confirm `Content-Type: image/...` and `x-content-type-options: nosniff`; if CF returns HTML/404, check uploads dir mount and `index.html` fallback. See `references/avatar-upload-cross-account.md` |
| New message overwrites previous in UI ("new eats old") | Message ids not unique end-to-end and/or client merge/key/dedupe collapse | UUID stamp before commit; preserve clientMessageId; soft channel-messages merge; keep `dedupeByIdKey`. See `references/message-identity-new-eats-old.md` |
| Deploy claimed live but console still loads old chunks / `dedupeByIdKey is not defined` after fix | Service Worker holding old shell; login CSS is **route chunk** `2.<hash>.css` not only layout `0.<hash>.css`; helper refactor deleted `dedupeByIdKey` still used by init | Prove Tim SHA = local; curl public + `2.*.css` for `login-auth-panel`; restore `dedupeByIdKey` if removed; user: unregister SW + Clear site data. See `references/cf-stale-js-chunk-and-diagnostic-runtime.md` + `references/message-identity-new-eats-old.md` |
| Deploy SHA matches, `/health` 200, but new routes/features silently absent (`/api/addons` lists only `mesh`, no `lore`) | **Shipped to the wrong binary path** — Tim compose bind-mounts `./target/release/wabi-server → /wabi-server`; a `~/Desktop/Wabi/wabi-server` file the container never reads can look like a successful ship | Verify the mount target (`docker inspect ... --format '{{range .Mounts}}...'`), ship to `~/Desktop/Wabi/target/release/wabi-server.new`, remove BOTH locks, restart. See `references/lore-addon-deploy-and-binary-path.md` |
| Verified deploy, then live SHA/mtime CHANGED on Tim | **Peer/concurrent session redeployed over you** from the shared tree (binary mtime jumps hours after your ship; served CSS hash differs from what you shipped but matches the NEW local build) | Not a failure — your code is in the newer build IF it is committed+pushed. Verify: `stat -c %y` + `sha256sum` on Tim vs local; `git log --oneline -3`; grep the served chunk for your feature marker (e.g. "Recognize as math"). Confirm the newer build still contains your work, then re-verify public path. Do NOT re-ship your older binary over the peer's newer one without checking what theirs contains (2026-08-08: peer redeployed 2h after my ship; their build included the whiteboard work — safe) |
| SHA matches local, /health 200, container restarted — but feature STILL absent / user sees old UI | **SHA is not proof of content.** Hash match only says the file you built is the file on disk; it says nothing about whether the RUNNING container read it (compose `up -d` after an in-place `mv` can keep serving the previously-read inode), whether a peer rebuild replaced both copies with a stale one, or whether the marker lives in a lazy-loaded chunk index.html never references | Prove content, not hash: (1) `docker rm -f wabi-server` + `up -d` (force recreate, not restart); (2) `docker inspect` → `State.StartedAt` must be AFTER the binary `stat -c %y`; (3) grep the RUNNING binary's strings for the feature marker — `strings <binary> | grep -c 'marker'`. SvelteKit lazy chunks are NOT in index.html hrefs; scan the binary strings instead (`strings ws | grep -oE 'chunks/[A-Za-z0-9_-]+\\\\.js'`). 2026-08-08: first "deploy" SHA-matched yet served bundle lacked the lore markers — forced recreate + string-grep proved the fix was actually live | 
| **LOCAL binary SHA changed between build and deploy check** — you shipped X, verified X on Tim, then an hour later the LOCAL `target/release/wabi-server` is a DIFFERENT hash (peer session rebuilt over the shared tree) | **Peer overwrites happen on BOTH ends.** The concurrent Hermes session rebuilds the local binary too, so "local SHA == Tim SHA" can be true for a build you never made. This is also why the user may still see old UI: the RUNNING container may have started 1s before the file swap landed, or the peer's rebuild embedded a different frontend | Always re-`sha256sum target/release/wabi-server` IMMEDIATELY before scp, and compare against `strings <binary> | grep -c '<feature marker>'` to confirm the CONTENT you intend is in the build you're shipping. After deploy: verify `StartedAt > binary mtime`, then curl the served lazy chunk that contains the marker (find its name via `strings <binary> | grep -oE 'chunks/[A-Za-z0-9_-]+\\\\.js'`, then `curl -s http://localhost:3001/_app/immutable/<chunk> | grep -c '<marker>'`). 2026-08-08: local binary silently changed `b58b72ba` → `924398ca` between my build and the "verify" step — the marker was still present (peer built from the same pushed commits), but the lesson is: re-check content at ship time, never trust an earlier SHA |
| MANY deploys over a day "change nothing"; multiple features (whiteboard/lore/planner/mobile) look stale or "mixed and matched" | **Not the SW.** Final audit (2026-08-08) proved `static/sw.js` is network-first, passes `/api/*`, never caches `_app/immutable/*` chunks — SW version bumps (v9→v10) change nothing served. Real causes: (a) CSS cascade fights — a legacy sheet imported LAST in `styles.css` overrides modern sheets at equal specificity (todo-list.css stomped kanban-board.css grid-vs-flex, `.add-btn`, `.header-right`, `.column-settings`); (b) single-shot capability gates caching `false`; (c) peer-session rebuilds over the shared tree making features look "mixed" | Diagnosis order (proved 2026-08-08): (1) Tim binary SHA == local → deploy correct; (2) container `StartedAt` after binary mtime → running new inode; (3) public CSS hash == `strings binary \| grep -oE '0\.[A-Za-z0-9_-]+\.css'` → serving correct; (4) then audit SOURCE, not cache: run `scripts/css-cascade-audit.py` (duplicate class defs across sheets, later import wins), grep `hasAddonCapability` for cached-`false` gates, check banner z-index vs toolbar. A SW-only bump does NOT change the CSS hash — verify ships via binary SHA + `StartedAt`, never CSS diff alone |
| **Tailscale SSH interactive approval on Tim** — `ssh -o BatchMode=yes tim@100.96.11.45` hangs or exits with `Tailscale SSH requires an additional check` + a `login.tailscale.com/a/<code>` link. Tim's tailnet requires one-time interactive approval for new SSH clients. The link must be approved in a browser before non-interactive SSH works. Retry the same SSH command after approval. Do NOT use `sirpaulham@` — tailnet policy blocks that user for SSH; `tim@` is the correct deploy user. Key auth works non-interactively once approved (BatchMode OK); `sshpass -p 'IyokuIyoku'` is the historical fallback if key auth fails temporarily. **2026-08-10 session:** BatchMode passed without interactive approval, so no approval link was required that day. |
| SW version confirmed current (v10) by user, but UI still looks stale / "ghost regression" | **Not a cache problem — hunt deterministic causes.** 2026-08-08: SW v10 live, SHA matched, container recreated, yet kanban still stacked + Code chip missing. Two real culprits: (a) **CSS cascade war** — legacy `todo-list.css` re-defined `.kanban-board { display:grid }` + `!important` grid media queries and imports AFTER `kanban-board.css` in `styles.css` → same specificity + later import = grid stomps flex at every width; (b) **capability gate cached `false`** — `hasAddonCapability('lore')` in `addonInventory.ts` cached its promise FOREVER, so one raced first fetch hid the Code chip for the whole session | Grep the served CSS for BOTH competing `.kanban-board { display:` definitions (`grep -rn ".kanban-board {" frontend/src/styles/`); in `hasAddonCapability`, only `true` may be sticky — evict a `false` result so the next call re-probes. See `wabi-planner-workspace` (cascade war) + `references/lore-capability-gate.md` |
| SHA + /health OK, user says "it doesn't update at all" | **NOT the service worker** (final audit 2026-08-08: `static/sw.js` is network-first for navigations, passes `/api/*`, and NEVER caches `_app/immutable/*` chunks — an SW version bump changes nothing served). Real culprits, in order: CSS duplicate-selector cascade (legacy sheet imported LAST wins — `.kanban-board` grid in `todo-list.css` stomped flex in `kanban-board-part1.css`), single-shot `hasAddonCapability` gates, z-index banners hidden under floating toolbars, stub handlers | 1) `stat -c %y` + `sha256sum` Tim binary vs local. 2) `curl` public `/` and grep CSS hash vs local `build/index.html`. 3) If hash matches and UI still wrong, run `scripts/css-cascade-audit.py`, check capability-gate re-probes, compare banner z-index vs toolbar z-index, grep `TODO` handlers. See `references/sw-truth-and-css-cascade.md` |
| Deploy verified (SHA match, health 200) but feature looks "half baked" / grid missing | **check-passing code can ship visually broken** — a feature wired into a dead code path, or near-invisible styling. 2026-08-08 whiteboard: `renderLayersWithBlend` was wired into an unused helper (`createRenderLoop` never imported — component has its own inline render loop) so blend modes silently did nothing; grid lines at 14% alpha were imperceptible on the dark surface | Don't trust `svelte-check`/`cargo check` alone for render-path changes. Grep which function the component ACTUALLY calls (`grep -rn "createRenderLoop" frontend/src/` — if only the helper defines it, it's dead). Verify the LIVE served chunk contains the feature marker AND the specific styling (e.g. `grep -o "12%,transparent"` on the served CSS for grid alpha). Ask the user to hard-refresh / clear site data, then confirm visually |
| `GET /api/addons/lore/health` → `{"addon":"lore","status":"disabled"}` | Lore addon compiled in but **runtime-disabled**: container missing `WABI_LORE_ENABLED=true` env, host `lore` CLI not bind-mounted, or `host.docker.internal` unreachable | Add `.env` vars + compose volume for `/usr/local/lorebin` + `extra_hosts` host-gateway. See `references/lore-addon-deploy-and-binary-path.md` |
| `/api/addons` lists only `mesh`, no `lore` entry at all | **Binary built without `--features addons`** — the `lore` addon is compiled out entirely, not just disabled | `cargo build -p wabi-server --release --features addons`, redeploy. Verify with `curl /api/addons | grep -c lore` → must be ≥1. This is distinct from `disabled` — there is no `lore` key in the JSON array when the feature flag is absent |
| `GET /api/media/turn-credentials` → 404 | coturn compose profile not enabled, OR route mismatch. Backend must serve credentials at `GET /api/media/turn-credentials` (matching frontend calls) with HMAC-secret-based time-limited credentials. The route must be registered in `api/media.rs` `media::routes()`, NOT in a separate `/media-turn` path. Fix: (1) ensure `turn-server/` build context exists (Dockerfile + template + entrypoint); (2) `docker compose --profile turn build coturn && docker compose --profile turn up -d coturn`; (3) verify `curl http://127.0.0.1:3001/api/media/turn-credentials -H "Authorization: Bearer <jwt>"` returns JSON. See `wabi-calling` → `references/turn-deploy.md` for envsubst pitfall and env var setup. |
| `GET /api/media/runtime` → 404 | Route registered in the wrong router module — frontend calls `/api/media/...` but the handler was added in `api/routes.rs` under `/media-turn`, not in `api/media.rs` under `/media` | Move the route/handler into `api/media.rs` `media::routes()`, remove the stale declaration from `api/routes.rs`, rebuild, redeploy. Verify: `curl http://127.0.0.1:3001/api/media/runtime` → 200 JSON. See `references/media-runtime-404-fix.md` |
| `cargo check` reports `cannot find value <fn> in this scope` after you moved a handler between modules | Stale build artifact still referencing the old symbol location | `cargo clean -p wabi-server && cargo check -p wabi-server --release --features addons` |
| Adding a route in `routes.rs` compiles but the frontend still 404s | Frontend path is `/api/media/...`; the actual router is `media::routes` mounted at `/api/media` in `routes.rs`. A separate `media_routes()` under `/media-turn` is invisible to `/api/media/*` calls | Always trace the frontend URL prefix through `create_api_router()` before adding routes. New `/api/media/*` handlers belong in `api/media.rs`, not `api/routes.rs` |
| Lore CLI fails inside container: `Permission denied (os error 13)` loading global config | Container-traversal fail: the host home dir (e.g. `/home/tim`) has no world-execute bit (`drwxr-x---`), so the container's mapped uid 1000 cannot traverse the bind-mounted path to reach `~/.config/lore/` — even though `lore` binary exists and is executable | `chmod o+rx /home/tim` on the host. Verify with `docker exec wabi-server /usr/local/lorebin/lore --version`. This is NOT a binary ownership issue (the binary is owned by `tim:tim` and readable); it's the PARENT directory that blocks traversal |
| `POST /repos/{channelId}` create returns 405; link works | Frontend/backend URL contract mismatch: backend defines `POST /repos` (channelId in JSON body) for create, and `POST /repos/{channel_id}/link` for link. Frontend that appends `/{channelId}` to the create URL hits 405 | Fix the frontend create URL to `/repos` and include `{ channelId, repoName }` in the request body. Verify with `curl -X POST http://host/api/addons/lore/repos -H 'Content-Type: application/json' -d '{"channelId":3,"repoName":"default"}'` → must return repo JSON, not 405 |
| Lore CLI fails inside container: `Permission denied (os error 13)` loading global config | Two causes: (1) host home dir lacks world-execute, so uid 1000 cannot traverse bind-mounted `/home/tim` to `~/.config/lore/`; (2) `HOME=/home/wabi` but `/home/wabi` does not exist in the image/container, so `mkdir -p /home/wabi/.config/lore` fails with EACCES before the CLI starts | **Preferred:** set `HOME=/var/wabi/lore` in the Lore backend spawn env (`Command::new(binary).env("HOME", "/var/wabi/lore")`) — `/var/wabi/lore` is already bind-mounted and writable, requires no host chmod or compose changes. **Legacy fallback:** `chmod o+rx /home/tim` on host. **Ephemeral fix:** `docker exec -u root ... mkdir -p /home/wabi/.config/lore && chown -R 1000:1000 /home/wabi`. Verify with `docker exec wabi-server /usr/local/lorebin/lore --version` |
| `docker compose up -d` after deploy → `Error: engine already running` restart loop | Stale WabiDB lock from prior unclean shutdown. There are **TWO** lock files; both must be removed. `data/wabi-server/.lock` alone is not enough | `docker rm -f wabi-server && find data -name '*.lock' -delete && docker compose up -d wabi-server`. Verify container becomes `healthy` within seconds |
| Tim `wabi-server` restart-loops ~1m with `🚀 Wabi Node ...` + `Error: engine already running`, public `wabi.chat` returns **Cloudflare 502** on `/api/public/backend-endpoints` and `socket.io` | Same stale WabiDB lock, but the visible symptom is **public 502** rather than localhost health. The backend is binding `:3000`, then dying on WabiDB init, then Docker restarts it. The frontend appears “stuck signed in” because login/WS/post-login fetches all 502 and never complete | On Tim: `cd ~/Desktop/Wabi && docker compose stop wabi-server && docker rm wabi-server && find data/wabi-server -name '*.lock' -delete && docker compose up -d wabi-server`. Verify with `curl -sS -o /dev/null -w '%{http_code}' https://wabi.chat/api/public/backend-endpoints` → `200`. See also `references/tim-restart-loop-and-login-ux.md` |
| After logout/re-login, the app looks signed in but never completes — guest still works | Backend 502 from restart-loop; registered login finishes the credential exchange, then post-login fetches/places/WS all 502 → never finishes boot. Guest bypasses some post-auth paths, so it appears to work | Fix the backend 502 first. For UX hardening: the login/boot shell should show an explicit “Cannot connect to server / cannot log in or switch users” state instead of silently retrying. Do **not** hard-cache users to bypass this — preserve the current disconnect semantics, just make the failure visible. See `references/tim-restart-loop-and-login-ux.md` |
| Login shows "Server unreachable" while /health 200 | ConnectionBadge maps idle `disconnected` (pre-auth) to unreachable | Hide badge when idle; only show after real connect/fail — not an origin outage |
| Whiteboard shows a red error bar "behind the UI" / unreadable / "invasive" | **z-index + lifetime bugs in WhiteboardTab/WhiteboardCanvas** (2026-08-08): (1) `.whiteboard-banner.error` sits at `top:4.2rem; z-index:17` while `.wb-toolbar` floats at `top:4.25rem; z-index:20` → the toolbar covers the error exactly; (2) socket `whiteboard:error` set `errorMessage` with NO auto-clear → a transient error (payload-too-large, sync conflict) lingers forever as a stuck red bar; (3) `boardSyncError` store messages ("Sync failed — reload the board", conflict re-sync notices) were SET but never RENDERED anywhere — only the `desktop-only`/`read-only` strings were consumed for gate UIs | Fixes: banner → `top:8.2rem; z-index:30`, flex + dismiss × button, drop shadow; import-error HUD z-10 → z-40 (was also under the toolbar), max-width + centered text; `showTransientError()` auto-clears after 6s (same pattern as the canvas import-error); surface the sync store via a derived `syncErrorToShow` that excludes the gate strings (`!includes('desktop-only') && !includes('read-only')`). Same audit for ANY overlay vs floating toolbar: check `position` + `top` + `z-index` of banner AND toolbar — same `top` + lower z-index = invisible error |
| Build fails: `Mixing old (on:click) and new syntaxes for event handling is not allowed` | **Svelte 5 runes migration trap** — once a .svelte file contains ANY new-syntax handler (`onclick`), every remaining old-syntax handler (`on:click`, `on:change`, …) in that file becomes a BUILD ERROR (vite-plugin-svelte compile), not just a lint warning. Editing one new-syntax handler into a legacy file breaks the whole build | When touching a legacy .svelte file, migrate ALL its `on:` handlers to the new syntax in the same pass: `grep -nE "on:(click|change|input|keydown|pointer)" <file>`. Prove you didn't ADD errors: `git show HEAD:<file> | grep -cE "on:(click|change)"` vs current count (2026-08-08: WhiteboardTab had 4 pre-existing, dropped to 3 after partial migration — the build only passed once ALL were converted). Also add `role="menuitem"`/`role="menu"` to custom context-menu divs with click handlers — a11y warnings are also build-blocking in vite-plugin-svelte |

## SPA boot crash (the big one) — ROOT CAUSE: terser minification

**Symptom:** `STATIC_BUILD=1` build deploys, but on load the tab either (a) sits forever on the "Starting Wabi" boot shell (boot shell never hides — `wabi:boot-hide` event never fires, no JS error), or (b) the renderer **crashes** (Playwright `page.on('crash')`, `document` empty, no catchable `pageerror`). Dev (`bun run dev`, SSR) and `bun run check` are clean. In a REAL browser it usually just sits stuck (the headless OOM is a Playwright artifact, not a true crash).

**ACTUAL ROOT CAUSE (found 2026-07-19):** `frontend/vite.config.ts` used `minify: 'terser'` with `terserOptions.compress.drop_console`. Terser's aggressive `compress`/`drop_console` pass **breaks Svelte's store runtime / circular re-export init order in the client bundle**, so a store used as `$store` is `undefined` → `n.subscribe is not a function` → uncaught → boot IIFE dies before `dismissDocumentBootShell()` hides the shell. This is a **BUILD/MINIFIER bug, not an app-code regression** — the pre-overnight anchor also "crashes" only in the flaky headless harness, and the app worked for the user on Jul-17.

**THE FIX:** `frontend/vite.config.ts` → `minify: !process.env.TAURI_DEBUG` (esbuild by default; `false` only under `TAURI_DEBUG`). Drop the `terserOptions: { compress: { drop_console } }` block — it is inert once terser is no longer the minifier and was the thing breaking the app. After the fix, `STATIC_BUILD=1 bun run build` produces a working SPA. Rebuild the Rust binary to embed it, redeploy.

## CORS / Frontend Port Detection Issue

**Symptom:** Frontend makes API calls to `http://100.x.x.x:3001` but server is on port 3000. Console shows:
```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at http://100.87.255.66:3001/api/public/frontend-app-metadata
```

**Root Cause:** `frontend/src/lib/serverUrl.ts` has a port rewrite bug:
```typescript
// 4. Direct container access: frontend on :3000, backend on :8080 on the same host.
if (port === '3000') {
    return { url: `${protocol}//${hostname}:3001`, source: 'docker_port_rewrite' };
}
```
When the embedded SPA is served on port 3000 (via rust_embed), the frontend incorrectly rewrites the backend URL to port 3001. This is backwards logic for the embedded-serve pattern where frontend and API share the same origin.

**Fix (confirmed 2026-07-28, Ronin's machine):**

`frontend/src/lib/serverUrl.ts` has four places that incorrectly rewrite port 3000 → 3001. All must be changed to `:3000` (same port, embedded-serve pattern):

1. **SSR default (line 141):** `http://localhost:3001` → `http://localhost:3000`
2. **env_override_dev_rewrite (line 177):** `:3001` → `:3000`
3. **env_override_dev_rewrite_invalid (line 181):** `:3001` → `:3000`
4. **dev_tauri (line 193):** `:3001` → `:3000`
5. **dev_vite (line 200):** `:3001` → `:3000`
6. **docker_port_rewrite (line 206):** `:3001` → `:3000`

After editing `serverUrl.ts`, rebuild frontend and restart wabi-server:
```bash
cd /home/Ronin/wabi/frontend && npm run build
cp -r .svelte-kit/output/* build/
pkill -f wabi-server; sleep 2
WABIDB_ROOT_KEY=... WABI_CORS_ORIGINS="..." ./target/release/wabi-server --port 3000 --host 0.0.0.0 --data-dir ./data &
```
Hard-refresh browser (Ctrl+Shift+R) to get the new JS bundle.

## CORS Headers Stripped by Cloudflare Tunnel

**Symptom:** After fixing the port rewrite issue, `localhost:3000` CORS works correctly with `Access-Control-Allow-Origin: https://wabi.chat`, but `wabi.chat` responses are missing this header. The API is accessible but browser CORS blocks the response.

**Root Cause:** Cloudflare's reverse proxy for named tunnels does not automatically pass through dynamic CORS headers. Even though wabi-server correctly sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, etc., Cloudflare strips them from the response.

**Fix - WABI_CORS_ORIGINS + Caddy header_up:**
1. Set `WABI_CORS_ORIGINS="https://wabi.chat,http://localhost:3000,http://localhost:5173"` when starting wabi-server
2. Update `Caddyfile.tunnel` to forward CORS headers:
```caddy
reverse_proxy wabi-server:3000 {
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-For {http.request.remote.host}
    # Pass through CORS headers
    header_up Access-Control-Allow-Origin {upstream_response.header.Access-Control-Allow-Origin}
    header_up Access-Control-Allow-Credentials {upstream_response.header.Access-Control-Allow-Credentials}
    header_up Access-Control-Allow-Methods {upstream_response.header.Access-Control-Allow-Methods}
    header_up Access-Control-Allow-Headers {upstream_response.header.Access-Control-Allow-Headers}
}
```
3. **IMPORTANT:** For named tunnels, the Caddyfile changes require either:
   - Reconfiguring via Cloudflare dashboard, OR
   - Using a quick tunnel (`cloudflared tunnel --url http://caddy-tunnel:8088`) which reads local Caddyfile

**Verification:**
```bash
# Test localhost CORS
curl -s -H "Origin: https://wabi.chat" -X OPTIONS http://localhost:3000/api/auth/login -D - | grep "access-control"

# Test wabi.chat CORS (should show access-control-allow-origin after fix)
curl -s -H "Origin: https://wabi.chat" -X OPTIONS https://wabi.chat/api/auth/login -D - | grep "access-control"
```

## Orphan STDB-era containers (noise, safe to remove)

After the WabiDB cutover, `docker compose up` on Tim warns `Found orphan containers (wabi-stdb-proxy, wabi-stdb-publisher, wabi-spacetimedb) for this project`. These are **stopped** STDB-era leftovers (Exited 0/137, weeks idle) — noise, NOT a cutover signal when `wabi-server` is healthy. Safe to remove with `docker rm` (containers only; does NOT touch `data/` or `uploads/`, and do NOT delete STDB-era `data/spacetimedb/**/db.lock` unless explicitly cleaning orphans):

```bash
ssh tim@100.96.11.45 'docker rm wabi-stdb-proxy wabi-stdb-publisher wabi-spacetimedb'
```

Verified 2026-08-05: after `docker rm`, Tim runs only wabi-server (healthy) + 3 cloudflared connectors + caddy-tunnel. Orphan removal is optional housekeeping; the compose warning can be left alone safely.

## WabiDB Locks (restart-loop trap)

`wabi-server` owns a data dir (e.g. `data/wabi-server/`). There are **TWO** lock files:
- `data/wabi-server/.lock` (top-level)
- `data/wabi-server/wabidb/.lock` (DEEPER — the engine lock)

A stale deeper lock causes `Error: engine already running` and the container restart-loops even after `docker stop` + `docker rm` + `up`. **The deploy script MUST remove BOTH**: `rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock`. If you only clear the top lock, the new container loops until the deeper lock is gone.

- **`json!` macro resolution in adapter code.** Files using `json!()` without `use serde_json;` (or `use serde_json::json`) fail with `cannot find macro json in this scope`. When adding new code that uses `json!`, either add `use serde_json::json;` at the top or use the fully qualified `serde_json::json!()`. Recipe: `grep -n 'json!(.*)' core/crates/wabi-server/src/adapter/mod.rs | grep -v use | grep -v serde_json`. When adding new code that uses `json!`, either add `use serde_json::json;` at the top or use the fully qualified `serde_json::json!()`. Recipe: `grep -n 'json!(.*)' core/crates/wabi-server/src/adapter/mod.rs | grep -v use | grep -v serde_json`.

- **`json!` macro resolution in adapter code.** Files that use `json!()` without `use serde_json;` (or `use serde_json::json`) fail with `cannot find macro json in this scope`. The `wabi-server/src/adapter/mod.rs` and `wiring_handlers.rs` both use `json!()` extensively but rely on re-exports. When adding new code that uses `json!`, either add `use serde_json::json;` at the top or use the fully qualified `serde_json::json!()`. Fix recipe: `grep -n 'json!(.*)' core/crates/wabi-server/src/adapter/mod.rs | grep -v use | grep -v serde_json` to find unqualified usages in files missing the import.

- **ChannelKind match exhaustiveness (E0004).** The `ChannelKind` enum (defined in wabidb) has variants `Text`, `Voice`, `Dm`, `GroupDm`, `Announcement`, `Whiteboard`, `Wiki`, `Forum`, `Incident`, `Gallery`, `Category`. Any `match` on `channel_kind` (in `channels.rs`, `adapter/mod.rs`, `socket-types.ts`, etc.) MUST cover all 11 variants or fail to compile. `gallery` (media) and `category` (channel grouping header) are the two that are most often missed. Check ALL match arms after adding a new channel type: `grep -rn "ChannelKind::" core/crates/wabi-server/src/ | grep -v "Gallery\|Category" | grep "match\|=>"`.

## Related references

- `references/port-mismatch-debug.md`
- `references/frontend-serverurl-port-rewrite.md`
- `references/cloudflared-ws-and-wabidb-lock.md`
- `references/post-login-store-crash.md`
- `references/cloudflare-cors-header-stripping.md`
- `references/wabi-cors-header-stripping.md` (NEW: Cloudflare CORS header forwarding setup)
- `references/csp-unsafe-eval-and-beacon-block.md` (NEW: CSP script-src missing 'unsafe-eval' blocks SvelteKit runtime eval)
- `references/avatar-upload-cross-account.md` — profile picture cross-account visibility, /uploads serving, client merge race
- `references/message-identity-new-eats-old.md` — UUID message ids, merge/key/dedupe, don't delete `dedupeByIdKey`, SW stale chunk proof
- `references/sw-truth-and-css-cascade.md` — (2026-08-08 audit) SW never caches chunks; "deploys don't change anything" = CSS cascade / capability gates / z-index / stubs, NOT caching
- `references/lore-runtime-and-create-repo-fix.md` — container-traversal permission fix (host home dir `o+rx`), create-repo URL contract (`POST /repos` vs `/repos/{id}/link`), feature-flag vs runtime-disabled distinction
- `references/tim-restart-loop-and-login-ux.md` — Tim restart-loop diagnosis, lock cleanup, and login/boot UX hardening when backend 502 causes "stuck signed in"
- `scripts/css-cascade-audit.py` — list every class defined in 2+ sheets and which @import wins; run first when UI looks stale despite verified deploy