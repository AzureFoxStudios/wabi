# Add-on detach audit

**Measured:** 2026-11-13, on `claude/addons-detach-audit` (merged from `main`).
**Question asked:** does Wabi's core work with every add-on absent or switched
off, and does each add-on detach cleanly?

This is an audit, not a plan. `docs/addons/ATTACH_DETACH.md` stays the
reference for *how* to attach and detach; `docs/PROJECT_STATUS.md` stays the
maturity boundary. Everything below was read on this branch and, where it says
"measured", run.

**Short answer:** the Rust core is genuinely detachable — a default build links
no optional add-on crate, and the core install journey passes on it. The welds
are in the two places nobody compiles away: the **frontend bundle**, where core
components statically import add-on code (the server map alone is 1.1 MiB of
the 7.3 MiB of JavaScript), and a handful of **always-compiled** backends that
ship in every binary with only a runtime switch.

---

## How this was measured

| Measurement | Command |
|---|---|
| Crates linked | `cargo tree --locked -p wabi-server -e normal` for each feature set |
| Binary size | `cargo build --locked --release -p wabi-server [--features full]` |
| Frontend bytes | `STATIC_BUILD=1 npm run build` with sourcemaps on, then each emitted chunk's size split across its source modules in proportion to their original size (`scripts/` is not where this lives; the method is written out at the end of this file) |
| Routes when off | `core/crates/wabi-server/tests/addons_absent_contract.rs` against the real default binary |
| UI when off | `frontend/scripts/addons-absent-browser-smoke.mjs`, headful Chromium against a disposable default-build Authority |

### The numbers

**Server binary** (release, x86-64 Linux):

| Build | Crates (unique name+version) | Binary | Stripped |
|---|---|---|---|
| default (`default = []`) | 396 | 112.6 MiB | 97.5 MiB |
| `--features full` | 413 (+17) | 116.6 MiB (+4.0) | 100.3 MiB (+2.8) |

Compiling every optional add-on in costs **+17 crates and +2.8 MiB stripped —
about 3%**. The add-on crates themselves are small; `wabi-lore` brings the only
real dependency weight (`cap-std`, `ignore`, and friends: 12 of the 17 crates).

**Frontend** (static build, esbuild-minified, `WABI_WORKSPACE_ADDONS` unset):

- all JavaScript: **7,517 KiB** over 298 chunks;
- what a first visit downloads: **1,579 KiB** over 87 chunks.

Bytes attributable to each add-on, and whether they are in that first download:

| Add-on | KiB | % of all JS | In the first load? |
|---|---|---|---|
| server-map (incl. `maplibre-gl`) | 1,100 | 14.6% | the map workspace module is |
| Lore | 151 | 2.0% | `api/lore.ts` is (45 KB of source) |
| payments | 92 | 1.2% | the three payment API clients are |
| bundled plugin components | 71 | 0.9% | no |
| game-sync | 42 | 0.6% | no |
| youtube-sync | 16 | 0.2% | no |
| translator-assist | 10 | 0.1% | no |
| add-on runtime (`addonInventory`, loader, registry) | 10 | 0.1% | `addonInventory` is |
| spotify-sync | 2 | <0.1% | no |
| steam | 1 | <0.1% | no |
| sheets / present | 0 | 0% | no — not packaged unless `WABI_WORKSPACE_ADDONS` says so |
| core and shared libraries | 6,016 | 80.0% | — |

Sheets and Present are the model the rest should follow: `vite.config.ts`
resolves them to `addonUnavailable.ts` unless `WABI_WORKSPACE_ADDONS` names
them, so they contribute **zero bytes** to a default build.

---

## Inventory

**Verdicts.** *Detachable* — leaving it out (or off) removes its code and its UI
and nothing in core notices. *Switchable but compiled in* — it ships in every
build; the switch is honest but the code, routes and bytes are there. *Welded* —
core breaks, misbehaves, or shows UI that cannot work without it.

