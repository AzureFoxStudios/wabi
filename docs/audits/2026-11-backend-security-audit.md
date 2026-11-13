# Wabi Backend Security Audit & Dependency Diet — 2026-11-03

**Plan v1 execution report** · Product: Wabi (AzureFoxStudios) · Repo: `~/wabi` ·
Branch: `arena/894edf78-wabi` (HEAD `9bb4c9318b7ac4813140034523d7661e8cd391c7`) ·
Author: Arena.ai Agent Mode · Status: **phases A/B/D/E delivered; Phase C delivered
with explicit unrun-test gaps. No deploy, no product-behaviour changes beyond two
focused hardening patches.**

Companion deliverables (read these together):

| Document | Phase | What it holds |
| --- | --- | --- |
| `2026-11-supply-chain-posture.md` | A | Actions pins, Bun/Node floors, install scripts, IOC sweep, Playwright, gate policy |
| `2026-11-CVE-register.md` | B | 82 adjudicated rows, required schema, not-reachable proofs |
| `2026-11-authorization-matrix.md` | C | 355 HTTP + 97 Socket.IO rows, `input → guard → resource` |
| `2026-11-dependency-diet.md` | D | accepted/rejected lists, before/after counts, Tier 1/2, test proof |
| `2026-11-hardening-backlog.md` / `.json` | E | top-10 severity-ordered backlog with owners + IFS, export-ready |
| `docs/audits/evidence/*` | all | raw logs: npm audit, bun test, svelte-check, vite build, gates, IOC spot-check, RustSec matcher |

---

## 0. Executive summary

- **Supply chain (A)**: 95 `uses:` lines pinned to full SHAs, 12 Bun / 18 Node
  floor assertions raised, 6 container images patched, 10 runtime fingerprint
  steps added, 6 lifecycle scripts allowlisted, 626 locked npm entries swept
  against 80 published worm IOCs with **0 hits**, Playwright **frozen at 1.62.1**
  after re-verification (the reported malware is a typosquat family). Node2Shell
  CVE-2026-111497 is remediated in the repo ahead of the 2026-11-10 KEV deadline.
- **CVEs (B)**: 82 register rows, none unadjudicated. Four reachable npm
  advisories fixed (critical `dompurify` XSS among them), `npm audit` 14 → 10
  vulns (critical 2→1, high 5→2). 43 RustSec matches over 7 lockfiles plus 7
  explicit "absent crate" rows; reachable Rust TLS/QUIC chains are documented as
  Tier 2 because no Rust toolchain was available to regenerate locks safely.
- **Code (C)**: 23 October/November backend commits reviewed against the final
  tree. Two focused hardening patches landed with regression tests: an IPv6
  transition-prefix SSRF bypass in `preview.rs` and unbounded in-memory game
  state / a missing runtime gate in `game_ops.rs`. **No actively exploitable
  full compromise was confirmed.** The generated authz matrix has 452 rows;
  112 `REVIEW` rows still need human adjudication (B-13).
- **Diet (D)**: **0 dependency removals.** The plan requires every removal to be
  proven by `bun test` + `cargo check/tests` + desktop `cargo build`; cargo is
  unavailable here, so removals and all major bumps are Tier 2 recommendations.
  Four patch-level npm bumps were applied and proven by the full frontend suite.
- **Gates (E)**: advisory-first CI with two immediate blockers (Bun < 1.4.4,
  new install scripts), a **baseline-aware blocking gate for new high/critical
  npm advisories**, SHA-pin validation, advisory `npm audit` and advisory
  `cargo-deny` 0.20.2. Top-10 backlog exported as JSON.

**Honest acceptance status:** documents are authored on the branch, not yet
reviewed/merged; CI has **not** run on this branch from GitHub (no CI execution in
the sandbox). `svelte-check` has 42 pre-existing errors in both baseline and
patched trees, so the existing `test` job is already red (B-14). Do not read
"CI green" from the local gate results.

---

## 1. Scope, method and branch reconciliation

**In scope:** Rust backend `core/` (12-crate workspace, `wabi-server` HTTP +
Socket.IO), Tauri shell `src-tauri/`, frontend build/dependency pipeline,
`Cargo.lock` / npm lockfile hygiene, CI supply-chain posture. **Light-touch:**
SvelteKit runtime headers, CSP, static-output hygiene. **Out:** self-hosted
GitLab, PHP (non-exposure note only), per-branch audits, deploying anything,
product behaviour changes beyond minimal hardening.

