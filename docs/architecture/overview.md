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

- **Sequencer** orders durable commands by monotonic `commit_seq`; success waits for complete projection application. This is not MVCC or serializable application read-modify-write isolation.
- **Projections** are in-memory materialized views rebuilt from the event log at startup; they are the read model. `WabiStore` trait methods read them through typed query functions.
- **Workspace room admission** binds the 22 Wiki, Forum, incident, gallery and project-task/run event types to their decoded parent, channel stream and owner condition before preparation. Placed rooms require a condition; mixed placement/workspace commands are refused. The adapter shares this event catalog. Replay and supported record decoders retain their compatibility rules. This does not complete other internal/session admission, routing or leases. See [operator contract](../deployment/WORKSPACE_ROOM_ADMISSION.md).
- **Realtime**: socket clients get an `init` snapshot + incremental events; REST reads hit the same projections.

## 2. wabi-server (the binary)

### REST API — verified nest list (`src/api/routes.rs`)

`/public /setup /auth /bot /user /friends /following /channels /messages /upload /albums /wiki /forum /gallery /incidents /calls /admin /payments /nodes /blobs /mesh /operator /addons /places /emoji /steam /media /jobs /standby /sync /whiteboard /lan /media-turn`

Each group is a module with a `routes()` → `axum::Router`, declared in `api/mod.rs`, nested in `api/routes.rs`. Handlers extract `State<Arc<AppState>>`; `state.wdb` is the `Arc<WdbAdapter>`.

`POST /api/following/poll` is the authenticated, bounded read used by the client for followed channels on inactive saved servers. It rechecks channel access on each poll and returns a small cursor delta. The Activity center combines these local follows with server-local friends and current-server unread state; it is not a server-side notification authority or federation protocol. See [notification scope](../features/NOTIFICATIONS.md).

### Auth

- REST: `AuthUser` / `OptionalAuthUser` extractors (`auth_extractor.rs`) from `Authorization: Bearer <token>`.
- Admin: `admin_auth(&headers, &state)` (Bearer + role check) or `admin_auth_stepup` (also requires `X-Stepup-Token` from `POST /api/auth/stepup`). Destructive ops (revoke, transfer-ownership) require stepup; `reset_user_password` deliberately uses plain `admin_auth` (no frontend stepup flow exists).
- Login JWT per-user `iat` floor (`user_epochs`); revoke = bump the floor, not a global blocklist entry.
- Server role assignment is one canonical existing RBAC event, followed by projection completion, effective-role live update and a correlated receipt. Owner/configured-administrator protections apply before writes; Authority role names remain a protected built-in catalog; separate service-role memberships are described below. Init/roster and dashboard role presentation use the effective role. Administrative role changes are online-only and legacy queued grants cannot replay.
- Public-channel minimum-role gating and reaction-role automation are not implemented enforcement features in this version. Admin UI must say so, not offer a selector that appears to make public channels private. Durable DM/group admission remains a separate implemented boundary. Dashboard `extra.unavailableMetrics` distinguishes unsupported counters/feeds from measured zeroes.
- Legacy `minRole` updates reject before applying any other fields in the request. The old Ban UI/socket command never durably excluded accounts: it is now unavailable and rejects explicitly; old queue records remain non-retryable failures. Separate existing blacklist enforcement is unchanged. Role demotion does not revoke account access.

### Service roles

Additional service-role memberships and grants live in the additive JSON v1
`service_access` aggregate, separate from authority RBAC and Lore roles. Admin
Roles manages them inline with revision-checked writes. An operator-owned
endpoint registry explicitly exposes fixed TCP destinations; the authenticated
WebSocket gateway checks current grants before forwarding. No Tailcat device
or pipe mutation is implied. See [contracts, migration and limits](../features/SERVICE_ACCESS.md).

### Socket layer (`src/socketio/`)

`init` payload keys: `channels`, `users` (**online-only** presence map), `serverMembers` (**all** registered users — from `state.app.wdb.list_users()` → `UsersProjection` with `UsersFilter::default()`), `emotes`, `emojis`, `roleDefinitions`, `voiceState`, `messagePurgeVersion`. The frontend renders `offlineUsers = serverMembers − online`; an empty `serverMembers` = the "Offline" section silently disappears.

Handlers are wired in `socketio/wiring.rs` (e.g. `socket.on("message", on_message)` — the `#[allow(dead_code)]` is lint suppression only, it IS the live handler).

