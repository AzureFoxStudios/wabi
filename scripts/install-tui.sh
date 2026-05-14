#!/usr/bin/env bash
# install-tui.sh — install wabi-tui for the current user
#
# Usage:
#   ./scripts/install-tui.sh                  # installs from local bin/
#   curl -fsSL <your-url>/install-tui.sh | bash  # remote install (if binary is hosted)

set -euo pipefail

BINARY_NAME="wabi-tui"
INSTALL_DIR="${WABI_TUI_INSTALL_DIR:-$HOME/.local/bin}"
DEFAULT_SERVER="${WABI_SERVER:-http://localhost:8080}"

# ── Locate source binary ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BIN="$SCRIPT_DIR/../bin/$BINARY_NAME"

if [[ -f "$LOCAL_BIN" ]]; then
    SRC="$LOCAL_BIN"
elif command -v cargo &>/dev/null && [[ -f "$SCRIPT_DIR/../core/Cargo.toml" ]]; then
    echo "Binary not found — building from source (this takes ~30 seconds)..."
    pushd "$SCRIPT_DIR/.." > /dev/null
    cargo build --release -p wabi-tui 2>&1 | tail -3
    SRC="$SCRIPT_DIR/../target/release/$BINARY_NAME"
    popd > /dev/null
else
    echo "Error: no pre-built binary found at bin/wabi-tui and cargo is not available." >&2
    echo "Either copy a wabi-tui binary to bin/ or install Rust (https://rustup.rs) and re-run." >&2
    exit 1
fi

# ── Install ─────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cp "$SRC" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# ── Write config if none exists ──────────────────────────────────────────────
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wabi"
CONFIG_FILE="$CONFIG_DIR/config.toml"

if [[ ! -f "$CONFIG_FILE" ]]; then
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" <<EOF
server_url = "$DEFAULT_SERVER"
EOF
    echo "Config written to $CONFIG_FILE"
    echo "Edit server_url to point to your Wabi server."
fi

# ── PATH hint ───────────────────────────────────────────────────────────────
echo ""
echo "✓  wabi-tui installed to $INSTALL_DIR/$BINARY_NAME"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.) so 'wabi' is on PATH:"
    echo ""
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo "    alias wabi='wabi-tui'"
    echo ""
else
    echo "Run:  wabi-tui"
    echo "  or add to your profile:  alias wabi='wabi-tui'"
fi