**Branch deviation (explicit).** Plan v1 requested
`audit/backend-security-20261103` cut from a clean fast-forwarded `main`. Arena
ties this session to `arena/894edf78-wabi` and requires all work, commits and
pushes to stay on it; creating or switching branches would detach the work from
the session. **All work therefore stays on `arena/894edf78-wabi`.** A one-shot
`git fetch --prune origin` sanity check produced no changes, consistent with the
owner's statement that `main` is fully up to date; no per-branch review was done.

**History caveat.** The checkout arrived shallow (`rev-list --count HEAD = 1`, a
single merge commit with `added 211394`). `git fetch --deepen=120 origin main`
restored 285 commits and revealed the real 23-commit October/November backend
history used in §3. Shallow output was not used for attribution.

**Method.** Final-tree review rather than per-diff review (the October merge waves
carry ~189–192k added lines). Static enumeration from source with committed
generators (`generate_authz_matrix.py`, `rustsec_report.py`,
`generate_cve_register.py`) so a reviewer can re-run and diff the inventory.
Dynamic proof via `npm audit`, Bun 1.4.4 test suite, `svelte-check`, `vite build`,
gate unit tests, tree-sitter Rust syntax parse, PyYAML workflow parse. No
adversarial request was sent to any remote server; no secret entered the repo.

---

## 2. Phase A / B / D / E — summary and cross-references

### 2.1 Phase A — supply-chain posture (`2026-11-supply-chain-posture.md`)

| Criterion | Result |
| --- | --- |
| zero unpinned Actions | PASS — 94/94 across 17 workflows, `pin_actions.py --check` OK (re-landed on main by the 2026-11-04 CI-enforcement PR; see posture §8) |
| zero unapproved install scripts | PASS — 6 allowed, all with reviewed script bodies; gate blocks any new one |
| IOC sweep | PASS — 0 exact / 0 typosquat / 0 watch-scope hits; 5-package spot-check saved |
| Bun ≥ 1.4.4 everywhere | PASS in repo (12 assertions + 10 runtime fingerprints); local Node 22.22.3 is residual |
| Playwright frozen / verified | PASS — official 1.62.1 clean; typosquats watched |

A real gap was found while verifying: `frontend/package-lock.json` resolves
`xlsx@0.20.3` from `cdn.sheetjs.com`, so `npm ci` is non-hermetic and escapes
registry provenance. Recorded as F-09 / B-10 (Tier 2), not patched.

### 2.2 Phase B — CVE register (`2026-11-CVE-register.md`)

82 rows using the required schema `ID · CVSS · package · locked version ·
reachable? (yes/no + how) · fix version · action · residual-risk rationale`,
**0 `UNTRIAGED`**. Coverage: 18 toolchain/runtime rows (all 10 Node October CVEs,
PHP trio, GitLab, worm campaigns, Playwright, Tauri trio, `es5-ext`), 14 npm rows
(10 remaining + 4 resolved), 43 RustSec offline matches, 7 explicit absent-crate
rows (`zstd`, `tar`, `pulldown-cmark`, `ammonia`, `wasmtime`, tokio `-0384`,
`brotli-decompressor`). Every §2b item is adjudicated.

`NO` verdicts carry a concrete proof, e.g.:

- `zip` 4 advisories: **0 `.extract(` call sites**; `lore.rs` and
  `workspace_conversion.rs` use `ZipArchive::new` + `by_index` and read entries
  into memory with name, symlink-mode, ratio and size checks.
- `tokio -0386`: **0 `AsyncFd` / `tokio::io::unix` references**; the affected
  functions are only `AsyncFd::{new,try_new,with_interest,try_with_interest}`.
  `-0384` declares `unaffected < 1.54.0` and the locks are 1.52.1/1.53.1.
- `wasmtime`, `zstd`, `tar`, `pulldown-cmark`, `ammonia`: absent from all 7
  `Cargo.lock` files and all `Cargo.toml` manifests; no `wasm32` target.
- `CVE-2026-95625`: no `tauri-plugin-updater` in `Cargo.toml`/lock, `plugins: {}`.
- `CVE-2026-95626`: `script-src 'self' 'wasm-unsafe-eval'` has no `data:`/`blob:`.
- `CVE-2026-42184`: **version is in range** (`tauri 2.10.3` vs GHSA
  `>=2.0, <=2.11.0`, patched `>=2.11.1`), but no `local: true` capability and no
  `register_uri_scheme_protocol` call exists. Classified "NO today, YES by
  version" and escalated to B-02 rather than hand-waved away.