Message success effects follow successful WabiStore completion: a failed durable
send emits correlated `message-error` with an unknown outcome and returns before
cache, webhook, acceptance or broadcast. Pre-write validation/access/mute denials
are rejected; live channels retain intentional no-disk delivery. Clients show
bounded pending/unknown/rejected states, preserve sender-scoped optimistic nonces,
and never treat transport emit completion as server acceptance. This does not
fix the separate attachment/rich-metadata reconstruction gaps; see the
[delivery contract and limits](../plans/2026-09-08-message-delivery.md).

## 3. WabiDB engine (`core/crates/wabidb/`)

- **Storage**: append-only event segments `.wseg`, commit index `.widx`, engine checkpoint `projections/snapshot.json` (JSON+hex) under the data dir. Binary `.wsnap` support exists separately but is not the live engine checkpoint path. `WABIDB_ROOT_KEY` (or passphrase) is required at boot for the encryption key.
- **Sequencer/transactions**: one writer; every commit is a `CommandCommit` with `EventToWrite`s; fsync + crash recovery. On open the sequencer's `commit_seq` is seeded from the recovered high-water mark (commit index + on-disk segments including orphans + snapshot watermark), so a restart never reuses a seq — reusing one would repeat an AES-GCM (key, nonce) pair since stream keys are deterministically re-derived and the nonce IS the seq. Segment writers fsync before the acknowledging commit-index fsync; replay skips orphaned records absent from the commit index.
- **Write completion**: index group fsync → `DispatchCommit` containing all events → ordered handler application → one shared applied-watermark advance → application ack → command success. Optional work may return `EngineBusy` at command admission, not after durability. Immediate REST/adapter readback and live-event construction need no catch-up polling. At most one event per stream per command is allowed by the current nonce format.
- **Failure and recovery**: a registered projection failure after durability halts the writer/applied prefix; the command is not rolled back and must not be blindly retried. `/health` and `/readyz` return 503 for failed application or a stopped writer; `/livez` remains a process-liveness probe. Replay requires every indexed post-snapshot event, applies in `(commit_seq, event_ref ordinal)` order, and fails startup on handler errors. Unindexed records are skipped even when the commit index is empty; their sequences are reserved for nonce safety, not reported as applied work.
- **Checkpoint boundary**: snapshot writers and whole-commit application share a lock. Snapshots reject failed application state and use temporary-file write/fsync/rename (directory fsync on Unix), preserving the previous checkpoint until replacement. Ordinary reads do not acquire that lock and can observe a later in-flight command; no snapshot isolation is implied. See [write-completion evidence and limits](../plans/2026-09-05-wabidb-write-completion.md).
- **Projections** (22+ registered, `engine/mod.rs::build_type_registry()`): `messages`, `reactions`, `channel_members`, `users`, `friend_relationships`, `emotes`, `webhooks`, `user_layouts`, `channels`, `call_sessions`, `call_participants`, `call_signals`, `wiki_pages`, `forum_posts`, `incidents`, `albums`, `album_items`, `dm_messages`, `dm_message_recipients`, `audit`, `gallery_works`, `gallery_feedback`, `wiki_revisions` (+ noop). Records are postcard-encoded (a few JSON); composite keys are length-prefixed strings enabling prefix scans. Some have secondary indexes (`messages_by_channel`, `messages_by_author`, `messages_by_channel_time`); tombstone compaction must purge secondary indexes too.
- **Room placement control record:** `room_placement_changed_v1` writes a bounded JSON record to `room_placements`, keyed by channel ID, on `room-placement:v1:<channel-id>`. Ordinary channel creation pairs `room_placement_initialized_v1` with `channel_created` in one commit so both derive the same sequence-based channel ID; private-room creation includes a known-ID placement in its aggregate commit. The sequencer isolates placement commands from adjacent group-commit windows and rejects malformed streams, payloads and skipped epochs before durability; replay enforces the same projection rules. The Authority refuses selected local chat/channel writes when a recorded owner differs from its configured node ID, including Live-room session sends. Legacy rooms can be placed on the same node at a stopped boundary. Selected durable room writes carry an observed owner and epoch that the sequencer rechecks against earlier applied placements; other room paths still lack this admission. Future multi-owner builds must add a complete version-gated room-write fence, routing and a fenced handoff before moving rooms.
- **Persisted call parent admission:** all five call event types require a room owner condition matching their session parent and event stream before local durability. Call creation runs in an isolated sequencer window so the next queued command sees its accepted binding. Call record encodings and historic replay handlers are unchanged. Standalone direct calls use a separate canonical placement ID and initialize it atomically with unplaced creation, preserving their stored/public scope and any independent DM chat. Stopped backfill includes retained active/ended direct sessions. This does not cover live media admission, regional routing or delivery. See [focused evidence and limits](../testing/ROOM_PLACEMENT_FOUNDATION_2026-09-28.md).
- **WabiStore trait** (`engine/wabi_store.rs`): the typed domain API (50+ methods), object-safe, async. Two impls: `WdbAdapter` (real engine) and `LocalWabiStore` (HashMap test double). Read = projection query → domain type; write = build record → `self.run(...)` → seq becomes id (`format!("msg_{:x}", seq)` etc.). **Emit shape differs per adapter module — copy the target module's existing call.**
- **Domain types** (`domain/mod.rs`): `User`, `Channel`, `Message`, `WikiPage`, `WikiRevision`, … with `From<Record>` impls; serde_json across HTTP.

