# Wabi AI Onboarding Pack — distilled knowledge so AI agents don't deep-scan the codebase

**Date:** 2026-08-06
**Status:** Plan (awaiting Ronin's go)
**Why:** Wabi is close to done. Any new AI agent (GitHub swarmer, future contributor, Hermes on a fresh machine) currently must deep-scan the codebase because the distilled knowledge lives in ~33 private Hermes skills + memory, not in the repo. This pack moves the durable knowledge into the repo where any agent reads it on clone.
**Also covers:** the pending wabiDB skill updates from the 2026-08-06 "void account / offline roster" session.

---

## Deliverable 1 — `AGENTS.md` (repo root) — the entry point

Any AI agent that opens the repo reads this first. ~1.5 pages, no fluff.

Sections:
1. **What Wabi is** — 3 lines: self-hosted privacy-first Discord-alternative chat. One Rust binary (`wabi-server`) serves everything: Axum REST API + socket.io live updates + embedded SPA (rust_embed). Embedded event-sourced DB (WabiDB) replaces SpacetimeDB.
2. **Repo layout map** — table:
   - `core/crates/wabi-server/` — the binary: `api/` (REST handlers), `socketio/` (live handlers), `adapter/` (WdbAdapter → WabiStore), `state.rs`
   - `core/crates/wabidb/` — the embedded engine: `engine/` (sequencer, wabi_store.rs trait), `projections/`, `storage/` (.wseg/.widx/.wsnap)
   - `core/crates/wabi-core/` — protocol types (UserView, ChannelView, …) + `--features ts` → ts-rs codegen
   - `frontend/` — SvelteKit app, `adapter-static` (STATIC_BUILD=1), Svelte 5 runes
   - `packages/wabi-protocol/` — GENERATED TypeScript from wabi-core (do not hand-edit)
   - `docs/` — plans, architecture
3. **Mental model, one paragraph** — commands → events → projections (materialized views) → live socket push. REST for reads/writes, socket for presence + realtime. Retention classes live/timed/forever resolved in send path.
4. **Build / test / run** (exact commands):
   - `cd frontend && STATIC_BUILD=1 bun run build` (MUST be static; adapter-node breaks rust_embed)
   - `bun run check` (frontend type-check)
   - `cargo build --release -p wabi-server` (embeds frontend/build)
   - `cargo test` (wabidb unit/property/fuzz, wabi-server integration)
5. **Golden rules** (from memory/skills — the expensive lessons):
   - Never switch minifier to terser — breaks Svelte store runtime (`e.subscribe is not a function`)
   - Svelte 5 runes only: `$props/$derived/$effect`; no `export let`, no `$:`
   - Message ids are UUIDs end-to-end; never overwrite `clientMessageId` on merge; keyed lists collapse otherwise ("new eats old")
   - `packages/wabi-protocol` is generated: `cargo test -p wabi-core --features ts` STRIPS manual edits — must re-append `"category"|"lore"` to ChannelType.ts and `position/parentId` to ChannelView.ts
   - Lore is external (Epic Games CLI at lore://localhost:10000) — out of scope
   - Headless Chromium cannot render Wabi (Skia font crash) — verify UI in a real browser
   - Do NOT add fields to postcard-encoded records (`Channel`, `UserRecord`, …) without dual-decode fallback — breaks replay (this dropped real accounts once)
6. **Contribution rules** — tests with changes; domain/projection changes must be documented (plan doc section + skill update per Ronin's DB-change policy).

## Deliverable 2 — `docs/architecture/overview.md` ("This is Wabi")

The distilled knowledge doc, ~5–8 pages. Written for an AI with no context; every claim grounded in source.

Sections:
1. **System mental model** — one binary, event sourcing, projections, live updates. Diagram (ASCII).
2. **wabi-server** — REST groups table (from `api/routes.rs` + wabidb-api-handlers skill): auth, channels, messages, albums, wiki, forum, gallery, incidents, calls, upload, blobs, user, admin, payments, nodes, mesh, media, jobs, standby, sync, lan. Auth model: JWT `AuthUser`/`OptionalAuthUser`, `admin_auth` headers-based, stepup for destructive ops (except reset-password which is plain admin_auth). Socket layer: `init` payload (users = online presence, serverMembers = full roster via `wdb.list_users()` → UsersProjection), message/typing/presence events.
3. **WabiDB engine** — event store files (.wseg/.widx/.wsnap), commit sequencer, ACID, crash recovery, projections (22+ registrations, keys, secondary indexes, tombstone compaction), `WabiStore` trait → `WdbAdapter` (real) + `LocalWabiStore` (tests), domain types. Emit-shape is adapter-module-specific (forum `emit` vs wiki `run`) — load-bearing.
4. **Users & auth** — owner bootstrap (`setupRequired` gates on owner_user_id only; legacy server_owner.json shim removed), registered vs guest (empty `password_hash` = guest, `isRegistered` on wire), admin registry merge (`$serverMembers` + `$users`, keyed `dbUserId ?? id`), reset-password flow, revoke (per-user iat floor), login clears legacy `users` revocations entry.
5. **Channels & content** — ChannelKind table (text/voice/dm/group_dm/announcement/whiteboard/wiki/forum/incident/gallery/category/lore + `position`/`parent_id` reorg), messages (UUID ids, `msg_{seq}_{uuid}` pattern), wiki pages/revisions, forum threads/posts, gallery works/feedback, incidents, albums, DMs.
6. **Retention & privacy** — live/timed/forever classes; `channel_auto_delete_label` sentinel map (`"live"`/`"forever"`), NOT a Channel field (schema-safety); TTL scheduler; contract tests prove "never written".
7. **Frontend architecture** — SvelteKit static build, runes, `styles/tokens.css` semantic tokens (never raw hex), themes (ALL_PALETTES + ambient effects, game palettes matrix/balatro/spire selectable), workspace pills (Messages/Whiteboard/Planner/Media/Reader/3D/Map in ChatHeader), layout stores, IndexedDB-only client, offline outbound queue (25 action types, keyPath gotcha), socket store layer.
8. **Protocol** — wabi-core types → ts-rs → generated TS; regen hazard (see golden rules).
9. **Replication/standby/mesh** — one short section (SyncTransport/SyncWorker, standby snapshot receive, mesh coordination) — depth lives in skills; keep brief.
10. **Ops** — data dir layout (wabidb/, .lock files — BOTH server + engine locks), deploy pattern in one paragraph (build → scp .new → stop → rm both locks → swap → up → verify SHA + hashed CSS) WITHOUT machine addresses/credentials.

## Deliverable 3 (optional, phase 2) — `docs/ai/` deep-dive mirrors

Scrub + port the highest-value wabidb skills (core-capabilities, storage-format, transaction-system, projection-system, api-handlers) into `docs/ai/*.md` so external AI agents get engine depth without Hermes. Only if wanted — AGENTS.md + overview.md already cover the "don't scan deeply" goal.

## Deliverable 4 (small, in same pass) — wabiDB skill maintenance

The 2026-08-06 session's findings landed in `wabidb-troubleshooting` + `wabidb-api-handlers` (both patched, verified). Still missing from engine skills: the **UsersProjection → `list_users`/`UsersFilter::default()` → `serverMembers`** path (UsersProjection only shows `user_registered` in the projection-system table; store-trait has no `list_users`; adapter skill doesn't cover the roster wiring). Fold the same content into the overview.md Users section AND patch the 3 skills.

## Scrubbing rules (load-bearing)

- NEVER copy: deploy IPs/hostnames (100.96.11.45, tim@), credentials (owner login, JWT secrets, WABIDB_ROOT_KEY), machine-local paths (/var/home/Ronin, ~/.hermes), token values
- Drop session-log flavor ("real incident 2026-07-25", "worker over-edited") — keep the lesson, not the log
- Verify claims against source where cheap (endpoint table vs `api/routes.rs`, ChannelKind mapping, storage classes, retention sentinel) — skills have drift risk
- Final gate: `grep -rnE 'Please1|100\.96\.|tim@|/var/home/Ronin|WABIDB_ROOT_KEY' docs/architecture AGENTS.md` must return nothing

## Execution order

1. AGENTS.md (highest value, smallest)
2. docs/architecture/overview.md
3. wabiDB skill maintenance (3 small patches)
4. Phase-2 docs/ai/ mirrors — only on request
5. Gate: scrub grep + `git diff --stat` + (no build impact — docs-only)

## Sources

README.md, ~33 wabi/wabidb skills, memory, and live code at `/var/home/Ronin/wabi` (fact-check against source during writing).
