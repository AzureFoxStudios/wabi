# ADR-0003: Which Rust MLS library Wabi builds on

- **Status:** Accepted, 2026-11-13 (owner). Nothing is built yet; the work starts at ADR-0002 stage 2, after stage 1. This follows ADR-0002 §5 (ii) and §8 question 4, where the owner asked for "a doc giving verbose info about both, but deeply think about the longer term of both and choose that one, outlining why in said document." The owner answered "yes" to mls-rs as recommended.
- **Scope:** a decision about which library implements the MLS protocol Wabi chose in ADR-0002. It changes no product code and adds no dependency to the Wabi workspace. It is stage 2 preparation only (ADR-0002 §7).
- **Decision in one line:** build on **mls-rs** (AWS), not OpenMLS, and keep the whole library behind one small Wabi-owned interface so the choice can be reversed cheaply if the facts change.

> **A note on words, because this is an encryption document.** Choosing a library is not a security claim. Nothing here says Wabi's encryption is secure, private, end-to-end, verified or audited. Wabi's conversation encryption is **experimental** (see `docs/ENCRYPTION_STATUS.md`), and it stays experimental after this decision and after the library is adopted. Picking a well-tested library is a starting point, not a result. AGENTS.md golden rule 13.

## How to read this

- Facts about **Wabi** or about **what I built and ran** are marked **[tested: how]** or **[measured]**.
- Facts about the **outside world** carry the URL they came from and the date I read it (all 2026-11-13).
- Anything I could not check against a primary source is marked **not verified** and is not used to decide anything.
- Jargon is explained the first time it appears, in a short line.

**What could not be reached.** From this environment, these hosts were refused by the network policy (the proxy returned 403, or DNS did not resolve): `rfc-editor.org`, `datatracker.ietf.org`, `openmls.tech`, `blog.openmls.tech`, `srlabs.de`, `docs.rs`, `rustsec.org`, `sovereign.tech`, `phnx.im`, `celabs.eu`. Where a fact depended only on one of these it is marked **not verified**. I did not route around the block. What *did* load: `crates.io` (API), `raw.githubusercontent.com`, `github.com` web pages (through a fetch tool, not the shell), and the IETF working-group's own GitHub repositories (`mlswg/mls-protocol`, `mlswg/mls-architecture`), which carry the RFC source text and let me verify the RFC claims that ADR-0002 had to leave unverified.

---

## 1. Plain summary (for a non-cryptographer)

**The choice, in two sentences.** Wabi will use **mls-rs**, a Rust implementation of the MLS encryption standard written and maintained by Amazon Web Services, under a licence Wabi is allowed to use. It fits a browser app and a single-ordering-server app like Wabi slightly better than the main alternative, OpenMLS, it is cleaner on Wabi's dependency-safety check today, and — the part that makes the decision safe — I proved by running them together that the two libraries speak the exact same protocol on the wire, so if mls-rs ever disappoints, switching to OpenMLS later is a change of one Wabi component, not a change of protocol or a migration of anyone's stored messages.

**Why (five points):**

