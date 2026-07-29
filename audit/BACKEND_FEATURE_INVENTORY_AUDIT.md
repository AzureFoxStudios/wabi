> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Wabi Backend Feature Inventory Audit

Purpose: turn the generated feature inventory into a truthful backend checklist. A feature is only “implemented” here when code exists, is wired into runtime, and has a clear verification path. Frontend components, docs, manifests, or type definitions alone do not make a backend feature implemented.

Status vocabulary:

- Implemented: backend code exists, is wired into runtime, and is plausibly callable. Still needs smoke/runtime verification unless explicitly noted.
- Partial: meaningful backend code exists, but persistence, validation, authz, runtime behavior, or tests are incomplete/unclear.
- Scaffold: route/type/module shape exists, but the core behavior is placeholder or not wired enough to claim feature support.
- Docs-only: docs, manifests, examples, or scripts exist, but no runtime backend feature was found.
- Missing: no backend implementation found.
- Out of backend scope: frontend/desktop/visual claims that should be audited separately.

## Audit table

### 1. Auth

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---|---|---|---|
| Register/login/guest | Registered users and guests can authenticate | Implemented | `core/crates/wabi-server/src/api/auth.rs`; routes `/register`, `/login`, `/guest` | Runtime curl smoke with fresh data dir + STDB available | Keep |
| Password hashing | bcrypt stores/verifies passwords | Implemented | `api/auth.rs` uses `bcrypt::hash` and `bcrypt::verify` | Add/verify auth unit or integration tests | Keep |
| JWT expiry | Registered tokens 30d, guest tokens 24h | Implemented | `generate_jwt`, `generate_guest_jwt` in `api/auth.rs` | Decode token in smoke test and inspect `exp` | Keep |
| Token validation | Protected routes use JWT extractor/manual validation | Implemented | `core/crates/wabi-server/src/auth_extractor.rs`; protected handlers take `AuthUser`; TURN has local decode | Audit all protected routes and Socket.IO auth consistency | Keep |
| TURN credentials | Authenticated TURN credentials endpoint exists | Implemented | `api/auth.rs::handle_turn_credentials`; mounted under `/api/auth/turn-credentials` and `/api/media-turn/turn-credentials` | Smoke valid/invalid token; verify `use_turns` behavior | Keep |
| Blacklist on login | Banned users are rejected after successful auth | Partial | `api/auth.rs` checks `state.get_blacklist().await` on login | Verify admin/Socket.IO ban writes to same blacklist source and persists | Keep but audit |
| Login logs | Login logs expose password hash prefix/cost or verify result | Fixed | `api/auth.rs` reduced sensitive logs from info to debug level | Verify logs are no longer exposing sensitive data | Keep |

First auth batch:
- Verify which protected routes use `AuthUser` versus ad-hoc token parsing.
- Remove or reduce sensitive login logs if still present.
- Runtime smoke: register, login, guest, invalid token, expired token if easy, TURN with/without config.

### 2. User management

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---|---|---|---|
| Current user | `/api/user/me` exists | Implemented / needs smoke | `core/crates/wabi-server/src/api/user.rs` uses `AuthUser` and `get_user_by_id` | Runtime-smoke registered and guest users | Keep after smoke |
| User settings | `/api/user/settings` exists | Partial | `api/user.rs` reads `display_name`, `avatar_url`, `status_message`, `theme`; update uses raw `ingest_event("user", "upsert")` | Verify reducer accepts these fields and preserves existing user fields | Audit/runtime-test |
| User profile by ID | `/api/user/profile/{id}` exists as authenticated public-safe profile lookup | Implemented / needs smoke | `api/user.rs` requires `AuthUser`, allows other-user lookup, returns public fields only: username/handle/color/displayName/avatarUrl/statusMessage/createdAt | Runtime-smoke own and other-user lookup; verify email/private flags are absent | Keep after smoke |
| User layout | `/api/user/layout` GET/PUT exists | Implemented / needs smoke | `api/user.rs` uses `get_user_layout` / `upsert_user_layout` helpers | Verify layout JSON persistence and auth scoping | Keep after smoke |
| Avatar upload | `/api/upload-profile-picture` mounted | Partial | `api/routes.rs`; `api/upload.rs` | Verify auth, file limits, path safety, returned URL | Audit with upload pass |