- Node TLS/DNS CVEs: Wabi's outbound HTTP/TLS is Rust `reqwest`/`rustls`; Node is
  build-tooling only. All 10 fixed versions are applied via the Node bump.
- PHP / GitLab: no PHP runtime or base image, no `.gitlab-ci.yml`; `.php` string
  matches are a ReaderTab file-type allowlist, a Lore mirror enum label and a
  `.dockerignore` entry.

The plan's `ammonia -0157` ID was a misattribution (that ID is `metacall`);
ammonia's 2026 advisories are `-0193/-0213/-0373`. Corrected in section 4 of the
register. The Tauri version-range conflict was resolved **against** Wabi using
the official GHSA (2.11.1), not the OSV 2.10.3 line claim.

### 2.3 Phase D — dependency diet (`2026-11-dependency-diet.md`)

Before/after counts: Rust 645 / 834 lock packages unchanged, 7 lockfiles, 948
unique Rust packages, 4 npm lockfiles, 392 frontend lock packages, 626 swept
npm entries; `npm audit` 14 → 10. Four patch bumps (dompurify 3.4.17, vite
8.3.5, devalue 5.9.4, source-map-js 1.2.2) applied. **No removals** — the
required cargo proof was impossible here, so every removal/major bump is Tier 2.

### 2.4 Phase E — CI gates, docs, backlog

`ci.yml` `supply-chain` job: `supply_chain_check.py --mode advisory` (two
`always_block` exceptions + IOC P0), `pin_actions.py --check` (blocking),
`npm_audit_gate.py --mode blocking` (new high/critical only), advisory
`npm audit --audit-level=high`, advisory `cargo-deny 0.20.2`. The baseline-aware
gate is the "flip to blocking for future high/critical introductions" mechanism:
triage is in the register, existing debt is graded, new severity fails. The Rust
half of that policy is still advisory (B-12).

`2026-11-hardening-backlog.md` + `.json` export 15 items, top 10 severity-ranked
with owner, IFS (Issue Filing Status), evidence, fix, proof gate and target.

---

## 3. Phase C — October backend review (deep)

### 3.1 Commit-by-commit notes (23 commits, final-tree review)

| Commit | Date | Subject | Review note |
| --- | --- | --- | --- |
| `807dc2e` | 11-01 | Merge game-sync panel | Final-tree review of `game_ops.rs` + `game:*` registrations; produced F-05/F-06 |
| `3bfda45` | 10-17 | game-sync review pass: runtime gate, panel, scoring | Verified env→persisted→default precedence in `addon_switches.rs`; all handlers except `leave` call `require_socket_channel`; F-06 |
| `f64b300` | 10-15 | game-sync v1 Go games | New `socketio/game_ops.rs`, `core/addons/game-sync/plugin.json`; unbounded process-local rooms; F-05 |
| `7184ad9` | 10-14 | operator accent / theme-color | Shell/UI only; no authz surface |
| `bc5a1a6` | 10-11 | integrate exo frontend + local backend | Broad merge; re-reviewed final `preview.rs` / `workspace_conversion.rs` |
| `b0ada69` | 10-10 | project cards blocked reason | Additive optional fields, no authz change |
| `2b49426` | 10-09 | X fallback injectable, displayFont | `preview.rs` outbound URL resolution; F-04 |
| `db20dac` | 10-09 | design fixes (scale, palette, encryption seal) | UI only |
| `69d9d8d` | 10-09 | typed link cards + X oEmbed | `preview.rs` outbound fetch — primary SSRF surface; F-04 |
| `8e74f63` | 10-09 | channel-aware push, link preview, E2EE images | `preview.rs` image-proxy upload sandbox headers verified; `push.rs` |
| `ccf04ae` | 10-07 | server-side Web Push | `push_store.rs`; contract suite not executable here (§3.5) |
| `20721ee` | 10-02 | native snapshot advisory locking | `checkpoint_jobs.rs` / `instance_archive/source_context.rs`; symlink + mode checks reviewed |
| `6193930` | 10-02 | isolate voice admission/eviction by Authority | Socket.IO handlers in `voice_*` modules; matrix namespace coverage checked |
| `5ec7838` | 10-02 | combined capability schema + refresh fixtures | `src-tauri/capabilities/*`: no `local: true` → Tauri not-reachable proof |
| `ce87066` | 10-02 | Office mobile media | `workspace_conversion.rs` ZIP validation reviewed |
| `1e5b041` | 10-02 | mobile boot + Office + showcase | Broad merge; final-tree review |
| `63f204a` | 10-02 | Office workspaces + album/desktop | `workspace_conversion.rs` |
| `79ef30f` | 10-02 | voice media policy + Authority | `socketio/voice_media_policy.rs`; REVIEW rows in matrix |
| `7528e73` | 10-02 | mobile native + desktop boundaries | Tauri CSP/capabilities re-read |
| `2fe5865` | 10-02 | Office + Authority admission | `app_router.rs` layer stack re-read |
| `03a6844` | 10-02 | showcase scenes + forum | UI only |
| `32a271d` | 10-02 | profile fixtures + profile security | auth extractors |
| `9e6efa8` | 10-02 | pointer worlds + appearance | UI only |

