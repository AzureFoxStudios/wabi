#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/state-plane-local-drill.sh [options]

Runs a disposable local STDB backup/restore drill without touching production.

The drill:
  1. Starts a temporary SpacetimeDB container with data under /tmp.
  2. Publishes the Wabi state bridge to a throwaway source database.
  3. Seeds synthetic rows with state-plane-stdb-primary-smoke.mjs.
  4. Creates a continuity logical backup with --skip-filesystem.
  5. Publishes a clean throwaway restore database.
  6. Restores the backup into the clean database and verifies key row counts.

Options:
  --database <name>                  Source DB (default: wabi-restore-drill-<timestamp>)
  --restore-database <name>          Restore DB (default: <database>-restore)
  --port <port>                      Host port for temporary STDB (default: 3310)
  --runtime <docker|podman>          Container runtime (default: docker)
  --image <image>                    SpacetimeDB image (default: docker.io/clockworklabs/spacetime:latest)
  --node-image <image>               Node image if host node is missing (default: node:22-alpine)
  --node-bin <path>                  Host node binary override
  --keep                             Keep containers and /tmp drill dir after exit
  --i-know-this-is-not-production    Required for custom DB names outside wabi-restore-drill-*
  -h, --help                         Show help

This script intentionally uses --skip-filesystem so it does not copy the repo's
real .env or local data into the drill backup.
USAGE
}

timestamp="$(date -u +%Y%m%d-%H%M%S)"
database="wabi-restore-drill-${timestamp}"
restore_database=""
port="${WABI_STDB_DRILL_PORT:-3310}"
runtime="${WABI_STDB_DRILL_RUNTIME:-docker}"
image="${WABI_STDB_DRILL_IMAGE:-docker.io/clockworklabs/spacetime:latest}"
node_image="${WABI_STDB_DRILL_NODE_IMAGE:-docker.io/library/node:22-alpine}"
node_bin="${WABI_STDB_DRILL_NODE_BIN:-}"
keep="false"
confirmed_custom_db="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database)
      database="${2:?--database requires a value}"
      shift 2
      ;;
    --restore-database)
      restore_database="${2:?--restore-database requires a value}"
      shift 2
      ;;
    --port)
      port="${2:?--port requires a value}"
      shift 2
      ;;
    --runtime)
      runtime="${2:?--runtime requires a value}"
      shift 2
      ;;
    --image)
      image="${2:?--image requires a value}"
      shift 2
      ;;
    --node-image)
      node_image="${2:?--node-image requires a value}"
      shift 2
      ;;
    --node-bin)
      node_bin="${2:?--node-bin requires a value}"
      shift 2
      ;;
    --keep)
      keep="true"
      shift
      ;;
    --i-know-this-is-not-production)
      confirmed_custom_db="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[state-plane-local-drill] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$restore_database" ]]; then
  restore_database="${database}-restore"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="wabi-state-drill-${timestamp}-$$"
drill_dir="/tmp/${project}"
compose_file="${drill_dir}/compose.yml"
server="http://127.0.0.1:${port}"

fail() {
  echo "[state-plane-local-drill] $*" >&2
  exit 2
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

require_safe_database() {
  local name="$1"
  local label="$2"
  local lowered
  lowered="$(lower "$name")"

  case "$lowered" in
    ""|wabi|prod|production|main|wabi-state|wabi-state-prod|wabi-state-benchmark-v2)
      fail "Refusing unsafe ${label} database name: ${name}"
      ;;
  esac

  if [[ -n "${WABI_STDB_BRIDGE_DATABASE:-}" && "$name" == "$WABI_STDB_BRIDGE_DATABASE" ]]; then
    fail "Refusing ${label} database because it matches WABI_STDB_BRIDGE_DATABASE"
  fi

  if [[ "$name" != wabi-restore-drill-* && "$confirmed_custom_db" != "true" ]]; then
    fail "${label} database must start with wabi-restore-drill-* or pass --i-know-this-is-not-production"
  fi
}

require_safe_database "$database" "source"
require_safe_database "$restore_database" "restore"

if [[ "$database" == "$restore_database" ]]; then
  fail "Source and restore databases must differ"
fi

if [[ "$runtime" != "docker" && "$runtime" != "podman" ]]; then
  fail "--runtime must be docker or podman"
fi

command -v "$runtime" >/dev/null 2>&1 || fail "${runtime} is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is required"
if [[ -n "$node_bin" ]]; then
  command -v "$node_bin" >/dev/null 2>&1 || fail "Configured node binary not found: ${node_bin}"
elif command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
else
  node_bin=""
fi

compose_cmd=("$runtime" compose -f "$compose_file" -p "$project")

node_exec() {
  if [[ -n "$node_bin" ]]; then
    "$node_bin" "$@"
    return
  fi
  "$runtime" run --rm \
    --network host \
    -v "${repo_root}:${repo_root}:z" \
    -v "${drill_dir}:${drill_dir}:z" \
    -w "$repo_root" \
    "$node_image" \
    node "$@"
}

cleanup() {
  if [[ "$keep" == "true" ]]; then
    echo "[state-plane-local-drill] Keeping drill dir: ${drill_dir}"
    echo "[state-plane-local-drill] Cleanup later with: ${runtime} compose -f ${compose_file} -p ${project} down -v"
    return
  fi
  "${compose_cmd[@]}" down -v >/dev/null 2>&1 || true
  rm -rf "$drill_dir"
}
trap cleanup EXIT

