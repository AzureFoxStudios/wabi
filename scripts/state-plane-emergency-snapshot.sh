#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/state-plane-emergency-snapshot.sh --i-understand-this-includes-content [options]

Creates a break-glass filesystem snapshot. This includes message/content data
and must not be used as the normal Wabi backup path.

Options:
  --i-understand-this-includes-content   Required safety confirmation
  --backup-root <path>                   Backup root (default: ./backups)
  --data-dir <path>                      DATA_DIR on host (default: ./data)
  --uploads-dir <path>                   Uploads directory (default: ./uploads)
  --plugins-dir <path>                   Plugins directory (default: ./plugins)
  --compose-file <path>                  Compose file (default: ./docker-compose.yml)
  --no-pause                             Do not pause/unpause spacetimedb around tar
  --retention-days <n>                   Retention note in manifest (default: 7)
  -h, --help                             Show help

The produced tarball is plaintext. Put it into restic/borg/age-encrypted
storage immediately and restrict access to break-glass operators only.
EOF
}

backup_root="./backups"
data_dir="./data"
uploads_dir="./uploads"
plugins_dir="./plugins"
compose_file="./docker-compose.yml"
pause_compose="true"
retention_days="7"
confirmed="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --i-understand-this-includes-content)
      confirmed="true"
      shift
      ;;
    --backup-root)
      backup_root="${2:?--backup-root requires a value}"
      shift 2
      ;;
    --data-dir)
      data_dir="${2:?--data-dir requires a value}"
      shift 2
      ;;
    --uploads-dir)
      uploads_dir="${2:?--uploads-dir requires a value}"
      shift 2
      ;;
    --plugins-dir)
      plugins_dir="${2:?--plugins-dir requires a value}"
      shift 2
      ;;
    --compose-file)
      compose_file="${2:?--compose-file requires a value}"
      shift 2
      ;;
    --no-pause)
      pause_compose="false"
      shift
      ;;
    --retention-days)
      retention_days="${2:?--retention-days requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[state-plane-emergency-snapshot] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$confirmed" != "true" ]]; then
  echo "[state-plane-emergency-snapshot] Refusing: pass --i-understand-this-includes-content" >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%d-%H%M%S)"
snapshot_dir="${backup_root%/}/emergency-${timestamp}"
archive_path="${snapshot_dir}/wabi-full-emergency-${timestamp}.tar.gz"
manifest_path="${snapshot_dir}/manifest.txt"
paused="false"

mkdir -p "$snapshot_dir"

cleanup() {
  if [[ "$paused" == "true" ]]; then
    docker compose -f "$compose_file" unpause spacetimedb >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$pause_compose" == "true" && -f "$compose_file" ]] && command -v docker >/dev/null 2>&1; then
  if docker compose -f "$compose_file" ps spacetimedb >/dev/null 2>&1; then
    docker compose -f "$compose_file" pause spacetimedb >/dev/null 2>&1 || true
    paused="true"
  fi
fi

tar_args=()
[[ -f ".env" ]] && tar_args+=(".env")
[[ -d "$data_dir" ]] && tar_args+=("$data_dir")
[[ -d "$uploads_dir" ]] && tar_args+=("$uploads_dir")
[[ -d "$plugins_dir" ]] && tar_args+=("$plugins_dir")

if [[ ${#tar_args[@]} -eq 0 ]]; then
  echo "[state-plane-emergency-snapshot] Nothing to archive" >&2
  exit 1
fi

tar -czf "$archive_path" "${tar_args[@]}"

{
  echo "profile=full-emergency"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "retention_days=${retention_days}"
  echo "archive=$(basename "$archive_path")"
  echo "sha256=$(sha256sum "$archive_path" | awk '{print $1}')"
  echo "includes_content=true"
  echo "includes_data_dir=$([[ -d "$data_dir" ]] && echo true || echo false)"
  echo "includes_uploads=$([[ -d "$uploads_dir" ]] && echo true || echo false)"
  echo "includes_plugins=$([[ -d "$plugins_dir" ]] && echo true || echo false)"
  echo "privacy_note=Plaintext break-glass archive; encrypt immediately and delete per retention policy."
} > "$manifest_path"

chmod 700 "$snapshot_dir" || true
chmod 600 "$archive_path" "$manifest_path" || true

echo "[state-plane-emergency-snapshot] Snapshot created"
echo "  snapshotDir=$snapshot_dir"
echo "  archive=$archive_path"
echo "  manifest=$manifest_path"
echo "  sha256=$(sha256sum "$archive_path" | awk '{print $1}')"
echo "[state-plane-emergency-snapshot] Store with restic/borg/age encryption and enforce ${retention_days}-day retention."