Plan estimated ~24 commits; deepened history yields 23. Merge-diff volume is
~189–192k added lines, which is why final-tree review (not per-diff) was used.

### 3.2 Authorization matrix (`2026-11-authorization-matrix.md`)

Generated by `scripts/security/generate_authz_matrix.py` from `api/routes.rs`
nests, every `.route(...)` in `core/crates/wabi-server/src/**`, and every
`socket.on(...)`. **355 HTTP declarations** (316 under `api/`, 39 operational /
helper / test-fixture routers) and **97 Socket.IO events**. Each row carries
source `file:line`, prefix, path, methods, handler and *guard evidence* derived
from tokens in the handler signature/body. `REVIEW` marks a row with no
handler-level guard token (85 HTTP + 27 socket = **112**, tracked as B-13).

**Namespace completeness (reviewer point 4).** All 97 `socket.on(`
registrations in `core/crates/wabi-server/src/` are in `socketio/wiring.rs` —
zero elsewhere. Handler bodies live in the 21 files `include!`-ed by
`socketio_impl.rs`; the guard scan reads all of them, not just `wiring.rs`.
September's `channel_access::require_access` is the shared REST/Socket.IO
channel policy; October's new surface is `game:*`.

Global layers in `app_router.rs` (rate limiting, IP deny, JSON body budget,
`RequestBodyLimitLayer`/`DefaultBodyLimit`, CORS, compression, tracing,
`TimeoutLayer`) are **not** authorization and are not counted as a guard.
`/health`, `/livez` and `/readyz` are deliberately unauthenticated operational
endpoints. At the time of this audit `/metrics` was also served without
authentication: nothing read `WABI_METRICS_PUBLIC`, although INSTALL.md said it
was admin-gated. Corrected afterwards: `/metrics` now requires an admin
(`admin_auth`) or `WABI_METRICS_TOKEN`, and is open only when
`WABI_METRICS_PUBLIC=1` (contract: `tests/metrics_access_contract.rs`).

### 3.3 Bug-class pass

| Class | Surface checked | Result |
| --- | --- | --- |
| SSRF / DNS rebinding | `preview.rs`: `validate_outbound_url`, `pinned_client`, `redirect::Policy::none()`, `MAX_FETCH_REDIRECTS 5`, per-hop validation, 2/10 MiB caps, `no_proxy` | Hardened (F-04). No live SSRF proof possible without a local server build |
| Path traversal / archive | `workspace_conversion.rs`, `lore.rs`: ZIP name/duplicate/symlink-mode/ratio/CRC checks; no `.extract()` | No finding |
| Authz / IDOR | 452-row matrix; `channel_access`, `admin_auth`, `require_socket_channel`, `SioIdentity`, revocation | 112 REVIEW rows remain (B-13); F-08 info leak |
| Deserialisation / parsing | Office ZIP, PPTX/ODP, Go session JSON, `serde_json` bounds | Hardened (F-05) |
| Resource exhaustion | game rooms/move log/channelId, body budgets, timeouts | Hardened (F-05) |
| Payments replay / claim | `api/payments/*`, `intents.rs`, 4 contract suites | Static review only (§3.5) |
| Secret handling | Tauri CSP/capabilities, CI `persist-credentials`, env parsing | No new secret introduced; F-09/B-10 CDN gap |
| Race / TOCTOU | `addon_switches.rs` env→persisted→default, `evict_channel_games` | No finding |
| Typosquats / worms | 626 locked npm entries × 80 IOCs + names + scopes | 0 hits |
| CSP / desktop | `tauri.conf.json`, capabilities | Tauri not-reachable proofs in §2.2 |

