#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# Wabi CI — single source of truth
# Runs on: Ronin's master box (by hand), co-dev's box (by hand),
#         GitHub Actions cloud runner (PR gate via .github/workflows/ci.yml)
#
# Safety guarantees (non-negotiable):
#   - Never reads or writes data/, .env, or target/release/wabi-server
#   - cargo test writes only to target/ (per-crate) and tempfile temp dirs
#   - npm ci writes only to frontend/node_modules (never mutates the lockfile)
#   - bun test + svelte-check read frontend/src, never data/ or .env
#   - GitHub Actions checks out a fresh temp dir per run — your dirty tree
#     (modified files / untracked WIP) is never involved
#
# Toolchain:
#   rust-toolchain.toml pins the Rust channel (read by rustup automatically)
#   frontend/package-lock.json is the canonical frontend lockfile (npm-built)
# ------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- 1. Toolchain gate ---
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: 'cargo' not found. Install Rust: https://rustup.rs"
  echo "After install, re-run: bash scripts/ci.sh"
  exit 1
fi

if [ -f rust-toolchain.toml ]; then
  echo "==> rust-toolchain.toml present (channel pinned)"
else
  echo "WARNING: rust-toolchain.toml missing — toolchain may float"
fi

# --- 2. Cargo check (fast smoke — catches compile errors early) ---
echo "==> cargo check --workspace"
cargo check --workspace

# --- 3. Frontend install + checks (only if frontend/ exists) ---
FRONTEND_DIR="$REPO_ROOT/frontend"
if [ -d "$FRONTEND_DIR" ]; then
  cd "$FRONTEND_DIR"

  if command -v npm >/dev/null 2>&1; then
    echo "==> npm ci (frontend — canonical lockfile is package-lock.json; no fallback)"
    npm ci --no-audit --no-fund
  else
    echo "ERROR: 'npm' not found. Skipping frontend checks."
    cd "$REPO_ROOT"
    exit 1
  fi

  # --- 4. Frontend unit tests (bun test, runs against installed node_modules) ---
  if command -v bun >/dev/null 2>&1; then
    echo "==> bun test src/lib (frontend unit tests)"
    bun test src/lib
  else
    echo "WARNING: 'bun' not found — skipping bun test (npm install worked, tests skipped)"
  fi

  # --- 5. Svelte type/lint check (fails on real errors, ignores warnings) ---
  if command -v bun >/dev/null 2>&1; then
    echo "==> bun run check (frontend svelte-check)"
    bun run check -- --threshold 1
  else
    echo "WARNING: 'bun' not found — skipping svelte-check"
  fi

  cd "$REPO_ROOT"
else
  echo "WARNING: frontend/ not found — skipping frontend checks"
fi

# --- 6. Full Rust test suite (all crates; wabidb crash/power-loss/property tests
#     run in tempfile temp dirs — never touch real data/) ---
echo "==> cargo test --workspace"
cargo test --workspace

echo "==> ALL CHECKS PASSED"
