# This is Wabi — architecture overview for AI agents

The distilled mental model of the Wabi system, so you can work on it without deep-scanning the codebase. Facts verified against source (2026-08-06). Companion to `AGENTS.md` at the repo root.

---

## 1. System mental model

**One binary.** `wabi-server` (Rust) is the entire product: Axum REST API + socket.io live updates + embedded frontend (rust_embed serves the static SPA with an `index.html` fallback — no SSR).

**Event sourcing.** All durable state flows: command → event → projection.

```
REST /api/*  ─┐
socket.io ────┤→ WabiStore trait (WdbAdapter) → CommandCommit → sequencer
              │                                      │
              │                              append-only event store (.wseg)
              │                                      │
              │                                      ▼
              │                        ProjectionDispatcher → SkipMap indexes
              │                                      │
              ▼                                      ▼
         response JSON                        typed query methods (list_*/get_*)
        + socket broadcasts ◄── event ─────────────────┘
```

- **Sequencer** assigns monotonic `commit_seq` to every commit (transactional, ACID).
- **Projections** are in-memory materialized views rebuilt from the event log at startup; they are the read model. `WabiStore` trait methods read them through typed query functions.
- **Realtime**: socket clients get an `init` snapshot + incremental events; REST reads hit the same projections.

## 2. wabi-server (the binary)

### REST API — verified nest list (`src/api/routes.rs`)

`/public /setup /auth /bot /user /channels /messages /upload /albums /wiki /forum /gallery /incidents /calls /admin /payments /nodes /blobs /mesh /operator /addons /places /emoji /steam /media /jobs /standby /sync /whiteboard /lan /media-turn`

Each group is a module with a `routes()` → `axum::Router`, declared in `api/mod.rs`, nested in `api/routes.rs`. Handlers extract `State<Arc<AppState>>`; `state.wdb` is the `Arc<WdbAdapter>`.

### Auth

- REST: `AuthUser` / `OptionalAuthUser` extractors (`auth_extractor.rs`) from `Authorization: Bearer <token>`.
- Admin: `admin_auth(&headers, &state)` (Bearer + role check) or `admin_auth_stepup` (also requires `X-Stepup-Token` from `POST /api/auth/stepup`). Destructive ops (revoke, transfer-ownership) require stepup; `reset_user_password` deliberately uses plain `admin_auth` (no frontend stepup flow exists).
- Login JWT per-user `iat` floor (`user_epochs`); revoke = bump the floor, not a global blocklist entry.

### Socket layer (`src/socketio/`)

`init` payload keys: `channels`, `users` (**online-only** presence map), `serverMembers` (**all** registered users — from `state.app.wdb.list_users()` → `UsersProjection` with `UsersFilter::default()`), `emotes`, `emojis`, `roleDefinitions`, `voiceState`, `messagePurgeVersion`. The frontend renders `offlineUsers = serverMembers − online`; an empty `serverMembers` = the "Offline" section silently disappears.

Handlers are wired in `socketio/wiring.rs` (e.g. `socket.on("message", on_message)` — the `#[allow(dead_code)]` is lint suppression only, it IS the live handler).

## 3. WabiDB engine (`core/crates/wabidb/`)

- **Storage**: append-only event segments `.wseg`, commit index `.widx`, snapshot `.wsnap` under the data dir; `WABIDB_ROOT_KEY` (or passphrase) required at boot for the encryption key.
- **Sequencer/transactions**: one writer; every commit is a `CommandCommit` with `EventToWrite`s; fsync + crash recovery. On open the sequencer's `commit_seq` is seeded from the recovered high-water mark (commit index + on-disk segments including orphans + snapshot watermark), so a restart never reuses a seq — reusing one would repeat an AES-GCM (key, nonce) pair since stream keys are deterministically re-derived and the nonce IS the seq. Segment writers fsync before the acknowledging commit-index fsync; replay skips orphaned records absent from the commit index.
- **Projections** (22+ registered, `engine/mod.rs::build_type_registry()`): `messages`, `reactions`, `channel_members`, `users`, `emotes`, `webhooks`, `user_layouts`, `channels`, `call_sessions`, `call_participants`, `call_signals`, `wiki_pages`, `forum_posts`, `incidents`, `albums`, `album_items`, `dm_messages`, `dm_message_recipients`, `audit`, `gallery_works`, `gallery_feedback`, `wiki_revisions` (+ noop). Records are postcard-encoded (a few JSON); composite keys are length-prefixed strings enabling prefix scans. Some have secondary indexes (`messages_by_channel`, `messages_by_author`); tombstone compaction must purge secondary indexes too.
- **WabiStore trait** (`engine/wabi_store.rs`): the typed domain API (50+ methods), object-safe, async. Two impls: `WdbAdapter` (real engine) and `LocalWabiStore` (HashMap test double). Read = projection query → domain type; write = build record → `self.run(...)` → seq becomes id (`format!("msg_{:x}", seq)` etc.). **Emit shape differs per adapter module — copy the target module's existing call.**
- **Domain types** (`domain/mod.rs`): `User`, `Channel`, `Message`, `WikiPage`, `WikiRevision`, … with `From<Record>` impls; serde_json across HTTP.