| Add-on | Code lives in | Attached by | Off switch | What a default build carries with it off | Verdict |
|---|---|---|---|---|---|
| **Lore** | `core/addons/lore/backend` (crate `wabi-lore`); server `api/lore.rs`, `api/lore_auth.rs`, `lore.rs`; frontend `lib/components/lore/*`, `lib/api/lore.ts`, `lib/lore*` | compile feature `wabi-lore` (`lore`, in `addons`, in `full`) + frontend bundle | `WABI_LORE_ENABLED` → `addons.json` → off; applies on restart | **Server: nothing** — no crate, no routes, no tasks. **Durable: yes** — `ChannelKind::Lore = 11` and 7 projections (`lore_repos`, `lore_bindings`, `lore_promotes`, `lore_commits`, `lore_file_changes`, `lore_tokens`) exist in every build. **Frontend: 151 KiB**, incl. `api/lore.ts` in the first-load chunk; `lore_roles.rs` seeds `<data>/lore_roles.json` on every boot | **Switchable but compiled in** (frontend + durable schema; the Rust service itself is detachable) |
| **Webhooks** | `core/addons/webhooks/backend` (crate `wabi-webhooks`) | compile feature `wabi-webhooks` (in `addons`, `full`) | none — the inventory hard-codes `enabled: false` | The crate is **never referenced by server code**. Core's own webhook delivery (`bot_delivery.rs`) is unconditional and spawns per message; the `webhooks` durable record and projection exist regardless | **Detachable** (and inert even when attached) |
| **Payment rails** (crypto / EU / US) | `core/addons/payments-{crypto,eu,us}/backend` | compile feature `payments-rails` (in `full`) | none at runtime | `/api/payments` is **always** mounted; a rail that is not compiled answers 400 "not enabled in this build". PromptPay is core, not a rail. Payment projections and records (`PLNK`/`PINT`/`PPOL`/`PBLK`) exist in every build; **92 KiB** of frontend, with the three API clients in the first-load chunk | **Switchable but compiled in** (rails detach; the payments surface does not) |
| **Tailcat** | `core/addons/tailcat/backend` (crate `wabi-tailcat`); server `api/tailcat.rs` | **always compiled** (non-optional dependency) | in-app switch (`POST /api/addons/tailcat/{enable,disable,switch}`), persisted in `<data>/tailcat/settings.json` | Routes always mounted (admin-gated; `/connect` answers 200 `enabled:false`). Adds **no crates** — every dependency it has, core already had. **Was** binding `127.0.0.1:<port+1>` and spawning a `tailcat version` probe while off; **fixed in this PR** | **Switchable but compiled in** |
| **Steam** | server `api/steam.rs` (inside `wabi-server`); frontend `lib/games/*` | **always compiled** | `WABI_STEAM_ENABLED` → `addons.json` → off | Routes mounted; each answers 404 "Steam addon is disabled on this server", except `/capabilities` (200, `enabled:false` — how the UI learns to say so). `steam_cache` and an HTTPS client are built at boot; the `steam_join` socket emit is not switch-gated. Durable `GameProfileRecord.steam_id` exists regardless | **Switchable but compiled in** |
| **Game Sync** | server `socketio/game_ops.rs`; frontend `lib/game-sync/*` | **always compiled** | `WABI_GAME_SYNC_ENABLED` → `addons.json` → off | Socket handlers registered unconditionally; each answers `game:error` "Game Sync is disabled on this server". No durable records (in-memory only). 42 KiB of frontend, lazily loaded | **Switchable but compiled in** |
| **AI Worker Connections** (project-workers) | server `api/project_runs.rs`; frontend `ProjectConnections.svelte` | **always compiled** | `WABI_PROJECT_WORKERS_ENABLED` → `addons.json` → off | Routes mounted under `/api/projects`; worker routes answer 404 "The AI Worker Connections addon is disabled", `GET …/workers` answers 200 `enabled:false`. Durable `project_worker_updated_v1` → `project_workers` exists regardless. UI tab is gated on the inventory | **Switchable but compiled in** |
| **Sheets / Present** (office) | frontend `lib/workspaces/{sheets,present}`; server `api/workspace*.rs` | **frontend build flag** `WABI_WORKSPACE_ADDONS` (default: neither) + per-device switch + server capability | admin `PUT /api/workspace/capabilities` (stored in the WabiDB `settings` record), plus the build flag | **Zero frontend bytes** when not packaged. Server workspace routes are core and answer 403 "This optional workspace is disabled on the server; local work is retained". Workspace records/projection are shared with Documents, which is core | **Detachable** (frontend); the server side is core and stays |
| **Translator Assist** | frontend `lib/addons/translator*` | frontend bundle | in-app setting (local, off by default) | 10 KiB, runtime lazily loaded, no server code at all | **Detachable** |
| **youtube-sync / spotify-sync** | frontend `lib/components/plugins/*Embed.svelte` | frontend bundle | local display setting (Spotify); YouTube only in queue channels | 18 KiB, lazy. No server code | **Detachable** |
| **Server map** | `core/addons/server-map/` (frontend only — its `backend/` crate is **not** a workspace member), plus `lib/addons/server-map/*`, `lib/components/map/*` | frontend bundle, **statically imported by core panels** | none | **1,100 KiB — 14.6% of all JavaScript**, mostly `maplibre-gl`. The Map panel is a core built-in; `WorkspacePanelHost` imports it statically. `/api/places` is a core route | **Welded** (frontend) |
| **Runtime plugins** (`plugins/`) | docs, `plugins/README.md`, signing scripts | — | — | **There is no server implementation.** No plugin loader, no `/api/plugins` route, no plugin-mode flag anywhere in `wabi-server` or the frontend. The only trace is the archive verifier refusing to restore when a `plugins/` directory exists | **Not implemented** (docs overstate it) |
| **Mesh (legacy)** | `core/addons/mesh/` + `src/mesh.rs`, `src/api/mesh.rs` | **not compiled** — the crate is not a workspace member and neither module is declared | `WABI_MESH_ENABLED` is still parsed | Dead source in the tree. `config.mesh_enabled` is read in exactly one place: refusing a restore. `scripts/launch.sh` still emits `WABI_MESH_*`. A unit test already asserts it is never advertised | **Dead code** — not a deployment option, not revived here |
| **persistence-disk** | `core/addons/persistence-disk` | **not compiled** — not a workspace member, no `plugin.json`, referenced nowhere | — | Orphan, as `ATTACH_DETACH.md` already says | **Dead code** |