- **Message parent admission and ID lookup:** new local message create/edit/delete, channel clear and reaction events are checked against their actual parent and expected stream before durability. A placed room requires a matching observed owner/epoch; a valid condition for a different room is refused. Message creates prepared earlier in the fsync group provide parent bindings for later edits/reactions, but failed preparation contributes no binding. Placement changes and message mutations require separate commands. Historic replay remains unchanged. `message_by_id_v1` stores composite-primary-key pointers, rebuilt and validated at startup; ID-only reads reject legacy duplicates rather than choosing a room. Message compaction removes ID pointers and all time-index versions of deleted rows. The sequencer also checks the immutable local runtime identity described below; this remains trusted application admission, not a distributed writer lease. See [operator migration and lookup behavior](../deployment/MESSAGE_ID_LOOKUP.md).

- **Local engine identity:** the Authority selects its configured node ID when opening WabiDB; the engine and sequencer retain that immutable runtime identity, and the adapter reads it directly. Every provided owner condition must name this local ID before its observed placement/epoch is checked. A correct remote owner/epoch does not grant that remote identity to the local engine. Default engine embedding remains `node-1`; custom embedding selects identity before startup. The previous adapter builder cannot rename a running engine. This is operator-selected runtime identity, not authenticated membership or a distributed lease; other unguarded writers remain outside complete room admission. See [runtime identity contract](../deployment/NODE_RUNTIME_IDENTITY.md).

## 4. Users & auth model

- **Owner bootstrap**: `setupRequired` gates ONLY on `owner_user_id` (WabiDB OwnerProjection via `claim_owner`/`get_owner_user_id`). First registration after a wipe creates the owner. Legacy `server_owner.json` was a boot-migration shim (user-id only) — code path removed.
- **Registered vs guest**: a user row with EMPTY `password_hash` is a guest; the wire exposes `is_registered: Option<bool>` (`UserView`, `crates/wabi-core/src/workspace/mod.rs` → generated `isRegistered?: boolean | null`). `handle_login` uses the same empty-hash discriminator.
- **Friends candidate (2026-09-25)**: a versioned JSON relationship event replaces one server-local account pair's pending/accepted state in `friend_relationships`. Only the pair can read or change its request; accepting a request does not grant channel access. Retained DM history pages use channel-scoped message IDs and the durable time index. See the [candidate contract](../plans/2026-09-25-friends-and-dm-rebuild.md).
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
The bot send endpoint rejects Live rooms because it only supports durable delivery. Lore promotion also rejects a Live room before performing its external write; if a room switches to Live during an ongoing promotion, its optional durable chat announcement is skipped and the promotion result reports that fact.

## 7. Frontend architecture (`frontend/`)