mkdir -p "$drill_dir/spacetimedb" "$drill_dir/spacetime-config" "$drill_dir/publisher-config" "$drill_dir/backups" "$drill_dir/module"

(
  cd "$repo_root/spacetimedb/wabi_state_bridge"
  tar --exclude target -cf - .
) | (
  cd "$drill_dir/module"
  tar -xf -
)

cat > "$compose_file" <<EOF
services:
  spacetimedb:
    image: ${image}
    command: ["start", "--listen-addr", "0.0.0.0:3000", "--data-dir", "/var/lib/spacetimedb"]
    ports:
      - "127.0.0.1:${port}:3000"
    volumes:
      - "${drill_dir}/spacetimedb:/var/lib/spacetimedb:z"
      - "${drill_dir}/spacetime-config:/home/spacetime/.config/spacetime:z"
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:3000/v1/ping || exit 1"]
      interval: 2s
      timeout: 2s
      retries: 30
      start_period: 5s

  stdb-publisher:
    image: ${image}
    depends_on:
      spacetimedb:
        condition: service_healthy
    volumes:
      - "${drill_dir}/module:/module:z"
      - "${drill_dir}/publisher-config:/home/spacetime/.config/spacetime:z"
    environment:
      WABI_STDB_BRIDGE_DATABASE: ${database}
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -e
        spacetime server add --url http://spacetimedb:3000 wabi-drill --default 2>/dev/null || true
        spacetime publish --module-path /module --server wabi-drill "\${WABI_STDB_BRIDGE_DATABASE}" --yes
EOF

wait_for_ping() {
  local deadline=$((SECONDS + 90))
  until curl -fsS "${server}/v1/ping" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      fail "Timed out waiting for ${server}/v1/ping"
    fi
    sleep 1
  done
}

publish_database() {
  local db="$1"
  WABI_STDB_BRIDGE_DATABASE="$db" "${compose_cmd[@]}" run --rm -e WABI_STDB_BRIDGE_DATABASE="$db" stdb-publisher
}

json_field() {
  local field="$1"
  node_exec -e '
    const field = process.argv[1];
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const value = parsed[field];
      if (value == null) process.exit(1);
      console.log(value);
    });
  ' "$field"
}

count_rows() {
  local db="$1"
  local table="$2"
  node_exec "$repo_root/backend/scripts/state-plane-stdb-http.mjs" \
    sql \
    --server "$server" \
    --database "$db" \
    --query "SELECT * FROM ${table}" \
    --anonymous \
    --json \
    | node_exec -e '
        let input = "";
        process.stdin.on("data", (chunk) => input += chunk);
        process.stdin.on("end", () => {
          const parsed = JSON.parse(input);
          if (!parsed.ok) {
            console.error(parsed.text || parsed.statusText || "SQL failed");
            process.exit(1);
          }
          const rows = Array.isArray(parsed.json?.rows) ? parsed.json.rows : [];
          console.log(rows.length);
        });
      '
}

echo "[state-plane-local-drill] Starting disposable STDB at ${server}"
"${compose_cmd[@]}" up -d spacetimedb
wait_for_ping

echo "[state-plane-local-drill] Publishing source database: ${database}"
publish_database "$database"

echo "[state-plane-local-drill] Seeding synthetic state"
node_exec "$repo_root/scripts/state-plane-stdb-primary-smoke.mjs" \
  --server "$server" \
  --database "$database" \
  --skip-publish \
  --anonymous \
  --json >/dev/null

echo "[state-plane-local-drill] Creating continuity backup without filesystem sidecars"
backup_json="$(
  node_exec "$repo_root/scripts/state-plane-backup.mjs" \
    --profile continuity \
    --backup-root "$drill_dir/backups" \
    --server "$server" \
    --database "$database" \
    --anonymous \
    --skip-filesystem \
    --json
)"
backup_dir="$(printf '%s' "$backup_json" | json_field backupDir)"

echo "[state-plane-local-drill] Publishing clean restore database: ${restore_database}"
publish_database "$restore_database"

echo "[state-plane-local-drill] Restoring continuity backup into clean database"
node_exec "$repo_root/scripts/state-plane-restore.mjs" \
  --backup-dir "$backup_dir" \
  --server "$server" \
  --database "$restore_database" \
  --anonymous \
  --json >/dev/null

users_count="$(count_rows "$restore_database" state_user)"
channels_count="$(count_rows "$restore_database" state_channel)"
messages_count="$(count_rows "$restore_database" state_message)"

if (( users_count < 1 )); then
  fail "Expected restored users, got ${users_count}"
fi
if (( channels_count < 1 )); then
  fail "Expected restored channels, got ${channels_count}"
fi
if (( messages_count != 0 )); then
  fail "Continuity restore should not restore messages, got ${messages_count}"
fi

echo "[state-plane-local-drill] PASS"
echo "  sourceDatabase=${database}"
echo "  restoreDatabase=${restore_database}"
echo "  restoredUsers=${users_count}"
echo "  restoredChannels=${channels_count}"
echo "  restoredMessages=${messages_count}"
echo "  backupDir=${backup_dir}"
