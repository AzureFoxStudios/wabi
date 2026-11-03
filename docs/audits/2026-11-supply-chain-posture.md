# Wabi supply-chain posture note — 2026-11-03 (Phase A)

Owner: backend security audit · Status: **implemented on `arena/894edf78-wabi`** · Scope:
CI workflows, lockfiles, container base images, build docs, frontend dependency
pipeline. Companion: `2026-11-CVE-register.md`, `2026-11-backend-security-audit.md`.

## 1. Verdict

| Acceptance criterion | Result | Proof |
| --- | --- | --- |
| Zero unpinned GitHub Actions | **PASS** | 95 active `uses:` lines across 17 workflows, all 40-char SHAs; `python3 scripts/security/pin_actions.py --check` → OK |
| Zero unapproved install scripts | **PASS** | 6 lifecycle-script packages in 4 npm lockfiles, all in `scripts/security/install-script-allowlist.json` with a reviewed script body; `supply_chain_check.py` blocks any new one in *every* mode |
| IOC sweep clean / quarantine | **PASS (0 hits)** | 626 locked npm name@version entries × 80 exact IOCs / 53 packages, 5 typosquat names, 19 watch scopes → 0 exact, 0 name, 0 scope hits |
| Bun ≥ 1.4.4 in local/docs/actions/CI working dirs | **PASS (repo)** | 12 Bun assertions all ≥ 1.4.4; 10 `oven-sh/setup-bun` uses gained a runtime fingerprint step; local sandbox Node 22.22.3 is below the Node floor and is called out as residual |
| Playwright frozen / removed / verified | **PASS (freeze + watch)** | official `playwright 1.62.1` kept; no official compromise found; the reported malware is `playwright-1.45/1.46/1.48` typosquats, now watch names |
| CI gates advisory-first | **PASS** | see §5 |

## 2. What changed

### 2.1 GitHub Action pinning

`scripts/security/pin_actions.py` is an idempotent rewriter/validator. It pinned 92
pre-existing `uses:` lines; the 3 new `supply-chain` job lines were authored already
pinned. `scripts/security/action-pins.json` records **15 resolved refs** with the
commit object verified on 2026-11-03 (`gh api .../git/commits/<sha>` and
`git ls-remote`). Examples: `actions/checkout@v4` → `11d5960a…` (v4.4.0),
`oven-sh/setup-bun@v2` → `0c5077e5…` (v2.2.0), `dtolnay/rust-toolchain@1.93` →
`633c1125…`. Every checkout in the new job sets `persist-credentials: false`.
All 17 workflow files parse as YAML (PyYAML, 0 failures).

### 2.2 Node2Shell floor (CVE-2026-111497)