- SvelteKit, **adapter-static only** (`STATIC_BUILD=1`), Svelte 5 runes. Vite config uses esbuild minification (terser breaks the store runtime).
- **Design system**: semantic tokens in `src/styles/tokens.css` — never raw hex in components. Component CSS under `src/styles/components/`. Neutral-branding + glass shell in login/boot (anti-flicker: no default logo src).
- **Themes**: `ALL_PALETTES` registry (`palettes.ts`) — each palette = surfaces/text/accents/status + `ambient` effect (Balatro/Matrix/Spire are selectable themes, not login-only flair). `themeManager.ts` persists; `ThemeCustomizer.svelte`/`ThemePreview.svelte`/`EffectsTab.svelte` manage custom themes.
- **Center-stage workspaces**: `WorkspaceViewKey` in `chat/types.ts`; one persistent `WorkspaceViewBar` in `MainLayout` (Messages/Calls/Whiteboard/Planner/Notes/Project/Files/Media/Reader/3D/Map). `workspaceNavigationState.ts` binds the existing queue, voice-view, and per-channel board stores to the shared resolver/transition logic. Project/Files render in the shell, not the message scroller; ChatHeader owns channel context/actions only. Do NOT add duplicate sidebar/header switchers or a parallel persisted view store.
- **Layout**: `MainLayout.svelte` with dock (left/right), right panel, resize handles (window listeners are load-bearing — attach in `onMount`, clean up in `onDestroy`), workspaces save/restore.
- **Product layout contract (2026-09-15)**: channels anchor location/context; center stage owns the primary task. Stubs are additive only and open optional multitasking alongside center stage. Right panels must not become required primary destinations or replace the selected center-stage workspace. Preserve the stub system and simultaneous center/panel use even when both views share underlying data. On narrow screens, an explicitly opened secondary view needs a clear return to the selected center stage.
- **Restore ownership**: pin/mode/width subscriptions synchronize the saved workspace snapshot. Startup/login/reconnect home-preference refresh must not issue panel-open commands over a restored layout; saved pins and intentionally closed docks win. Explicit registration/Settings home choices are idempotent commands.
- **Draft and overlay ownership**: runes-based ChatComposer mounts are keyed by identity/channel. Session-memory draft slots preserve text, replies and selected Files through workspace changes; simultaneous center/dock editors remain separate. Explicit logout clears saved drafts even without a mounted editor. An in-flight message-store handoff can settle its own pending draft after remount, but a retired editor cannot send the next chunk or redirect an upload. This is not a persisted chat archive or a claim of server message acknowledgment. Settings/BaseModal share modal focus ownership; Admin entry closes Settings and Back restores the app.
- **Offline layer** (`src/lib/wabidb/`): IndexedDB-only (`wabi-queue` DB, `outbound_queue` store with explicit `key: \`${scopeId}:${id}\`` — IndexedDB keyPath must match a real record field or `put()` throws `DataError`). 25 outbound action types; 10k cap enforced by count (FIFO trim), not age alone. Chat enqueue captures account ownership; drain durably claims before emit. Concrete `settleMessageReceipt` matches account/server, channel, client nonce, chat type and attempt marker atomically. Acceptance cannot be downgraded; uncertain attempts and unowned legacy chat are not automatically replayed. Explicit-session generations fence same-account logout/re-login. `StorageSettings.svelte` renders the Offline & Storage UI.
- **Local history boundary**: the queue is not an offline chat archive; client `put/get/query` remain scaffolds. Legacy chat archives and native chat-sidecar autosave were retired (no active inbound writer and no registered native sidecar commands). Unowned old archive records remain on disk but are never loaded/exported/migrated or automatically deleted. `storage.ts` now exposes only existing server-scoped Planner settings; it does not grant account ownership to old message data. See the [membership work record](../plans/2026-09-07-group-membership-revocation.md).
- **State**: Svelte stores — `messageStore`, `channelStore`, `presenceStore`, `socketConnectionCore.ts` (reconnect w/ backoff, `ServerUrl` resolution user-configured), `themeStore`, `layoutStore`.

## 8. Protocol

`crates/wabi-core` defines the wire types; `cargo test -p wabi-core --features ts` runs ts-rs codegen → `packages/wabi-protocol/src/generated/*.ts` (consumed by the frontend). **The regen STRIPS manual edits** — follow `AGENTS.md` for the existing `position`/`parentId` compatibility additions in `ChannelView.ts`. `Category` and `Lore` are native Rust variants now; do not manually re-add them to `ChannelType.ts`. Parallel workers doing `git checkout`/stash in the shared workdir can silently wipe uncommitted changes — re-verify `git diff` before relying on prior patches.

## 9. Replication / standby / mesh (brief)

- **Replication**: `SyncTransport` trait + `SyncWorker`; `/sync` REST group; deployment patterns in wabidb skills.
- **Standby**: `/standby` receives snapshots for warm-standby nodes.
- **Mesh**: `/mesh` multi-node coordination; `core/addons/mesh/backend` is a workspace addon. Helper nodes via `/nodes`; media via `/media` + `/media-turn` (SFU assignment).

### Optional Project worker coordination (development candidate)

The Authority durably owns the optional `project-workers` addon roster and run
attempts. `project_worker_updated_v1` is a schema-version-1 JSON channel event,
registered in the actual-parent/local-owner workspace admission catalog and
applied to `project_workers`. Additive worker/recovery fields on `project_runs`
default for older JSON records; no persistent postcard layout changes. Workers
are scoped bot clients, not state authorities or replication peers. The
Authority serializes lease/contact-based recovery and fences stale attempts;
pending side effects block automatic recovery. The default-off Project
Connections UI is a scoped roster, not a private network inventory. See
[the contract](../features/PROJECT_CONNECTIONS.md) for trust, revocation,
compatibility and the unimplemented native repository-recovery boundary.

