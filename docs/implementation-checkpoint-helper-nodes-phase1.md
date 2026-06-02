# Implementation Checkpoint — Helper Nodes Phase 1

Date: May 25, 2026
Branch: `main`
Current head before implementation: `12e2957 chore: clean up fracture branch before Phase 1`

## Context

The helper-node architecture is documented in:

- `docs/futuresight-multi-anchor-helper-nodes.md`
- `docs/futuresight-multi-anchor-research.md`
- `docs/futuresight-scaling-middleware.md`
- `docs/futuresight-native-media-pipeline.md`

Do not use the phrase/product target "mesh" for this work. The first implementation target is core authority-owned helper-node registry infrastructure, not federation and not active-active state.

## Phase 1 Implementation Target

Build a minimal, testable core registry in `core/crates/wabi-server/src/nodes/`:

- Authority-owned node registry in `wabi-server` core, not addon.
- Admin creates short-lived one-use pairing tokens.
- Helper joins with pairing token and receives node credentials.
- Helper sends heartbeat with capability/load/reachability snapshot.
- Admin can list and revoke nodes.
- Persistence should be local JSON in `data_dir` for Phase 1; STDB/event-log integration is later.
- Default control transport remains HTTPS/WebSocket-compatible API surface, no QUIC/gRPC/libp2p for Phase 1.

## API Shape To Start

Recommended initial routes under `/api/nodes`:

- `GET /api/nodes` — admin list registry nodes.
- `POST /api/nodes/pairing-tokens` — admin creates a `NodePairingToken`.
- `POST /api/nodes/join` — helper redeems pairing token.
- `POST /api/nodes/{node_id}/heartbeat` — helper updates status using node secret header.
- `POST /api/nodes/{node_id}/revoke` — admin revokes node.

Use existing admin auth pattern from `api/channels.rs` (`Bearer` JWT -> `state.is_admin(user_id)`).

## Design Constraints

- Keep helpers dumb: they do not own permissions or auth state.
- Signed route tokens are later Phase 2; Phase 1 can issue node credentials and track capabilities/reachability.
- Avoid extending `wabi-mesh`; replace it later.
- Do not introduce heavy dependencies unless necessary.
- TDD: write failing Rust tests before production code.

## Repo State Notes

- `main` is now the cleaned fracture branch.
- `old-main` preserves the stale old branch.
- Current largest component files after fracture include `MessageList.svelte` (~1885), `MediaAlbumsTabImpl.svelte`, `MapWorkspace.svelte`, `ServerSwitcherPanel.svelte`.
- Rust server has no `core/crates/wabi-server/src/nodes/` directory yet.

## Verification Targets

- Unit tests for pairing token lifecycle, joining, heartbeat, revocation, and persistence.
- `cargo test -p wabi-server nodes`
- `cargo check -p wabi-server`
- If frontend/admin UI is touched later: `cd frontend && npm run check`
