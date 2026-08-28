# Wabi local-dev.sh container-runtime detection

Use when `scripts/local-dev.sh` fails to start on Bazzite/Ronin because the
script hard-requires `docker` to be installed AND `docker ps` to succeed. The
fix is to teach the script to detect whichever container runtime is actually
usable: `docker` → `podman-compose` → `podman compose` (in priority order).

## Symptom (before the fix)

User runs `bash scripts/local-dev.sh` on Bazzite. The script exits with code
4 or 5, even though `podman-compose` is installed and the STDB image
(`docker.io/clockworklabs/spacetime:latest`) is already pulled locally.

Original failing block in the script:

```bash
if ! command -v docker >/dev/null 2>&1; then
  echo "[local-dev] ERROR: docker CLI is not installed. ..." >&2
  exit 4
fi

if ! docker ps >/dev/null 2>&1; then
  cat >&2 <<ERR
[local-dev] ERROR: Docker is not usable by this user.
...
ERR
  exit 5
fi
```

The error text correctly told the user "install podman-compose and set
PODMAN_COMPOSE_PROVIDER", but the script never actually tried that path —
it just hard-failed.

## Why podman-compose works as a drop-in for docker compose

- `docker-compose.yml` parses cleanly under `podman-compose config`
  (verified: exit 0, 6076 bytes of rendered config on the Wabi tree).
- Both `docker compose up -d <services>` and `podman-compose up -d <services>`
  accept the same `up -d <services...>` argument shape, so a single
  `${CONTAINER_CMD} up -d` substitution works for both.
- SpacetimeDB and wabi-server images already present in the local podman
  cache are reused without re-pulling.
- The wait loops (60s for STDB proxies, 60s for `/health`) hit
  `http://${FRONTEND_HOST}:${PORT}/...` via curl, not via the container
  runtime, so they don't care which compose tool was used.

## Fix shape

Replace the hard-fail docker checks with a tiered detector that picks the
first working runtime, then drive the compose invocation through
`${CONTAINER_CMD}`:

```bash
if ! command -v docker >/dev/null 2>&1; then
  echo "[local-dev] docker CLI is not installed; will try podman-compose as a fallback." >&2
fi

if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
  CONTAINER_CMD="docker"
  echo "[local-dev] Container runtime: docker (compose via 'docker compose')"
elif command -v podman-compose >/dev/null 2>&1; then
  CONTAINER_CMD="podman-compose"
  echo "[local-dev] Container runtime: podman-compose (docker socket not available, falling back)"
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  CONTAINER_CMD="podman"
  echo "[local-dev] Container runtime: podman (using 'podman compose' subcommand)"
else
  cat >&2 <<ERR
[local-dev] ERROR: No usable container runtime found.
[local-dev] Need ONE of:
[local-dev]   - 'docker ps' to work (docker installed + user has socket access), or
[local-dev]   - 'podman-compose' on PATH, or
[local-dev]   - 'podman compose version' to work
ERR
  exit 4
fi
```

And the compose call site:

```bash
WABI_STDB_BRIDGE_DATABASE="${CORE_STDB_DATABASE}" \
WABI_CALL_STDB_DATABASE="${CALL_STDB_DATABASE}" \
${CONTAINER_CMD} up -d \
  spacetimedb stdb-publisher stdb-proxy \
  call-spacetimedb call-stdb-publisher call-stdb-proxy \
  wabi-server
```

Note `${CONTAINER_CMD} up -d` works for both `docker compose` and
`podman-compose` because they share the `up` subcommand shape. Do not
write `${CONTAINER_CMD} compose up -d` — that fails for `podman-compose`
which is a wrapper binary, not a subcommand.

## Why fixing the real script beats building mock-infrastructure

The user said directly: "do we need all that? someone can just make a STDB
on their computer and run a wabi server off that, what they need is a way
to test bots right?" The right move when local dev is broken on a real
machine is to fix the real dev script, not to add frontend HTTP mocks
that fudge the auth flow. Frontend-only mocks cannot drive reducer-level
behavior, real channel membership, or bot-style generators that need the
real Rust + STDB path. The `dev:mock` lane is for visual smoke only.

If a future session is tempted to add a Vite plugin that intercepts
`/api/auth/login` / `/api/setup/status` to let the user "bypass the login
wall" in mock mode, stop and ask: can `local-dev.sh` work for this user
with one more targeted fix instead? If yes, do that.

## Verification

After the fix, run the detection block standalone and confirm it picks the
right runtime on the box:

```bash
bash -n scripts/local-dev.sh
# expect: exit 0, no syntax errors

bash -c '
  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    CONTAINER_CMD="docker"
  elif command -v podman-compose >/dev/null 2>&1; then
    CONTAINER_CMD="podman-compose"
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    CONTAINER_CMD="podman"
  else
    echo "NO RUNTIME" >&2; exit 4
  fi
  echo "RESOLVED: CONTAINER_CMD=$CONTAINER_CMD"
'
```

On a Bazzite box without docker socket access but with `podman-compose`
installed, expect: `RESOLVED: CONTAINER_CMD=podman-compose`.

## What NOT to change

- Do not add a third compose vendor (nerdctl, lima, colima) without
  user request. Three tiers is enough for the Wabi audience.
- Do not silently default to `podman-compose` if `docker` is present but
  socket-inaccessible. The detection order already prefers docker; the
  user has a reason docker is set up on their box and you should respect
  it when it works.
- Do not modify `docker-compose.yml` for this fix. The file is already
  podman-compatible.
- Do not change the `VITE_WABI_LOCAL_MOCK` guard at the top of the script.
  Mock mode is for visual smoke; the script's job is to run the real
  stack, and conflating them is exactly the kind of dev-mode chaos this
  skill cluster is meant to prevent.