First user batch:
- Read `api/user.rs` and `db/users.rs` end-to-end.
- Mark each field as persisted, derived, defaulted, or ignored.
- Add small tests only if the existing test harness can cover them without full STDB boot.

### 3. Channels

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---|---|---|---|
| List/get channels | `/api/channels/`, `/api/channels/{id}` exist | Implemented | `core/crates/wabi-server/src/api/channels.rs` | Smoke with STDB-backed channel rows | Keep |
| Create channel | Admin-only POST exists | Implemented | `api/channels.rs::create_channel`; uses `AuthUser`; `state.is_admin` | Smoke as owner/admin and non-admin | Keep |
| Delete/archive channel | Admin-only DELETE exists | Partial | `api/channels.rs::delete_channel`; calls `stdb.delete_channel` | Verify whether this is soft delete/archive or hard delete | Audit wording |
| Channel types | `channel_type` accepted and returned | Implemented | `CreateChannelRequest.channel_type`, `ChannelResponse.channel_type` | Verify allowed values are constrained if needed | Keep but validate |
| Channel position/parent | position and parent returned | Partial | `ChannelResponse.position`, `parent_id`; create returns defaults | Verify creation/update support before claiming organization features | Downgrade if no update path |
| Description | description accepted and persisted | Implemented | `CreateChannelRequest.description`, `ChannelResponse.description`, `db/channels.rs::create_channel` with description support | Verify description is stored and returned correctly | Keep |
| Role-based channel access | claimed in generated inventory | Unverified / likely partial | Admin checks exist; full per-channel RBAC not proven here | Search/audit STDB reducers and enforcement points | Do not claim yet |

First channel batch:
- Channel description now persisted and returned (fixed).
- Verify delete semantics.
- Do not claim nested organization or role permissions until update/enforcement paths are verified.

### 4. Messages

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Message history | GET `/api/messages/{channel_id}` merges STDB + session cache | Implemented / needs smoke | `core/crates/wabi-server/src/api/messages.rs::get_messages`; now preserves `message_type` from STDB row_json/session cache | Smoke with STDB rows and cached messages | Keep after smoke |
| Message send | POST `/api/messages/` caches immediately and writes STDB async | Implemented / needs smoke | `api/messages.rs::send_message` uses `AuthUser`, session cache, async `upsert_message`; now persists `message_type` | Verify STDB write success/failure behavior; HTTP path does not broadcast Socket.IO by itself | Keep after smoke |
| Session cache cap | HTTP/session cache caps at 1000/channel | Implemented | `api/messages.rs` and `socketio/messages.rs` drain cache over 1000 | Unit-test if practical | Keep |
| Socket.IO message send/history | `message` and `load-history` events are wired | Implemented / needs socket smoke | `socketio/wiring.rs`, `socketio/messages.rs`; message send persists text/type and broadcasts to channel | Runtime Socket.IO smoke with two clients | Keep after smoke |
| Edit/delete | Socket.IO handlers are wired and persist to STDB | Implemented / needs socket smoke | `socketio/messages.rs::on_delete_message`; `socketio/group_members_messages.rs::on_edit_message`; owner checks accept both `123` and `user-123` sender-id shapes | Runtime test owner, non-owner, admin paths | Keep after smoke |
| Reactions | Socket.IO reaction add/remove persists and broadcasts | Implemented / needs socket smoke | `socketio/media_reactions_signaling.rs`; `db/content.rs`; events `emoji-reaction-added/removed` | Runtime test add/remove, duplicate behavior, frontend UI contract | Keep after smoke |
| Rich attachment metadata persistence | Generated inventory implied full media/message metadata persistence | Partial | Socket session cache preserves rich fields; STDB `upsert_message` stores content/type only | Decide whether to extend STDB message row_json for files/gifs/replies/entities | Downgrade or future batch |
| Search | Generated inventory implied broader message features | Missing | No backend search route identified | Move to roadmap | Do not claim |

First message batch:
- Build a message event matrix: HTTP send, Socket.IO send, edit, delete, reaction add/remove.
- For each: auth, persistence, broadcast, frontend event name.

