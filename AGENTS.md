# AGENTS.md — Wabi Orientation for Code/AI Agents

Read this before making non-trivial changes. The canonical product maturity boundary is `docs/PROJECT_STATUS.md`; the deeper code mental model is `docs/architecture/overview.md`.

## What Wabi is

Wabi is a FOSS, self-hosted **communication and collaborative-workspace app for small communities**. The normal deployment is one Rust **Authority** server with an embedded SvelteKit frontend and embedded event-sourced **WabiDB** storage engine.

A single client can save/switch among multiple independent Wabi servers. **That is not federation.** Servers do not share a global identity database or community state.

Do not quietly change these product boundaries:

- current DMs/private rooms are server-readable, **not E2EE**;
- WabiDB network replication/warm standby is experimental, **not production HA**;
- the legacy mesh addon is not the production topology;
- CAD/model features are review/inspection surfaces, **not a CAD editor**;
- open/draft PRs are not shipped features.

## Repository layout

Single root Cargo workspace (`Cargo.toml`):

| Path | What lives there |
|---|---|
| `crates/wabi-core/` | Protocol types (`UserView`, `ChannelView`, …). `--features ts` runs ts-rs codegen → `packages/wabi-protocol/` |
| `core/crates/wabi-server/` | Authority binary: Axum API, Socket.IO/WebSocket, auth, `WdbAdapter`, helpers/jobs |
| `core/crates/wabidb/` | Embedded event-sourced engine: sequencer, projections, storage, recovery, experimental replication |
| `core/crates/wabi-tui/` | Terminal client |
| `core/addons/` | Curated/compiled integrations; `mesh` material is legacy/compatibility, not current HA |
| `frontend/` | SvelteKit app (adapter-static, Svelte 5 runes), workspace UI, browser clients |
| `src-tauri/` | Tauri native shell |
| `packages/wabi-protocol/` | **GENERATED** TypeScript from `wabi-core`; do not hand-edit as normal source |
| `plugins/` | Operator-installed runtime plugins when plugin mode is enabled |
| `docs/` | Living docs; historical/stale material belongs on `docs-history` |

## Core mental model

```text
HTTP / Socket.IO / WebSocket
           │
           ▼
       wabi-server
           │
       WabiStore trait
           │
           ▼
        WabiDB
 command → event → durable commit → projection application
                                  │
                                  └→ response / live push
```

WabiDB uses a single sequenced writer for durable commands. Projections are the read model. Realtime clients receive snapshots/incremental events from server-owned state.

Message retention (`live` / timed / `forever`) is decided before the durable write path. “Live/not retained” is not E2EE.

## Runtime topology

### Authority

`WABI_SERVER_ROLE=authority` is the normal state-owning runtime.

### Helpers

TURN/SFU/media gateway/tunnel/Tailcat and other scoped helpers solve specific transport/integration jobs. They do not become additional state authorities merely because they are nodes.

### Anchor — experimental

`WABI_SERVER_ROLE=anchor` is a stateless proxy to `WABI_AUTHORITY_URL`. It must not initialize its own community WabiDB. Current Anchor behavior is HTTP-oriented; native WebSocket forwarding is not a completed regional-realtime guarantee.

### Replication / standby — experimental

WabiDB peer replication is explicitly gated and does not yet prove live projection convergence, safe writer semantics, or failover. Warm standby export/import/promotion is not a production recovery path. Never describe either as HA without the acceptance gates in `docs/architecture/SERVER_MESH_PLAN.md` passing.

## Build / test / run

```bash
# Frontend must be static for Rust embedding
cd frontend
STATIC_BUILD=1 bun run build
bun run check
cd ..

# Backend (frontend/build must exist for embedded build)
cargo build --release -p wabi-server

# Workspace tests
cargo test --workspace
```

Dev ports are normally 5173 for Vite and 3001 for the local backend. Docker exposes host port 3001 by default.

For release/integration changes, use the repository-pinned dependency/toolchain path and inspect CI rather than substituting an arbitrary newer local toolchain.

## Golden rules

These are repository invariants that have caused real regressions when ignored.

1. **Do not switch the frontend minifier to terser.** Existing builds use esbuild because terser previously broke the Svelte store runtime.

2. **Use Svelte 5 runes in modern frontend code.** Follow the patterns already used by the target component; do not introduce a parallel state/navigation architecture because it is easier in isolation.

3. **Preserve message identity end to end.** Backend IDs and client optimistic IDs have deliberate reconciliation rules. Never overwrite a valid `clientMessageId` with `undefined` or collapse keyed optimistic/accepted messages.

4. **`packages/wabi-protocol` is generated.** `cargo test -p wabi-core --features ts` regenerates TypeScript. Do not depend on manual edits surviving codegen. If a compatibility patch is still required, follow the current documented generation workflow rather than editing generated output casually.

5. **Postcard-encoded persistent records require compatibility planning.** Do not add/remove/reorder fields on durable record types without a versioned/dual-decode migration path. Breaking replay can destroy access to real stored state.