Bun < 1.4.4 and Node < 22.23.4 / 24.22.1 / 26.12.1 are affected by the Brotli
decoder OOB write; CISA added it to KEV on 2026-10-27 with a 2026-11-10 deadline
[1](https://www.getastra.com/blog/security-advisory/node-js-security-release/)
[2](https://www.konfirmity.com/advisories/nodejs-october-2026-security-releases).

- 10 `bun-version: 1.3.14` → `1.4.4`; 18 `node-version` → `22.23.4` (or `24.22.1`).
- Container images: `frontend/Dockerfile` `node:20-slim` → `node:22.23.4-slim`;
  `frontend/Dockerfile.bun` `oven/bun:1.2.22` → `oven/bun:1.4.4`;
  `media-gateway/Dockerfile` → `node:22.23.4-slim`; `relay-node/Dockerfile` →
  `node:24.22.1-alpine`; `sabi/Dockerfile` → `node:22.23.4-bookworm-slim`;
  `integrations/wabi-project-plugin/compose.example.yml` → `node:22.23.4-bookworm-slim`.
- **10 fingerprint steps** were inserted immediately after each `oven-sh/setup-bun`
  in 9 workflows: `node scripts/security/toolchain-fingerprint.mjs --require-bun`.
  The script asserts the *actual runtime* (not just the YAML literal) is ≥ 1.4.4
  and ≥ Node 22.23.4, and prints the resolved versions into CI logs.
- `docs/deployment/BUILD-NATIVE.md` now states Node 22.23.4+ / Bun ≥ 1.4.4 as a
  hard requirement; `HANDOFF.md` labels the old 1.3.x toolchain as superseded.
  Dated plans/testing/reviews are intentionally left untouched: they are historical
  evidence, not instructions (the gate reports 22 such prose mentions as `info`).

The same Node release fixed 9 more CVEs (TLS hostname bypasses, `dns.resolve` NUL
truncation, keep-alive, `crypto.randomUUID`, permission-model and ZipFile issues).
Each has a row in the CVE register; Wabi's production HTTP/TLS is Rust
axum/reqwest, so the Node-only issues are not reachable in the running server.

### 2.3 Lifecycle scripts

`scripts/security/install-script-allowlist.json` records 6 allowlisted entries,
with the exact script body read from the registry on 2026-11-03:

| Lockfile | Package | Hook | Note |
| --- | --- | --- | --- |
| `frontend/package-lock.json` | `esbuild` | `postinstall: node install.js` | native binary installer; version pinned by `overrides.esbuild` |
| `frontend/package-lock.json` | `es5-ext` | opaque `postinstall` dynamic require | **highest-risk**, temporary approval only; no IOC match |
| `frontend/package-lock.json` | `fsevents` | `install: node-gyp rebuild` | macOS-only optional dep |
| `frontend/package-lock.json` | `playwright/node_modules/fsevents` | `install: node-gyp rebuild` | nested macOS-only optional dep |
| `package-lock.json` | `sharp` | `install: node install/check.js \|\| npm run build` | root image tooling |
| `sabi/package-lock.json` | `fsevents` | `install: node-gyp rebuild` | macOS-only optional dep |

`es5-ext` is explicitly *not* claimed to be proven benign: its postinstall
swallows errors and dynamically requires an in-package file. Removal is Tier 2
(backlog B-08) because it arrives through the legacy `svelte-i18n`/`deepmerge`
chain and a removal requires the full office/i18n acceptance suite.

### 2.4 IOC sweep

`scripts/security/npm-iocs.json` compiles 80 exact name@version indicators across
53 packages (ChainDrop's 11 seed carriers, TanStack/axios/AsyncAPI/Tensorlake/
Red Hat waves), 5 Playwright typosquat names and 19 worm-affected scopes, with 14
sources. The gate walks **all 4 npm lockfiles** (root, frontend, sabi, pureref) and
flags: exact version hits (P0), typosquat names (P0), and watch-scope hits
(reported in advisory, blocking in `--mode blocking`).

Result on 2026-11-03: **0 / 0 / 0**. Five clean packages were independently
spot-checked against the indicator set and live npm registry metadata —
`dompurify@3.4.17`, `vite@8.3.5`, `esbuild@0.25.12`, `@tauri-apps/api@2.11.1`,
`socket.io-client@4.8.3` — all resolve to `registry.npmjs.org` tarballs with no
`preinstall`/`install` hook. Full output:
`docs/audits/evidence/ioc-spotcheck-2026-11-03.txt`.

**Not a clean bill of health forever**: IOC lists are point-in-time. The gate is
only as good as the list committed next to it.

### 2.5 Playwright re-verification (breaking news, 2026-11-03)

Execution-time re-verification found **no compromise of the official `playwright`
package**. The malicious packages are `playwright-1.45@10.1.3` (MAL-2024-11772)
and the `playwright-1.46`/`1.48` typosquats (SNYK-JS-PLAYWRIGHT148-8536733).
Latest official is 1.64.1; Wabi pins 1.62.1. A social-media claim about bundled
Chromium CVE-2026-118306/118331/118348/118344 is unverified, and the LiteLLM
master-key incident leaked Playwright *storage state* from CI — neither is a
package compromise. **Decision: freeze 1.62.1** (no blind upgrade), watch the 5
typosquat names, and file B-09 for browser-binary digest pinning plus CI storage
state hygiene. Rationale for not upgrading: a breaking-news claim is not a reason
to move a browser automation dependency without a full visual/smoke run.

### 2.6 A real gap found while verifying

`frontend/package-lock.json` resolves `xlsx@0.20.3` from
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, not the npm registry.
Consequences: `npm ci` cannot complete in a network-restricted environment
(this sandbox), the tarball escapes registry provenance / SLSA checks, and the
IOC gate cannot inspect its contents. `npm view xlsx@0.20.3` returns 404 on
`registry.npmjs.org`, so there is no drop-in registry substitute. **This is
backlog B-10 (Tier 2)**, not a drive-by change. To run the frontend test suite
locally, the verification harness copied `frontend/` to a temp dir, removed only
that one lockfile entry, stubbed the module, and copied repo-root `shared/` so
`../../../../shared/...` imports resolve. See §6 and the diet doc.

## 3. New files

| Path | Purpose |
| --- | --- |
| `scripts/security/action-pins.json` | 15 verified 40-char SHAs with labels |
| `scripts/security/pin_actions.py` | idempotent pinner + `--check` validator |
| `scripts/security/supply_chain_check.py` | lockfile-aware gate (Bun/Node floors, scripts, IOCs, pins, docs) |
| `scripts/security/toolchain-fingerprint.mjs` | runtime Node/Bun floor assertion |
| `scripts/security/install-script-allowlist.json` | reviewed lifecycle scripts |
| `scripts/security/npm-iocs.json` | 80 exact IOCs / 5 names / 19 scopes / 14 sources |
| `scripts/security/npm-audit-baseline.json` | triaged existing npm debt |
| `scripts/security/npm_audit_gate.py` | blocks **new** high/critical npm advisories |
| `scripts/tests/test_supply_chain_check.py`, `test_npm_audit_gate.py` | gate regression tests |
| `deny.toml` | cargo-deny 0.20.x policy, no blanket advisory ignores |
| `.github/workflows/ci.yml` | `supply-chain` job + advisory `npm audit` |

## 4. Container / runtime hygiene (light-touch SvelteKit)

SvelteKit runtime was not rewritten. The static-output and header posture was
reviewed via `src-tauri/tauri.conf.json`: `default-src 'self'`, `connect-src`
`ws:/wss:/http:/https:`, `style-src 'unsafe-inline'`, `script-src 'self'
'wasm-unsafe-eval'` (no `data:`/`blob:` → CVE-2026-95626 not reachable). The
broad `connect-src` is a pre-existing design decision for user-hosted Wabi
servers; it is recorded as backlog B-11, not changed here because narrowing it
would break self-hosted instances.

## 5. CI gate policy (Phase E, owner-delegated)

`.github/workflows/ci.yml` gains a `supply-chain` job:

| Step | Mode | Fails CI on |
| --- | --- | --- |
| `supply_chain_check.py --mode advisory` | **advisory** | **blocks immediately**: Bun < 1.4.4 anywhere, unapproved lifecycle script, exact worm IOC, malicious typosquat |
| `pin_actions.py --check` | blocking | any `uses:` not a 40-char SHA |
| `npm_audit_gate.py --mode blocking` | **blocking** | any **new** high/critical npm advisory not in the committed baseline |
| `npm audit --audit-level=high` (test job) | advisory (`continue-on-error: true`) | nothing — grades existing 10-advisory debt |
| `cargo deny check advisories licenses sources` (`cargo-deny` 0.20.2) | advisory (`continue-on-error: true`) | nothing yet |

Threshold sanity: `npm audit --audit-level=high` is **not** used as a gate on
existing debt (it would fail on the 1 critical + 2 high items that need owner
approval). The baseline-aware gate is the "flip to blocking for future high/critical
introductions" mechanism — triage has landed in the CVE register, so new severe
advisories fail now while the 10 existing ones remain graded. The two mandated
immediate exceptions are `always_block=True` in `supply_chain_check.py` and the
step has **no** `continue-on-error`, so they really do fail CI. To flip the whole
gate after the Tier 2 work, change one flag (`--mode blocking`) and remove the two
`continue-on-error` lines; the comment in `ci.yml` says exactly that.

The Rust side of "future high/critical introductions" is still advisory:
`cargo-deny` has no committed Rust advisory baseline. That is backlog B-12.

## 6. Verification actually run

| Check | Command | Result |
| --- | --- | --- |
| Action pins | `python3 scripts/security/pin_actions.py --check` | OK, 95 active uses / 17 workflows |
| Supply-chain gate, blocking | `… --mode blocking` | PASS (30 info rows) |
| Supply-chain gate, advisory | `… --mode advisory` | PASS |
| Gate unit tests | `python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v` | **57 tests OK** |
| New-advisory gate | `npm_audit_gate.py --mode blocking` (live + saved JSON) | PASS |
| YAML | PyYAML over `.github/workflows/*.yml` | 17/17 parse |
| Whitespace | `git diff --check` | clean |
| IOC spot-check | 5 packages × 4 checks | 0 hits |
| Frontend `npm audit` | before/after JSON in `docs/audits/evidence/` | 14 → 10 vulns (critical 2→1, high 5→2) |
| Frontend `bun test --isolate src/lib` | Bun 1.4.4, baseline vs patched | 2892 pass / 3 skip / 6 fail, **identical** |
| `svelte-check` | baseline vs patched | 42 errors / 108 warnings, **identical** |
| `vite build` (`npm run build:only`) | patched tree | **passes** (both SSR and client bundles, `✔ done`) |
| Rust syntax | tree-sitter parse of the 2 patched `.rs` files | OK |

Logs: `docs/audits/evidence/*.txt` / `*.json`. **Not run**: `cargo audit`,
`cargo deny`, `cargo tree --duplicates`, `cargo check/tests`, desktop
`cargo build`, GitHub Actions on the branch (no Rust toolchain / no CI run in
this sandbox). Do not read the table above as a green CI badge.

## 7. Residual risk

1. The sandbox's Node 22.22.3 is below 22.23.4; any host-level Node outside the
   repo is out of scope.
2. `es5-ext`'s postinstall remains a reviewed-but-opaque code execution point.
3. `xlsx` is fetched from a third-party CDN with no digest pin (B-10).
4. IOC data is a snapshot; new worm waves need a new list.
5. `es5-ext`/`fsevents`/`sharp` are allowlisted, not removed; `--ignore-scripts`
   is not yet enforced repo-wide.
6. Not every workflow sets `persist-credentials: false`; the new job does.