1. **It runs in the browser more cheaply and is tested there the same way Wabi tests.** Both libraries work in a browser; mls-rs's browser bundle is about **1.7× smaller** (240 KB vs 418 KB compressed) and its own test suite runs in a real headless Chrome on every change. **[measured]**
2. **It passes Wabi's supply-chain gate today; OpenMLS does not.** Wabi runs a tool (`cargo deny`) that fails the build on known-vulnerable or wrongly-licensed dependencies. mls-rs passes cleanly in every configuration I tested. OpenMLS 0.9.2 fails on two advisories — including the exact timing-attack advisory (`RUSTSEC-2026-0387`) that Wabi's own `deny.toml` singles out as a permanent failure. OpenMLS has already fixed both in its development branch but has not released the fix. **[tested: `cargo deny` with Wabi's `deny.toml`]**
3. **Its "server that orders messages but cannot read them" is a built-in, first-class part of the library.** Wabi's server (WabiDB) is one ordered writer per community. mls-rs ships an `ExternalClient` type built for exactly that role; I wired it to a tiny stand-in for WabiDB and it checked and ordered membership changes without ever holding a key that could read a message. OpenMLS has an equivalent (`PublicGroup`) and it also worked, but mls-rs's is more obviously shaped for a delivery server. **[tested: prototype delivery service]**
4. **Its stored state has a version number and a regression test guarding it.** Wabi promises that data written today stays readable. mls-rs serializes group state with a format that carries a version field and keeps a test that loads an old stored snapshot. OpenMLS had a storage-format break in the past and now warns, loudly and in its own docs, that some storage formats can "silently shift the layout ... and corrupt existing data." Both passed my own old-version-to-new-version load test. **[tested: cross-version storage test]**
5. **The decision is reversible, which caps the risk of mls-rs's weaker spots.** mls-rs's weak spots are real — one dominant maintainer, no independent security audit yet, and frequent breaking releases. But because I proved the two libraries interoperate on the wire, and because Wabi will wrap the library behind one small interface, a later switch to OpenMLS is cheap. That turns "bet the project on one library" into "pick the better one now, keep the other as a spare."

**What is still unknown / could not be verified:**

- The **RFC publication dates** and the **OpenMLS security audit report** could not be read (hosts blocked). The audit's existence and its fixes are confirmed only indirectly, through OpenMLS's public GitHub security advisories.
- mls-rs has **no independent third-party security audit** (its own README says so). Neither library's own audit status decides anything for Wabi, because Wabi needs its *own integration* reviewed at ADR-0002 stage 3 regardless.
- mls-rs is **pre-1.0 (version 0.57) with no written stability policy and no changelog**. Its API churns between releases. This is managed below (§7), not waved away.
- Long-term maintenance of both projects depends on sponsors (AWS; and for OpenMLS, named companies and a public fund) whose future commitment no one can verify.

---

## 2. What was built and measured

I built a small throwaway prototype for **each** library, plus a cross-library test and a storage-compatibility test. **They are not in the current tree.** They were committed once, at commit `3e193fde96d039c84737673bfa47aadcfd5e1d13`, and removed in the next commit, so they live in git history only. Appendix B gives the exact commands to restore and re-run them. While they existed, each had its own `[workspace]` and lockfile, so they never touched Wabi's dependency tree, lockfile, `cargo deny` or CI. What stays in the tree is the evidence as plain text: the run outputs and the exact resolved dependency versions, in [`docs/architecture/adr-0003/results/`](adr-0003/results/). (Why history and not the tree: see Appendix B.)

Each prototype runs the **same scenario**: three clients form a group, exchange messages, race two simultaneous membership changes, refuse an outsider, add a fourth member, remove one, confirm the removed member cannot read later messages, let an offline member catch up over several changes, and save a device's state to bytes and reload it. The scenario is driven through a tiny in-memory stand-in for WabiDB that **orders** messages and **checks** membership commits using only their public parts.

**Machine and limits.** One cloud container: Intel Xeon @ 2.10 GHz, 4 vCPUs, 15 GiB RAM, Linux. Rust 1.93.1. Release builds with `opt-level = "s"`, LTO, one codegen unit. mls-rs was built **without** its optional `rayon` parallelism (closer to what a WASM build gets). These are not benchmark-grade conditions (a shared VM); treat every number as an order-of-magnitude, and read the medians, not the spread. Each timing is the **median of 3 runs**.

### 2.1 Did the scenario pass?

| | Native, suite 1 (X25519) | Native, suite 2 (P-256) | Browser (headless Chromium) |
|---|---|---|---|
| OpenMLS 0.9.2 | 10/10 pass | 10/10 pass | 10/10 pass (pure-Rust crypto) |
| mls-rs 0.57.1 (Rust crypto) | 10/10 pass | 10/10 pass | 10/10 pass |
| mls-rs 0.57.1 (WebCrypto) | n/a | n/a | 10/10 pass (suite 2 only) |

**[tested: `prototypes/mls-trial/{openmls-proto,mlsrs-proto}` at commit `3e193fde96d039c84737673bfa47aadcfd5e1d13`, scenario in `src/lib.rs`]** Browser runs used the pre-installed Chromium 153 via Playwright, serving the wasm over a local HTTP server. The full pass/fail output is in [`results/native-openmls.txt`](adr-0003/results/native-openmls.txt), [`results/native-mlsrs.txt`](adr-0003/results/native-mlsrs.txt) and [`results/browser.txt`](adr-0003/results/browser.txt).

### 2.2 Cross-library interoperability — the decisive test for reversibility

I put **both libraries in the same group at the same time**: alice and carol on one library, bob and dave on the other, and the delivery-service checker built on the library the group creator does *not* use. The group was created once with OpenMLS and once with mls-rs, each at suites 1 and 2.

**Result: 112 checks, 112 passed, 0 failed, both directions, both suites.** An OpenMLS client joined a group created by mls-rs from its Welcome message, decrypted mls-rs's application messages, processed mls-rs's add/remove commits, and vice versa; and a delivery service built on one library correctly ordered and validated commits produced by the other. **[tested: `prototypes/mls-trial/interop` at commit `3e193fde96d039c84737673bfa47aadcfd5e1d13`; output in [`results/interop.txt`](adr-0003/results/interop.txt); re-run from a restored copy on 2026-11-13 with the original lockfile, again 112/112]**

This is the single most important result in the document. It means a later switch between the two libraries is a **client-library change, not a protocol migration**: the bytes on the wire and the group state the server orders are RFC-9420 conformant on both sides, so one library's groups are the other library's groups.

### 2.3 Browser build size

Built with `wasm-bindgen --target web`, then size-optimised with `wasm-opt -Oz` (what a shipping build would do). Compression is what a web server would send.

| Build | raw `.wasm` after `-Oz` | gzip -9 | brotli -11 |
|---|---|---|---|
| OpenMLS (pure-Rust crypto) | 1,427,868 | 553,127 | **418,101** |
| mls-rs (pure-Rust crypto) | 782,997 | 315,283 | **240,803** |
| mls-rs (WebCrypto) | 773,488 | 308,460 | **239,807** |

**[measured]** mls-rs is about **1.7× smaller** compressed. For a browser-first app this is real: it is bytes every web visitor downloads before a conversation can start.

### 2.4 Speed (median of 3, milliseconds)

Selected rows; the raw runs for both suites and both environments are in [`results/`](adr-0003/results/). "create group of n" builds a group of that size in one commit; "remove 1" removes one member at that size.

**Native, suite 1 (X25519/AES-128 — the MLS mandatory-to-implement suite):**

| library | n | create group | member joins | add 1 (commit) | remove 1 (commit) | encrypt | decrypt |
|---|---|---|---|---|---|---|---|
| OpenMLS | 2 | 0.70 | 0.36 | 0.98 | 0.41 | 0.05 | 0.07 |
| mls-rs | 2 | 0.95 | 0.37 | 0.64 | 0.80 | 0.14 | 0.07 |
| OpenMLS | 100 | 25.9 | 8.1 | 4.8 | 4.6 | 0.06 | 0.08 |
| mls-rs | 100 | 28.6 | 7.5 | 1.5 | 16.7 | 0.13 | 0.08 |

**Browser (headless Chromium), suite 1:**

| library | n | create group | member joins | add 1 (commit) | remove 1 (commit) | encrypt | decrypt |
|---|---|---|---|---|---|---|---|
| OpenMLS | 2 | 2.0 | 1.1 | 1.9 | 1.6 | 0.20 | 0.19 |
| mls-rs | 2 | 2.6 | 0.8 | 1.4 | 2.1 | 0.34 | 0.18 |
| OpenMLS | 100 | 61.6 | 16.6 | 24.5 | 22.8 | 0.15 | 0.18 |
| mls-rs | 100 | 66.1 | 16.7 | 2.7 | 31.0 | 0.28 | 0.17 |

**Reading these honestly:** for Wabi's real sizes (DMs and small groups, n ≈ 2–10) both libraries do every operation in **single-digit milliseconds in the browser**, which is far below anything a person notices. Neither is "too slow." The differences only open up at n = 100 and they go both ways: mls-rs's *add* is much cheaper (its default add-only commit does not bundle a key update, so the message stays ~0.47 KB regardless of group size), while its *remove* is more expensive at large n. Suite 2 (P-256) is ~5–10× slower than suite 1 in the browser on both libraries, because P-256 runs in pure-Rust big-integer code rather than the optimised X25519 path — a reason to prefer the X25519 suite as Wabi's default where a browser is involved. **[measured]**

mls-rs's **WebCrypto** build (which hands the cryptography to the browser's own `SubtleCrypto`) was competitive on P-256 (create a pair in ~2.7 ms vs OpenMLS's 18 ms pure-Rust P-256), but it only offers the NIST P-curve suites, its own docs label it experimental, and it drove JS-heap use up (~12 MB at n = 100 vs ~2 MB for the pure-Rust builds) because of the async bridge. It is a future option, not the path to start on. **[measured]**

### 2.5 Stored state and message sizes

| | OpenMLS | mls-rs |
|---|---|---|
| Device state after the scenario | 13 storage entries, ~13 KB (suite 1) | group snapshot ~1.9 KB + 3 epoch records, ~3.1 KB |
| Welcome for a group of 100 | ~33 KB | ~29.5 KB |
| Add-one commit at n=100 | ~9.0 KB (includes a tree path) | ~0.47 KB (add only) |
| Stored state at n=100 | ~105 KB | ~43 KB |

**[measured]** Two caveats so the numbers are not misread: OpenMLS's "device state" is its *entire* key-value store (signer, key packages, group), while mls-rs's is the group snapshot plus epoch records — not strictly like-for-like. And OpenMLS's larger add-commit is because its `add_members` bundles a self-update (a fresh key for the committer) into the same commit; that is a defensible security default, not waste. mls-rs can be configured to do the same; its default does not.

---

## 3. OpenMLS in depth

Same headings as §4 so the two can be compared directly.

**What it is.** A Rust implementation of RFC 9420, the first and most widely cited one.

**Licence.** MIT. Source: the repo's `LICENSE` ("Copyright (c) 2020 OpenMLS Authors") and `openmls/Cargo.toml` (`license = "MIT"`), and the crates.io API, which reports MIT for every published version (https://crates.io/api/v1/crates/openmls, read 2026-11-13). MIT is on Wabi's allow-list in `deny.toml`. **[verified]**

**Maintainers and governance.** The README states: "OpenMLS is maintained and developed by Phoenix R&D (https://phnx.im) and CE Labs (https://celabs.eu)." `CODEOWNERS` is `@openmls/maintainers` with no named individuals, and there is no `GOVERNANCE` or `MAINTAINERS` file (read on `github.com`, 2026-11-13). From the git history of the repo clone (2026-11-13), the active authors over the last two years are a **broad group across several affiliations**: Konrad Kohbrok (`datashrine.de`), "wysiwys"/clara and Franziskus Kiefer (`cryspen.com`), raphaelrobert, Jan Winkelmann, and boxdot/Dimitri (`phnx.im`), among 41 distinct human authors. **[measured from git]** The companies' own sites (`phnx.im`, `celabs.eu`) did not load — **not verified**.

**Funding.** Search results (not the pages themselves — the hosts were blocked) attribute funding to the Sovereign Tech Fund / Sovereign Tech Agency, a German public-interest programme. **Not verified** (I could not load `sovereign.tech`).

**Release history and cadence (last 2 years).** 12 non-prerelease versions since 2024-11-13 (crates.io API, 2026-11-13): the 0.7 line (0.7.0 through 0.7.4, Jul 2025 – Feb 2026), the 0.8 line (0.8.0/0.8.1, Feb 2026; 0.8.2/0.8.3 as backports in Oct 2026), and the current 0.9 line (0.9.0 Aug 2026, 0.9.1 Oct 2026, 0.9.2 Oct 2026). No yanked releases. The 0.8 line is still being patched alongside 0.9, which is a sign of a project that back-ports security fixes. **[verified]**

**Activity.** 412 non-merge commits in the last 2 years, 243 in the last year, 154 in the last 6 months, from 21 distinct human authors in the last 6 months — a healthy, multi-person cadence. **[measured from git]** Open issues ~169; open PRs ~40 (closed ~1,359) (github.com, 2026-11-13). **[verified]**

**MSRV (minimum supported Rust version).** Published 0.9.x requires Rust 1.91 (crates.io API). The development branch has already raised this to 1.94 (its `Cargo.toml`, repo clone). Wabi pins Rust 1.93, so **0.9.2 fits, but the next release may not without a toolchain bump.** **[verified / measured]**

**Semver and breaking changes.** The project's book (`release_management.md`, in the repo clone) states it follows semver and ships a release-candidate at least a week before a minor or major release. Being pre-1.0, minor bumps are breaking; the 0.7→0.8→0.9 path shows regular breaking releases. **[verified from repo]**

**Interop testing.** OpenMLS is listed in the MLS working group's implementation list ("OpenMLS (Rust) ... Status: RFC", from `mlswg/mls-implementations` clone) and ships an `interop_client` (a gRPC server for the WG test runner). But **no CI workflow runs interop** — the interop client is only compiled, not exercised, in CI (its `.github/workflows`, repo clone). **[verified from repo]**

**Security audit.** An independent assessment by **SRLabs** is referenced widely. The report (`https://blog.openmls.tech/SRL-OpenMLS_security_assurance_assessment.pdf`) **did not load — not verified**. Search snippets describe a 41-page report with 1 high / 3 medium / 2 low / 2 informational findings, final version March 2026, with fixes in 0.8.1 and 0.7.3 — **not verified**. What *is* verified: OpenMLS maintains a public security-advisory process and has published and fixed real issues (next item).

**Known CVEs / advisories.** OpenMLS publishes GitHub Security Advisories (`github.com/openmls/openmls/security/advisories`, read 2026-11-13). Seven are listed, all with fixes:

| Advisory | Severity | Issue | Fixed in |
|---|---|---|---|
| GHSA-94v4-rg25-x625 | Moderate | Removed leaves reappear when an external commit regrows the tree | 0.9.2 / 0.8.3 |
| GHSA-p276-g3f3-wwgh | Low | Rejected private messages advance the sender ratchet | 0.9.2 / 0.8.3 |
| GHSA-gc79-23g3-8g52 | High | Unbounded recursion decoding nested extensions (DoS) | 0.9.1 / 0.8.2 |
| GHSA-w62v-gv48-63rh | Moderate | Quadratic pre-auth extension decoding | — |
| GHSA-rrmv-c79f-cf5r | Moderate | Out-of-bounds panic in `DeserializeBytes` (remote DoS) | 0.9.0 |
| GHSA-8x3w-qj7j-gqhf | High | Improper tag validation (truncated/empty tags accepted) | 0.7.2 / 0.8.0 |
| GHSA-qr9h-x63w-vqfm | Moderate | Improper secret-tree persistence | — |

**[verified from github.com]** This is not a mark against the library — it is what *healthy* security maintenance looks like: real bugs found (some by outside researchers, credited on the advisory pages), published, and fixed on both release lines. A library with an active advisory stream and an independent audit has had more eyes on it than one without.

**No RUSTSEC advisory** targets the `openmls` crate itself (the advisory database has no `crates/openmls` directory; checked 2026-11-13). **[verified]**

**Supply-chain check against Wabi's `deny.toml`.** This is the one place OpenMLS fails **today**. Running `cargo deny` with Wabi's own `deny.toml` against the OpenMLS prototype's lockfile gives **2 advisory errors** (licenses, bans and sources all pass):

- `RUSTSEC-2026-0387` — timing variability in `crypto-bigint 0.5.5`, pulled in through `p256`/`p384` (the pure-Rust crypto provider) and `openmls_basic_credential`. Fix is in `crypto-bigint ≥ 0.7.6`.
- `RUSTSEC-2026-0173` — `proc-macro-error2` unmaintained, pulled in through `hax-lib-macros → libcrux-sha3 → hpke-rs → openmls_rust_crypto`.

With the alternative **libcrux** crypto provider it is **worse** (5 advisory errors: the two above plus three panics in `libcrux-hmac-drbg 0.0.1` and `libcrux-kem 0.0.9`). **[tested: `cargo deny` with `/home/user/wabi/deny.toml`]**

Two things make this fair rather than damning: (1) the failures are entirely in the **crypto provider's transitive dependencies**, not OpenMLS's own code; (2) they are **already fixed in the development branch** — the repo clone's `openmls_rust_crypto` has moved `p256`/`p384` to 0.14 and `hpke-rs` to 0.8, and `libcrux_crypto` to `libcrux-hmac-drbg 0.0.2` — so the next OpenMLS release is likely to clear them. But `RUSTSEC-2026-0387` is the specific advisory Wabi's `deny.toml` comment says "stays a failure," so adopting OpenMLS 0.9.2 **today** would hard-fail Wabi's supply-chain gate. **[verified from deny.toml + tested]**

**Browser / WASM.** The README lists `wasm32-unknown-unknown` under "built but not tested" targets, and the `openmls-wasm` crate's own README calls itself an "Experiment ... a step on the way to proper Wasm support." However, the **core crate is tested on wasm32 in CI** (`tests.yml` runs `cargo test -p openmls --target wasm32-unknown-unknown -F js,js-test` under a Node-based runner). There is **no WebCrypto provider** — the only browser path is the pure-Rust `openmls_rust_crypto`. In my own runs the pure-Rust browser build passed the full scenario. **[verified from repo + tested]**

**Crypto providers.** `openmls_rust_crypto` (pure Rust: RustCrypto crates + `hpke-rs`) and `openmls_libcrux_crypto` (libcrux, at 0.0.x versions). Consumers can bring their own. Neither provider's README states a maturity level. **[verified from repo]**

**Storage.** A `StorageProvider<const VERSION>` trait, `CURRENT_VERSION = 1`. The book treats the storage provider as **trusted** (tampering is out of its threat model). Release 0.9.0 made self-describing serialization formats **mandatory** and fixed a bug (#2034) where "integer storage tags ... were changed, leading to incorrect deserializations"; a `0-8-1-storage-format` feature preserves 0.8.1 compatibility. The migration chapter warns plainly: with non-self-describing formats, "changes in struct layouts between openmls versions may silently shift the layout used for serialization, and corrupt existing data," and offers an export/import bridge (via `serde_json`) to migrate 0.7.4/0.8.1 data into 0.9.0. **[verified from repo]** This is the kind of stored-format fragility Wabi's "data written today stays readable" rule most needs to guard against — it is manageable (use a self-describing format, keep golden bytes) but it is a documented hazard.

**Post-quantum.** Furthest along in *exposing* PQ code: an XWing hybrid KEM (classical + post-quantum key agreement) via the libcrux provider, plus P-384, ML-DSA and the `draft-ietf-mls-pq-ciphersuites` v5 code points behind a feature flag (CHANGELOG + `traits/src/types.rs`, repo clone). All experimental and behind flags. **[verified from repo]**

**Who uses it (with a source).** Dependency manifests (read via `raw.githubusercontent.com`, 2026-11-13) show **Wire** (`wireapp/core-crypto`, "Abstraction over OpenMLS with persistent keystore") and **XMTP** (`xmtp/libxmtp`) depend on OpenMLS — but **both use their own forks** (`github.com/wireapp/openmls`, `github.com/xmtp/openmls`), not upstream. **Phoenix** (`phnx-im/air`) uses upstream OpenMLS at a pinned git revision. A manifest shows a dependency, not a production deployment, and the forks are a mild yellow flag about using upstream directly. **[verified from manifests]**

---

## 4. mls-rs in depth

**What it is.** A Rust implementation of RFC 9420 written and maintained by AWS, in the `awslabs` GitHub organisation.

**Licence.** Apache-2.0 OR MIT (dual). Source: `Cargo.toml` (`license = "Apache-2.0 OR MIT"`), the two `LICENSE-*` files, and the crates.io API for `mls-rs` and its provider crates (2026-11-13). Both licences are on Wabi's allow-list. **[verified]**

**Maintainers and governance.** `CODEOWNERS` is `* @awslabs/mls-rs-dev` (an AWS team), and every source file carries "Copyright Amazon.com, Inc. or its affiliates." `CONTRIBUTING.md` uses the Amazon Open Source Code of Conduct and routes security reports to AWS's vulnerability-reporting page. crates.io owners are `tomleavy` (Tom Leavy), `stefunctional` (Stephane Raux) and `mulmarta` (Marta Mularczyk) — their AWS employment is implied by the copyright and team name but is **not verified** from the owners API. I did **not** find a "not an officially supported AWS product" disclaimer in the README or on the repo page. **[verified from repo/github.com, except employment]**

**Activity and bus factor.** This is mls-rs's main weakness. Over the last 2 years: 135 non-merge commits, 23 distinct human authors; over the last 6 months: **33 commits from 8 authors, of which `mulmarta` alone made 21** (the next contributor made 4). **[measured from git]** So recent development is **concentrated in one maintainer**. Open issues ~32; open PRs ~5 (closed ~328); 262 stars (github.com, 2026-11-13). The project is active but materially less busy, and less broadly staffed, than OpenMLS.

**Funding and continuity.** A single corporate sponsor (AWS). There is no public grant or foundation. The strongest external continuity signal is a **production dependency**: the Firefox source tree vendors `mls-rs` (I loaded `third_party/rust/mls-rs/Cargo.toml` from `mozilla-firefox/firefox`, version 0.56.0, 2026-11-13) and Mozilla maintains an `mls-platform-api` wrapper and its own `mls-rs-crypto-nss` provider for it (`mozilla/mls-platform-api`, README: "Implementation of the MLS platform API for Firefox," 2026-11-13). A browser vendor shipping mls-rs to a very large user base, with its own crypto provider, is a powerful hedge against AWS walking away — and it is validation from a project with Wabi's exact browser-crypto problem. **[verified from manifests]**

**Release history and cadence (last 2 years).** 27 non-prerelease versions since 2024-11-13, from 0.43.0 (Nov 2024) to 0.57.1 (Nov 2026) — roughly one minor release a month. One version was yanked (0.55.3, Aug 2026). The development branch already reads 0.58.0 (unreleased). **[verified from crates.io API]** This frequent, breaking, pre-1.0 cadence is a double-edged fact: steady maintenance, but a moving target.

**MSRV.** 1.82.0 (crates.io API + `Cargo.toml`), comfortably below Wabi's 1.93. No written MSRV policy. **[verified]**

**Semver and breaking changes.** Pre-1.0 (0.x). I found **no written versioning or breaking-change policy** in the README, `CONTRIBUTING.md` or crate docs, and **no CHANGELOG file**; GitHub Releases appeared empty. Breaking changes between minor versions are frequent and undocumented in prose. **[verified — absence confirmed by search of the repo clone]** This is the single biggest day-to-day cost of choosing mls-rs and §7 addresses it directly.

**Interop testing.** mls-rs is in the WG implementation list ("mls-rs (Rust) ... Status: RFC"). Unlike OpenMLS, **mls-rs runs interop in CI on every PR**: `interop_tests.yml` checks out `mlswg/mls-implementations` at a pinned commit and runs the Go test-runner against mls-rs (with itself and reduced-feature builds), and it ships a gRPC interop harness and the WG test-vector JSONs. The README claims "100% RFC 9420 conformance with support for all default credential, proposal, and extension types." **[verified from repo]**

**Security audit.** The README's Security Notice states, verbatim: "This library has been validated for conformance to the RFC 9420 specification but **has not yet received a full security audit by a 3rd party**." (repo clone + github.com, 2026-11-13). So: **no independent audit** — a genuine deficit versus OpenMLS. Mitigating practices that *are* verified: **6 fuzz targets run on every PR** (`fuzz.yml`, `RUNS: 10000`), interop on every PR, and the RFC-conformance test vectors. **[verified from repo]**

**Known CVEs / advisories.** The GitHub security page lists **no published advisories** (github.com, 2026-11-13), and the RUSTSEC advisory database has **no `mls-rs` directory** (checked 2026-11-13; this is partly inferred — the full listing could not be paged to the "m" entries, but the specific `crates/mls-rs` path returned 404). "No known advisories" can mean fewer bugs or fewer eyes; given the no-audit status, read it conservatively. **[verified for GitHub; partly verified for RUSTSEC]**

**Supply-chain check against Wabi's `deny.toml`.** **mls-rs passes cleanly** — `advisories ok, licenses ok, bans ok, sources ok`, exit 0 — in **all three** configurations I tested: default (Rust crypto), the WASM build, and the WebCrypto build. The only noise is one duplicate-version warning (`syn`), which is a warning, not a failure. **[tested: `cargo deny` with `/home/user/wabi/deny.toml`]** A structural reason sits behind this: mls-rs ships its *own* crypto providers (`rustcrypto`, `awslc`, `webcrypto`, `openssl`) whose dependency trees it controls, rather than leaning on the fast-moving `libcrux`/`hpke-rs` stack. That is a supply-chain-hygiene advantage, not just a point-in-time accident.

**Browser / WASM.** First-class. The README lists "Support for WASM builds," and CI (`wasm_build.yml`) runs the **actual test suite in headless Chrome** (`wasm-pack test --headless --chrome`) for the main library, the Rust-crypto provider, the x509 crate **and** the WebCrypto provider. There is a real **WebCrypto provider** (`mls-rs-crypto-webcrypto`, 0.16.0) that uses the browser's `SubtleCrypto` — but its own README table marks it "⚠️ Experimental" and it supports only the NIST P-curve suites (2, 5, 7), not the mandatory X25519 suite. The pure-Rust provider works on wasm too (`browser` feature). There is no browser *example* in the repo; I wrote my own. **[verified from repo + tested]**

**Storage.** Three traits in `mls-rs-core`: `GroupStateStorage`, `KeyPackageStorage`, `PreSharedKeyStorage`. Group state is an opaque blob serialized with the **mls-codec** (TLS-style) encoding — `state_repo.rs` writes `snapshot.mls_encode_to_vec()`, `client.rs` loads with `Snapshot::mls_decode`. The `Snapshot` type carries a **`version: u16` field** (currently always 1), a `PendingCommitSnapshot` variant is annotated "This must be 1 for backwards compatibility," and a `legacy_interop` **test loads a stored `legacy_snapshot.mls` fixture** (added Jan 2025) — i.e. the project keeps a regression test that old stored state still decodes. There is a SQLite provider (`mls-rs-provider-sqlite`) whose default feature encrypts the database with SQLCipher. There is still **no written stability guarantee** for the stored format, but the version field, the TLS codec and the legacy test are more robust footing than a serde-layout that can silently shift. **[verified from repo]**

**Post-quantum.** PQ sits behind a `post-quantum` feature in `mls-rs-core` and `mls-rs-crypto-awslc` (built on `aws-lc-rs`'s "unstable" PQ), with private-range suite numbers (ML-KEM-512/768/1024 and an ML-KEM-768+X25519 hybrid) and an X-Wing combiner in `mls-rs-crypto-hpke`. The code comments note "So far, there are no official PQ cipher suites." PQ is available **only** through the AWS-LC provider — **not** the pure-Rust or browser path. **[verified from repo]**

**Who uses it (with a source).** **Firefox**, via `mozilla/mls-platform-api` and the vendored `third_party/rust/mls-rs` (verified from manifests, 2026-11-13). That is one concrete, verifiable, large-scale consumer — and, unlike the OpenMLS consumers, it depends on mls-rs through a thin wrapper rather than a fork, which is the same strategy §7 recommends for Wabi.

---

## 5. Side-by-side

| | OpenMLS 0.9.2 | mls-rs 0.57.1 |
|---|---|---|
| Licence | MIT | Apache-2.0 OR MIT |
| Passes Wabi `deny.toml` **today** | **No** (2 advisory errors in the crypto provider's deps; fixed in git, unreleased) | **Yes** (clean in all 3 configs) **[tested]** |
| Governance | Two named companies (Phoenix R&D, CE Labs/Cryspen) + public fund (unverified) | AWS (single sponsor) |
| Contributor breadth (last 6 mo) | 21 human authors, 154 commits | 8 authors, 33 commits — **one dominant** |
| Independent security audit | Yes — SRLabs (report **not verified**; fixes confirmed via advisories) | **No** (README says so) |
| Public advisory process | Yes — 7 advisories, all fixed, some outside-reported | None published |
| Continuous fuzzing / interop in CI | Fuzzing yes; interop **not** run in CI | Fuzzing yes; **interop run on every PR** |
| Browser bundle (brotli) | 418 KB | **240 KB** (1.7× smaller) **[measured]** |
| Browser crypto options | Pure-Rust only | Pure-Rust **and** a WebCrypto provider (experimental, P-curves only) |
| Browser tested in CI | Core crate on wasm (Node runner) | Full suite in **headless Chrome** |
| Server-as-delivery-service API | `PublicGroup` (works) | `ExternalClient` (purpose-built; works) **[tested]** |
| Stored-format robustness | Serde layout; past break (#2034); "may silently corrupt" warning; migration bridge | TLS codec + version field + legacy regression test |
| Cross-version load (old→current) | Passed (0.7.4 and 0.8.1 → 0.9.2) **[tested]** | Passed (0.50.1 → 0.57.1) **[tested]** |
| Post-quantum exposure | Further along (XWing/ML-KEM/ML-DSA behind flags) | Behind a flag, AWS-LC-only, not in the browser path |
| Semver / changelog | Semver, RC before releases, book documents policy | **No written policy, no changelog**, frequent breaking 0.x releases |
| MSRV | 1.91 (dev branch 1.94 > Wabi's 1.93) | 1.82 |
| Verified production user | Wire, XMTP (both **forks**); Phoenix (upstream) | **Firefox** (upstream, via wrapper) |
| Speed at Wabi's sizes (n≤10) | single-digit ms in browser | single-digit ms in browser |
| Wire-format interop with the other | **Proven both ways, 112/112** **[tested]** | **Proven both ways, 112/112** **[tested]** |

---

## 6. The long-term argument

This is the part the owner asked for most, so it is argued, not just tabulated.

The owner wants "something that lasts." For a self-hosted FOSS communications app, two things threaten "lasts": the library becoming **unmaintained** (you are stuck, or forced to switch under pressure), and the library having a **latent flaw** (you ship something broken). I weigh both, plus the five dimensions the task named: maintenance, governance, storage stability, browser path, switch cost.

**Switch cost comes first, because it changes everything else.** I proved (112/112, §2.2) that OpenMLS and mls-rs interoperate on the wire and on the ordered server state: one library's groups *are* the other's. So the question is **not** "which library do we marry for a decade." It is "which do we start with, keeping the other as a drop-in spare." That single fact deflates the usual dominant risk in this kind of decision — vendor lock-in — to near zero, provided Wabi keeps the library behind a thin interface (§7). Every other long-term worry should be read through this lens: a worry you can escape in one bounded code change is a managed risk, not a trap.

**Maintenance and governance cut toward OpenMLS.** OpenMLS has more contributors, more affiliations, a public-interest funder, an independent audit, and a live advisory stream. mls-rs is more concentrated: one dominant recent maintainer, one corporate sponsor, no audit. On a naive "which project is more robust in the abstract" question, OpenMLS wins this axis, and I will not pretend otherwise.

**But three things pull the *net* long-term judgement toward mls-rs:**

1. **The browser is Wabi's front door, and mls-rs is lighter and tested there the way Wabi tests.** Wabi is browser-first. mls-rs ships a 1.7×-smaller bundle and runs its full suite in real headless Chrome in CI; its storage and delivery-service pieces are shaped for a web client talking to one ordering server. OpenMLS's browser story works but is self-described "experimental," bigger, and pure-Rust-only. For an app whose main client is a web page, the lighter, browser-proven library is the one that "lasts" in the way that matters to users.

2. **mls-rs clears Wabi's own supply-chain gate; OpenMLS does not, today, on the exact advisory Wabi treats as non-negotiable.** `deny.toml` names `RUSTSEC-2026-0387` as a permanent failure, and OpenMLS 0.9.2 trips it (via its crypto provider's `crypto-bigint`/`libcrux` stack); mls-rs passes clean because it owns its crypto providers' dependency trees. This is partly timing — OpenMLS has the fix in git — but it reflects a durable structural difference in how each project manages its dependency surface, and "the one I can adopt without disabling my own safety rule" is a legitimate long-term signal, not a gotcha.

3. **Firefox is a stronger continuity hedge than it first appears, and it validates Wabi's exact use.** The scariest long-term scenario for mls-rs is "AWS loses interest and the one maintainer leaves." But Mozilla ships mls-rs in Firefox *through a thin wrapper with its own crypto provider* — a browser vendor, with Wabi's exact browser-crypto problem, betting on mls-rs and carrying maintenance weight of its own. That is at least as durable as grant funding, and it is independent of AWS. Meanwhile OpenMLS's own heaviest users (Wire, XMTP) run **forks**, which quietly says upstream-as-is was not enough for them.

**Storage stability is a slight edge to mls-rs** (version field + TLS codec + legacy regression test, versus a serde layout that has broken once and carries a "may silently corrupt" warning), and both passed my cross-version load test, so neither is disqualifying for "data written today stays readable."

**Put together:** OpenMLS is the more broadly-governed, already-audited project in the abstract; mls-rs is the better *fit for Wabi specifically* — browser, supply-chain, delivery-service, storage codec — and its abstract weaknesses (one maintainer, no audit, 0.x churn) are each bounded by a concrete, verified mitigation (Firefox's stake; Wabi's own stage-3 audit, which reviews the *integration* regardless of which library it wraps; and the thin wrapper + pinning + golden-byte tests). Because the switch cost is proven low, choosing the better-fit library now and keeping the broader-governed one as the documented fallback is the decision that most serves "something that lasts."

## 7. The choice, and what would reverse it

**Decision: adopt `mls-rs` (Apache-2.0 OR MIT) as Wabi's MLS library for the server, the desktop app, the terminal client, and the browser (as WASM), starting from the pure-Rust `mls-rs-crypto-rustcrypto` provider. Default cipher suite: X25519/AES-128 (suite 1, the MLS mandatory-to-implement suite), which is also the fastest browser path.**

**Mitigations, to be built with the integration (not optional):**

1. **One small Wabi-owned interface.** Wrap mls-rs behind a single Wabi crate (working name `wabi-mls`) exposing only what Wabi needs: create/join group, add/remove member, encrypt/decrypt, serialize/restore device state, and the server-side "observe and validate a commit" operation. No mls-rs type appears outside that crate. This is what makes the proven reversibility real — a switch to OpenMLS touches one crate. (Firefox does exactly this with `mls-platform-api`.)
2. **Pin exact versions** (`=0.57.1` style) and upgrade deliberately, reading the diff each time, because mls-rs has no changelog. Keep the trial's `cargo deny` result green on every bump.
3. **Golden-byte tests of stored state.** Capture bytes written by the adopted mls-rs version and assert they still load after every upgrade — Wabi's own regression test for "data written today stays readable," not relying on mls-rs's (real but unguaranteed) format stability. This dovetails with AGENTS.md golden rule 5 (versioned/dual-decode for durable records).
4. **Keep the OpenMLS prototype as the documented fallback, in git history.** The interop proof (§2.2) is the evidence that the fallback is cheap. The prototype is preserved at commit `3e193fde96d039c84737673bfa47aadcfd5e1d13` (Appendix B). If a switch is ever seriously considered, restore it and re-run the interop and storage tests first. Expect to update versions: nothing builds or tests this code, so it will age.

**Concrete triggers that would reverse this to OpenMLS (or re-open the decision):**

- mls-rs goes **6 months with no release and no substantive commit**, or its dominant maintainer departs with no replacement, *and* Firefox drops or forks it.
- A mls-rs release **breaks stored-state loading** without a migration path, and the project declines to provide one.
- mls-rs's `cargo deny` status **fails and stays failing** across two releases while OpenMLS is clean.
- OpenMLS ships a release that **passes Wabi's `deny.toml`** (its fixes are already in git) *and* a published, independent audit of its **browser/WASM** path appears, *and* mls-rs still has no audit — at which point the audit+governance edge plus a clean supply chain could outweigh the fit advantages. (This would be a re-evaluation, not an automatic switch.)
- Wabi's needs change such that **post-quantum in the browser** becomes near-term: today neither library offers PQ on the pure-Rust browser path, but OpenMLS is further along exposing PQ suites, so a hard PQ-in-browser requirement should re-open the comparison.

## 8. Risks that remain with mls-rs, and how Wabi limits them

| Risk | Limit |
|---|---|
| **One dominant maintainer / single corporate sponsor** | Thin wrapper (reversible to OpenMLS, proven); Firefox's independent production stake; the fallback is documented, not hypothetical. |
| **No independent third-party audit** | Wabi's ADR-0002 **stage 3** audits Wabi's *integration* regardless of library; until then the label stays "experimental"; rely on mls-rs's fuzzing + interop + RFC conformance, not on an audit that doesn't exist. |
| **No semver policy, no changelog, frequent breaking 0.x releases** | Pin exact versions; upgrade deliberately with a read of the diff and a green `cargo deny`; the wrapper localises breakage to one crate. |
| **Stored-format stability is practised but not guaranteed** | Golden-byte tests owned by Wabi (mitigation 3); prefer the stable TLS-codec snapshot; never persist mls-rs types directly in a Wabi durable record without the wrapper's own versioning (golden rule 5). |
| **WebCrypto provider is experimental and P-curve-only** | Start on the pure-Rust provider (suite 1); treat WebCrypto as a later, measured option, not a dependency. |
| **No PQ on the browser path** | Not a near-term requirement (ADR-0002 makes no PQ promise); re-open if it becomes one (a §7 trigger). |
| **MSRV / toolchain drift** | mls-rs MSRV 1.82 is well under Wabi's 1.93; watch it on upgrades (this bit OpenMLS, whose dev branch wants 1.94). |

Nothing in this table is a claim that Wabi's encryption is secure. Every item is a code-quality and longevity control.

## 9. What stage 2 of ADR-0002 should do first

Given mls-rs, the first concrete steps of stage 2 (ADR-0002 §7), in order:

1. **Create the `wabi-mls` wrapper crate** with the interface in §7.1 and *nothing* leaking mls-rs types. Port the prototype's delivery-service checks (`ExternalClient`-based; `mlsrs-proto/src/lib.rs` at commit `3e193fde96d039c84737673bfa47aadcfd5e1d13`, see Appendix B) into the shape WabiDB will call. Write them as new, reviewed Wabi code with tests; do not copy the prototype in unchanged. This is the reversibility guarantee; build it first.
2. **Map the MLS message flow onto WabiDB's single sequenced writer.** A group's commits are ordered by WabiDB exactly as the MLS architecture document requires of a "strongly consistent" Delivery Service (§A). The server validates each commit's public parts (sender, epoch, membership, tree) via the wrapper's observe-operation **without holding any key that can read content** — the prototype shows this works; keep the membership-revision cross-check from the v1 server boundary (ADR-0002 §5 (ii)).
3. **Define what the server stores:** MLS KeyPackages (published per-device keys, single-use) and ordered group messages, replacing v1's `devices`/wrapped-copies registry. Carry over the plaintext-refusal boundary, the opaque-upload shape, the no-downgrade rule and the pending/server-readable policy — most of `dm_encryption_contract.rs` is about those and stays valid (ADR-0002 §5 (ii)).
4. **Golden-byte storage tests** for the chosen mls-rs version before any feature work builds on stored state.
5. **Per-file attachment keys:** keep v1's chunked file encryption but give each file a fresh key carried inside the MLS message, not the group key (ADR-0002 §5 (ii) design note).
6. **Credentials and multi-device:** each device is a leaf presenting a BasicCredential now; design the user-identity cross-signing (ADR-0002 A2) as a credential the wrapper issues, so stage-1 verification and stage-2 cross-signing share one identity key. (API points exist: mls-rs `SigningIdentity`/`Client::builder().signing_identity(...)`; a custom `IdentityProvider` is where cross-signing validation would live.)
7. Only then: the terminal client gains encryption for the first time via the same `wabi-mls` crate, and v1 is retired (ADR-0002 §9 answer 8).

---

## Appendix A: RFC facts (verified from the working-group source)

ADR-0002 had to mark these "not verified" because the RFC hosts would not load. This time I read the **working-group's own GitHub repositories**, which hold the RFC source text.

- **RFC 9420 (the MLS protocol).** Source: `mlswg/mls-protocol`, commit `1a441b8` "Final changes for RFC 9420 (#885)", dated 2023-07-18; file `rfc9420.md`, `category: std`. The abstract reads, verbatim: "we specify a key establishment protocol that provides efficient asynchronous group key establishment with **forward secrecy (FS) and post-compromise security (PCS) for groups in size ranging from two to thousands**." The introduction: the protocol lets members "derive and update shared keys with **costs that scale as the log of the group size**." **[verified from repo]** The *publication date* as an RFC (commonly cited July 2023) is consistent with the "Final changes" commit but the RFC-editor page itself is **not verified** (host blocked).
- **RFC 9750 (the MLS architecture).** Source: `mlswg/mls-architecture`, `rfc9750-draft.xml`, `number="9750" category="info"`, dated February 2025. On the Delivery Service (the server's role): "these properties **do not depend on correct behavior by the DS; even a malicious DS cannot add itself to groups or recover the group key**. However ... the DS may be able to determine group membership or prevent changes to the group from taking place." On ordering: "the group must agree on a single MLS Commit message that ends each epoch and begins the next one," and in the strongly-consistent model "the **Delivery Service is trusted to break ties** when two members send a Commit message at the same time" — clients "apply the first valid Commit for an epoch and ignore subsequent Commits." **[verified from repo]** This is exactly WabiDB's single-sequenced-writer role, and why §7 can map Wabi's server onto MLS without the server being able to read anything.
- **Post-quantum / hybrid suites.** A working-group draft (`draft-ietf-mls-pq-ciphersuites`) exists; its status and revision could not be verified (datatracker blocked). Both libraries implement PQ code behind flags (§3, §4). No PQ promise is made here.

## Appendix B: Where the prototypes are, and how to re-run them

**Where they are.** The prototypes are **not in the current tree**. They were committed at

`3e193fde96d039c84737673bfa47aadcfd5e1d13`

on the branch `claude/mls-library-trial`, and removed in the commit after it. This PR is merged with a merge commit, so that commit stays in `main`'s history and the code can be restored at any time.

**Why history and not the tree.** Three reasons, decided before merge:
1. GitHub's dependency graph reads every `Cargo.toml` and `Cargo.lock` on the default branch. The prototypes' lockfiles include old OpenMLS releases and the tree that trips `RUSTSEC-2026-0387`, which would raise Dependabot alerts and update PRs against code nobody runs.
2. Code scanning would scan it too.
3. The owner does not want code in the tree that is meant to be thrown away.

What stays in the tree is everything a reader needs to check the claims without building anything:
- the run outputs, in [`adr-0003/results/`](adr-0003/results/);
- the exact resolved versions of every dependency each prototype used, in [`resolved-versions.txt`](adr-0003/results/resolved-versions.txt), taken with `cargo tree` before removal.

**Not maintained.** Nothing in CI builds or tests this code. It is pinned to the November 2026 releases and will age: crates get yanked, toolchains move on, and advisories are published. A future re-run may need version updates first. That is expected, and it does not change the recorded results.

**Restore.** The commands below were tested on 2026-11-13 from a fresh restore, with the original lockfiles. Restore to a directory **outside** the repository, so nothing lands in the working tree by accident:

```bash
# from the root of a Wabi clone
mkdir -p /tmp/mls-trial
git archive 3e193fde96d039c84737673bfa47aadcfd5e1d13 prototypes/mls-trial | tar -x -C /tmp/mls-trial
cd /tmp/mls-trial/prototypes/mls-trial
export CARGO_TARGET_DIR=/tmp/mls-trial-target   # build output stays out of the clone
```

Alternatively, `git checkout 3e193fde96d039c84737673bfa47aadcfd5e1d13 -- prototypes/mls-trial` puts the files back inside the clone. If you use that, do not commit them, and remove them afterwards with `git rm -r --cached prototypes && rm -rf prototypes`.

To read a single file without restoring anything: `git show 3e193fde96d039c84737673bfa47aadcfd5e1d13:prototypes/mls-trial/interop/src/main.rs`.

**Re-run the interop test (§2.2)** from the restored copy:

```bash
cd /tmp/mls-trial/prototypes/mls-trial/interop
cargo run --release --locked
# expect 112 lines starting with PASS and none starting with FAIL
```

**Re-run the storage test (§2, point 4)**, which writes with an older release, loads with the current one, and replies:

```bash
cd /tmp/mls-trial/prototypes/mls-trial/storage-compat
./run.sh
# expect five "--- old-... -> ..." blocks, each ending "bob read the reply from the upgraded alice"
```

**Other runs** (same restored copy; details in its `README.md`):
- Scenario and benchmarks: `cd openmls-proto && cargo run --release --locked -- 2 10 100`, and the same in `mlsrs-proto`.
- Browser: build each crate for `wasm32-unknown-unknown` (`--features wasm`; for mls-rs WebCrypto, `RUSTFLAGS="--cfg mls_build_async"` with `--no-default-features --features webcrypto`), run `wasm-bindgen --target web` (0.2.130) and `wasm-opt -Oz`, then `node web/run.mjs <dir> 2 10 100`.
- Supply-chain check: `cargo deny --config <wabi-clone>/deny.toml check advisories licenses bans sources` in a prototype directory. Today's results are in [`cargo-deny-openmls.txt`](adr-0003/results/cargo-deny-openmls.txt) and [`cargo-deny-mlsrs.txt`](adr-0003/results/cargo-deny-mlsrs.txt).