6. **Lore is an optional external integration, but the Wabi Lore workspace is real product UI.** The backend may depend on an external Lore service/CLI; do not pretend that dependency is bundled. Equally, do not dismiss the existing Wabi workspace as “out of scope” when the task is explicitly about Lore UX/integration.

7. **UI validation needs a real rendering environment.** Historical headless Chromium/Skia limitations have made some screenshot claims unreliable. HTTP/compile tests are not substitutes for real browser/native acceptance when visual/media behavior matters.

8. **Adapter emit/write shapes are not globally uniform.** When adding a WabiDB event through `WdbAdapter`, copy the established pattern in the target module and verify persistence/replay. A call that compiles can still bypass the intended durable path.

9. **Know the lock files when recovering/deploying.** Wabi may have both `data/wabi-server/.lock` and `data/wabi-server/wabidb/.lock`. Only remove stale locks after confirming no process is using the data. See `docs/deployment/BACKUP_AND_RECOVERY.md`.

10. **Multi-server client UX is not federation.** Keep credentials/offline state scoped by server/account. Do not add cross-server server-side state sharing as a convenience shortcut.

11. **No fake HA.** A successful HTTP request between nodes is not proof of replication. A copied segment is not proof that live projections converged. A standby endpoint is not a backup unless restore/promotion is real and tested.

12. **CAD/model boundary: review, inspect, discuss.** DXF/DWG/3MF/STEP/IGES import paths converge into Wabi viewers/review tools. Do not grow a second renderer or editing format when the existing workspace can own the experience. Optional/proprietary conversion helpers must stay honest about licensing/deployment.

13. **Privacy wording is a code-quality concern.** Do not label server-readable DMs as encrypted/private-from-operator, and do not equate ephemeral retention with confidentiality.

14. **Open PR != shipped feature.** Check `main`, the current task branch, and `docs/PROJECT_STATUS.md` before writing present-tense product claims.

## Frontend/workspace ownership

Wabi's UI has accumulated code from many generations. Existing design is not automatically correct just because it already exists.

**Product layout contract (Ronin, 2026-09-15):**

- Channels anchor the user's location/context and remain part of the shell.
- Center stage owns the primary task and selected workspace.
- Stubs are additive multitasking affordances. Preserve the stub system; do not delete it as redundant navigation or make stub actions replace center stage.
- Right panels are only for optional multitasking alongside center stage. They must not become a required primary destination or silently take over the selected workspace.
- Shared underlying data does not make center-stage and right-panel views redundant. Preserve simultaneous use and independent editor drafts; polish hierarchy and behavior within this contract.

Prefer:

- semantic theme tokens over raw component-specific colors;
- one obvious control path over duplicate floating text buttons;
- existing shared workspace/dock navigation over parallel persisted layout state;
- predictable `open` / `dock` / `right-click` behavior across content types;
- narrow/mobile layouts designed intentionally, not desktop squeezed smaller;
- actual loading/error/empty states instead of silent failure;
- truthful labels for local draft vs shared/published state.

Substantial UX cleanup is acceptable when it removes confusing legacy/AI-generated structure and preserves the underlying capabilities.

## CAD/model import rules

Current intended import paths:

- DXF → built-in read-only 2D viewer/review;
- DWG → optional authenticated server `dwg2dxf` conversion → DXF viewer;
- 3MF → browser conversion → temporary GLB → normal 3D viewer;
- STEP/STP/IGES/IGS → OpenCascade WASM → temporary GLB → normal 3D viewer.

Review markup should remain anchored to drawing/model coordinates, not be a screenshot overlay. Converted temporary URLs must not change the stable review identity of the original attachment.

## Plugin/addon rules

- Runtime plugins are opt-in and should be treated as trusted operator-installed backend code until sandbox/isolation guarantees are actually proven.
- Checksums/signatures/scanning are supply-chain controls, not a magic sandbox.
- The legacy mesh addon is not a deployment recipe.
- Optional integrations must fail clearly when dependencies are absent.
- Core Wabi should remain usable with optional plugins/helpers disabled.

## Documentation hierarchy

When facts disagree, prefer:

1. current source/tests on the branch being changed;
2. `docs/PROJECT_STATUS.md` for maturity claims;
3. canonical architecture/deployment docs;
4. dated `docs/plans/` as work history;
5. `docs-history` as archaeology only.

Any domain/projection/`ChannelKind` change must update the relevant plan/engine docs in the same work. Any feature maturity change should update PROJECT_STATUS + the relevant operator doc.

## Contribution / safety rules

- Add regression tests for behavioral changes.
- Do not commit live `data/` contents, generated secrets, or operator-private configuration.
- Do not weaken auth/permission checks merely to make a failing client path work; fix the ownership/admission model.
- Preserve old data before recovery/migration experiments.
- Push/deploy/merge are distinct operations. Do not claim one happened unless it actually happened and its resulting SHA/state is known.
