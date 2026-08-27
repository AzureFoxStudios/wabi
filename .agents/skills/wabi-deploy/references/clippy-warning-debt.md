# Wabi clippy warning-debt pattern

Use this when a deploy task runs:

```bash
cargo clippy -p wabi-server --release -- -D warnings
```

Observed pattern from the Wabi Rust binary stack: the strict clippy gate can fail on repository-wide pre-existing warning debt even when the deploy change itself compiles and the release binary builds.

Representative categories seen:

- unused imports in `core/crates/wabi-server/src/api/*`, `blacklist.rs`, `blobs/mod.rs`, `helper_*`, `standby/mod.rs`
- broad dead-code warnings in helper/blob/standby/socket modules
- `clippy::duplicate_mod` around `socketio_impl.rs` being loaded via both `main.rs` and `socketio.rs`
- minor clippy style findings such as `unwrap_or_else` where `unwrap_or` is enough, manual clamp, redundant closure, clone-on-copy
- many socket handler functions reported unused because of the split socket module/wiring shape

Recommended deploy handling:

1. Run `cargo check -p wabi-server` and `cargo fmt -p wabi-server -- --check` as hard blockers.
2. Run frontend checks/builds for frontend-affecting changes.
3. Run clippy for visibility, but if it fails with the broad pattern above, report it as existing warning debt instead of starting a mass cleanup during deploy.
4. Only treat clippy as a hard deploy blocker once the project has a clean clippy baseline, or if clippy points directly at the files changed for the deploy.
5. If the user asks to fix the clippy debt, split that into a separate cleanup task/commit from deployment.