### 3.4 Findings register

| ID | Sev | Status | Finding (file:line) | Repro / proof | Action |
| --- | --- | --- | --- | --- | --- |
| F-01 | High | **FIXED** | `ci.yml` used `bun-version: 1.3.14`, `Dockerfile.bun` `oven/bun:1.2.22`, `node:20-slim` (all < Node2Shell fix) | `grep -rn 'bun-version\|node:' .github/workflows/ Dockerfile*`; gate reports `p0` for any Bun < 1.4.4 | 12 Bun + 18 Node assertions, 6 images, 10 fingerprint steps, doc floors |
| F-02 | High | **FIXED** | 92 `uses:` lines were tag refs (`actions/checkout@v4`, `oven-sh/setup-bun@v2`) | `python3 scripts/security/pin_actions.py --check` before/after | 92 rewritten + 2 in the re-landed `supply-chain` job = 94/94 full SHAs, `action-pins.json` |
| F-03 | High | **FIXED** | Critical `dompurify <=3.4.16` XSS, reachable in `frontend/src/lib/markdown.ts`, `notes/render.ts`, `readerTabHelpers.ts`, `documentMarkdown.ts`, `localVisualEffects.ts`, `DocumentsWorkspace.svelte` | `npm audit --json` critical row; `npm view dompurify@3.4.17` | bumped 3.4.14 → 3.4.17; `npm audit` critical 2→1 |
| F-04 | Medium | **FIXED** | `api/preview.rs:245` `is_public_ipv6` accepted IPv6 transition/documentation prefixes (`::127.0.0.1`, `2002::/16` 6to4, `2001::/32` Teredo, `64:ff9b::/96` NAT64, `2001:db8::/32`, `100::/64`) that can encode an IPv4 destination without being IPv4-*mapped* | `validate_outbound_url("http://[::127.0.0.1]/")` previously reached the public-IP allowlist as a global IPv6 literal; now rejected before any DNS lookup | explicit rejects + 6 new literal cases + 7 new `is_public_ip` cases |
| F-05 | Medium | **FIXED** | `socketio/game_ops.rs:59` unbounded `ROOMS` map, unbounded `moves` log, unbounded client `channelId`; every `game:move`/`game:pass` re-broadcasts the *entire* session JSON | an authenticated channel member alternating `pass` grows memory linearly and cumulative broadcast cost quadratically; `game:create` with a fresh random channelId grows the map without limit | `MAX_GAME_MOVES 1024`, `MAX_GAME_ROOMS 4096`, `MAX_CHANNEL_ID_LEN 128` + 3 unit tests |
| F-06 | Medium | **FIXED** | `socketio/game_ops.rs:303` `on_game_leave` was the only `game:*` event without the `game_sync_enabled` runtime gate | with `WABI_GAME_SYNC_ENABLED=false`, emitting `game:leave` still produced `game:left` and left the room | gate added, input bound added |
| F-07 | Info | DOCUMENTED | `on_game_leave` has no channel resource guard (matrix `MANUAL` adjudication) | it only removes the caller's own socket from a broadcast room; refusing to leave on revoked access would keep a removed user subscribed | explicit rationale in the generated matrix |
| F-08 | Low | OPEN (B-13) | `api/addons.rs:350` `list_addons` and `:357` `get_addon` take only `State` — unauthenticated capability enumeration at `GET /api/addons` | `curl -s https://<host>/api/addons` without a bearer returns the enabled addon list; `app_router.rs` applies no global auth layer | not patched (product behaviour change); flagged for owner decision |
| F-09 | Medium | OPEN (B-10) | `frontend/package-lock.json`: `xlsx@0.20.3` resolved from `cdn.sheetjs.com` | `npm ci` fails with `ECONNRESET` in a registry-restricted sandbox; `npm view xlsx@0.20.3` → 404 on npmjs | Tier 2: vendored digest or adapter replacement |
| F-10 | Medium | OPEN (B-08) | `es5-ext` opaque `postinstall` dynamic require | script body read from registry 2026-11-03 | allowlisted temporarily, removal in Tier 2 |
| F-11 | Medium | OPEN (B-02) | `src-tauri/Cargo.toml:23` `tauri = 2.10.3` is inside GHSA-7gmj-67g7-phm9's affected range | official GHSA `>=2.0, <=2.11.0` / patched `>=2.11.1`; `tauri-build.yml` builds Windows; config mitigations make it not exploitable today | Tier 2 bump; no hand-edited lock |
| F-12 | Medium | OPEN (B-14) | `npm run check` reports 42 errors / 108 warnings in both baseline and patched trees | `docs/audits/evidence/svelte-check-{before,after}.txt` are byte-identical | pre-existing; blocks the "CI green" claim |
| F-13 | Medium | OPEN (B-13) | 112 `REVIEW` rows in the generated authz matrix have no handler-level guard token | regenerate the matrix; every `REVIEW` row needs a guard or an explicit no-guard rationale | human adjudication |
| F-14 | Info | OPEN | Payments rails are **compile-time gated**, not dead: `payments-rails`/`payments` features in `wabi-server/Cargo.toml:128-133`, `#[cfg(feature = "wabi-payments-*")]` in `intents.rs:363/412/468` | `/api/payments` routes are always nested but the EU/US/crypto rail code is not compiled by default; `payments-acceptance.yml` builds with `--features payments-rails,field-embed` | adversarial re-test status in §3.5 |
| F-15 | Info | CLOSED | PHP / GitLab non-exposure | no PHP runtime/base image, no `.gitlab-ci.yml`; `.php` matches are UI allowlist / enum / `.dockerignore` | no action |

