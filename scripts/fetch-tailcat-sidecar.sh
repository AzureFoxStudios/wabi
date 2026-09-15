#!/usr/bin/env bash
# Stage the pinned Tailcat sidecar where Tauri's externalBin lookup expects it:
#   src-tauri/binaries/tailcat-<target-triple>[.exe]
#
# Usage:
#   ./scripts/fetch-tailcat-sidecar.sh
#   ./scripts/fetch-tailcat-sidecar.sh aarch64-apple-darwin x86_64-apple-darwin
#
# With no arguments the Rust host triple is used. Multiple triples are accepted
# so the macOS universal bundle can stage both architecture-specific sidecars.
#
# Pin policy (docs/plans/2026-09-01-tailcat-private-access.md): upstream is
# v0.x with NO API stability promises — bump deliberately and re-run the
# real-binary E2E from the plan doc.
set -euo pipefail

TAILCAT_VERSION="v0.4.0"
TAILCAT_COMMIT="ce6fedcabc220bab3b94d470ab330219111eeae8"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/src-tauri/binaries"
mkdir -p "$OUT_DIR"

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    python - "$file" <<'PY'
import hashlib
import pathlib
import sys
p = pathlib.Path(sys.argv[1])
h = hashlib.sha256()
with p.open('rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        h.update(chunk)
print(h.hexdigest())
PY
  fi
}

download_release_sidecar() {
  local triple="$1"
  local asset expected out archive tmp bin

  case "$triple" in
    x86_64-unknown-linux-gnu)
      asset="tailcat_0.4.0_linux_amd64.tar.gz"
      expected="8b819c43dfdf806b5663e23535aba557bb106075b0b5839df289af9bba70bec2"
      out="$OUT_DIR/tailcat-$triple"
      ;;
    aarch64-unknown-linux-gnu)
      asset="tailcat_0.4.0_linux_arm64.tar.gz"
      expected="3b77322350f64d229d5b2119b159b863b4bcffa0a62a0294682423a19956dc76"
      out="$OUT_DIR/tailcat-$triple"
      ;;
    x86_64-pc-windows-msvc)
      asset="tailcat_0.4.0_windows_amd64.zip"
      expected="c238a4e8d3b460423a67e5ad400888b73ffa0b28e15173fd32c9acb699a3a89e"
      out="$OUT_DIR/tailcat-$triple.exe"
      ;;
    aarch64-pc-windows-msvc)
      asset="tailcat_0.4.0_windows_arm64.zip"
      expected="78b26d4be91d251bb9b8b865139bddc5e4545ca1c3316a90faa57c6521aed153"
      out="$OUT_DIR/tailcat-$triple.exe"
      ;;
    *)
      return 1
      ;;
  esac

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  archive="$tmp/$asset"
  local url="https://github.com/tailscale/tailcat/releases/download/${TAILCAT_VERSION}/${asset}"

  echo "fetching $url"
  curl -fL --retry 3 --retry-delay 2 -o "$archive" "$url"

  local actual
  actual="$(sha256_file "$archive")"
  if [ "$actual" != "$expected" ]; then
    echo "Tailcat checksum mismatch for $asset" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi

  mkdir -p "$tmp/extract"
  if [[ "$asset" == *.zip ]]; then
    python -m zipfile -e "$archive" "$tmp/extract"
    bin="$(find "$tmp/extract" -type f -iname 'tailcat.exe' | head -1)"
  else
    tar -xzf "$archive" -C "$tmp/extract"
    bin="$(find "$tmp/extract" -type f -name tailcat | head -1)"
  fi

  if [ -z "$bin" ]; then
    echo "Tailcat binary not found in $asset — upstream asset layout changed" >&2
    exit 1
  fi

  cp "$bin" "$out"
  if [[ "$out" != *.exe ]]; then
    chmod +x "$out"
  fi
  rm -rf "$tmp"
  trap - RETURN
  echo "sidecar installed: $out"
}

build_macos_sidecar() {
  local triple="$1"
  local goarch out tmp src

  case "$triple" in
    aarch64-apple-darwin) goarch="arm64" ;;
    x86_64-apple-darwin) goarch="amd64" ;;
    *) return 1 ;;
  esac

  if ! command -v go >/dev/null 2>&1; then
    echo "Go is required to build Tailcat for macOS (upstream v0.4.0 has no macOS release archive)" >&2
    exit 1
  fi

  out="$OUT_DIR/tailcat-$triple"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  src="$tmp/tailcat"

  git init -q "$src"
  git -C "$src" remote add origin https://github.com/tailscale/tailcat.git
  git -C "$src" fetch -q --depth=1 origin "$TAILCAT_COMMIT"
  git -C "$src" checkout -q --detach FETCH_HEAD

  echo "building Tailcat $TAILCAT_VERSION ($TAILCAT_COMMIT) for $triple"
  (
    cd "$src"
    CGO_ENABLED=0 GOOS=darwin GOARCH="$goarch" \
      go build -trimpath -o "$out" ./cmd/tailcat
  )
  chmod +x "$out"

  rm -rf "$tmp"
  trap - RETURN
  echo "sidecar installed: $out"
}

if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  if [ -z "$HOST_TRIPLE" ]; then
    echo "could not detect Rust host triple" >&2
    exit 1
  fi
  TARGETS=("$HOST_TRIPLE")
fi

for triple in "${TARGETS[@]}"; do
  case "$triple" in
    x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu|x86_64-pc-windows-msvc|aarch64-pc-windows-msvc)
      download_release_sidecar "$triple"
      ;;
    aarch64-apple-darwin|x86_64-apple-darwin)
      build_macos_sidecar "$triple"
      ;;
    *)
      echo "no Tailcat sidecar strategy for target $triple" >&2
      exit 1
      ;;
  esac
done
