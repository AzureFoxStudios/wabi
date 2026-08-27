# Binary path trap + Lore addon enablement on Tim (verified 2026-08-08)

## The wrong-binary-path trap (silent no-op deploy)

Tim's `docker-compose.yml` bind-mounts `./target/release/wabi-server` → container `/wabi-server`.
The RUNNING binary is `~/Desktop/Wabi/target/release/wabi-server`. There is also a stale-looking
`~/Desktop/Wabi/wabi-server` file that the container NEVER reads.

Shipping to the wrong path (e.g. `scp ... tim@host:wabi-server.new` then
`mv ~/wabi-server.new ~/Desktop/Wabi/wabi-server`) looks successful:
- SHA matches local
- `/health` stays 200
- container keeps running the OLD binary

…but the new routes/features silently never appear. Classic symptom found 2026-08-08:
`cargo build --features addons` produced a binary with the Lore routes, SHA matched on Tim,
yet `/api/addons` listed only `mesh` — because the shipped file was not the mounted one.

### Verify the mount target before shipping
```bash
ssh tim@100.96.11.45 "docker inspect \$(docker ps -q -f name=wabi-server) \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{end}}'"
# expect a line like: /home/tim/Desktop/Wabi/target/release/wabi-server -> /wabi-server
```

### Correct ship sequence
```bash
# scp to the project dir's target/release, NOT to ~/ or ~/Desktop/Wabi root
scp target/release/wabi-server tim@100.96.11.45:~/Desktop/Wabi/target/release/wabi-server.new
ssh tim@100.96.11.45 'cd ~/Desktop/Wabi && \
  test "$(sha256sum target/release/wabi-server.new | awk "{print \$1}")" = "<LOCAL_SHA>" && \
  docker compose stop wabi-server && \
  rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock && \
  mv -f target/release/wabi-server.new target/release/wabi-server && \
  chmod +x target/release/wabi-server && \
  docker compose up -d wabi-server'
```
(Split scp from the compose-up ssh — Hermes may block a single long-lived shell ending in `up -d`.)

## Lore addon enablement (runtime-disabled trap)

The Lore addon compiles in with `--features addons` but stays **disabled at runtime**
until the container gets env vars + the host lore CLI mounted.

### `.env` additions on Tim
```
WABI_LORE_ENABLED=true
WABI_LORE_MODE=sidecar
WABI_LORE_SERVER_URL=lore://host.docker.internal:41337
WABI_LORE_BINARY_PATH=/usr/local/lorebin/lore
WABI_LORE_DATA_DIR=/data/lore
WABI_LORE_AUTO_CREATE=true
```

### docker-compose.yml additions
```yaml
    volumes:
      # ...existing mounts...
      - /home/tim/.local/bin:/usr/local/lorebin:ro,Z   # host lore CLI
      - ./lore-data:/var/wabi/lore:Z,U                 # working trees
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Why: the container image is minimal (no shell, no host PATH). The `lore` CLI must be
bind-mounted in, and the container reaches the host's `loreserver` via
`host.docker.internal` (needs `extra_hosts`). `loreserver` must listen on `0.0.0.0:41337`
(demo mode default does; verify `ss -tlnp | grep 41337`) — 127.0.0.1-only is unreachable
from inside the container.

### Verification
- `/api/addons` lists `lore` (plus `mesh`, `webhooks`)
- `/api/addons/lore/health` → `{"addon":"lore","status":"ok"}`
- logs: `[lore] Lore addon initialized`

## Stale-lock restart loop after data-dir change

Adding `WABI_LORE_DATA_DIR` (or any data-dir change) can crash-loop the container with
`Error: engine already running` even after `docker compose stop`. The two known lock paths
(`data/wabi-server/.lock`, `data/wabi-server/wabidb/.lock`) may not be the only ones.
Use the broad sweep:
```bash
docker compose stop wabi-server
find data -name '*.lock' -delete
docker compose up -d wabi-server
```

## Lore route shape (axum `{*path}` conflict)

Lore file sub-routes MUST be action-first: `/repos/{id}/lock/{*path}`,
`/repos/{id}/history/{*path}`, `/repos/{id}/diff/{*path}`.
Registering `/files/{*path}/lock` after `/files/{*path}` panics at startup:
`Invalid route ... Insertion failed due to conflict with previously registered route`.
The wildcard swallows the sub-paths. (Full detail in `rust-axum-server` skill.)

## Rust gotchas hit while building the addon (2026-08-08)

- **`Instant` does not impl `Serialize`/`Deserialize`.** Any struct you return as JSON
  (`#[derive(Serialize, Deserialize)]`) must store timestamps as `u64` unix-ms
  (`SystemTime::now().duration_since(UNIX_EPOCH)`) or `chrono::DateTime<Utc>`, NOT
  `std::time::Instant`. The serde bound failure (`the trait bound Instant: Serialize is
  not satisfied`) shows up as a cascade of E0277 errors.
- **`matches!` cannot destructure with a `=>` body.** `matches!(r, PolicyResult::Deny { reason } => reason.contains("x"))`
  is a syntax error (`no rules expected =>`). Use `if let PolicyResult::Deny { reason } = r { ... } else { panic!(...) }`.
- **`tokio::process::Output` is private; name `std::process::Output`.** A helper typed
  `anyhow::Result<tokio::process::Output>` fails with E0603; the `Output` returned by
  `tokio::process::Command::output()` is actually `std::process::Output`.
- **async-move block captures steal the variable.** `tokio::time::timeout(t, async move { ... })`
  moves every capture into the block; using `sp`/`args`/`script_id` AFTER the block fails
  E0382. Clone before the block (`let sp_for_run = sp.clone();`), keep the originals for
  post-block result construction.
- **LSP "async fn is not permitted in Rust 2015" is a false positive** when editing a
  workspace crate in isolation: the file linter doesn't see `edition = "2021"` in
  Cargo.toml and flags every `async fn`/`async move` with E0670. Trust `cargo check -p <crate>`,
  not the editor diagnostics.
- **`ts-rs` on new types needs the same cfg-gating as neighbors**: `#[cfg_attr(feature = "ts", derive(TS))]`
  + `#[cfg_attr(feature = "ts", ts(export))]`, and `ts(as = "Vec<...>")` takes a STRING
  literal, not a bare type expression. Unconditional `use ts_rs::TS` breaks the
  no-features build (`unresolved import ts_rs`).
- **Peer session can wipe uncommitted files**: a concurrently-running Hermes session's git
  ops removed `editor_bridge.rs`/`mirror.rs` mid-work. Commit new modules to git as soon
  as they compile, before wiring them in.