### 5. Socket.IO realtime

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Socket.IO layer | Socket.IO server is mounted | Implemented / needs smoke | `core/crates/wabi-server/src/socketio/wiring.rs`; `main.rs` layers `sio_layer`; frontend connects with `socket.io-client` auth token/session | Start server and connect client/socket smoke | Keep after smoke |
| Connect/join/init | `connect` then `join` emits init snapshot | Implemented / needs smoke | frontend `socketConnectionCore.ts` emits `join`; backend `presence.rs::on_join` emits `init`, `user-joined`; auth token is stored in socket extensions | Runtime smoke with registered user and guest session behavior | Keep after smoke |
| Presence/typing | join/leave/typing events are wired | Implemented / needs socket smoke | `presence.rs`, `messages.rs::on_typing`, frontend listeners update `users`, `serverMembers`, `typingUsers` | Verify two-client presence and typing lifecycle | Keep after smoke |
| Channel room join/history | `join-channel` loads STDB + session messages and joins room | Implemented / needs socket smoke | `presence.rs::on_join_channel`; frontend `joinChannel`/`switchChannel` path should emit `join-channel` | Runtime smoke channel switch and message receipt | Keep after smoke |
| DM creation | frontend/backend event payload now matches | Implemented / needs smoke | `socket.ts::createDM` now emits `create-dm` with `targetUserId`; backend `dm_moderation.rs::on_create_dm` expects `targetUserId` | Smoke create/delete DM | Keep after smoke |
| Group creation | generated inventory/UI imply groups can be created | Implemented / needs smoke | `CreateGroupModal.svelte` calls `createGroup`; frontend emits `create-group`; backend now wires `create-group` to `on_create_group`, persists via `upsert_group`, emits `group-created`/`group-channel-added`; frontend upserts returned channels | Runtime smoke create group, reconnect, verify persisted channel/members | Keep after smoke |
| Role assignment helpers | admin UI role emits now match backend | Implemented / needs smoke | `presenceStore.ts` now emits `assign-role`/`remove-role` with `targetUserId` + `roleName`; backend `wiring_handlers.rs` expects those fields | Smoke promote/demote as admin and non-admin | Keep after smoke |
| Voice listen helper | helper emits now match backend subscribe/leave names | Implemented / needs smoke | `presenceStore.ts` now emits `voice-channel-subscribe` and `voice-channel-leave`; backend wires both | Runtime voice room smoke later | Keep after smoke |
| Voice transmit mode | frontend helper and voice UI transmit selector exist | Implemented / needs smoke | `presenceStore.ts::setVoiceTransmitMode` now emits `primary`/`all-listening`; `ChannelSidebar.svelte` also updates local `setVoiceTransmitRoutingMode`; backend wires `set-voice-transmit-mode`, updates live `VoiceParticipant.transmit_mode`, and broadcasts `voice-transmit-mode-updated` plus refreshed `voice-channel-state` | Runtime smoke two clients switching primary/all-listening while joined/listening to voice channels | Keep after smoke |
| Direct calls/group calls | signaling events are wired | Partial | `wiring.rs` wires call events | Runtime media/signaling smoke required | Keep as signaling, not proven media |
| Voice moderation | mute/deafen events are wired | Partial | `wiring.rs` wires voice moderation handlers | Verify permission checks and broadcast behavior | Audit |
| Whiteboard/P2P/screen-share events | frontend emits several live-collab/media events | Mixed | Screen-share signaling is now implemented/needs smoke: frontend emits `start-screen-share`/`stop-screen-share`/`webrtc-offer`/`webrtc-answer`/`webrtc-ice-candidate`; backend relays those events and returns `screen-share-targets`; frontend creates screen-share offers and handles screen-share WebRTC offer/answer/ICE. P2P file-transfer signaling relay is now wired: backend registers `p2p-offer`/`p2p-answer`/`p2p-ice-candidate` event handlers that relay between sockets; frontend `socketConnectionCore.ts` now listens for these events and routes them to `p2pFileTransfer.ts` handlers. However, the `p2pFileTransfer.ts` module is still not imported by any UI component — the stores/progress model exist but are not wired into any visible transfer UI. Whiteboard `whiteboard:*` events remain missing/partial. | Runtime two-client screen-share smoke; audit P2P/file-transfer progress UI separately (see P2P/File Transfer section below) | Do not claim P2P/file-transfer UI complete |

