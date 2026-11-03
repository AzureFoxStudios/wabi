# Top-10 hardening backlog — 2026-11-03 backend security audit (Phase E)

Severity-ordered, export-ready. Machine-readable twin:
`docs/audits/2026-11-hardening-backlog.json` (for launch-prep import).

**IFS convention.** This document interprets `IFS` as **Issue Filing Status** —
the tracker id/state needed to export each row into launch prep. Each item also
carries an owner, a proof gate and a target. If the org uses a different IFS
field, remap that single column; the rest of the row is unchanged. `not-filed`
means no tracker issue exists yet (nothing was filed from this audit).

**Ranking rule.** Ordered by *effective* severity: reachable > conditionally
reachable > present-but-unreachable, then CVSS/advisory severity, then breadth
of exposure. IDs are stable cross-references used by the CVE register, posture
note and dependency diet; they are not the rank.

## Top 10

| Rank | ID | Severity | Item | Owner | IFS | Evidence | Fix | Proof gate | Target |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **B-01** | P0 / High | Refresh the reachable Rust TLS chain: `rustls 0.23.43/0.23.45`, `rustls-webpki 0.103.14/0.103.15`, `webpki-root-certs 1.0.9` | Backend lead (Rust) | `not-filed` · proposed label `security/p0` | 11 RustSec rows (`RUSTSEC-2026-0285/0346/0347/0348/0349/0382/0383`); used by `preview.rs` outbound link previews, webhooks, Lore mirror, Tauri reqwest | `cargo update -p rustls --precise 0.23.46` (+ webpki/root-certs), regenerate lock | `cargo check/test` full workspace, server contract suites, `cargo audit` clean | before launch |
| 2 | **B-02** | P0 / High | Bump `tauri 2.10.3` → ≥ 2.11.1 (CVE-2026-42184 / GHSA-7gmj-67g7-phm9) | Desktop lead | `not-filed` · `security/p0` | Official GHSA affected `>=2.0, <=2.11.0`; `tauri-build.yml` builds `windows-latest`. Not currently exploitable: no `local: true` capability, no `register_uri_scheme_protocol` | Cargo.toml bump + `cargo update -p tauri`, regenerate `src-tauri/Cargo.lock` | desktop `cargo build` on ubuntu/windows/macos + capability re-review | before launch |
| 3 | **B-04** | P1 / High | Resolve reachable `pptxgenjs 4.0.1` / `image-size 2.0.2` DoS on the PPTX export path | Frontend / Office lead | `not-filed` · `security/p1` | `present/files.ts` exports user-authored slides; npm's suggested fix is a **downgrade** to `pptxgenjs 4.0.0` | approve downgrade or vendor a patched `image-size`, then regenerate lock | full `bun test`, office acceptance suite, `vite build` | sprint +1 |
| 4 | **B-03** | P1 / Critical (present, not reachable) | `maplibre-gl 5.20.0` → 6.16.0 critical XSS primitive | Frontend lead | `not-filed` · `security/p1` | Only remaining npm **critical**. No `Popup.setHTML` / `DOM.sanitize` / `innerHTML` sink in `MapVectorStage.svelte`; addon runtime-gated | major bump | `bun test`, map/office visual QA, `vite build`, desktop build | sprint +1 |
| 5 | **B-06** | P1 / High (conditional) | `quinn-proto` → 0.11.18 (8 DoS/panic advisories) | Backend lead | `not-filed` · `security/p1` | `reqwest 0.13.4` resolves `quinn 0.11.11`; outbound requests reach user-supplied URLs. No `http3_prior_knowledge()` call site, so treat as reachable until proven otherwise | `cargo update -p quinn-proto --precise 0.11.18` | `cargo check/test` + `preview.rs` contract tests + HTTP/3 feature audit | sprint +1 |
| 6 | **B-10** | P1 / Supply chain | Remove the CDN-hosted `xlsx@0.20.3` tarball dependency | Build/CI lead | `not-filed` · `security/p1` | `frontend/package-lock.json` resolves from `cdn.sheetjs.com`; `npm ci` fails in restricted networks; escapes registry provenance/IOC scanning; no registry version exists | vendor a pinned tarball with a committed digest, or replace the spreadsheet adapter | full `bun test` **including** `fileAdapter.test.ts`, office acceptance, `npm ci` from a clean cache | sprint +1 |
| 7 | **B-08** | P1 / Supply chain | Remove `es5-ext`'s opaque `postinstall` by dropping the `svelte-i18n`/`deepmerge` chain | Frontend lead | `not-filed` · `security/p1` | Postinstall dynamically requires `./_postinstall` and swallows errors — an ideal worm hiding place; allowlisted only temporarily | retire the legacy i18n path (pairs with B-05) | `bun test`, i18n/office acceptance, lockdiff showing 0 install scripts | sprint +2 |
| 8 | **B-07** | P2 / Medium | `zip 2.4.2` → 9.x (4 `extract()` advisories, currently unreachable) | Backend lead | `not-filed` · `security/p2` | 0 `.extract(` call sites; `lore.rs`/`workspace_conversion.rs` read entries into memory with name/mode/ratio/size checks. Parser still handles untrusted archives | major crate bump + API migration | `cargo check/test`, office conversion suites, `cargo audit` | sprint +2 |
| 9 | **B-05** | P2 / Low-major | Coordinated SvelteKit 3.1.1 / adapter 6.0.1 / 4.0.1 chain (resolves all 7 low advisories) | Frontend lead | `not-filed` · `security/p2` | 7 low rows share one major upgrade; also removes `deepmerge` (B-08) | coordinated major bump | `bun test`, `svelte-check`, `vite build`, desktop build | sprint +2 |
| 10 | **B-09** | P2 / Medium | Pin Playwright browser binaries by digest and clean CI storage state | QA/CI lead | `not-filed` · `security/p2` | Official `playwright 1.62.1` is clean (malware was `playwright-1.45/1.46/1.48` typosquats); `npx playwright install` fetches Chromium from a CDN with no committed digest; LiteLLM incident leaked Playwright storage state | commit browser digests, wipe/scope `storageState`, keep typosquat watch | browser smoke suite on all 3 OSes + secret scan of CI artifacts | sprint +2 |

