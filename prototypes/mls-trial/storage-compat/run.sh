#!/usr/bin/env bash
# Write with an older release, load and reply with the current one, read the reply with the older one.
# Usage: CARGO_TARGET_DIR=<dir> ./run.sh   (builds everything first)
set -u
here=$(cd "$(dirname "$0")" && pwd)
T=${CARGO_TARGET_DIR:?set CARGO_TARGET_DIR}
for d in old-openmls-081 old-openmls-074 old-mlsrs-050 current; do (cd "$here/$d" && cargo build -q --release) || exit 1; done
(cd "$here/current" && CARGO_TARGET_DIR=$T-081fmt cargo build -q --release --features om-081-format) || exit 1
run() { # $1 old binary, $2 current binary, $3 lib
  w=$(mktemp -d)
  echo "--- $1 -> $(basename "$(dirname "$(dirname "$2")")")/$3"
  "$T/release/$1" write "$w" && "$2" "$3" "$w" && "$T/release/$1" verify "$w"
  rm -rf "$w"
}
run old-openmls-074 "$T/release/storage-compat-current" openmls
run old-openmls-081 "$T/release/storage-compat-current" openmls
echo "(current built with feature 0-8-1-storage-format:)"
run old-openmls-074 "$T-081fmt/release/storage-compat-current" openmls
run old-openmls-081 "$T-081fmt/release/storage-compat-current" openmls
run old-mlsrs-050 "$T/release/storage-compat-current" mlsrs
