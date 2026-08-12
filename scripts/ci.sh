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
#   - bun install writes only to frontend/node_modules + bun.lockb
#   - GitHub Actions checks out a fresh temp dir per run — your dirty tree
#     (modified files / untracked WIP) is never involved
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

# --- 2. Cargo check (fast smoke) ---
echo "==> cargo check --workspace"
cargo check --workspace

# --- 3. Frontend deps (deterministic after bun.lockb committed) ---
FRONTEND_DIR="$REPO_ROOT/frontend"
if [ -d "$FRONTEND_DIR" ]; then
  cd "$FRONTEND_DIR"

  if command -v bun >/dev/null 2>&1; then
    echo "==> bun install (frontend)"
    bun install
  else
    echo "ERROR: 'bun' not found. Install: https://bun.sh"
    echo "Skipping frontend checks."
    cd "$REPO_ROOT"
    exit 1
  fi

  # --- 4. Frontend unit tests ---
  echo "==> bun run test (frontend)"
  bun run test

  # --- 5. Svelte type/lint check ---
  echo "==> bun run check (frontend)"
  bun run check

  cd "$REPO_ROOT"
else
  echo "WARNING: frontend/ not found — skipping frontend checks"
fi

# --- 6. Full Rust test suite (all crates, temp-dir tests) ---
echo "==> cargo test --workspace"
cargo test --workspace

echo "==> ALL CHECKS PASSED"