### 3.5 Adversarial payment-claim re-test — explicit status

**Not executed locally.** There is no Rust toolchain in the sandbox, so
`cargo test` could not run. This is an open item, not a pass. What exists:

- Four contract suites are present and CI-invoked:
  `tests/payment_access_contract.rs`, `payments_admission_contract.rs`,
  `payments_projection_contract.rs`, `payments_rails_contract.rs`, plus
  `--lib api::payments` in `.github/workflows/payments-acceptance.yml`.
- Static review of the adversarial cases shows forged token types, revoked
  credentials, guest flags, session-revocation cutoffs, owner/admin/moderator
  roles, restart/durable-application checks and membership-wait rechecks.
- `intents.rs` validates `amountMinor > 0` and `<= 9_007_199_254_740_991`,
  rejects non-`pending` status re-use and mismatched `actualAmountMinor`.

**Owner action:** run `payments-acceptance.yml` on this branch and attach the log
before sign-off. No adversarial request was sent to any remote service.

### 3.6 Patches applied (Phase C priority inversion honoured)

Two focused Rust patches were made as soon as the issues were identified, with
regression tests in the same files, rather than being deferred to the report:

1. `core/crates/wabi-server/src/api/preview.rs` — IPv6 transition-prefix
   rejects; extended `literal_urls_reject_internal_and_mapped_addresses_before_any_lookup`
   and `dns_mapped_ipv6_uses_the_same_ipv4_classification`.
2. `core/crates/wabi-server/src/socketio/game_ops.rs` — bounds + runtime gate,
   plus `channel_ids_are_bounded_and_non_empty`,
   `move_log_cap_is_strict_at_the_bound`,
   `room_cap_only_blocks_new_channels`.

**Gap:** the Rust regression tests were **added but not executed** (no `cargo`).
Tree-sitter parsed both files with zero syntax errors, and a manual borrow review
found no conflict with the existing `drop(g); return;` NLL pattern. CI must run
`cargo test -p wabi-server --lib api::preview` and `cargo test -p
wabi-server --lib socketio` before these patches are considered proven. This is
recorded rather than hidden.

---

