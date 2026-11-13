# MLS library trial (ADR-0003)

Throwaway prototypes behind [`docs/architecture/ADR-0003-mls-library-choice.md`](../../docs/architecture/ADR-0003-mls-library-choice.md),
which compares the two Rust MLS (RFC 9420) libraries, **OpenMLS** and **mls-rs**, and
chooses mls-rs for Wabi's long term.

**This is not Wabi code.** None of it is reviewed, none of it ships, and it adds no
dependency to Wabi. Each crate declares its own `[workspace]` and keeps its own
`Cargo.lock`, and `prototypes/` is excluded from the root Cargo workspace, so this
trial cannot touch Wabi's lockfile, `cargo deny` or CI. Versions are pinned (`=x.y.z`)
so the recorded numbers reproduce. It exists so the owner (and any later reader) can
re-run the evidence rather than take the ADR's word for it.

## Layout

| Dir | What it is |
|---|---|
| `openmls-proto/` | OpenMLS 0.9.2: the scenario + benchmark, as a lib shared by a native binary and a WASM build. |
| `mlsrs-proto/` | mls-rs 0.57.1: the same scenario + benchmark. One source, built sync (native, pure-Rust WASM) or async (WebCrypto WASM). |
| `interop/` | Both libraries in one group at once, + a delivery service built on each. Proves wire-format interoperability (the reversibility argument). |
| `storage-compat/` | Writes group state with an older release, loads it with the current one, reads a reply back on the old release. Proves stored state survives an upgrade. |
| `web/` | Playwright harness that runs the WASM builds in headless Chromium and records scenario pass/fail, timings, bundle behaviour and memory. |
| `results/` | The actual run outputs quoted by the ADR. |

## The scenario (same for both libraries)

Three clients form a group, exchange messages, **race two simultaneous commits** (the
server takes the first, refuses the second), **refuse an outsider's commit** reading only
public fields, add a fourth member, remove one, confirm the **removed member cannot read
later messages**, let an **offline member catch up** over several commits, and **save a
device's state to bytes and reload it**. It is driven through a tiny in-memory stand-in
for WabiDB that *orders* messages and *validates* membership commits using only their
public parts — never a key that could read content.

## Running

Needs Rust (1.93 was used) with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli`
0.2.130, `wasm-opt` (binaryen), and the preinstalled Playwright/Chromium for the browser
run. Build output is large, so point Cargo at a scratch dir outside the repo:

```bash
export CARGO_TARGET_DIR=/tmp/mls-trial-target   # keep build output out of the repo

# Native scenario (suites 1 and 2) + benchmarks for sizes 2, 10, 100:
( cd openmls-proto && cargo run --release -- 2 10 100 )
( cd mlsrs-proto   && cargo run --release -- 2 10 100 )

# Cross-library interop (both directions, both suites):
( cd interop && cargo run --release )

# Old-version -> current-version stored-state load:
( cd storage-compat && CARGO_TARGET_DIR=$CARGO_TARGET_DIR ./run.sh )

# Browser: build each WASM variant, then drive them in headless Chromium.
( cd openmls-proto && cargo build --release --lib --target wasm32-unknown-unknown --features wasm )
( cd mlsrs-proto   && cargo build --release --lib --target wasm32-unknown-unknown --features wasm )
( cd mlsrs-proto   && RUSTFLAGS="--cfg mls_build_async" cargo build --release --lib \
    --target wasm32-unknown-unknown --no-default-features --features webcrypto )
# then wasm-bindgen --target web each .wasm into web-out/<name>/, wasm-opt -Oz, and:
( cd web && node run.mjs <dir-with-harness.html-and-builds> 2 10 100 )

# Supply-chain check against Wabi's own policy:
( cd mlsrs-proto   && cargo deny --config ../../../deny.toml check advisories licenses bans sources )
( cd openmls-proto && cargo deny --config ../../../deny.toml check advisories licenses bans sources )
```

Numbers were taken on a shared cloud VM (4 vCPU Xeon @2.10 GHz); treat them as
orders of magnitude, and prefer the medians in the ADR over any single run.