First realtime batch:
- Create a Socket.IO event matrix document section in this audit.
- Do not mark an event “done” until handler behavior and frontend event names match.

### 6. Uploads, blobs, albums, whiteboard, preview

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Uploads | upload routes exist | Partial | `core/crates/wabi-server/src/api/upload.rs`; mounted under `/api/upload` and profile upload route | Audit auth, max size, path safety, resumable flow, cleanup | Audit/security pass |
| Blob storage | content-addressed blob API exists | Implemented / needs smoke | `api/blobs.rs`; `src/blobs/mod.rs` | Smoke upload/get; verify hash mismatch rejection | Keep after smoke |
| Albums | album routes exist | Partial | `api/albums.rs` | Verify whether storage is persistent or memory-only | Downgrade/fix |
| Whiteboard | whiteboard upload/file serving exists | Partial | `api/whiteboard.rs`; `WhiteboardCanvas.svelte` frontend | Verify auth/access/path safety and whether collaboration is real | Audit |
| URL preview/image proxy | preview/proxy endpoints exist | Partial | `api/preview.rs`; mounted `/url-preview`, `/image-proxy` | Audit SSRF, timeouts, content type, size limits | Security audit |
| Auto-deletion on message delete | generated inventory claim | Unverified | No evidence yet tied to message delete | Verify or remove claim | Do not claim yet |

First media/storage batch:
- Prioritize path traversal, SSRF, and upload-size safety before polish.
- Split “file serving exists” from “privacy-safe file lifecycle exists.”

### 7. Security, moderation, and rate limiting

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Rate limiting | global HTTP rate limit is mounted | Implemented | `core/crates/wabi-server/src/rate_limit.rs`; `main.rs` uses `from_fn_with_state` | Runtime loop should show 429 after threshold | Keep |
| CORS | CORS layer configured | Implemented | `main.rs` builds `CorsLayer` | Verify production origin behavior | Keep |
| Body size limit | max body size configured | Implemented | `main.rs` uses `DefaultBodyLimit::max`; `WABI_MAX_BODY_SIZE` | Smoke over-limit request if practical | Keep |
| Admin checks | some admin-only routes exist | Partial | channels use `state.is_admin`; moderation handlers need audit | Verify every sensitive route/event | Audit |
| RBAC | role-based access control claimed | Partial/unverified | `state.get_user_highest_role` exists; full enforcement not proven | Audit roles, assignments, and enforcement | Do not overclaim |
| Request validation | “all endpoints validate input” | Missing as blanket claim | Manual checks exist in some handlers only | Endpoint-by-endpoint validation audit | Remove blanket claim |
| HTTPS required | generated inventory claim | Deployment-level, not app-enforced | No app-level HTTPS enforcement identified | Keep only in deployment docs if true | Do not claim backend enforcement |

First security batch:
- Make a sensitive-route list: admin, upload, proxy, payments, nodes/jobs, standby, mesh.
- Verify auth/authz for each.

### 8. Helper nodes, jobs, standby, LAN

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Helper node registry | node registry exists | Implemented / needs smoke | `core/crates/wabi-server/src/api/nodes.rs`; `src/nodes/mod.rs` | Smoke pairing, heartbeat, revoke, stale offline | Keep after smoke |
| Job queue | worker job queue exists | Implemented / tested | `src/jobs/mod.rs`; tests observed in `cargo test` output | Verify API routes and stale reaping runtime | Keep |
| Standby snapshots | encrypted envelope validation/storage exists | Implemented / tested | `src/standby/*`; tests observed in `cargo test` output | Verify API route capability restrictions | Keep |
| LAN signed routes | signed local route tokens exist | Implemented / tested | `src/lan/mod.rs`; tests observed in `cargo test` output | Verify route mounting and helper selection | Keep |

First infra batch:
- Prefer smoke tests over new feature work.
- Keep helper-node roadmap phases separate from mesh/distributed sync wording.

