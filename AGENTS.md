# AGENTS.md — Wabi orientation for AI agents

Wabi is a self-hosted, privacy-first chat platform (a "Discord alternative") built as ONE Rust binary that serves everything: a REST API, socket.io live updates, and the embedded SvelteKit frontend. It replaces SpacetimeDB with its own embedded event-sourced database, **WabiDB**. Read this file first; read `docs/architecture/overview.md` for the full mental model.

## Repo layout

Single root Cargo workspace (`Cargo.toml`):

| Path | What lives there |
|------|------------------|
| `crates/wabi-core/` | Protocol types (`UserView`, `ChannelView`, …). `--features ts` runs ts-rs codegen → `packages/wabi-protocol/` |
| `core/crates/wabi-server/` | The binary. `src/api/` (Axum REST handlers), `src/socketio/` (live socket handlers), `src/adapter/` (`WdbAdapter` → `WabiStore`), `src/state.rs` |
| `core/crates/wabidb/` | The embedded engine: `engine/` (sequencer, `wabi_store.rs` trait), `projections/`, `storage/` (`.wseg`/`.widx`/`.wsnap`) |
| `core/crates/wabi-tui/` | Terminal UI crate |
| `core/addons/webhooks/backend`, `core/addons/mesh/backend`, `core/addons/lore/backend` | Rust addon backends (workspace members) |
| `frontend/` | SvelteKit app (adapter-static, Svelte 5 runes). Built with `STATIC_BUILD=1` and embedded into the binary via rust_embed |
| `packages/wabi-protocol/` | **GENERATED** TypeScript from wabi-core. Do NOT hand-edit |
| `docs/` | Plans, architecture, handoffs |

## Mental model (one paragraph)

Commands → events → projections → live socket push. REST (`/api/*`) and socket.io handlers call the `WabiStore` trait (`WdbAdapter`), which writes events through a commit sequencer into an append-only event store. **Projections** are in-memory materialized views (SkipMap indexes) rebuilt from events on startup; typed query methods read them. Socket clients receive live `init` + incremental events. Message retention classes (`live`/`timed`/`forever`) are resolved in the send path before any durable write.

## Build / test / run

```bash
# Frontend (MUST be static — adapter-node breaks the Rust embed)
cd frontend && STATIC_BUILD=1 bun run build     # emits frontend/build (index.html SPA)

# Frontend type-check
bun run check

# Backend (embeds frontend/build; must exist first)
cargo build --release -p wabi-server            # binary: target/release/wabi-server

# Tests
cargo test                                      # wabidb unit/property/fuzz + wabi-server integration
```

Dev ports: 5173 = Vite (`bun run dev`), 3001 = `wabi-server` backend. `serverUrl.ts` rewrites backend URLs to :3001 when the page is on 5173.

## Golden rules (each one cost real debugging time)

1. **Never switch the minifier to terser.** It breaks the Svelte store runtime (`e.subscribe is not a function` boot crash). vite.config uses esbuild (`minify: !process.env.TAURI_DEBUG`).
2. **Svelte 5 runes only** in the frontend: `$props`/`$derived`/`$effect`. No `export let`, no `$:`.
3. **Message ids are UUIDs end-to-end.** Backend pattern `msg_{seq}_{uuid}`. Never overwrite `clientMessageId` with undefined on merge; keep optimistic→accepted keys stable (`clientMessageId || id`). Keyed lists collapse ("new eats old") otherwise.
4. **`packages/wabi-protocol` is generated.** `cargo test -p wabi-core --features ts` REGENERATES the `.ts` files and STRIPS manual edits — you must re-append `position`/`parentId` to `ChannelView.ts` after any regen. (`"category"|"lore"` in `ChannelType.ts` used to need manual re-append too; since 2026-08-18 they are native Rust enum variants, so codegen emits them — do NOT re-add them by hand.)
5. **Never add fields to postcard-encoded records** (`Channel`, `UserRecord`, `MessageRecord`, …) without a dual-decode `RecordV0`/`V1` fallback — replay of older on-disk events breaks. This dropped real user accounts once. Per-channel flags go in the in-memory `channel_auto_delete_label` map, not the record.
6. **Lore is external.** `core/addons/lore/backend` shells out to an Epic Games Lore CLI at `lore://localhost:10000`; there is no lore binary in this repo. Treat lore as out of scope unless explicitly asked.
7. **Headless Chromium cannot render Wabi** (Skia `SkFontMgr_FontConfigInterface Not implemented` crash at first paint). Verify UI in a real browser; use headless only for HTTP/route checks.
8. **Adapter emit-shape is not uniform.** When adding an event via `WdbAdapter`, copy the emit call from the TARGET module's existing create method (forum uses `self.wdb.emit(event)`, wiki uses `self.run(actor, "op", channel_id, "event_type", 6, payload, true, None)`). A wrong emit compiles but silently doesn't persist.
9. **Two lock files on restart/deploy**: `data/wabi-server/.lock` AND the deeper engine lock `data/wabi-server/wabidb/.lock`. Remove BOTH or the server won't start after a swap.
10. **No parallel subagents.** The zai Start plan allows only one concurrent model stream; extra agents get 429 "user concurrency limit exceeded" and die as "Subagent was inactive for 600000ms". Spawn at most one Agent per message (never batched with other tool calls); prefer direct Read/Grep exploration when practical.

## Contribution rules

- Tests accompany changes (wabidb has unit/property/fuzz targets; wabi-server has integration tests).
- Any domain/projection/ChannelKind change MUST be documented: append to the active plan doc in `docs/plans/` and update the relevant wabidb skill — per Ronin's DB-change policy, implement + document + update skills autonomously, do not stop to flag.
- Do not commit: `data/` contents, `data/admin_policies.json`, `data/jwt_secret`, `docs/wabi-carl-watch.md` (noise files).
- Push/deploy gates are explicit ("push", "deploy") — never push or deploy without the word.
