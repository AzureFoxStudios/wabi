# Wabi authorization matrix — 2026-11-03 backend security audit

> **Generated, do not hand-edit.** Regenerate with
> `python3 scripts/security/generate_authz_matrix.py`.
> Source of truth: `core/crates/wabi-server/src/api/routes.rs`
> (HTTP nests), each module's `routes()` (` .route(...)` calls), and
> `core/crates/wabi-server/src/socketio/wiring.rs` (Socket.IO events).

## How to read the guard column

The `Guard evidence` column is derived from tokens in the handler's
signature/body, not from a claim that the guard is sufficient. `REVIEW`
means no handler-level guard token was found: those rows are the ones a
reviewer must adjudicate by hand. Every HTTP request also passes through
the router-level layers in `app_router.rs` (rate limiting, IP deny, JSON
body budget, `RequestBodyLimitLayer`/`DefaultBodyLimit`, CORS,
compression, tracing); those are *not* authorization and are not counted
as a guard. Socket.IO connections pass the namespace middleware in
`wiring.rs` (`SioIdentity` + bearer/revocation checks) before any event
handler runs.

September's boundary passes (channel access, call admission, call state,
Lore credentials) established `channel_access::require_access` as the
shared REST/Socket.IO channel policy. October's new surface is the
`game:*` family; see the audit report for its per-event adjudication.

## HTTP routes (355 declarations; 316 under `api/`)

Rows marked `other` come from `app_router.rs` (operational endpoints),
the helper/inbox/replica binaries and `socket.rs`, plus test-fixture
routers in `anchor.rs`, `rate_limit.rs`, `bot_delivery.rs`,
`checkpoint_jobs.rs` and `helper_client.rs`. They are listed so the
inventory is complete; the `Guard evidence` column is a static token
scan, not a claim that a fixture router is production-exposed.