### 9. Mesh

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Mesh status/config | `/api/mesh/status`, `/api/mesh/config` exist | Implemented / basic | `core/crates/wabi-server/src/api/mesh.rs` | Smoke disabled/enabled behavior | Keep as basic |
| Mesh heartbeat receive | `/api/mesh/heartbeat` exists | Implemented / basic | `api/mesh.rs::post_heartbeat`; `state.record_heartbeat`; `mesh.rs::record_heartbeat` | Two-process or mocked peer smoke | Keep as basic |
| Mesh heartbeat send | service POSTs heartbeat to configured peers | Implemented / basic | `core/crates/wabi-server/src/mesh.rs::send_heartbeat` | Two-process smoke and logs | Keep as basic |
| Peer health | liveness tracking exists | Partial | `mesh.rs::is_peer_alive`, `get_alive_peers` are future-facing and currently not exposed | Expose or leave internal; do not overclaim | Partial |
| Region-aware routing | generated inventory claim | Missing | `get_optimal_node` returns own node and ignores region | Move to roadmap | Do not claim |
| Distributed state sync | generated inventory claim | Missing | No sync implementation found | Move to roadmap | Do not claim |

First mesh batch:
- Smoke basic heartbeat between two local ports if useful.
- Do not implement distributed sync now unless explicitly chosen; it is not a small backend cleanup.

### 10. Payments and plugins

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Payments API | `/api/payments` routes exist | Partial/implemented-by-route | `core/crates/wabi-server/src/api/payments/mod.rs`, `handlers.rs` | Verify storage, authz, frontend contract | Audit |
| Payment plugin manifests | plugin.json files exist | Docs/config-only for runtime claims | `plugins/*/plugin.json`, `addons/payments-*` | Verify scripts/manifests separately from runtime loading | Keep as manifests |
| Plugin protocol types | plugin types exist | Scaffold | `crates/wabi-core/src/plugin.rs` | Useful type contract, not runtime | Keep as scaffold |
| Plugin verification scripts | checksum/sign scripts exist | Implemented as scripts | `scripts/plugin-verify.mjs`, `plugin-sign.mjs`, `plugin-crypto.mjs` | Run against sample plugin if needed | Keep as tooling |
| Dynamic backend plugin runtime | generated inventory claim | Missing/unverified | No runtime loader found in server pass | Implement later or move to roadmap | Do not claim |
| Dynamic frontend plugin mounting | generated inventory claim | Out of backend scope/unverified | Frontend components/manifests exist | Frontend audit later | Do not claim backend |
| Safe mode/crash-loop protection | generated inventory claim | Docs-only/unverified | README mentions safe mode; runtime not found | Search deeper before claiming | Do not claim |

First payments/plugin batch:
- Audit payment API separately from plugin runtime.
- Do not let manifest existence imply plugin system completion.

### 11. Monitoring, privacy, performance claims

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Health check | `/health` exists | Implemented | `core/crates/wabi-server/src/main.rs::health_check` | Runtime curl | Keep |
| HTTP tracing | TraceLayer mounted | Implemented | `main.rs` layers `TraceLayer::new_for_http()` | Verify logs in runtime smoke | Keep |
| Metrics/correlation IDs | generated inventory claim | Missing/unverified | No metrics endpoint/correlation middleware found | Add later only if desired | Do not claim |
| Zero persistence by default | generated inventory claim | False for current Rust backend direction | STDB + persistent registries/files exist | Reword product docs if needed | Remove from implemented backend |
| No metadata leaks/no IP logging | generated inventory claim | Unverified/privacy-policy-level | Rate limiter extracts IP-like headers; logging behavior needs audit | Do not claim until audited | Remove/downgrade |
| PWA/service worker/offline | generated inventory claim | Out of backend scope | frontend concern | Audit separately | Do not claim backend |

First observability/privacy batch:
- Keep only `/health` and tracing as implemented backend claims.
- Move privacy guarantees to a dedicated privacy audit.

### 12. Desktop/Tauri

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---:|---|---|---|
| Desktop app | generated inventory claims Tauri desktop support | Out of backend scope | `src-tauri/` exists at repo root; package scripts reference Tauri | Separate desktop audit later | Do not block backend |
| Detached panels/windowing | generated inventory claim | Out of backend scope | frontend components/routes exist | Frontend/runtime audit later | Do not block backend |

