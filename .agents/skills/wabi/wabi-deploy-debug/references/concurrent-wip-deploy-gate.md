# Concurrent WIP deploy gate (2026-08-08)

## Problem

Shared Wabi tree often has peer Hermes/OpenCode work in flight (whiteboard backend, PWA, untracked projections). Baking that into a release breaks cargo or ships half-features.

## Fail signals

- `git status` shows modified `core/crates/wabidb/**` + untracked `whiteboard_docs.rs`
- `cargo check -p wabi-server --release` errors: missing `whiteboard_docs`, `put_whiteboard_doc` not on `WdbAdapter`
- Frontend builds while backend does not — still **not** ship-safe

## Safe sequence

```bash
git status -sb
git stash push -u -m "pre-deploy-concurrent-wip"
# restore any *your* files if stash was too broad, then:
cargo check -p wabi-server --release
cd frontend && STATIC_BUILD=1 bun run build
cd .. && cargo build --release -p wabi-server
# Tim swap per tim-binary-swap-2026-08.md
git stash pop   # restore peer WIP intentionally after ship
```

## Stashes observed this session (names may vary)

- `wip-whiteboard-pwa-before-deploy-check`
- `wip-pwa-i18n-leftover`
- `wip-concurrent-whiteboard-backend-push`

Do not drop peer stashes without asking.
