# Native Wabi Project helpers

Independent Rust helper replacement for Project MCP and the optional API AI
worker. It does not build the Authority, frontend, Office or media services.
The existing live gateway has not been replaced.

## Install

Requires Rust 1.93 and a system C linker for source builds, and system CA roots
for HTTPS. Installed helpers require neither Rust, Node nor Docker. Run:

```sh
./scripts/install.sh "$HOME/.local"
```

For an offline build with cached crates, use:

```sh
cargo +1.93 build --release --offline --locked --manifest-path Cargo.toml
install -m755 target/release/wabi-project-helper "$HOME/.local/bin/wabi-project-helper"
```

The one executable provides `gateway`, `mcp`, `worker`, `agent`, `package`,
`control` and `health` commands. The installer also creates the familiar
`wabi-project-{plugin,mcp,worker,agent}` and `package-wabi-project-plugin` names.

## Gateway

Use the existing version 1 connection JSON. Its bot token remains scoped by
the Authority to the configured Project. Protect the directory as 0700 and
connection file as 0600. With your existing configuration:

```sh
wabi-project-helper gateway \
  --connection "$HOME/.config/wabi-project/connection.json" \
  --public-url https://YOUR-MCP-HOST \
  --name 'YOUR PROJECT' \
  --callback https://chatgpt.com/connector_platform_oauth_redirect \
  --auth-path /project-plugin \
  --control-socket "$XDG_RUNTIME_DIR/wabi-project-gateway/control.sock" \
  --listen 127.0.0.1 --port 4319
```

The control socket parent must already exist with mode 0700. A stale or occupied
socket is refused; it is never unlinked to admit a second owner. After its own
normal shutdown, the helper removes only its own socket inode.

An interactive gateway accepts `link` and `revoke`. For a service, run
`wabi-project-helper control SOCKET link` in a private terminal. Connection
codes are never printed through a redirected control CLI. `status` reports only
a fixed consent refusal reason and time; `revoke` affects this gateway's links.
Do not use either linking or revocation against production during testing.

OAuth pairing codes, authorization codes, access tokens, refresh tokens and
transactions remain memory-only. Restart revokes them; no session persistence
has been added. Optional `--registered-clients ABSOLUTE_FILE` preserves only
public registrations, with the same issuer/callback/expiry validation. Moving
to a new process requires fresh user consent unless a future separately
approved session migration is designed.

`service/wabi-project-gateway.service` is a user systemd entrypoint with a native
healthcheck. Replace its visible placeholders and review it before enabling it.
A reverse proxy must still publish the configured HTTPS origin, `/mcp`, discovery
routes and namespaced OAuth routes. The helper has no embedded TLS terminator.
The default bind is loopback. `--listen 0.0.0.0` remains available explicitly. An explicit private IPv4
address can bind only an existing private proxy interface. For a native helper
on that interface, `health http://PRIVATE_IP:PORT/health --host PUBLIC_HOST`
checks the fixed health route without sending credentials. Connector/worker
upstream origin restrictions remain HTTPS or exact loopback HTTP.

## Stdio, agent CLI and portable package

```sh
wabi-project-helper mcp --connection /protected/connection.json
codex mcp add wabi-project -- wabi-project-helper mcp --connection /protected/connection.json
wabi-project-helper package https://YOUR-MCP-HOST/mcp /new/plugin-directory
```

Stdio retains all 10 tools; hosted MCP adds `connection_profile` (11 total).
MCP protocol versions, tool descriptions, schemas, annotations, errors, scoped
Project paths, unverified runtime labels and code-link guidance are retained.
Package creation refuses an existing output directory and embeds no credential.

The agent commands remain `list-cards`, `list-pages`, `create-card`,
`set-card-status`, `claim-card`, `assign-card`, `create-page`, and `ping`.
Set the same `WABI_PROJECT_URL`, `WABI_PROJECT_CHANNEL_ID` and `WABI_BOT_TOKEN`
variables. Card changes preserve notes/checklists/links and use the read revision.
The helper never accepts estimate changes or retries an uncertain write.

## Optional worker

Use the existing `WABI_PROJECT_URL`, `WABI_PROJECT_CHANNEL_ID`, `WABI_BOT_TOKEN`,
`WABI_AI_PROVIDER_URL`, `WABI_AI_API_KEY`, `WABI_AI_MODEL`, optional
`WABI_AI_MAX_TOKENS`, `WABI_AI_COMPLETION_PATH`, `WABI_AI_REASONING_EFFORT`,
`WABI_WORKER_ID`, and `WABI_WORKER_NAME` variables. A model must be chosen
explicitly. `WABI_AI_PROVIDER_URL` retains the existing OpenRouter default.
The helper never switches providers or models after a failure.

```sh
wabi-project-helper worker --once
# Or poll until SIGINT/SIGTERM:
wabi-project-helper worker
```

`service/wabi-project-worker.service` reads a protected operator-owned environment
file. No setup step creates credentials, grants, worker identities or new OAuth
consent. Saved run steps are included in model history rather than replayed.
Attempt/worker/lease/pending fences are checked both before and after generation.
Cancellation, pause, takeover and addon disable prevent further model work or
step submission. An uncertain step is reloaded from Authority before a possible
failure report; it is never retried. Authority remains the final write fence.

## Verification

```sh
cargo +1.93 test --offline --locked
cargo +1.93 build --offline --locked
python3 tests/contracts.py
```

Python is a test dependency only. The executable fixture tests use fake local
Authority/provider HTTP services and protected temporary control sockets, without
production credentials or paid model calls. They need permission to listen on
loopback. OAuth expiry/restart cases use Rust unit fixtures. See the separate
verification receipt for exact results and integration constraints.

## Integration and live cutover

This crate is integrated at `helpers/wabi-project/` as an independent workspace.
Keep its own lockfile and target output; do not add it to the root workspace or
link Authority crates.
Replace the documented Node commands with the native commands above. Install
and review the native systemd entrypoints on the operator's host.

Do not stop or replace the deployed Node gateway as part of source integration.
Live cutover needs separate authorization, a reviewed reverse-proxy/service
change and fresh OAuth linking because gateway sessions do not survive restart.
Preserve the existing protected connection files and public registration file.