## 4. Users & auth model

- **Owner bootstrap**: `setupRequired` gates ONLY on `owner_user_id` (WabiDB OwnerProjection via `claim_owner`/`get_owner_user_id`). First registration after a wipe creates the owner. Legacy `server_owner.json` was a boot-migration shim (user-id only) — code path removed.
- **Registered vs guest**: a user row with EMPTY `password_hash` is a guest; the wire exposes `is_registered: Option<bool>` (`UserView`, `crates/wabi-core/src/workspace/mod.rs` → generated `isRegistered?: boolean | null`). `handle_login` uses the same empty-hash discriminator.
- **Admin registry**: UI merges `$serverMembers` + `$users` (online wins, keyed `dbUserId ?? id`) — `AdminWorkspace.svelte` + `settings/AdminSettingsTab.svelte`. The People panel does the same.
- **Admin endpoints** (`/api/admin`): policies (get/save by key), compression config/metrics, runtime guardrails, payment blocks, dashboard stats, revoke user/all/token, transfer-ownership, recovery-codes, `users/reset-password` (bcrypt → `update_user(password_hash)` → `revoke_user` → `{success:true}`), `users/clear-login-lockout` (honest no-op — no lockout store server-side).
- **Login-bounce gotcha**: legacy `revocations.json` `users: [id]` is a permanent ban (login mints JWT but endpoints 401 "token revoked"). Live fix: clear the array + restart. Code fix: per-user `iat` floor; login clears the legacy entry. Probe `POST /api/auth/login` then `GET /api/user/me` before blaming the frontend.

## 5. Channels & content

`ChannelKind` (append-only, never renumber):

| # | Kind | Wire `channel_type` |
|---|------|---------------------|
| 0 | Text | `text` |
| 1 | Voice | `voice` |
| 2 | Dm | `dm` |
| 3 | GroupDm | `group_dm` |
| 4 | Announcement | `announcement` |
| 5 | Whiteboard | `whiteboard` |
| 6 | Wiki | `wiki` |
| 7 | Forum | `forum` |
| 8 | Incident | `incident` |
| 9 | Gallery | `gallery` |
| 10 | Category | `category` (Discord-style grouping; channels have `position` + `parent_id` for drag-reorder) |
| 11 | Lore | `lore` (external Epic Games Lore CLI; out of scope) |
| 12 | Planning | `planning` (Planner business/workspace surface) |

Content surfaces: wiki pages + revisions (page tree via `parent_page_id`, `slug` deep links `^w/slug`), forum threads/posts (solution marking, votes), gallery works + feedback, incidents (severity/resolve), albums (scope-typed), DMs + DM message recipients.

**Messages**: ids are UUIDs end-to-end. Backend writes `msg_{seq}_{uuid}`; frontend keeps `clientMessageId` through optimistic → accepted (see AGENTS.md golden rule 3). `dedupeByIdKey` is still used for the init channel list — do not remove without a replacement.

## 6. Retention & privacy

Three storage classes, resolved in the send path BEFORE any durable write:

- **live** — session only: skip `wdb.send_message` entirely, assign `live_<uuid>`, keep in the in-memory `session_messages` cache, emit the socket event, no TTL spawn. Gone on restart. NOT E2EE — never market as private.
- **timed** (product default) — `wdb.send_message` + TTL delete after `DEFAULT_CHANNEL_AUTO_DELETE_MS` (24h) unless a map/policy overrides.
- **forever** — `wdb.send_message`, no TTL spawn. Explicit opt-in.

Sentinel labels (`"live"`/`"forever"`) live in the in-memory `channel_auto_delete_label` map (`Arc<RwLock<HashMap<String,String>>>`), NOT as a `Channel` record field (postcard schema safety — see golden rule 5). Both send paths must carry the gate: `socketio/messages.rs::on_message` AND REST `api/messages.rs::send_message` — fixing only one leaves an HTTP persistence hole. Contract tests prove "never written" by scanning the data dir for a canary body, not by restart-and-list.

## 7. Frontend architecture (`frontend/`)