### 13. P2P / File Transfer

| Area | Claim | Status | Evidence | Verification / next step | Decision |
|---|---|---|---|---|---|
| WebRTC DataChannel send | Frontend can open a DataChannel and stream file chunks | Implemented / needs UI wiring | `frontend/src/lib/p2pFileTransfer.ts` exports `sendFileP2P()` which creates `RTCPeerConnection`, creates `DataChannel`, sends `file-meta` JSON header then 64 KB binary chunks, then `file-complete` marker. Backpressure: waits while `bufferedAmount > CHUNK_SIZE * 8`. No hash verification. | Wire into a visible UI component (file picker, accept/reject dialog, progress bar). Add hash/chunk integrity verification. | Keep core, but not UI-complete. |
| WebRTC DataChannel receive | Frontend can receive chunks via incoming DataChannel | Implemented / needs UI wiring | `p2pFileTransfer.ts::acceptFileTransfer()` sets `pc.ondatachannel`, buffers binary chunks, reassembles via `Blob`, triggers download via `<a>` click. | Build an incoming-file-acceptance UI (modal/toast with accept/reject). Add verified reassembly. | Keep core, but not UI-complete. |
| P2P signaling relay (backend) | Backend relays `p2p-offer`, `p2p-answer`, `p2p-ice-candidate` between peers | Implemented / needs smoke | `media_reactions_signaling.rs`: `on_p2p_offer()` reads `transferId`/`targetId`/`offer`/`fileName`/`fileSize`, resolves sender stable ID/username, emits to target. `on_p2p_answer()` and `on_p2p_ice_candidate()` analogous. | Two-client runtime smoke: verify relay reaches correct target, verify `senderId`/`senderUsername`/`transferId` are preserved across relay. | Keep after smoke. |
| P2P socket event wiring | Backend registers `p2p-offer`/`p2p-answer`/`p2p-ice-candidate` handlers | Implemented | `wiring.rs` registers three `socket.on("p2p-*", ...)` handlers calling above functions. | Verify no naming collision with existing screen-share events. | Keep. |
| P2P frontend socket listeners | Frontend listens for relayed `p2p-*` events and routes to handler | Implemented | `socketConnectionCore.ts::bindStateEventListeners` now has `sock.on('p2p-offer')` → `handleP2PIncomingOffer`, `p2p-answer` → `handleP2PAnswer`, `p2p-ice-candidate` → `handleP2PIceCandidate`. | Verify incoming offer triggers store update. | Keep. |
| Transfer progress store | `activeTransfers` store tracks per-transfer state with full fields | Implemented / expanded | `p2pFileTransfer.ts::activeTransfers` is a `writable<FileTransfer[]>` store. `FileTransfer` now includes: `transferredBytes`, `completedChunks`, `totalChunks`, `chunkSize`, `speedBytesPerSec`, `errorMessage`. Status phases: `pending/preparing/hashing/requesting/transferring/paused/resuming/verifying/complete/failed/cancelled`. | Expand `updateTransferProgress` to accept all fields (done). `updateTransferStatus` now accepts optional `errorMessage`. | Keep. |
| Transfer progress UI component | Visible progress bar with file name, bytes, speed, controls | Implemented / needs smoke | `TransferCenter.svelte` and `TransferCard.svelte` subscribe to `activeTransfers`, `incomingFileOffers`, `transferHistory`. Four-tab view: Incoming, Active, Outgoing, History. Progress cards show: file name, direction icon, transferred/total bytes, completed/total chunks, percent, speed (when available), phase label, error message, animated progress bar. Controls: pause, resume, cancel, retry/restart. Stalled/error visibility via status color and error message field. Registered as workspace panel `'transfers'` with tray button on MainLayout. | Browser smoke: open Transfer Center, accept an offer, pause/resume/cancel/restart in two-client flow. | Keep after smoke. |
| Pause/resume support | Transfer can be paused and resumed mid-stream | Partial / session-runtime implemented | `p2pFileTransfer.ts` now keeps per-transfer runtime control flags. Sender send-loop checks `paused` and `cancelled`, waits while paused, resumes without closing the DataChannel, and stops on cancel. Receiver pause/resume/cancel sends `transfer-control` messages over the DataChannel so the sender loop obeys receiver controls too. | Two-client runtime smoke: pause sender side, pause receiver side, resume both, verify byte counter stops/continues. Durable page-reload resume still requires IndexedDB checkpoints plus STDB session coordination. | Partial — real in-session pause/resume, not durable chunk-offset resume. |
| Hash verification | Chunk or file-level hash check on receive | Missing | No hashing in `p2pFileTransfer.ts`. `file-meta` does not include hash. `file-complete` does not include digest. | Add hash field to `file-meta` (SHA-256 of whole file or per-chunk). Verify on assembly. Reject on mismatch. | Missing — needed for integrity. |
| Fallback path (P2P → HTTP relay) | If P2P connection fails, transfer via server relay | Missing | No fallback code exists. The HTTP resumable upload path (`uploadResumable.ts`) is for user-initiated uploads to the server, not for P2P-fallback. | After P2P timeout/failure, offer to switch to HTTP relay. The receiver would download from server instead of DataChannel. | Missing — future work. |
| Incoming offers list | Single nullable offer replaced with list; per-offer accept/reject | Implemented | `incomingFileOffers` writable list store. `incomingFileOffer` retained as derived backward-compat. `acceptFileTransfer(socket, transferId?)` accepts optional id. `rejectFileTransfer(transferId?)` accepts optional id. `handleP2PIncomingOffer` pushes to list. | Verify multi-offer accept/reject in UI. | Keep. |
| Transfer history | Completed/failed/cancelled transfers tracked | Implemented | `transferHistory` writable store. `moveToHistory()` called in `cleanup()` and `cancelTransfer()`. History tab in TransferCenter shows past transfers. | Verify entries appear in history after completion. | Keep. |
| Transfer settings (local) | askEveryTime, autoAcceptTrusted, max downloads/uploads | Implemented (scaffold) | `transferSettings` writable persisted to localStorage. Settings tab in TransferCenter with field editors. No server-side enforcement. | Verify localStorage round-trip. | Keep — UI scaffold. |
| Retry/restart transfer | Failed/cancelled transfers can be retried | Partial / outgoing session-runtime implemented | `restartTransfer(transferId, socket?)` can restart outgoing transfers during the same app session by retaining the original `File`, socket, and target user in runtime maps, closing old transport, and emitting a fresh `p2p-offer` for the same transfer id. Receiver-side restart currently surfaces a clear message because re-request routing needs STDB transfer-session state. | Two-client runtime smoke: fail/cancel an outgoing transfer, click restart, verify a new incoming offer appears and transfer can complete. | Partial — outgoing same-session restart works; durable/receiver-originated restart needs STDB. |
| Storage persistence and transfer truth | Transfers survive page reload / tab close | Missing / explicitly bounded | No IndexedDB persistence for chunks/manifests yet. Runtime maps keep selected `File` handles only during the current app session. STDB must be the shared source of truth for offers, restart requests, sender/receiver intent, policy, and relay/helper state; IndexedDB should only cache local chunks/checkpoints. HTTP resumable uploads use localStorage for upload-id resume only. | Add STDB transfer-session table/reducers first; then persist local chunk/checkpoint manifests to IndexedDB keyed by STDB transfer/session id. | Missing — future work. |
| Speed calculation | Transfer throughput tracked and exposed | Implemented | `sendFileChunks` and the receive `dc.onmessage` handler both track speed samples (3-second sliding window), computing `speedBytesPerSec` on 500ms intervals. Exposed in `activeTransfers` store. | Verify speed values in debug UI or future component. | Keep. |
| E2EE for P2P transfers | Encrypted DataChannel for DMs | Missing | No encryption applied to DataChannel. The HTTP upload path has E2EE (`e2eManager.ts`) for DMs via pre-encrypted blob upload — this is server-relayed, not P2P. | Future: negotiate encryption keys via the same DM E2EE key exchange, then encrypt chunks before sending over DataChannel. | Missing — future work. |