## 4. Verification matrix (what actually ran)

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `python3 scripts/security/pin_actions.py --check` | OK, 95 uses / 17 workflows | `evidence/pin-actions-check.txt` |
| 2 | `supply_chain_check.py --mode advisory` / `blocking` | PASS (30 info rows in each mode) | `evidence/supply-chain-{advisory,blocking}.txt` |
| 3 | `python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v` | **57 tests OK** | `evidence/supply-chain-unittests.txt` |
| 4 | `npm_audit_gate.py --mode blocking` (live + saved JSON) | PASS | console + `evidence/npm-audit-after.json` |
| 5 | `npm audit --json` before / after | 14 → 10 (critical 2→1, high 5→2) | `evidence/npm-audit-{before,after}.json` |
| 6 | `bun test --isolate src/lib` (Bun 1.4.4), baseline vs patched | 2892 pass / 3 skip / 6 fail, identical names (diff = 0) | `evidence/bun-test-{before,after}.txt` |
| 7 | `npm run check` (svelte-check), baseline vs patched | 42 errors / 108 warnings, byte-identical | `evidence/svelte-check-{before,after}.txt` |
| 8 | `npm run build:only` (vite build), patched | pass (SSR + client, `✔ done`) | `evidence/vite-build-after.txt` |
| 9 | PyYAML over `.github/workflows/*.yml` | 17/17 parse, 0 failures | console |
| 10 | `git diff --check` | clean | console |
| 11 | tree-sitter Rust parse of the 2 patched files | 0 syntax errors | console |
| 12 | IOC 5-package spot-check | 0 exact / name / scope hits | `evidence/ioc-spotcheck-2026-11-03.txt` |
| 13 | RustSec offline matcher (7 locks, 948 pkgs, 436 advisories) | 43 matches | `evidence/rustsec-2026-11-03.{md,json}` |

**Not run:** `cargo audit`, `cargo deny check`, `cargo tree --duplicates`,
`cargo check/tests`, desktop `cargo build`, the 4 payments contract suites,
GitHub Actions on this branch, any network adversarial test against a live
server. The 6 `bun test` failures are the xlsx-dependent spreadsheet round-trip
file, which cannot load because the CDN tarball is unreachable; they are
identical in baseline and patched trees.

---

## 5. Reviewer scrutiny — direct answers

1. **"Demand proof for not reachable."** Every `NO` in the register names a
   feature flag, absent call site, absent lockfile entry, config directive or
   explicit `unaffected` range. Examples: `zip` (0 `.extract`), tokio `-0386`
   (0 `AsyncFd`), `-0384` (`unaffected <1.54.0`), zstd/tar/wasmtime (absent from
   7 locks), Tauri `-95626` (no `data:`/`blob:` in `script-src`), `-95625` (no
   updater plugin), PHP (no runtime), Node TLS (Rust reqwest owns outbound TLS).
   Tauri `-42184` is explicitly **not** claimed "not reachable by version" —
   it is in range and escalated to B-02.

2. **"Spot-check 5 clean IOC packages."** Done: `dompurify@3.4.17`,
   `vite@8.3.5`, `esbuild@0.25.12`, `@tauri-apps/api@2.11.1`,
   `socket.io-client@4.8.3`, each checked against 80 exact IOCs / 5 names / 19
   scopes and live registry tarball + lifecycle-hook metadata. 0 hits;
   `esbuild`'s `postinstall` is the reviewed allowlist entry, dompurify's
   `prepare` is dev-only and not `hasInstallScript` in the lockfile.

3. **"Confirm dependency-removal test logs and feature/platform paths."**
   There were **no removals**, and the diet doc says so explicitly. The four
   version bumps are proven by baseline-vs-patched `bun test`, byte-identical
   `svelte-check`, a passing `vite build`, and `npm audit` — logs committed.
   Feature paths: `payments-rails` compile-time gates (`Cargo.toml:128-133`,
   `intents.rs:363/412/468`), `#[cfg(feature = "wabi-lore")]` nested addon
   routes, runtime `addon_enabled` for `game-sync`, platform-gated Tauri
   capabilities (`platforms: [linux, macOS, windows]` / `[android, iOS]`),
   `fsevents` macOS-only optional deps. Desktop `cargo build` on all 3 runner
   OSes is the unrun proof for any Rust lock change — which is why none was made.

4. **"Verify authz matrix namespaces outside `wiring.rs`."** All 97
   `socket.on(` registrations are in `wiring.rs`; 0 elsewhere. Handlers are in
   21 `include!`-ed `socketio/*.rs` files and are all scanned for guard tokens.
   HTTP coverage extends beyond `api/` to `app_router.rs`, helper/inbox/replica
   binaries, `socket.rs` and test-fixture routers (39 extra rows). 112 REVIEW
   rows are flagged, not silently filled.