## Beyond the top 10 (tracked, not ranked here)

| ID | Severity | Item | Owner | IFS | Proof gate |
| --- | --- | --- | --- | --- | --- |
| B-11 | P2 | Narrow `connect-src` / `style-src 'unsafe-inline'` in `tauri.conf.json` | Desktop lead | `not-filed` | desktop webview QA on self-hosted servers |
| B-12 | P2 | Commit a Rust advisory baseline and make `cargo-deny` block **new** high/critical Rust advisories (currently advisory-only) | Backend lead | `not-filed` | `cargo deny check` in CI on 7 lockfiles |
| B-13 | P2 | Human-adjudicate the 85 HTTP + 27 Socket.IO `REVIEW` rows in `2026-11-authorization-matrix.md` | Security / Backend lead | `not-filed` | reviewed matrix with a guard or explicit no-guard rationale per row |
| B-14 | P2 | Fix the 42 pre-existing `svelte-check` errors so `bun run check` is green | Frontend lead | `not-filed` | `npm run check` exit 0; CI `test` job green |
| B-15 | P3 | Deduplicate `tokio 1.52.1/1.53.1`, `rand` 4 versions, `reqwest 0.12.28/0.13.4`; enforce `--ignore-scripts` repo-wide | Backend / Build lead | `not-filed` | `cargo tree --duplicates` + full build + 3-OS CI matrix |

## What is **not** backlog

The following were fixed on the branch and must not be re-filed: 95 unpinned
Actions, Bun/Node Node2Shell floors, 6 container image tags, 10 fingerprint
steps, 4 reachable npm advisories (dompurify/devalue/vite/source-map-js), IPv6
transition-prefix SSRF hardening, unbounded game-state DoS, `game:leave` gate
bypass, Playwright freeze, npm lifecycle-script allowlist + gate.

## Export notes for launch prep

- `2026-11-hardening-backlog.json` contains the same 15 items with `rank`,
  `id`, `severity`, `owner`, `ifs`, `evidence`, `fix`, `proof_gate`, `target`.
- All `ifs` values are `not-filed`: no issue tracker was written to from this
  audit. Import creates the issues; it does not assume they exist.
- Every item's acceptance is a **test proof**, following the plan's "CI logs,
  not vibes" rule. No item is marked done without the named proof gate.