## 10. Ops

- **Data dir**: `data/wabi-server/` — WabiDB lives in `wabidb/`. The current engine holds an OS advisory lock on the persistent `wabidb/.lock` inode; its PID is diagnostic only. Background disk writers retain ownership while draining. Leave the file in place on restart. A root `.lock` is legacy; resolve it only after stopping every old process. Never mix old PID-based and new advisory-lock binaries against the same tree. See [backup/recovery](../deployment/BACKUP_AND_RECOVERY.md).
- **Deploy pattern**: build frontend (`STATIC_BUILD=1 bun run build`) → `cargo build --release -p wabi-server` → scp binary as `.new` → stop container and verify old process exit → leave advisory lock inode in place → swap → chmod +x → up → verify: SHA match + new hashed CSS chunk (`0.<hash>.css`) served by the binary. Never redeploy the binary to fix Cloudflare-edge 502s; check for a rogue `cloudflared` on another host first.
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

### Timed retention query (Tim release branch, not yet merged)

The Authority's full sweep runs once per minute, while channels with a five-second, thirty-second or one-minute policy generation are checked each second. It selects up to 1,000 undeleted expired records per channel and policy generation from `messages_by_channel_time`, bounding the indexed creation-time range before applying the batch limit. Recent traffic and older messages from a forever-retained generation therefore cannot hide expired records. The existing commit-sequence suffix resolves edit/delete versions before counting candidates. This adds no events, record fields, indexes or postcard migration. Timestamps use the existing nonnegative Unix-microsecond ordering.

Expiry still calls ordinary logical deletion. It does not purge the original event history, attachment files, saved reports, caches or external backups. `message_retention_contract` verifies deleted-body retention and stopped-backup restoration using canaries; `scripts/authority-retention-smoke.mjs` exercises the real runtime sweep and exact policy hydration across restarts.

Exact retention labels and policy epochs are initialized synchronously in `AppState::new` from validated `channel_retention.json` before WabiDB opens. Changing retention now appends an effective-at boundary: messages already sent keep the policy that applied when they were written; only later messages take the new policy. Existing sidecars containing only `channels` decode as one time-zero generation with their previous label. The authenticated retention endpoint returns these generations for the message countdown UI. Empty past generations are compacted on policy changes, and a per-channel bound prevents unbounded sidecar growth. Malformed/unreadable files fail startup; reads and mutations propagate errors instead of synthesizing an empty policy map. No persistent message record schema changed. While Live mode is selected, the session-only history view may hide earlier durable messages until the room leaves Live mode; their original policy still applies in storage. An older binary ignores the epoch history and must not be used as a simple rollback after epoch writes (see the backup procedure).

Realtime channel settings delegate retention changes to `api::channels::apply_channel_retention`, matching the REST path. Settings receipts contain only the changed fields instead of representing omitted retention/spoiler values as null resets.

### Independent personal Planner (development candidate)

The `/personal` app-level surface reuses Planner views with an identity independent of community authentication. Browser records use a distinct IndexedDB scope. Desktop records use the bundled `wabi-server --personal-planner` mode over private stdin/stdout IPC via an origin-checked main-window Tauri command. This mode exits before normal server logging, configuration, network listeners, helpers or Authority/WabiDB startup. It stores versioned JSON snapshots under the native app data `personal-planner` folder, with cross-process operation locking, revision conflict drafts and immutable synchronized commits. These are personal snapshot records, not new community projections, replication or federation. No old account records migrate automatically. See [Local Planner](../features/LOCAL_PLANNER.md) and [acceptance](../testing/PERSONAL_PLANNER_ACCEPTANCE_2026-09-28.md).

### Office integration candidate (2026-10-02)

Documents and optional Sheets/Present use one Yjs editor/session path. The new
`workspace_records_v1` projection decodes versioned JSON, without modifying
existing postcard records. `workspace_record_replaced_v1` and
`workspace_update_appended_v1` commit on private `workspace:<key>` streams;
channel sharing is an ACL association, not a channel-stream event or chat fanout.
Adapter compare-and-swap checks revision/owner and confirms the applied read
model before acknowledging. Reads and mutations re-admit the original credential
under the membership guard; owned operations retain both through cancellation
and durable completion. Channel-associated content mutations also require
participation/rules acknowledgment. These object streams do not claim complete
room-placement writer fencing, distributed leases, regional routing or HA.
Sheets/Present packages are independently gated in Vite and addon inventory;
center-stage routing reuses the existing addon queue and preserves optional
right panels and separate drafts. See [Office workspaces](../operations/office-workspaces.md).