| Source | Scope | Prefix | Path | Method(s) | Handler | Guard evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `core/crates/wabi-server/src/api/addons.rs:433` | API | `/addons` | `/` | GET | `list_addons` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/addons.rs:436` | API | `/addons` | `/{id}` | GET | `get_addon` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/addons.rs:438` | API | `/addons` | `/{id}/switch` | POST | `switch_addon` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:790` | API | `/admin` | `/policies/{key}` | GET/POST | `get_policy, save_policy` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:791` | API | `/admin` | `/compression-config` | GET | `get_compression_config` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:792` | API | `/admin` | `/compression-metrics` | GET | `get_compression_metrics` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:793` | API | `/admin` | `/compression-metrics/reset` | POST | `reset_compression_metrics` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:797` | API | `/admin` | `/runtime-guardrails` | GET | `get_runtime_guardrails` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:798` | API | `/admin` | `/network-health` | GET | `super::network_health::get` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/admin.rs:799` | API | `/admin` | `/payments/blocks` | GET/POST | `list_payment_blocks, create_payment_block` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/admin.rs:803` | API | `/admin` | `/payments/blocks/{user_id}` | DELETE | `clear_payment_block` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/admin.rs:804` | API | `/admin` | `/stats` | GET | `get_dashboard_stats` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/admin.rs:805` | API | `/admin` | `/revoke/user` | POST | `revoke_user` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/admin.rs:806` | API | `/admin` | `/revoke/all` | POST | `revoke_all` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:807` | API | `/admin` | `/revoke/token` | POST | `revoke_token` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:808` | API | `/admin` | `/transfer-ownership` | POST | `transfer_ownership` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/admin.rs:809` | API | `/admin` | `/recovery-codes` | POST | `recovery_codes` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/admin.rs:810` | API | `/admin` | `/users/reset-password` | POST | `reset_user_password` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/admin.rs:811` | API | `/admin` | `/users/clear-login-lockout` | POST | `clear_login_lockout` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:812` | API | `/admin` | `/uploads/revoke` | POST | `revoke_upload` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:813` | API | `/admin` | `/uploads` | GET | `list_uploads` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:814` | API | `/admin` | `/jobs/dead-lettered` | GET | `list_dead_lettered` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/admin.rs:815` | API | `/admin` | `/jobs/{job_id}/requeue` | POST | `requeue_job` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/albums.rs:75` | API | `/albums` | `/` | GET/POST | `list_albums, create_album` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/albums.rs:76` | API | `/albums` | `/{id}` | GET/DELETE | `get_album, delete_album` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/albums.rs:77` | API | `/albums` | `/{id}/items` | GET/POST | `list_items, add_item` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/albums.rs:78` | API | `/albums` | `/{id}/items/reorder` | PUT | `reorder_items` | AuthUser bearer |
| `core/crates/wabi-server/src/api/albums.rs:79` | API | `/albums` | `/{id}/items/{item_id}` | DELETE | `delete_item` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/albums.rs:80` | API | `/albums` | `/{id}/featured` | PUT | `set_featured` | AuthUser bearer |
| `core/crates/wabi-server/src/api/auth.rs:91` | API | `/auth` | `/register` | POST | `handle_register` | AuthUser (body) |
| `core/crates/wabi-server/src/api/auth.rs:92` | API | `/auth` | `/login` | POST | `handle_login` | AuthUser (body), authentication helper |
| `core/crates/wabi-server/src/api/auth.rs:93` | API | `/auth` | `/guest` | POST | `handle_guest` | AuthUser (body), authentication helper |
| `core/crates/wabi-server/src/api/auth.rs:94` | API | `/auth` | `/logout` | POST | `handle_logout` | AuthUser bearer |
| `core/crates/wabi-server/src/api/auth.rs:95` | API | `/auth` | `/refresh` | POST | `handle_refresh` | AuthUser (body), authentication helper |
| `core/crates/wabi-server/src/api/auth.rs:96` | API | `/auth` | `/recover` | POST | `handle_recover` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/auth.rs:97` | API | `/auth` | `/change-password` | POST | `handle_change_password` | AuthUser bearer |
| `core/crates/wabi-server/src/api/auth.rs:101` | API | `/auth` | `/stepup` | POST | `handle_stepup` | AuthUser bearer, authentication helper |
| `core/crates/wabi-server/src/api/auth.rs:102` | API | `/auth` | `/turn-credentials` | POST | `handle_turn_credentials` | AuthUser bearer |
| `core/crates/wabi-server/src/api/blobs.rs:57` | API | `/blobs` | `/upload` | POST | `upload_blob` | AuthUser bearer |
| `core/crates/wabi-server/src/api/blobs.rs:58` | API | `/blobs` | `/` | GET | `list_blobs` | AuthUser bearer |
| `core/crates/wabi-server/src/api/blobs.rs:59` | API | `/blobs` | `/{hash}` | GET | `download_blob` | AuthUser bearer |
| `core/crates/wabi-server/src/api/blobs.rs:60` | API | `/blobs` | `/{hash}/meta` | GET | `blob_meta` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:166` | API | `/boosters` | `/status` | GET | `status` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:167` | API | `/boosters` | `/admin` | GET | `admin` | authentication helper, gate |
| `core/crates/wabi-server/src/api/boosters.rs:168` | API | `/boosters` | `/policy` | PUT | `policy` | gate |
| `core/crates/wabi-server/src/api/boosters.rs:169` | API | `/boosters` | `/sessions` | POST | `start` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:170` | API | `/boosters` | `/sessions/{id}` | DELETE | `stop` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:171` | API | `/boosters` | `/sessions/{id}/heartbeat` | POST | `heartbeat` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:172` | API | `/boosters` | `/sessions/{id}/offers` | GET | `offers` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:173` | API | `/boosters` | `/file` | POST | `file` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:174` | API | `/boosters` | `/tickets` | POST | `offer` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:175` | API | `/boosters` | `/tickets/{id}` | GET | `ticket` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:176` | API | `/boosters` | `/tickets/{id}/answer` | POST | `answer` | AuthUser bearer |
| `core/crates/wabi-server/src/api/boosters.rs:177` | API | `/boosters` | `/tickets/{id}/receipt` | POST | `receipt` | AuthUser bearer |
| `core/crates/wabi-server/src/api/bots.rs:27` | API | `/bot` | `/create` | POST | `handle_create` | AuthUser bearer, owner |
| `core/crates/wabi-server/src/api/bots.rs:28` | API | `/bot` | `/rotate` | POST | `handle_rotate` | AuthUser bearer, owner |
| `core/crates/wabi-server/src/api/bots.rs:29` | API | `/bot` | `/disable` | POST | `handle_disable` | AuthUser bearer, owner |
| `core/crates/wabi-server/src/api/bots.rs:30` | API | `/bot` | `/project-access` | POST | `handle_project_access` | AuthUser bearer, channel_access module, owner, membership gate, gate |
| `core/crates/wabi-server/src/api/bots.rs:34` | API | `/bot` | `/send-message` | POST | `handle_send_message` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/cad.rs:63` | API | `/cad` | `/capabilities` | GET | `capabilities` | AuthUser bearer |
| `core/crates/wabi-server/src/api/cad.rs:64` | API | `/cad` | `/dwg-to-dxf` | POST | `convert_dwg_to_dxf` | AuthUser bearer |
| `core/crates/wabi-server/src/api/calls.rs:20` | API | `/calls` | `/sessions` | POST | `create_session` | AuthUser bearer |
| `core/crates/wabi-server/src/api/calls.rs:21` | API | `/calls` | `/sessions/{id}` | GET | `get_session` | AuthUser bearer |
| `core/crates/wabi-server/src/api/calls.rs:22` | API | `/calls` | `/sessions/{id}/join` | POST | `join_session` | AuthUser bearer |
| `core/crates/wabi-server/src/api/calls.rs:23` | API | `/calls` | `/sessions/{id}/leave` | POST | `leave_session` | AuthUser bearer |
| `core/crates/wabi-server/src/api/calls.rs:24` | API | `/calls` | `/sessions/{id}/end` | POST | `end_session` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/calls.rs:25` | API | `/calls` | `/sessions/{id}/signals` | GET/POST | `emit_signal, list_signals` | AuthUser bearer |
| `core/crates/wabi-server/src/api/calls.rs:29` | API | `/calls` | `/sessions/{id}/participants` | GET | `list_participants` | AuthUser bearer |
| `core/crates/wabi-server/src/api/channels.rs:56` | API | `/channels` | `/` | GET | `list_channels` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/channels.rs:57` | API | `/channels` | `/` | POST | `create_channel` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/channels.rs:58` | API | `/channels` | `/{id}` | GET | `get_channel` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/channels.rs:59` | API | `/channels` | `/{id}` | PATCH | `update_channel` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/channels.rs:60` | API | `/channels` | `/{id}` | DELETE | `delete_channel` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/channels.rs:61` | API | `/channels` | `/{id}/join` | POST | `join_channel` | AuthUser bearer, channel_access module, role |
| `core/crates/wabi-server/src/api/channels.rs:62` | API | `/channels` | `/{id}/retention` | GET/PUT | `get_channel_retention_epochs, set_channel_retention` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/channels.rs:63` | API | `/channels` | `/{channel_id}/reactions` | GET | `list_channel_reactions` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/community.rs:16` | API | `/community` | `/roster` | GET/PUT | `get_roster, put_roster` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/conversation_notes.rs:52` | API | `/conversation-notes` | `/{channel_id}` | GET/POST | `list_notes, create_note` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/conversation_notes.rs:53` | API | `/conversation-notes` | `/{channel_id}/{note_id}` | PUT/DELETE | `update_note, delete_note` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/e2ee.rs:265` | API | `/e2ee` | `/devices` | GET/POST | `list_my_devices, register_device` | AuthUser bearer |
| `core/crates/wabi-server/src/api/e2ee.rs:266` | API | `/e2ee` | `/devices/{device_id}` | DELETE | `revoke_device` | AuthUser bearer |
| `core/crates/wabi-server/src/api/e2ee.rs:267` | API | `/e2ee` | `/channels/{channel_id}` | GET | `room_status` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/e2ee.rs:268` | API | `/e2ee` | `/channels/{channel_id}/enable` | POST | `enable_room` | AuthUser bearer |
| `core/crates/wabi-server/src/api/e2ee.rs:269` | API | `/e2ee` | `/channels/{channel_id}/rekey` | POST | `rekey_room` | AuthUser bearer |
| `core/crates/wabi-server/src/api/e2ee.rs:270` | API | `/e2ee` | `/channels/{channel_id}/allow-server-readable` | POST | `allow_server_readable` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/emoji.rs:253` | API | `/emoji` | `/upload` | POST | `upload_emoji` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:224` | API | `/field` | `/capability` | GET | `pilot_disabled` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/field.rs:230` | API | `/field` | `/capability` | GET | `pilot_capability` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/field.rs:231` | API | `/field` | `/sessions` | GET/POST | `list_sessions, create_session` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:232` | API | `/field` | `/sessions/{session_id}` | GET | `get_session` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:233` | API | `/field` | `/sessions/{session_id}/consent` | POST | `consent` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:234` | API | `/field` | `/sessions/{session_id}/checkins` | POST | `checkin` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:235` | API | `/field` | `/sessions/{session_id}/checkins/{checkin_id}/ack` | POST | `acknowledge` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:239` | API | `/field` | `/sessions/{session_id}/leave` | POST | `leave` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:240` | API | `/field` | `/sessions/{session_id}/participants/{user_id}/revoke` | POST | `revoke` | AuthUser bearer |
| `core/crates/wabi-server/src/api/field.rs:244` | API | `/field` | `/sessions/{session_id}/end` | POST | `end_session` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/following.rs:24` | API | `/following` | `/poll` | POST | `poll` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/forum.rs:46` | API | `/forum` | `/{channel_id}/threads` | GET/POST | `list_threads, create_thread` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/forum.rs:50` | API | `/forum` | `/{channel_id}/threads/{thread_id}/posts` | GET/POST | `list_posts, create_post` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/forum.rs:54` | API | `/forum` | `/{channel_id}/threads/{thread_id}/posts/{post_id}` | PUT/DELETE | `update_post, delete_post` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/forum.rs:58` | API | `/forum` | `/{channel_id}/threads/{thread_id}/posts/{post_id}/vote` | POST | `vote_post` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/forum.rs:62` | API | `/forum` | `/{channel_id}/threads/{thread_id}/posts/{post_id}/solution` | POST | `mark_solution` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/friends.rs:24` | API | `/friends` | `/` | GET | `list` | AuthUser bearer |
| `core/crates/wabi-server/src/api/friends.rs:25` | API | `/friends` | `/requests` | POST | `request` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/friends.rs:26` | API | `/friends` | `/requests/{id}/accept` | POST | `accept` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/friends.rs:27` | API | `/friends` | `/requests/{id}` | DELETE | `cancel_or_decline` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/friends.rs:28` | API | `/friends` | `/{user_id}` | DELETE | `remove` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/gallery.rs:36` | API | `/gallery` | `/{channel_id}/works` | GET/POST | `list_works, upload_work` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/gallery.rs:40` | API | `/gallery` | `/{channel_id}/works/{work_id}` | GET/PUT/DELETE | `get_work, edit_work, delete_work` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/gallery.rs:46` | API | `/gallery` | `/{channel_id}/works/{work_id}/feedback` | GET/POST | `list_feedback, add_feedback` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/gallery.rs:50` | API | `/gallery` | `/{channel_id}/works/{work_id}/feedback/{feedback_id}` | DELETE | `delete_feedback` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/games.rs:15` | API | `/games` | `/me` | GET/PUT | `me, save` | AuthUser bearer |
| `core/crates/wabi-server/src/api/games.rs:16` | API | `/games` | `/profile/{id}` | GET | `profile` | AuthUser bearer |
| `core/crates/wabi-server/src/api/games.rs:17` | API | `/games` | `/match` | POST | `matches` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/games.rs:18` | API | `/games` | `/members/{channel_id}` | GET | `members` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/incidents.rs:14` | API | `/incidents` | `/{channel_id}` | GET/POST | `list_incidents, create_incident` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/incidents.rs:15` | API | `/incidents` | `/{channel_id}/{incident_id}` | GET/PUT | `get_incident, update_incident` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/incidents.rs:19` | API | `/incidents` | `/{channel_id}/{incident_id}/resolve` | POST | `resolve_incident` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/invites.rs:146` | API | `/invites` | `/` | GET/POST | `list, create` | AuthUser bearer |
| `core/crates/wabi-server/src/api/invites.rs:147` | API | `/invites` | `/{id}` | DELETE | `revoke` | AuthUser bearer |
| `core/crates/wabi-server/src/api/jobs.rs:45` | API | `/jobs` | `/` | GET/POST | `list_jobs, submit_job` | AuthUser bearer, admin |
| `core/crates/wabi-server/src/api/jobs.rs:46` | API | `/jobs` | `/claim` | POST | `claim_job` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/jobs.rs:47` | API | `/jobs` | `/{job_id}/result` | POST | `report_result` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/jobs.rs:48` | API | `/jobs` | `/{job_id}/cancel` | POST | `cancel_job` | AuthUser bearer, admin |
| `core/crates/wabi-server/src/api/lan.rs:78` | API | `/lan` | `/discover` | GET | `get_lan_discover` | AuthUser bearer |
| `core/crates/wabi-server/src/api/lan.rs:79` | API | `/lan` | `/route` | GET | `get_lan_route` | AuthUser bearer |
| `core/crates/wabi-server/src/api/lore.rs:314` | API | `(nested)` | `/repos` | POST | `create_repo` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:315` | API | `(nested)` | `/repos/import` | POST | `import_repo` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:316` | API | `(nested)` | `/repos/{channel_id}/link` | POST | `link_repo` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:317` | API | `(nested)` | `/repos/{channel_id}` | GET/DELETE/PATCH | `get_repo, update_repo, delete_repo` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:323` | API | `(nested)` | `/repos/{channel_id}/external` | POST | `register_external_mirror` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:327` | API | `(nested)` | `/repos/{channel_id}/mirror/refresh` | POST | `refresh_mirror_cache` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:331` | API | `(nested)` | `/repos/{channel_id}/snapshot` | POST | `snapshot` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:336` | API | `(nested)` | `/repos/{channel_id}/files` | GET | `list_files` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:337` | API | `(nested)` | `/repos/{channel_id}/archive` | GET | `repo_archive` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:341` | API | `(nested)` | `/repos/{channel_id}/files/{*path}` | GET/PUT/DELETE | `upload_file, download_file, delete_file` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:348` | API | `(nested)` | `/repos/{channel_id}/manifest` | GET | `repo_manifest` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:352` | API | `(nested)` | `/repos/{channel_id}/changes` | GET | `repo_changes` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:357` | API | `(nested)` | `/repos/{channel_id}/connect-tokens` | GET/POST | `mint_connect_token, list_connect_tokens` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:361` | API | `(nested)` | `/repos/{channel_id}/connect-tokens/{token_hash}` | DELETE | `revoke_connect_token` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/lore.rs:366` | API | `(nested)` | `/repos/{channel_id}/lock/{*path}` | POST/DELETE | `lock_file, unlock_file` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:370` | API | `(nested)` | `/repos/{channel_id}/history/{*path}` | GET | `file_level_history` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:374` | API | `(nested)` | `/repos/{channel_id}/diff/{*path}` | GET | `file_diff` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:379` | API | `(nested)` | `/repos/{channel_id}/signed-url` | GET | `signed_download_url` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:384` | API | `(nested)` | `/repos/{channel_id}/history` | GET | `repo_history` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:389` | API | `(nested)` | `/repos/{channel_id}/branches` | GET/POST | `list_branches, create_branch` | channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:393` | API | `(nested)` | `/repos/{channel_id}/branches/{branch_name}/merge` | POST | `merge_branch` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:398` | API | `(nested)` | `/repos/{channel_id}/review/{branch_name}/approve` | POST | `approve_review_branch` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:402` | API | `(nested)` | `/repos/{channel_id}/review/{branch_name}/reject` | POST | `reject_review_branch` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:407` | API | `(nested)` | `/binding/{channel_id}` | GET/PUT/DELETE | `get_binding, set_binding, delete_binding` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:414` | API | `(nested)` | `/promote/from-message` | POST | `promote_from_message` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/lore.rs:418` | API | `(nested)` | `/promotes/{message_id}` | GET | `promotes_for_message` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/lore.rs:423` | API | `(nested)` | `/health` | GET | `health_check` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/lore.rs:425` | API | `(nested)` | `/recordings` | POST | `upload_recording` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/media.rs:86` | API | `/media` | `/rooms` | POST | `create_room` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/media.rs:87` | API | `/media` | `/rooms` | GET | `list_rooms` | AuthUser bearer |
| `core/crates/wabi-server/src/api/media.rs:88` | API | `/media` | `/rooms/{room_id}` | GET | `get_room` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/media.rs:89` | API | `/media` | `/rooms/by-channel/{channel_id}` | GET | `find_by_channel` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/media.rs:90` | API | `/media` | `/rooms/{room_id}/assign` | POST | `assign_room` | AuthUser bearer |
| `core/crates/wabi-server/src/api/media.rs:91` | API | `/media` | `/rooms/{room_id}/active` | POST | `mark_active` | authentication helper |
| `core/crates/wabi-server/src/api/media.rs:92` | API | `/media` | `/rooms/{room_id}/close` | POST | `close_room` | AuthUser bearer |
| `core/crates/wabi-server/src/api/media.rs:93` | API | `/media` | `/rooms/{room_id}/endpoint` | GET | `get_endpoint` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/media.rs:94` | API | `/media` | `/livekit/token` | POST | `create_livekit_token` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/media.rs:95` | API | `/media` | `/turn-credentials` | GET | `handle_turn_credentials` | AuthUser bearer |
| `core/crates/wabi-server/src/api/media.rs:96` | API | `/media` | `/runtime` | GET | `media_runtime_snapshot` | gate |
| `core/crates/wabi-server/src/api/mesh.rs:58` | API | `(nested)` | `/status` | GET | `get_mesh_status` | AuthUser bearer |
| `core/crates/wabi-server/src/api/mesh.rs:59` | API | `(nested)` | `/config` | GET | `get_mesh_config` | AuthUser bearer |
| `core/crates/wabi-server/src/api/mesh.rs:60` | API | `(nested)` | `/heartbeat` | POST | `post_heartbeat` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/messages.rs:53` | API | `/messages` | `/{channel_id}` | GET | `get_messages` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/messages.rs:54` | API | `/messages` | `/` | POST | `send_message` | AuthUser bearer, channel policy, channel_access module, owner, gate |
| `core/crates/wabi-server/src/api/nodes.rs:31` | API | `/nodes` | `/` | GET | `list_nodes` | admin |
| `core/crates/wabi-server/src/api/nodes.rs:32` | API | `/nodes` | `/pairing-tokens` | GET/POST | `list_pairing_tokens, create_pairing_token` | admin |
| `core/crates/wabi-server/src/api/nodes.rs:36` | API | `/nodes` | `/join` | POST | `join_node` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/nodes.rs:37` | API | `/nodes` | `/media-advertisements` | GET | `list_media_advertisements` | admin |
| `core/crates/wabi-server/src/api/nodes.rs:38` | API | `/nodes` | `/{node_id}/heartbeat` | POST | `record_heartbeat` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/nodes.rs:39` | API | `/nodes` | `/{node_id}/media-advertisement` | POST | `record_media_advertisement` | authentication helper |
| `core/crates/wabi-server/src/api/nodes.rs:43` | API | `/nodes` | `/{node_id}/revoke` | POST | `revoke_node` | admin |
| `core/crates/wabi-server/src/api/operator.rs:161` | API | `/operator` | `/status` | GET | `operator_status` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/operator.rs:162` | API | `/operator` | `/reset-owner` | POST | `reset_owner` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/operator.rs:163` | API | `/operator` | `/revoke-all` | POST | `revoke_all` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/payments/mod.rs:35` | API | `(nested)` | `/access` | GET/POST | `handlers::get_payment_access, handlers::save_payment_access` | owner, authentication helper |
| `core/crates/wabi-server/src/api/payments/mod.rs:39` | API | `(nested)` | `/account-links` | GET/POST | `handlers::list_account_links, handlers::create_account_link` | authentication helper |
| `core/crates/wabi-server/src/api/payments/mod.rs:43` | API | `(nested)` | `/account-links/{plugin_id}` | DELETE | `handlers::delete_account_link` | authentication helper |
| `core/crates/wabi-server/src/api/payments/mod.rs:47` | API | `(nested)` | `/donations` | GET/POST | `handlers::get_donation_config, handlers::save_donation_config` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/payments/mod.rs:51` | API | `(nested)` | `/user-blocks` | GET/POST | `handlers::list_user_blocks, handlers::create_user_block` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/payments/mod.rs:55` | API | `(nested)` | `/user-blocks/{user_id}` | DELETE | `handlers::clear_user_block` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/payments/mod.rs:57` | API | `(nested)` | `/intents` | GET/POST | `intents::list_intents, intents::create_intent` | authentication helper |
| `core/crates/wabi-server/src/api/payments/mod.rs:61` | API | `(nested)` | `/intents/{id}/confirm` | POST | `intents::confirm_intent` | authentication helper |
| `core/crates/wabi-server/src/api/payments/mod.rs:62` | API | `(nested)` | `/intents/{id}/reject` | POST | `intents::reject_intent` | authentication helper |
| `core/crates/wabi-server/src/api/places.rs:30` | API | `/places` | `/` | GET | `list_places` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/preview.rs:978` | API | `(root-level)` | `/echo` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/api/preview.rs:984` | API | `(root-level)` | `/redirect` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/api/preview.rs:993` | API | `(root-level)` | `/private` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/api/preview.rs:1088` | API | `(root-level)` | `/start` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/api/preview.rs:1097` | API | `(root-level)` | `/landed` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/api/preview.rs:1127` | API | `(root-level)` | `/loop` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/api/privacy.rs:56` | API | `/privacy` | `/` | GET | `summary` | AuthUser bearer |
| `core/crates/wabi-server/src/api/privacy.rs:57` | API | `/privacy` | `/channels/{channel_id}` | GET | `channel_summary` | AuthUser bearer, channel policy, channel_access module |
| `core/crates/wabi-server/src/api/project_runs.rs:24` | API | `(nested)` | `/{channel_id}/workers` | GET/POST | `workers, register_worker` | AuthUser bearer, channel_access module, owner |
| `core/crates/wabi-server/src/api/project_runs.rs:28` | API | `(nested)` | `/{channel_id}/workers/{worker_id}/heartbeat` | POST | `worker_heartbeat` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/project_runs.rs:32` | API | `(nested)` | `/{channel_id}/workers/{worker_id}` | DELETE | `disable_worker` | AuthUser bearer, channel_access module, owner |
| `core/crates/wabi-server/src/api/project_runs.rs:36` | API | `(nested)` | `/{channel_id}/runs` | GET/POST | `list, create` | AuthUser bearer |
| `core/crates/wabi-server/src/api/project_runs.rs:37` | API | `(nested)` | `/{channel_id}/runs/{run_id}/control` | POST | `control` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/project_runs.rs:41` | API | `(nested)` | `/{channel_id}/runs/{run_id}/claim` | POST | `claim` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/project_runs.rs:45` | API | `(nested)` | `/{channel_id}/runs/{run_id}/step` | POST | `step` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/project_tasks.rs:21` | API | `/projects` | `/{channel_id}/tasks` | GET/POST | `list_tasks, create_task` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/project_tasks.rs:25` | API | `/projects` | `/{channel_id}/tasks/{task_id}/claim` | POST | `claim_task` | AuthUser bearer, channel_access module |
| `core/crates/wabi-server/src/api/project_tasks.rs:29` | API | `/projects` | `/{channel_id}/tasks/{task_id}` | GET/PUT | `get_task, update_task` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/project_tasks.rs:33` | API | `/projects` | `/{channel_id}/history` | GET | `history` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/project_tasks.rs:34` | API | `/projects` | `/{channel_id}/members` | GET | `list_members` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/public.rs:14` | API | `/public` | `/build-info` | GET | `get_build_info` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/public.rs:15` | API | `/public` | `/launch-page` | GET | `get_launch_page` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/public.rs:16` | API | `/public` | `/frontend-app-metadata` | GET | `get_frontend_metadata` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/public.rs:20` | API | `/public` | `/backend-endpoints` | GET | `get_backend_endpoints` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/public.rs:24` | API | `/public` | `/auth-policy` | GET | `get_auth_policy` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/public.rs:71` | API | `/public` | `/status` | GET | `get_setup_status` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/push.rs:52` | API | `/push` | `/vapid-public-key` | GET | `get_vapid_public_key` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/push.rs:53` | API | `/push` | `/subscribe` | POST/DELETE | `subscribe, unsubscribe` | AuthUser bearer |
| `core/crates/wabi-server/src/api/push.rs:54` | API | `/push` | `/preferences` | GET/PUT | `get_preferences, put_preferences` | AuthUser bearer |
| `core/crates/wabi-server/src/api/push.rs:55` | API | `/push` | `/channels` | GET/PUT | `get_push_channels, put_push_channels` | AuthUser bearer |
| `core/crates/wabi-server/src/api/push.rs:59` | API | `/push` | `/test` | POST | `test_push` | AuthUser bearer |
| `core/crates/wabi-server/src/api/routes.rs:104` | API | `(nested)` | `/users` | GET | `admin::list_users` | AuthUser bearer |
| `core/crates/wabi-server/src/api/routes.rs:129` | API | `(nested)` | `/url-preview` | GET | `preview::url_preview` | AuthUser bearer, gate |
| `core/crates/wabi-server/src/api/routes.rs:130` | API | `(nested)` | `/image-proxy` | GET | `preview::image_proxy` | AuthUser bearer |
| `core/crates/wabi-server/src/api/routes.rs:132` | API | `(nested)` | `/upload-profile-media` | POST | `upload::upload_profile_media` | AuthUser bearer |
| `core/crates/wabi-server/src/api/routes.rs:137` | API | `(nested)` | `/upload-profile-picture` | POST | `upload::upload_profile_picture` | AuthUser bearer |
| `core/crates/wabi-server/src/api/routes.rs:142` | API | `(nested)` | `/upload-background-image` | POST | `upload::upload_background_image` | AuthUser bearer |
| `core/crates/wabi-server/src/api/routes.rs:158` | API | `(nested)` | `/turn-credentials` | GET | `super::auth::handle_turn_credentials` | AuthUser bearer |
| `core/crates/wabi-server/src/api/server_center.rs:339` | API | `/server-center` | `/privacy` | GET/PUT | `get_privacy, put_privacy` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/server_center.rs:340` | API | `/server-center` | `/safety` | GET/PUT | `get_safety, put_safety` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/server_center.rs:341` | API | `/server-center` | `/reports` | GET/POST | `list_reports, create_report` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/server_center.rs:342` | API | `/server-center` | `/reports/mine` | GET | `list_my_reports` | AuthUser bearer |
| `core/crates/wabi-server/src/api/server_center.rs:343` | API | `/server-center` | `/reports/{report_id}/comment` | POST | `add_staff_comment` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/server_center.rs:344` | API | `/server-center` | `/reports/{report_id}/status` | PUT | `update_report_status` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/server_center.rs:345` | API | `/server-center` | `/reports/{report_id}/action` | POST | `apply_report_action` | owner |
| `core/crates/wabi-server/src/api/server_center.rs:346` | API | `/server-center` | `/reports/{report_id}/evidence` | DELETE | `delete_report_evidence` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/server_center.rs:347` | API | `/server-center` | `/rules` | GET/PUT | `get_community_rules, put_community_rules` | AuthUser bearer |
| `core/crates/wabi-server/src/api/server_center.rs:348` | API | `/server-center` | `/rules/ack` | POST | `ack_community_rules` | AuthUser bearer |
| `core/crates/wabi-server/src/api/server_center.rs:349` | API | `/server-center` | `/raid-mode` | GET/PUT | `get_raid_mode, put_raid_mode` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/server_center.rs:350` | API | `/server-center` | `/bans` | GET | `list_account_bans` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/server_center.rs:351` | API | `/server-center` | `/channel-gates` | GET | `list_channel_gates` | admin_auth (legacy admin extractor), role |
| `core/crates/wabi-server/src/api/server_center.rs:352` | API | `/server-center` | `/channel-gates/{channel_id}` | PUT | `set_channel_gate` | channel_access module, admin_auth (legacy admin extractor), role, membership gate, gate |
| `core/crates/wabi-server/src/api/server_center.rs:353` | API | `/server-center` | `/community-roles` | GET/PUT | `list_community_roles, put_community_roles` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/server_center.rs:354` | API | `/server-center` | `/reception` | GET | `get_reception` | AuthUser bearer, role, gate |
| `core/crates/wabi-server/src/api/server_center.rs:355` | API | `/server-center` | `/reception/complete` | POST | `complete_reception` | AuthUser bearer |
| `core/crates/wabi-server/src/api/server_center.rs:356` | API | `/server-center` | `/reception/roles` | PUT | `put_my_community_roles` | AuthUser bearer, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/server_center.rs:357` | API | `/server-center` | `/storage` | GET | `list_storage` | admin_auth (legacy admin extractor) |
| `core/crates/wabi-server/src/api/server_center.rs:358` | API | `/server-center` | `/storage/{filename}` | DELETE | `delete_storage_file` | admin_auth (legacy admin extractor), owner |
| `core/crates/wabi-server/src/api/service_access.rs:434` | API | `(nested)` | `/admin/service-access` | GET/PUT | `admin_get, admin_save` | membership gate, gate |
| `core/crates/wabi-server/src/api/service_access.rs:435` | API | `(nested)` | `/services` | GET | `list` | AuthUser bearer |
| `core/crates/wabi-server/src/api/service_access.rs:436` | API | `(nested)` | `/services/{id}/connect` | GET | `connect` | AuthUser bearer, membership gate, gate |
| `core/crates/wabi-server/src/api/standby.rs:32` | API | `/standby` | `/snapshots` | POST | `receive_snapshot` | authentication helper |
| `core/crates/wabi-server/src/api/standby.rs:33` | API | `/standby` | `/snapshots/export` | POST | `export_snapshot` | admin |
| `core/crates/wabi-server/src/api/standby.rs:34` | API | `/standby` | `/snapshots/import` | POST | `manual_import_stub` | admin |
| `core/crates/wabi-server/src/api/standby.rs:35` | API | `/standby` | `/promote` | POST | `manual_promote_stub` | admin |
| `core/crates/wabi-server/src/api/standby.rs:36` | API | `/standby` | `/status` | GET | `status` | AuthUser bearer |
| `core/crates/wabi-server/src/api/steam.rs:89` | API | `/steam` | `/capabilities` | GET | `capabilities` | AuthUser bearer |
| `core/crates/wabi-server/src/api/steam.rs:90` | API | `/steam` | `/link/start` | POST | `start` | AuthUser bearer |
| `core/crates/wabi-server/src/api/steam.rs:91` | API | `/steam` | `/link/callback` | GET | `callback` | authentication helper |
| `core/crates/wabi-server/src/api/steam.rs:92` | API | `/steam` | `/link/complete` | POST | `complete` | AuthUser bearer |
| `core/crates/wabi-server/src/api/steam.rs:93` | API | `/steam` | `/unlink` | POST | `unlink` | AuthUser bearer |
| `core/crates/wabi-server/src/api/steam.rs:94` | API | `/steam` | `/library` | POST | `library` | AuthUser bearer, gate |
| `core/crates/wabi-server/src/api/steam.rs:95` | API | `/steam` | `/status` | GET | `retired_status` | AuthUser bearer |
| `core/crates/wabi-server/src/api/steam.rs:96` | API | `/steam` | `/rich-presence` | GET | `retired_status` | AuthUser bearer |
| `core/crates/wabi-server/src/api/sync.rs:155` | API | `/sync` | `/pull` | POST | `handle_pull` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/sync.rs:156` | API | `/sync` | `/push` | POST | `handle_push` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/sync.rs:157` | API | `/sync` | `/status` | GET | `handle_status` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/tailcat.rs:59` | API | `(nested)` | `/status` | GET | `status` | AuthUser bearer |
| `core/crates/wabi-server/src/api/tailcat.rs:60` | API | `(nested)` | `/audit` | GET | `audit_tail` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/tailcat.rs:61` | API | `(nested)` | `/enable` | POST | `enable` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/tailcat.rs:62` | API | `(nested)` | `/disable` | POST | `disable` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/tailcat.rs:63` | API | `(nested)` | `/keys` | GET/POST | `list_keys, register_key` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/tailcat.rs:64` | API | `(nested)` | `/keys/{key_id}` | DELETE | `revoke_key` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/tailcat.rs:65` | API | `(nested)` | `/connect` | GET | `connect_info` | AuthUser bearer |
| `core/crates/wabi-server/src/api/tailcat.rs:66` | API | `(nested)` | `/port` | PUT | `set_port` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/tailcat.rs:67` | API | `(nested)` | `/keys/{key_id}/access` | PUT | `set_key_access` | admin_auth (legacy admin extractor), gate |
| `core/crates/wabi-server/src/api/upload.rs:69` | API | `/upload` | `/resumable/init` | POST | `init_upload` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/upload.rs:70` | API | `/upload` | `/resumable/chunk` | PUT | `upload_chunk` | gate |
| `core/crates/wabi-server/src/api/upload.rs:74` | API | `/upload` | `/resumable/complete` | POST | `complete_upload` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/upload.rs:75` | API | `/upload` | `/group-avatar` | POST | `upload_group_avatar` | AuthUser bearer |
| `core/crates/wabi-server/src/api/upload.rs:76` | API | `/upload` | `/` | POST | `upload_simple` | AuthUser bearer |
| `core/crates/wabi-server/src/api/user.rs:230` | API | `/user` | `/me` | GET | `get_current_user` | AuthUser bearer, owner |
| `core/crates/wabi-server/src/api/user.rs:232` | API | `/user` | `/settings` | GET/POST/PUT | `get_settings, update_settings` | AuthUser bearer |
| `core/crates/wabi-server/src/api/user.rs:238` | API | `/user` | `/profile/{id}` | GET | `get_user_profile` | AuthUser bearer |
| `core/crates/wabi-server/src/api/user.rs:239` | API | `/user` | `/layout` | GET/POST/PUT | `get_layout, save_layout` | AuthUser bearer |
| `core/crates/wabi-server/src/api/user.rs:245` | API | `/user` | `/theme` | GET/POST | `get_theme, save_theme` | AuthUser bearer |
| `core/crates/wabi-server/src/api/user.rs:246` | API | `/user` | `/theme/reset` | POST | `reset_theme` | AuthUser bearer |
| `core/crates/wabi-server/src/api/user.rs:247` | API | `/user` | `/profile-media` | GET/POST | `get_profile_media, save_profile_media` | AuthUser bearer |
| `core/crates/wabi-server/src/api/voice_policy.rs:298` | API | `/voice-policy` | `/{channel_id}` | PUT | `put_policy_route` | AuthUser bearer, channel policy, channel_access module, membership gate, gate |
| `core/crates/wabi-server/src/api/whiteboard.rs:64` | API | `/whiteboard` | `/boards/{board_id}/images` | POST | `upload_whiteboard_image` | AuthUser bearer, channel policy, channel_access module, gate |
| `core/crates/wabi-server/src/api/whiteboard.rs:65` | API | `/whiteboard` | `/boards/{board_id}/fonts` | GET/POST | `list_whiteboard_fonts, upload_whiteboard_font` | AuthUser bearer, channel policy, membership gate, gate |
| `core/crates/wabi-server/src/api/whiteboard.rs:69` | API | `/whiteboard` | `/boards/{board_id}/files/{file_id}` | GET | `serve_whiteboard_file` | AuthUser bearer, channel policy, membership gate, gate |
| `core/crates/wabi-server/src/api/whiteboard.rs:73` | API | `/whiteboard` | `/boards/{board_id}/document` | GET/PUT | `get_board_document, put_board_document` | AuthUser bearer, channel policy, membership gate, gate |
| `core/crates/wabi-server/src/api/wiki.rs:14` | API | `/wiki` | `/{channel_id}/pages` | GET/POST | `list_pages, create_page` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/wiki.rs:18` | API | `/wiki` | `/{channel_id}/pages/{page_id}` | GET/PUT/DELETE | `get_page, update_page, delete_page` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/wiki.rs:24` | API | `/wiki` | `/{channel_id}/pages/{page_id}/revisions` | GET | `list_revisions` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/wiki.rs:28` | API | `/wiki` | `/{channel_id}/pages/{page_id}/revisions/{revision_id}` | GET | `get_revision` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/workspace.rs:132` | API | `/workspace` | `/capabilities` | GET/PUT | `capabilities, set_capabilities` | AuthUser bearer |
| `core/crates/wabi-server/src/api/workspace.rs:133` | API | `/workspace` | `/artifacts` | GET/POST | `list_artifacts, create_artifact` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/workspace.rs:134` | API | `/workspace` | `/artifacts/{id}/sync` | POST | `sync_artifact` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/workspace.rs:135` | API | `/workspace` | `/artifacts/{id}/access` | POST | `set_access` | AuthUser bearer, channel policy, channel_access module, gate |
| `core/crates/wabi-server/src/api/workspace.rs:136` | API | `/workspace` | `/artifacts/{id}/protection` | POST | `set_protection` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/workspace.rs:140` | API | `/workspace` | `/artifacts/{id}/reviews` | POST | `review` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/api/workspace_conversion.rs:59` | API | `(nested)` | `/conversion` | GET/POST | `status, convert` | AuthUser bearer |
| `core/crates/wabi-server/src/api/workspace_present.rs:222` | API | `(nested)` | `/presentations` | POST | `start` | AuthUser bearer |
| `core/crates/wabi-server/src/api/workspace_present.rs:223` | API | `(nested)` | `/presentations/{id}` | GET/POST | `read, control` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/api/workspace_present.rs:227` | API | `(nested)` | `/presentations/{id}/heartbeat` | POST | `heartbeat` | AuthUser bearer |
| `core/crates/wabi-server/src/api/workspace_present.rs:231` | API | `(nested)` | `/presentations/{id}/questions` | POST | `question` | AuthUser bearer, channel_access module, gate |
| `core/crates/wabi-server/src/anchor.rs:203` | other | `(root/helper/test)` | `/health` | GET | `anchor_health` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/anchor.rs:770` | other | `(root/helper/test)` | `/uploads/art.bin` | ANY | `cacheable_asset` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/anchor.rs:1131` | other | `(root/helper/test)` | `/api/users/{id}` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/anchor.rs:1291` | other | `(root/helper/test)` | `/redirect` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/anchor.rs:1327` | other | `(root/helper/test)` | `/stream` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/anchor.rs:1380` | other | `(root/helper/test)` | `/upload` | POST | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/anchor.rs:1466` | other | `(root/helper/test)` | `/socket.io/` | GET | `echo` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/anchor.rs:1520` | other | `(root/helper/test)` | `/socket.io/` | GET | `close_with_reason` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/anchor.rs:1550` | other | `(root/helper/test)` | `/socket.io/` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/anchor.rs:1597` | other | `(root/helper/test)` | `/socket.io/` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/app_router.rs:827` | other | `(root/helper/test)` | `/health` | GET | `health_check` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/app_router.rs:829` | other | `(root/helper/test)` | `/livez` | GET | `liveness_check` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/app_router.rs:831` | other | `(root/helper/test)` | `/readyz` | GET | `readiness_check` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/app_router.rs:833` | other | `(root/helper/test)` | `/metrics` | GET | `metrics_handler` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/app_router.rs:850` | other | `(root/helper/test)` | `/uploads/{filename}` | GET/HEAD | `serve_upload, head_upload` | AuthUser bearer |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:229` | other | `(root/helper/test)` | `/livez` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:230` | other | `(root/helper/test)` | `/api/v1/sync/status` | GET | `status` | AuthUser bearer |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:231` | other | `(root/helper/test)` | `/api/v1/sync/push` | POST | `push` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:232` | other | `(root/helper/test)` | `/api/v1/sync/assets/missing` | GET | `missing_assets` | gate |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:233` | other | `(root/helper/test)` | `/api/v1/sync/assets/{filename}` | PUT | `put_asset` | gate |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:237` | other | `(root/helper/test)` | `/api/v1/sync/sidecars` | GET | `sidecar_inventory` | gate |
| `core/crates/wabi-server/src/bin/wabi-db-replica-dev.rs:238` | other | `(root/helper/test)` | `/api/v1/sync/sidecars/{name}` | PUT/DELETE | `put_sidecar, delete_sidecar` | gate |
| `core/crates/wabi-server/src/bin/wabi-instance-inbox.rs:227` | other | `(root/helper/test)` | `/healthz` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/bin/wabi-instance-inbox.rs:228` | other | `(root/helper/test)` | `/archives/{id}` | GET/PUT | `receive_archive, download_archive` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/bot_delivery.rs:233` | other | `(root/helper/test)` | `/` | POST | `fake_webhook_handler` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/checkpoint_jobs.rs:1011` | other | `(root/helper/test)` | `/api/operator/checkpoints` | GET/POST | `status, start` | AuthUser bearer |
| `core/crates/wabi-server/src/checkpoint_jobs.rs:1012` | other | `(root/helper/test)` | `/api/operator/checkpoints/` | GET/POST | `status, start` | AuthUser bearer |
| `core/crates/wabi-server/src/checkpoint_jobs.rs:1013` | other | `(root/helper/test)` | `/api/operator/checkpoints/peer-verifications` | GET/POST | `peer_verification_status, start_peer_verification` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/checkpoint_jobs.rs:1014` | other | `(root/helper/test)` | `/api/operator/checkpoints/publications` | GET/POST | `publication_status, start_publication` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/checkpoint_jobs.rs:1015` | other | `(root/helper/test)` | `/api/operator/checkpoints/{id}/source-context` | GET | `source_context` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/helper_api.rs:53` | other | `(root/helper/test)` | `/health` | GET | `health_check` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/helper_api.rs:54` | other | `(root/helper/test)` | `/verify-token` | GET | `verify_token_handler` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/helper_client.rs:733` | other | `(root/helper/test)` | `/credential-sink` | POST | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/helper_client.rs:744` | other | `(root/helper/test)` | `/join` | POST | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/rate_limit.rs:267` | other | `(root/helper/test)` | `/channels/{channel}/messages/{id}` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/rate_limit.rs:268` | other | `(root/helper/test)` | `/users/{id}` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/rate_limit.rs:270` | other | `(root/helper/test)` | `/uploads/{filename}` | GET | `(inline closure)` | inline closure — REVIEW (usually a test/router fixture) |
| `core/crates/wabi-server/src/socket.rs:19` | other | `(root/helper/test)` | `/` | ANY | `socket_handler` | no handler-level token — REVIEW |
| `core/crates/wabi-server/src/websocket.rs:61` | other | `(root/helper/test)` | `/` | GET | `ws_handler` | no handler-level token — REVIEW |

## Socket.IO events (97 registrations)

| Line | Event | Handler | Outer guard | Handler guard evidence |
| --- | --- | --- | --- | --- |
| `wiring.rs:44` | `join` | `on_join` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, authentication helper, gate |
| `wiring.rs:52` | `update-profile` | `on_update_profile` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:61` | `n` | `on_update_profile` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:72` | `set-presence` | `on_set_presence` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:80` | `rejoin` | `(inline)` | REVIEW: no scoped wrapper | router-level only |
| `wiring.rs:84` | `join-channel` | `on_join_channel` | scoped_socket_event + membership_gate.read_owned() | channel policy, DM policy, channel_access module, socket identity, authentication helper, role, gate |
| `wiring.rs:92` | `message` | `on_message` | scoped_socket_event + membership_gate.read_owned() | channel policy, DM policy, channel_access module, socket identity, owner, gate |
| `wiring.rs:100` | `load-history` | `on_load_history` | scoped_socket_event + membership_gate.read_owned() | channel policy, DM policy, socket identity |
| `wiring.rs:108` | `delete-message` | `on_delete_message` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:116` | `typing` | `on_typing` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:124` | `clear-channel-messages` | `on_clear_channel_messages` | scoped_socket_event + membership_gate.read_owned() | channel policy, owner |
| `wiring.rs:132` | `voice-channel-join` | `on_voice_channel_join` | scoped_socket_event + membership_gate.read_owned() | channel_access module, gate |
| `wiring.rs:140` | `voice-channel-subscribe` | `on_voice_channel_subscribe` | scoped_socket_event + membership_gate.read_owned() | channel_access module, gate |
| `wiring.rs:148` | `voice-channel-unsubscribe` | `on_voice_channel_unsubscribe` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, gate |
| `wiring.rs:156` | `voice-channel-leave` | `on_voice_channel_leave` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, gate |
| `wiring.rs:164` | `voice-channel-kick` | `on_voice_channel_kick` | scoped_socket_event + membership_gate.read_owned() | channel_access module, gate |
| `wiring.rs:172` | `set-voice-transmit-mode` | `on_set_voice_transmit_mode` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:180` | `voice-self-state` | `on_voice_self_state` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:188` | `call-initiate` | `on_call_initiate` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:196` | `call-answer` | `on_call_answer` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:204` | `call-reject` | `on_call_reject` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:212` | `call-cancel` | `on_call_cancel` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:220` | `call-end` | `on_call_end` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:228` | `group-call-leave` | `on_group_call_leave` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:236` | `group-call-stop-ringing` | `on_group_call_stop_ringing` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:244` | `create-dm` | `on_create_dm` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:252` | `create-group` | `on_create_group` | scoped_socket_event | membership gate, gate |
| `wiring.rs:260` | `delete-dm` | `on_delete_dm` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:268` | `ban-user` | `on_ban_user` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:276` | `voice-mute` | `on_voice_mute` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:284` | `voice-unmute` | `on_voice_unmute` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:292` | `voice-deafen` | `on_voice_deafen` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:300` | `voice-undeafen` | `on_voice_undeafen` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:308` | `kick-group-member` | `on_kick_group_member` | scoped_socket_event | no handler-level token — REVIEW |
| `wiring.rs:316` | `leave-group` | `on_leave_group` | scoped_socket_event | no handler-level token — REVIEW |
| `wiring.rs:324` | `add-group-member` | `on_add_group_member` | scoped_socket_event | no handler-level token — REVIEW |
| `wiring.rs:332` | `update-group-avatar` | `on_update_group_avatar` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:340` | `edit-message` | `on_edit_message` | scoped_socket_event + membership_gate.read_owned() | channel policy, channel_access module |
| `wiring.rs:348` | `toggle-pin-message` | `on_toggle_pin` | scoped_socket_event + membership_gate.read_owned() | channel policy, owner |
| `wiring.rs:359` | `wabidb-ping` | `(inline)` | REVIEW: no scoped wrapper | router-level only |
| `wiring.rs:368` | `call-offer` | `on_call_offer` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:376` | `call-answer-sdp` | `(inline)` | scoped_socket_event + membership_gate.read_owned() | router-level only |
| `wiring.rs:399` | `call-ice-candidate` | `(inline)` | scoped_socket_event + membership_gate.read_owned() | router-level only |
| `wiring.rs:422` | `get-emojis` | `handle_get_emojis` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:430` | `delete-emoji` | `handle_delete_emoji` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:438` | `add-emoji-reaction` | `on_add_emoji_reaction` | scoped_socket_event + membership_gate.read_owned() | channel policy, owner |
| `wiring.rs:446` | `remove-emoji-reaction` | `on_remove_emoji_reaction` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:454` | `get-role-definitions` | `handle_get_role_definitions` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:462` | `assign-role` | `handle_assign_role` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, owner, gate |
| `wiring.rs:472` | `admin-ban-user` | `handle_admin_ban_user` | membership_gate.read_owned() + instance_operations::scoped | socket identity, owner, authentication helper |
| `wiring.rs:482` | `admin-unban-user` | `handle_admin_unban_user` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:491` | `toggle-reception` | `handle_toggle_reception` | scoped_socket_event + membership_gate.read_owned() | socket identity, owner |
| `wiring.rs:499` | `remove-role` | `handle_remove_role` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, owner, gate |
| `wiring.rs:507` | `lore-roles-list` | `handle_lore_roles_list` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:516` | `lore-roles-upsert` | `handle_lore_roles_upsert` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:525` | `lore-roles-delete` | `handle_lore_roles_delete` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:533` | `lore-roles-set-default` | `handle_lore_roles_set_default` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:541` | `get-badge-catalog` | `handle_get_badge_catalog` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:549` | `assign-badge` | `handle_assign_badge` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:557` | `remove-badge` | `handle_remove_badge` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:565` | `update-channel-settings` | `handle_update_channel_settings` | scoped_socket_event + membership_gate.read_owned() | channel policy, gate |
| `wiring.rs:573` | `set-role-display-name` | `handle_set_role_display_name` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:581` | `join-wabidb-call` | `on_join_wabidb_call` | scoped_socket_event + membership_gate.read_owned() | channel policy, channel_access module, socket identity, gate |
| `wiring.rs:591` | `wabidb-media` | `on_wabidb_media` | scoped_socket_event + membership_gate.read_owned() | channel policy, channel_access module, socket identity, authentication helper, gate |
| `wiring.rs:599` | `start-screen-share` | `on_start_screen_share` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:607` | `stop-screen-share` | `on_stop_screen_share` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:617` | `call-recording-set-active` | `on_call_recording_set_active` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:625` | `webrtc-offer` | `on_webrtc_offer` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:633` | `webrtc-answer` | `on_webrtc_answer` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:641` | `webrtc-ice-candidate` | `on_webrtc_ice_candidate` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:649` | `p2p-offer` | `on_p2p_offer` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:657` | `p2p-answer` | `on_p2p_answer` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:665` | `p2p-ice-candidate` | `on_p2p_ice_candidate` | scoped_socket_event + membership_gate.read_owned() | socket identity |
| `wiring.rs:673` | `create-thread` | `on_create_thread` | scoped_socket_event + membership_gate.read_owned() | channel policy, channel_access module |
| `wiring.rs:681` | `pin-channel` | `on_pin_channel` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:689` | `unpin-channel` | `on_unpin_channel` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:697` | `reorder-channels` | `on_reorder_channels` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, gate |
| `wiring.rs:705` | `retry-message` | `on_retry_message` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:713` | `mark-messages-as-read` | `on_mark_messages_as_read` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:721` | `mark-channel-as-read` | `on_mark_channel_as_read` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:729` | `sync-newer` | `on_sync_newer` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:737` | `create-breakout-rooms` | `on_create_breakout_rooms` | scoped_socket_event + membership_gate.read_owned() | gate |
| `wiring.rs:745` | `close-breakout-rooms` | `on_close_breakout_rooms` | scoped_socket_event + membership_gate.read_owned() | channel policy |
| `wiring.rs:753` | `move-user-to-breakout` | `on_move_user_to_breakout` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:761` | `move-user-to-voice-channel` | `on_move_user_to_voice_channel` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:769` | `whiteboard:join` | `on_whiteboard_join` | scoped_socket_event + membership_gate.read_owned() | socket identity, gate |
| `wiring.rs:777` | `whiteboard:leave` | `on_whiteboard_leave` | scoped_socket_event + membership_gate.read_owned() | no handler-level token — REVIEW |
| `wiring.rs:785` | `whiteboard:snapshot` | `on_whiteboard_snapshot` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, gate |
| `wiring.rs:793` | `whiteboard:patch` | `on_whiteboard_patch` | scoped_socket_event + membership_gate.read_owned() | channel_access module, socket identity, gate |
| `wiring.rs:801` | `whiteboard:cursor` | `on_whiteboard_cursor` | scoped_socket_event + membership_gate.read_owned() | channel policy, socket identity, gate |
| `wiring.rs:810` | `game:join` | `on_game_join` | scoped_socket_event + membership_gate.read_owned() | channel policy, runtime add-on gate |
| `wiring.rs:817` | `game:leave` | `on_game_leave` | scoped_socket_event + membership_gate.read_owned() | no resource guard by design: only removes the caller's own socket from a broadcast room; runtime add-on gate + bounded channelId applied. Refusing to leave on revoked access would keep a removed user subscribed (2026-11 audit F-08) |
| `wiring.rs:824` | `game:create` | `on_game_create` | scoped_socket_event + membership_gate.read_owned() | channel policy, runtime add-on gate |
| `wiring.rs:831` | `game:claim` | `on_game_claim` | scoped_socket_event + membership_gate.read_owned() | channel policy, runtime add-on gate |
| `wiring.rs:838` | `game:move` | `on_game_move` | scoped_socket_event + membership_gate.read_owned() | channel policy, runtime add-on gate |
| `wiring.rs:845` | `game:pass` | `on_game_pass` | scoped_socket_event + membership_gate.read_owned() | channel policy, runtime add-on gate |
| `wiring.rs:852` | `game:resign` | `on_game_resign` | scoped_socket_event + membership_gate.read_owned() | channel policy, runtime add-on gate |

## Known completeness limits

- Nested routers inside `api/payments/`, `api/lore/` and similar
  directories are listed with their local path; compose the full URL as
  `/api` + the parent nest in `api/routes.rs` + the nested prefix.
- `app_router.rs` adds `/health`, `/livez`, `/readyz`, `/metrics`,
  `/uploads/{filename}`, `/ws/*` and `/api/*`; `/health*` and `/metrics`
  are deliberately unauthenticated operational endpoints (the audit
  report records their exposure).
- Handlers reached via `axum::routing::get(...)` written inside a
  multi-line expression are still captured; `REVIEW` rows are listed so
  a human can confirm the guard rather than assume one.
- Socket.IO namespace completeness: all 97 `socket.on(` registrations
  in `core/crates/wabi-server/src/` are in `wiring.rs` (0 elsewhere), so
  the event table is complete. Handler bodies live in the 21 files
  `include!`-ed by `socketio_impl.rs`; the guard token scan covers all
  of them, not just `wiring.rs`.
- This is a static inventory. It does not prove that a guard is correct;
  the September contract suites under `core/crates/wabi-server/tests/`
  are the behavioural fence.