**Required transfer progress model (for UI implementation):**

Any P2P/file-transfer acceptance criteria MUST require visible verbose progress/loading UI with:

- **File name** — plain text display
- **Transferred bytes / total bytes** — e.g. "14.2 MB / 50.0 MB"
- **Completed chunks / total chunks** — if chunked, e.g. "227 / 800 chunks"
- **Percent** — e.g. "28%"
- **Speed** — when available, e.g. "3.2 MB/s"
- **Phase label** — one of: `preparing`, `hashing`, `requesting`, `transferring`, `paused`, `resuming`, `verifying`, `complete`, `failed`
- **Controls** — pause, resume, cancel, retry
- **Stalled/error visibility** — show if no progress for >10s; show error message on failure
- **Progress bar** — animated fill based on `progress` (0–1)

No vague spinner-only UX is acceptable.

**State machine:**
```
pending → preparing → hashing → requesting → transferring → verifying → complete
                                         ↓                        ↓
                                      paused → resuming → transferring
                                         ↓
                                     cancelled / failed
```

## Prioritized execution order

1. Auth
2. User
3. Channels
4. Messages
5. Socket.IO realtime
6. Uploads/blobs/albums/whiteboard/preview
7. Security/moderation/rate limits
8. Helper nodes/jobs/standby/LAN
9. Mesh
10. Payments/plugins
11. Monitoring/privacy/performance claim cleanup
12. Desktop/Tauri claim cleanup as a separate non-backend audit