---

## Weld points

### Fixed in this PR (each with a test)

1. **Tailcat bound a port and spawned a process while switched off.**
   `TailcatManager::init()` ran `ensure_tasks()` unconditionally on every boot,
   binding `127.0.0.1:<server port + 1>` and spawning a monitor task on servers
   that had never touched the add-on — while both the code comment and
   `ATTACH_DETACH.md` said "disabled by default = no subprocess, no listener,
   zero footprint". Separately, the **unauthenticated** `GET /api/addons`
   reached `status()`, which spawns `tailcat version` once per process.
   *Fix:* `init()` starts nothing when the switch is off (`set_enabled` already
   calls `ensure_tasks` itself, so turning it on still works), and the
   inventory reads a new non-probing `is_enabled()`.
   *Tests:* a unit test in the tailcat crate asserts `init()` starts no tasks
   and binds no forwarder while the switch is off, and
   `addons_absent_contract.rs` checks the pipe port is free on the running
   binary. Both fail against the old `init()`.

2. **A build without Lore accepted a switch for Lore.** `SWITCHABLE_ADDONS` is
   compile-time-independent, so `POST /api/addons/lore/switch` on a default
   build persisted `{"switches":{"lore":true}}` — and `instance_checkpoint` and
   `instance_archive` read that switch as "Lore is in use" and **refuse to
   checkpoint or restore**. A core-only server could be talked into refusing
   its own backups for an add-on it does not contain.
   *Fix:* the switch endpoint answers 404 unless the id is in this binary's
   inventory. *Test:* the contract test flips a real add-on on and off, and
   checks that Lore is refused and nothing is persisted.

3. **Lore routes answered 500 when Lore was compiled in but switched off.**
   `lore_service()` returned `AppError::Internal("Lore addon not initialized")`,
   so a client got "Internal server error" — "this server is broken" rather
   than "this server does not run that". *Fix:* 404 with
   "The Lore add-on is not enabled on this server", matching what Steam already
   does. *Test:* a `#[cfg(feature = "wabi-lore")]` case in
   `addons_absent_contract.rs` that boots a Lore build with the switch off;
   CI's `features-full` job now runs that file.

4. **Settings → Add-ons could never switch anything.** `addonDetection.ts` has
   its own copy of the inventory mapper, and that copy dropped `runtimeSwitch`,
   `compiled`, `cargoFeature` and `runtimeEnv`. Every server add-on therefore
   rendered as locked, reading "Part of this server, fixed when the server was
   set up" — so the in-app off switch documented in `ATTACH_DETACH.md` was
   unreachable in the app. *Fix:* map the four fields.
   *Verified in a real browser:* the four switchable add-ons now render as
   switches set to off.

