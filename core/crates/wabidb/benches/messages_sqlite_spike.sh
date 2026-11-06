#!/usr/bin/env bash
# SPIKE (Task 0.1, throwaway): drive benches/messages_sqlite_spike.rs.
# Usage: messages_sqlite_spike.sh <work_root> [messages=1000000] [channels=50]
# Needs root for drop_caches; without it the "cold" runs read from page cache.
set -euo pipefail
root=${1:?work root}
messages=${2:-1000000}
channels=${3:-50}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cargo build --release -p wabidb --bench messages_sqlite_spike --manifest-path "$repo/Cargo.toml" >&2
bin=$(ls -t "$repo"/target/release/deps/messages_sqlite_spike-* | grep -v '\.d$' | head -1)

drop_caches() { sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || echo "WARN: page cache not dropped" >&2; }

# A step that dies (e.g. killed for memory) is a result: record it, go on.
step() { "$bin" "$@" || echo "{\"step\":\"$1-died\",\"backend\":\"$2\",\"exit\":$?}"; }

mkdir -p "$root"
if [ ! -f "$root/dataset/bench-cursors.txt" ]; then   # reuse a finished dataset
  rm -rf "$root/dataset"
  "$bin" generate "$root/dataset" "$messages" "$channels"
fi
for backend in memory sqlite; do
  rm -rf "$root/$backend"
  cp -a "$root/dataset" "$root/$backend"
  drop_caches
  step cold "$backend" "$root/$backend"
  drop_caches
  step warm "$backend" "$root/$backend"
  rm -rf "$root/$backend"
done
