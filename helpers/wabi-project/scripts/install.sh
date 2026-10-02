#!/bin/sh
# Builds the independent helper only. No Node, Docker, frontend or Authority.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_prefix=${1:-"$HOME/.local"}
case "$install_prefix" in /*) ;; *) printf '%s\n' 'Use an absolute install prefix.' >&2; exit 1 ;; esac
: "${CARGO_TARGET_DIR:=$source_dir/target}"
export CARGO_TARGET_DIR
cargo +1.93 build --release --locked --manifest-path "$source_dir/Cargo.toml"
mkdir -p "$install_prefix/bin"
install -m 755 "$CARGO_TARGET_DIR/release/wabi-project-helper" "$install_prefix/bin/wabi-project-helper"
for helper in mcp plugin worker agent; do
  ln -sfn wabi-project-helper "$install_prefix/bin/wabi-project-$helper"
done
ln -sfn wabi-project-helper "$install_prefix/bin/package-wabi-project-plugin"
printf '%s\n' "Installed to $install_prefix/bin."