- SvelteKit, **adapter-static only** (`STATIC_BUILD=1`), Svelte 5 runes. Vite config uses esbuild minification (terser breaks the store runtime).
- **Design system**: semantic tokens in `src/styles/tokens.css` — never raw hex in components. Component CSS under `src/styles/components/`. Neutral-branding + glass shell in login/boot (anti-flicker: no default logo src).
- **Themes**: `ALL_PALETTES` registry (`palettes.ts`) — each palette = surfaces/text/accents/status + `ambient` effect (Balatro/Matrix/Spire are selectable themes, not login-only flair). `themeManager.ts` persists; `ThemeCustomizer.svelte`/`ThemePreview.svelte`/`EffectsTab.svelte` manage custom themes.
- **Center-stage workspaces**: `WorkspaceViewKey` in `chat/types.ts`; pills in `ChatHeader.svelte` (Messages/Whiteboard/Planner/Media/Reader/3D/Map). Do NOT add duplicate sidebar buttons for center-stage workspaces.
- **Layout**: `MainLayout.svelte` with dock (left/right), right panel, resize handles (window listeners are load-bearing — attach in `onMount`, clean up in `onDestroy`), workspaces save/restore.
- **Offline layer** (`src/lib/wabidb/`): IndexedDB-only (`wabi-queue` DB, `outbound_queue` store with explicit `key: \`${scopeId}:${id}\`` — IndexedDB keyPath must match a real record field or `put()` throws `DataError`). 25 outbound action types; 10k cap enforced by count (FIFO trim), not age alone; drain on reconnect; `markSyncedByClientId` is on the concrete class, not the interface (deliberate). `StorageSettings.svelte` renders the Offline & Storage UI.
- **State**: Svelte stores — `messageStore`, `channelStore`, `presenceStore`, `socketConnectionCore.ts` (reconnect w/ backoff, `ServerUrl` resolution user-configured), `themeStore`, `layoutStore`.

## 8. Protocol

`crates/wabi-core` defines the wire types; `cargo test -p wabi-core --features ts` runs ts-rs codegen → `packages/wabi-protocol/src/generated/*.ts` (consumed by the frontend). **The regen STRIPS manual edits** — after any regen, re-append `"category"|"lore"` to `ChannelType.ts` and `position`/`parentId` to `ChannelView.ts`. Parallel workers doing `git checkout`/stash in the shared workdir can silently wipe uncommitted changes — re-verify `git diff` before relying on prior patches.

## 9. Replication / standby / mesh (brief)

- **Replication**: `SyncTransport` trait + `SyncWorker`; `/sync` REST group; deployment patterns in wabidb skills.
- **Standby**: `/standby` receives snapshots for warm-standby nodes.
- **Mesh**: `/mesh` multi-node coordination; `core/addons/mesh/backend` is a workspace addon. Helper nodes via `/nodes`; media via `/media` + `/media-turn` (SFU assignment).

## 10. Ops

- **Data dir**: `data/wabi-server/` — WabiDB files (`wabidb/` subdir) + `.lock`. **Two locks**: `data/wabi-server/.lock` and the engine lock `data/wabi-server/wabidb/.lock`. Remove BOTH on swap/restart.
- **Deploy pattern**: build frontend (`STATIC_BUILD=1 bun run build`) → `cargo build --release -p wabi-server` → scp binary as `.new` → stop container → rm both locks → swap → chmod +x → up → verify: SHA match + new hashed CSS chunk (`0.<hash>.css`) served by the binary. Never redeploy the binary to fix Cloudflare-edge 502s; check for a rogue `cloudflared` on another host first.
- **Health**: `/health`. SPA fallback serves `index.html` for all non-API routes.
- **Dev**: 5173 Vite frontend, 3001 backend. Stale browser localStorage with an old token causes "infinite spinning on 5173" after a DB reset — clear storage or incognito.
- **Secrets**: `WABIDB_ROOT_KEY` env (or from_passphrase) required; `data/jwt_secret` exists but is never committed.

## 11. Where things live (file map)

| Concern | Path |
|---------|------|
| REST handlers | `core/crates/wabi-server/src/api/*.rs` (routes: `api/routes.rs`) |
| Socket handlers | `core/crates/wabi-server/src/socketio/*.rs` (wiring: `socketio/wiring.rs`) |
| Engine ↔ API bridge | `core/crates/wabi-server/src/adapter/mod.rs` (`WdbAdapter`) |
| App state | `core/crates/wabi-server/src/state.rs` |
| WabiStore trait + test impl | `core/crates/wabidb/src/engine/wabi_store.rs` |
| Sequencer / engine | `core/crates/wabidb/src/engine/*` |
| Projections | `core/crates/wabidb/src/projections/*.rs` (+ registry in `engine/mod.rs`) |
| Storage formats | `core/crates/wabidb/src/storage/*` |
| Protocol types (source) | `crates/wabi-core/src/` (e.g. `workspace/mod.rs` = UserView/ChannelView) |
| Generated protocol TS | `packages/wabi-protocol/src/generated/*.ts` |
| Frontend components | `frontend/src/lib/components/` (`admin/`, `business/`, `settings/`, `sidebar/`, …) |
| Design tokens | `frontend/src/styles/tokens.css` |
| Frontend WabiDB client | `frontend/src/lib/wabidb/` |
| Plans / handoffs | `docs/plans/`, `docs/HANDOFF-hermes.md` |