5. **"Sanity-check gate thresholds."** `npm audit --audit-level=high` is
   advisory (`continue-on-error: true`) because it would fail on the 1 critical
   + 2 high items awaiting owner approval. The blocking gate is baseline-aware:
   only **new** high/critical advisories fail. The two mandated immediate
   exceptions are `always_block=True` and the step has no `continue-on-error`.
   `--mode advisory` vs `--mode blocking` is one flag; the flip instruction is a
   comment in `ci.yml`. The Rust half is deliberately still advisory (B-12).

---

## 6. Open items (explicit, not concealed)

1. Rust regression tests for F-04/F-05/F-06 are written but **unrun** — needs
   `cargo test` in CI.
2. Full adversarial payment-claim re-test **unrun** — needs
   `payments-acceptance.yml` log (§3.5).
3. 112 authz `REVIEW` rows need human adjudication (B-13).
4. `cargo audit` / `cargo-deny` / `cargo tree --duplicates` / desktop build
   **unrun**; all Rust version findings are static adjudications.
5. `svelte-check` 42 pre-existing errors make the existing CI `test` job red
   (B-14); "CI green" is not claimed.
6. `tauri 2.10.3` remains in the affected version range (B-02); the
   configuration mitigations are not a substitute for a version fix.
7. `xlsx` CDN tarball, `es5-ext` postinstall, `maplibre-gl` critical,
   `pptxgenjs`/`image-size` high remain (B-03, B-04, B-08, B-10).
8. Documents are on the branch, not reviewed/merged; no PR/CI run has occurred
   from GitHub in this session.
9. Rust "future high/critical introductions" blocking gate is advisory (B-12).
10. Local sandbox Node 22.22.3 is below the Node fix; any host-level Node is
    outside this repo's scope.

## 7. Acceptance checklist

| Criterion | Status |
| --- | --- |
| Phase A posture note, 0 unpinned Actions, 0 unapproved scripts, IOC clean, Playwright frozen | **DONE** (actions/CI half re-landed on main by the 2026-11-04 CI-enforcement PR; see posture §8) |
| Phase B `cargo audit` + `cargo-deny` + `cargo tree --duplicates` executed | **NOT DONE** (no Rust toolchain; offline RustSec matcher + `deny.toml` + CI jobs delivered instead) |
| CVE register with required schema, every §2b item adjudicated | **DONE** (82 rows, 0 untriaged) |
| Phase C reviewed-with-notes for every Oct commit | **DONE** (23 commits) |
| HTTP-route + Socket.IO authz matrix (`input → guard → resource`) | **DONE** (452 rows; 112 REVIEW flagged) |
| Adversarial payment-claim re-test | **NOT EXECUTED** (documented, CI job identified) |
| Findings register with file:line + repro | **DONE** (F-01…F-15) |
| Phase D diet doc, accepted/rejected, before/after counts, Tier 1 proofs | **DONE** (0 removals, honestly justified) |
| Phase E audit doc, advisory-first CI gates with 2 immediate blockers, later blocking for new high/critical | **DONE** (npm side blocking; Rust side B-12) |
| Top-10 backlog with owners/IFS exported | **DONE** (`.md` + `.json`) |
| Three docs reviewed/merged, CI green under advisory gates | **OPEN** — authored and pushed on the branch; merge/review and a real CI run are owner steps |

## 8. Sources

Node.js October 2026 security release [1](https://www.getastra.com/blog/security-advisory/node-js-security-release/) [2](https://www.konfirmity.com/advisories/nodejs-october-2026-security-releases);
Node2Shell / Bun [3](https://www.aikido.dev/blog/node2shell-nodejs-brotli-rce-cve-2026-111497) [4](https://www.ionsec.io/resources/node2shell-brotli-decoder-rce-cve-2026-111497/);
Tauri [GHSA-7gmj-67g7-phm9](https://github.com/tauri-apps/tauri/security/advisories/GHSA-7gmj-67g7-phm9);
RustSec advisory-db (clone 2026-11-03);
[StepSecurity ChainDrop](https://www.stepsecurity.io/blog/chaindrop-npm-worm),
[Aikido Tensorlake](https://www.aikido.dev/blog/tensorlake-npm-package-compromised),
[Snyk TanStack](https://snyk.io/blog/tanstack-npm-packages-compromised/),
[OSV MAL-2024-11772](https://osv.dev/vulnerability/MAL-2024-11772),
[Snyk playwright-1.48](https://security.snyk.io/vuln/SNYK-JS-PLAYWRIGHT148-8536733).
Full source list and IOC provenance are in `scripts/security/npm-iocs.json`.