## Known corrections to preserve

- Mesh heartbeat/status exists, but region-aware optimal routing and distributed state sync are not implemented.
- Plugin manifests/types/scripts exist, but dynamic backend/frontend plugin runtime and safe-mode must not be claimed unless runtime code is found.
- “Zero persistence by default” conflicts with current Rust + SpacetimeDB + persistent registry direction.
- Channel description is accepted in `CreateChannelRequest`, but current channel response/handler does not prove persistence.
- Rate limiting is real and mounted.
- Health endpoint and `TraceLayer` are real; full metrics/correlation IDs are not proven.
- Voice/video/calling has signaling/UI/backend pieces, but end-to-end media behavior must be runtime-tested before calling it done.

## First recommended implementation batch

Batch 1: Auth/user/channel truth pass.

Tasks:

1. Auth route smoke and cleanup
   - Inspect: `core/crates/wabi-server/src/api/auth.rs`, `auth_extractor.rs`, `main.rs`.
   - Verify: register/login/guest/TURN invalid-token behavior.
   - Fix only small issues found, such as unsafe logs or duplicated token parsing if obviously low-risk.

2. User endpoint audit
   - Inspect: `core/crates/wabi-server/src/api/user.rs`, `core/crates/wabi-server/src/db/users.rs`.
   - Produce exact field matrix: returned, persisted, defaulted, ignored.
   - Fix only small persistence mismatches if obvious.

3. Channel description decision
   - Inspect: `api/channels.rs`, `db/channels.rs`, STDB schema/reducers.
   - Either implement description persistence/response or remove the implemented claim.
   - Verify create/list/get behavior.

4. Backend health verification
   - Run:
     - `cargo build --manifest-path core/crates/wabi-server/Cargo.toml`
     - `cargo test --manifest-path core/crates/wabi-server/Cargo.toml`
   - If runtime prerequisites are available, start server and smoke `/health`, auth, channels, messages.

Suggested verification commands:

```bash
cd /var/home/Ronin/wabi
cargo build --manifest-path core/crates/wabi-server/Cargo.toml
cargo test --manifest-path core/crates/wabi-server/Cargo.toml

# Runtime smoke after server boot:
curl -s http://localhost:3000/health | jq .
```

## Operating rule for the campaign

For each inventory component:

1. If complete: mark implemented and move on.
2. If a small obvious gap blocks truthfulness: fix it and verify.
3. If a feature is scaffolded but not needed for backend readiness: mark scaffold/roadmap.
4. If docs overclaim: downgrade the docs/inventory rather than building a giant feature accidentally.
5. Keep `cargo build` and targeted tests green after each batch.

Current document status: initial audit/checklist with P2P/file-transfer section added. It is not a final certification of backend readiness. Each row still needs the verification step before it can be used as public-facing implemented-feature wording.