5. **`hasAddonCapability('steam')` and `('game-sync')` were hard-coded true.**
   Both sat in the frontend's bundled-allowlist short-circuit, so the check
   returned `true` without asking the server — on any server, including one
   that does not compile or enable them. `ATTACH_DETACH.md` says the opposite
   ("backend-backed entries (steam) follow the server inventory"). *Fix:* the
   allowlist now holds client-only add-ons only.
   *Test:* `addonAttachment.test.ts`.

6. **The "Project" companion panel was a Lore panel labelled core.** It is
   declared in `BUILTIN_WORKSPACE_PANELS` with `source: 'core'`, so every
   server offered it in "Add panels"; opening it called
   `GET /api/addons/lore/repos/<current channel>` for *any* channel, got 404 on
   a server without Lore, and sat there empty. *Fix:* MainLayout withdraws the
   panel when the inventory does not report Lore, and the panel itself checks
   before fetching and says "Project files come from the Lore add-on, which is
   not enabled on this server."
   *Test:* the browser smoke fails without the fix (the panel is in the list)
   and passes with it.

Also added, not a fix: `scripts/check-default-build-addons.py`, wired into
CI's `test` job. It reads `cargo tree` metadata only (about 2 seconds) and
fails if an optional add-on crate becomes a normal dependency of `wabi-server`,
if a feature stops attaching its crate, or if `--features full` stops being a
superset.

### Not fixed — larger, written down instead

Each of these is either a durable-format change (AGENTS.md golden rule 5), a
`ChannelKind` change, or a restructuring too big to ride along with an audit.

| # | Weld | Why it is not in this PR | Proposed approach |
|---|---|---|---|
| A | **`ChannelKind::Lore = 11` and seven Lore projections exist in every build**, including one that will never serve a Lore route | Golden rule 5: durable record types and `ChannelKind` variants may not move without a versioned dual-decode migration, and AGENTS.md requires the plan/engine docs to change in the same work | Leave the variant and the projections where they are — they are cheap and removing them would break replay of real stored state. Instead make the *behaviour* honest: refuse to **create** a Lore channel when the add-on is not compiled (the API already refuses; the frontend already disables the kind), and document in `STORAGE_FORMAT.md` that kind 11 is reserved whether or not the add-on ships. Only consider removal in a dedicated change with golden bytes captured first |
| B | **The server map is 1.1 MiB of the frontend bundle and is statically imported by core panels** (`WorkspacePanelHost`, `components/MapWorkspace.svelte`, `routes/detached`) | It is the single largest add-on cost, and unpicking it touches the panel host and two routes — a frontend restructuring, not a weld fix | Follow the Sheets/Present pattern exactly: a `WABI_WORKSPACE_ADDONS`-style build flag that resolves the map entry to an "unavailable" stub, plus `import()` at the panel host instead of a static import. Expect the first-load and total bundle to drop by roughly the 1.1 MiB above |
| C | **`api/lore.ts` and the three payment API clients are in the first-load chunk** because core components (`ChatHeader`, `ChannelSettingsModal`, `MessageList`, `Chat`) import them statically, even though each one checks a capability before calling | Converting a static import to `await import()` inside a guarded block is small per site, but there are a dozen sites and each changes component load order; it deserves its own change with its own browser acceptance | Move the call sites to dynamic `import()` inside the existing capability guards. The type-only imports can stay (they are erased). Measure before/after with the first-load chunk list in this document |
| D | **Core's webhook delivery (`bot_delivery.rs`) is unrelated to the webhooks add-on** and spawns a task per message, and the `webhooks` durable record and projection exist in every build, while the `wabi-webhooks` crate is referenced by nothing | Removing or renaming a durable record is golden rule 5 | Decide what the webhooks add-on *is*. Either wire `wabi-webhooks` to the delivery path and give it a runtime switch, or drop the crate and the inventory entry and rename the core path to what it is (bot delivery). Do not touch the `webhooks` projection either way |
| E | **Runtime plugins are documented but do not exist in the server.** `README.md`, `AGENTS.md`, `docs/ADDONS.md`, `docs/deployment/FRESH_INSTALL.md` and `plugins/README.md` all describe a plugin runtime with manifests, signing and permissions; `wabi-server` has no loader, no route and no flag | Documentation across five files, and the right answer is a product decision | Say plainly in `docs/ADDONS.md` and `PROJECT_STATUS.md` that the plugin package format and signing tools exist but no server runtime loads them yet. Keep the supply-chain tooling; stop describing an operator-facing feature that is not there |
| F | **`WABI_LORE_ENABLED` is parsed two different ways.** `main.rs` builds `config.lore.enabled` with `parse::<bool>()`, so the documented `WABI_LORE_ENABLED=1` reads as `false` there, while the switch resolver accepts `1`/`true`/`yes`/`on`. The boot gate uses the resolver, so the add-on behaves correctly; `config.lore.enabled` is only read when refusing a restore | A one-line change, but it changes when a restore is refused — a recovery path other sessions are working in | Make `config.lore.enabled` read the same resolver, with a test that `WABI_LORE_ENABLED=1` is true in both places |
| G | **Steam has pieces outside its switch**: the `steam_join` socket emit for `steam://run/<id>` links, and a `steam_cache` plus HTTPS client built at boot | Small, but it touches `api/messages.rs`, which this PR is asked to leave alone | Gate the `steam_join` emit on the same switch as the routes; build the cache and client lazily |
| H | **Settings → Add-ons lists several add-ons twice** — once from the server inventory and once from the bundled-frontend list (Steam, Game Sync, AI Worker Connections, Sheets, Present each appear in both sections, the second time as "Comes with this app … Off in this build") | Cosmetic, but confusing enough to mislead an operator about what is on | Show one row per add-on, with the server's state when the server knows about it, and the bundled fact as a detail line |
| I | **`core/addons/mesh/plugin.json` still declares crate `wabi-mesh`, and `core/addons/server-map/plugin.json` declares a `wabi-server-map` backend.** Neither crate is a workspace member; `ATTACH_DETACH.md` says the mesh coordinator was removed | Deleting add-on material is explicitly out of scope for this PR | Decide per directory: delete the orphan, or mark the manifest `"backend": null` so it matches reality. The mesh directory should be deleted, not revived |
| J | **Add-on switch checks run after request-body deserialization**, so a disabled add-on can answer "missing field X" instead of "not enabled" | Harmless (a 4xx either way, never a 500) | If it is ever worth it, move the switch check into an extractor or a per-route layer |

