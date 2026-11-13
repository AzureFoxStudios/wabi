---
name: wabi-run-tests
description: Use when running or interpreting Wabi's Rust or frontend tests, especially in a sandbox with a small disk, no IPv6, a root user or a restrictive proxy.
---

# Running Wabi tests

What CI runs, how to run the same locally without filling the disk, and which
failures come from the environment rather than the code.

## What CI runs

`.github/workflows/ci.yml` (on push to `main` and every PR):

| Job | Runs |
|---|---|
| `test` | `python3 scripts/check-runtime-files.py`; `python3 -m unittest discover -s scripts/tests -p 'test_*.py'`; `npm ci` in `frontend/`; `bun test --isolate src/lib`; `bun run check`; `STATIC_BUILD=1 npm run build` (+ `test -f build/index.html`); `cargo check --workspace`; `cargo test --workspace`; then backup/restore and retention smokes (`scripts/authority-backup-restore-smoke.mjs`, `scripts/authority-retention-smoke.mjs`) against `target/debug/wabi-server` |
| `features-full` | frontend static build, `cargo check --locked -p wabi-server --features full`, `cargo test --locked -p wabi-server --features wabi-lore --lib -- lore`, and each `core/crates/wabi-server/tests/lore_*.rs` plus `wabi_sync_contract.rs` with `--features wabi-lore --test <name>` (they are `#![cfg(feature = "wabi-lore")]`, so the workspace run compiles them to nothing) |
| `power-loss` | `cargo test --locked -p wabidb --features test-harness --lib tests::power_loss -- --ignored`, then `cargo test --locked -p wabidb --features test-harness --lib` (crash-injection tests are `#[ignore]` and need the feature; no other job runs them) |
| `container-install` | Docker image build + `scripts/authority-compose-smoke.mjs` |
| `supply-chain` | `scripts/security/*` pin, lifecycle-script and audit gates |

`.github/workflows/build.yml` adds `build-server` (static frontend build,
`cargo test --locked --workspace`, release build, a `GET /` smoke on port 3199,
retention and desktop-host smokes) and `frontend-checks` (`npm ci`,
`bun test --isolate src/lib`, a `TZ=America/New_York` calendar test, static
build, `scripts/pwa-production-smoke.mjs` under `xvfb-run`). Other workflows in
`.github/workflows/` cover specific areas (voice, reader, Lore UI, Tauri, …).

Toolchain: `rust-toolchain.toml` pins Rust 1.93; CI uses Node 22.23.4 and Bun
1.4.4. Use the pinned toolchain, not a newer local one (AGENTS.md).

## Rust locally on a small disk

```bash
mkdir -p frontend/build   # wabi-server embeds frontend/build (rust_embed); an empty dir lets it compile
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --locked -p wabi-server --no-fail-fast
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --locked --workspace --no-fail-fast
```

- `--no-fail-fast` so one failing target does not hide the others.
- A `wabi-server` test build is about 8 GB in `target/`. Delete `target/`
  between big builds (for example before a `--features full` or `--release`
  build) if the disk is near its limit.
- Never commit `frontend/build` (it is git-ignored). With an empty one, the
  tests that need the real SPA fail; see the list below. For those, build it:
  `cd frontend && STATIC_BUILD=1 npm run build`.
- Run a single target the way the error line tells you, e.g.
  `cargo test -p wabi-server --test channel_access_contract`.

## Known environment-only failures (`cargo test -p wabi-server`)

Measured on `main` (2026-11-13) as root, without IPv6, with an empty
`frontend/build`. Unit tests appear twice (in `--lib` and `--bin wabi-server`).

| Needs | Test |
|---|---|
| real frontend build | `anchor::tests::anchor_serves_embedded_immutable_assets_locally_and_forwards_missing_versions` |
| real frontend build | `app_router::embedded_immutable_tests::only_exact_public_immutable_paths_are_local` |
| real frontend build | `rate_limit::tests::cold_boot_assets_do_not_exhaust_the_unmatched_allowance_but_missing_versions_do` |
| real frontend build | `boot_brand_injection`: `brand_json_cannot_break_out_of_script`, `injects_brand_into_index_and_deep_links`, `publication_with_unchanged_mtime_cannot_pin_stale_branding`, `recomposes_when_policy_changes`, `rejects_non_hex_accent`, `stock_server_serves_untouched_shell`, `sw_and_manifest_revalidate` (before the missing-web-app `503`, this one passed vacuously on an empty build) |
| IPv6 (`::1`, os error 97) | `listener::tests::explicit_ipv6_loopback_is_preserved` |
| non-root user | `channel_access_contract::failed_retention_write_preserves_policy_and_rolls_back_new_channel` |
| non-root user | `recovery_peer_operator_contract::allocated_cleanup_failure_closes_admission_and_restart_refuses_remnants` |

**A failure not on this list is real** until you show otherwise. Read its
panic message; do not assume it is the environment.

## Frontend

```bash
cd frontend
npm ci --no-audit --no-fund   # what CI uses (package-lock.json); or `bun install`
bun test --isolate src/lib    # what CI runs (also `bun run test`)
bun run check                 # svelte-kit sync && svelte-check
```

- `xlsx` comes from a tarball URL (`https://cdn.sheetjs.com/xlsx-0.20.3/...`
  in `package.json`). Some proxies refuse it (`bun install` stops with
  `ProxyConnectFailed (403) downloading tarball xlsx@…`). Then:
  `bun run check` reports exactly 4 errors, all `Cannot find module 'xlsx'`
  in `src/lib/workspaces/sheets/fileAdapter.ts` and `fileAdapter.test.ts`;
  `bun test` fails only `src/lib/workspaces/sheets/fileAdapter.test.ts`.
  Anything else is real.
- Browser smokes live in `frontend/scripts/*-smoke.mjs` (and `*-checks.mjs`).
  Most launch Playwright Chromium with `headless: false` and
  `executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH`; CI sets it to
  Playwright's Chromium and runs under `xvfb-run -a`. A few scripts read other
  variables (`WABI_CHROMIUM_PATH`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`,
  `READER_CHROMIUM_PATH`): check the script header.

## Rules

- Never skip, `#[ignore]`, weaken or delete a test to get green. Fix the code
  or report the failure with its output.
- A claim that UI works needs a real browser run (AGENTS.md rule 7); unit tests,
  `svelte-check` and HTTP probes are not visual proof.
- Report which tests you did not run (for example `power-loss` or
  `features-full`) instead of implying CI coverage.
