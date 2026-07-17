#!/bin/bash
# Wabi Native Server Launcher — the runtime is now wabidb.
# Use the wabidb binary directly with the --data-dir flag:
#   cargo run --release --bin wabidb -- --data-dir /app/data
#
# Previously this script started SpacetimeDB + published a module.
# Those steps are no longer needed.
echo "wabi-serve.sh is deprecated. Use 'cargo run --release --bin wabidb -- --data-dir /app/data' instead." >&2
exit 1