---

## What is tested now

| Test | Runs where | Asserts |
|---|---|---|
| `core/addons/tailcat/backend/src/lib.rs` (`init_starts_nothing_while_the_switch_is_off`) | `cargo test --workspace` — CI `test` | A disabled Tailcat starts no tasks and binds no forwarder |
| `core/crates/wabi-server/tests/addons_absent_contract.rs` | `cargo test --workspace` (default features) — CI `test`; the Lore half also in CI `features-full` | On the real default binary from an empty directory: the inventory lists only what is compiled and reports everything off; add-on routes answer a clear client error, never 500 and never a hang; a non-compiled add-on cannot be switched on and nothing is persisted; a compiled one can be switched both ways; Tailcat's pipe port is free; the core API still answers |
| `core/crates/wabi-server/tests/install_from_nothing_contract.rs` | same job — **already existed** | The whole core journey on the default build: owner, invite, second account, channel message, DM, stop, back up, restore, read back. **Confirmed, not duplicated**: this audit relies on it for "core still works", and it passes unchanged |
| `scripts/check-default-build-addons.py` | CI `test`, ~2 s | The default build links no optional add-on crate; each feature attaches its crates; `--features full` is a superset |
| `frontend/src/lib/components/settings/addonAttachment.test.ts` | `bun test --isolate src/lib` — CI `test` | Attachment facts survive into the Settings row; backend-backed add-ons follow the server inventory; client-only ones do not need a server |
| `frontend/scripts/addons-absent-browser-smoke.mjs` | CI `core-browser-smokes` → `authority` (which already builds the default binary) | Headful: no add-on panel is offered, the Lore channel kind is visibly unavailable and says why, Settings → Add-ons shows nothing on and exactly the switches the server says are switchable, nothing calls an add-on-only route, no page exceptions |
| `core/crates/wabi-server/src/api/addons.rs` unit tests | both jobs | Inventory truthfulness per feature set (these already existed) |

The reverse direction — `--features full` with everything on — is what CI's
`features-full` job already covers (`cargo check --features full`, plus the
Lore test files with `--features wabi-lore`). This PR adds one step to it:
the add-on contract compiled **with** Lore, which is the only way to exercise
the "switched off, not broken" path. Everything that job ran before still runs
unchanged. Note for whoever owns CI next: **no job runs the payments-rails
tests.** `tests/payments_rails_contract.rs` is `#![cfg(feature = "payments-rails")]`
and `features-full` only *checks* that feature, never tests it.

---

## Recommendation for prebuilt downloads

The owner decides; this is what the measurements support.

**1. Ship one binary, not two.** Compiling every optional add-on in costs
**+17 crates and +2.8 MiB stripped, about 3% of a 97.5 MiB binary**. That is
not a size argument for a separate lean download, and two binaries means two
things to test, two things to sign and a support question ("which one do I
have?") for exactly the audience VISION.md says must not need a manual.

**2. But do not ship `--features full` as the default download.** The argument
against it is not size, it is attack surface and honesty:

- `wabi-lore` brings 12 crates of filesystem-capability machinery
  (`cap-std`, `cap-primitives`, `ignore`, …) into a binary most communities
  will never point at a Lore service;
- the **webhooks** feature adds outbound-HTTP capability that nothing calls —
  the inventory itself reports it `enabled: false` with the comment "latent
  SSRF surface with no product value yet". Shipping it by default is strictly
  worse than not shipping it;
- the payment rails are off-by-compile with no runtime switch, so a default
  build genuinely cannot be talked into a payment rail.

**Recommended shape:**

| Download | Contents | Why |
|---|---|---|
| **wabi-server** (the download) | `--features lore,payments-rails` — i.e. `full` minus `webhooks` | The two features an operator might actually want without rebuilding, both runtime-switchable or compile-only-inert. Costs about +2.8 MiB over the lean core |
| **wabi-server-core** (optional second artifact, only if asked for) | `default` | For operators who want the smallest attack surface and never intend to run Lore or payments |
| **Frontend** | one build, `WABI_WORKSPACE_ADDONS` unset | Sheets and Present already cost zero bytes when not packaged; ship the office tools as a separate packaging choice, as today |

**3. Compiling an add-on in and switching it off by default is acceptable — on
two conditions**, both of which this PR had to repair before they were true:

- *off means off.* An add-on that is switched off must bind no port, spawn no
  process and start no task. Tailcat failed this until this PR; whatever is
  added next must be held to it by a test.
- *off is visible and reversible from the app.* The inventory must report the
  truth and the owner's switch must work. Settings → Add-ons could not switch
  anything at all until this PR.

**4. Move these from "always compiled" to a compile feature.** All three are
runtime-gated today, which is honest, but none of them is core and each ships
in every binary:

| Add-on | Why | Difficulty |
|---|---|---|
| **Steam** | `api/steam.rs` lives inside `wabi-server`, holds an outbound HTTPS client and talks to a third party. The durable `GameProfileRecord.steam_id` stays regardless (golden rule 5) — only the routes and client would move behind `--features steam` | Moderate: extract the module, keep `/api/games` core |
| **Game Sync** | experimental, in-memory, no durable state, no dependents — the cheapest one to make optional | Easy |
| **AI Worker Connections** | optional by its own description, default-off, and the riskiest surface of the three (it registers external worker computers) | Moderate: the worker routes are interleaved with core project runs in `api/project_runs.rs` and would need splitting |

**Tailcat should stay always compiled.** It adds no crates at all — every
dependency it has, core already had — and it is the thing an operator reaches
for *because* they cannot reach their server, which is exactly when "rebuild
with a feature flag" is the wrong answer.

**5. The biggest single win is not in the binary.** The server map is
**1.1 MiB — 14.6% — of all the JavaScript the frontend ships**, on every
server, including ones that never show a map. Be precise about what that
costs: `maplibre-gl` itself is in a lazy chunk, so a visitor who never opens
the map does not download it; what every visitor does carry is the map
workspace module in the first-load graph, the panel entry in the shell, and
1.1 MiB sitting in every release artifact and every Tauri bundle. Weld point B
above is less work than any of the Rust feature splits and removes more bytes
than all of them together.

---

## Appendix: how the frontend bytes were attributed

A sourcemapped static build was produced (`build.sourcemap` on, nothing else
changed; the change was reverted after measuring). For each emitted chunk, its
minified size was divided among its source modules in proportion to their
original byte size, then summed per add-on by source path. Shared chunks are
therefore split rather than double-counted, and the figures are estimates, not
exact extractions — the ranking is what matters. "In the first load" means the
chunk is reachable by static import from the app entry or the root route node,
which is what a visitor downloads before interacting.
