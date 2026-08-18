# Security Remediation Plan — 2026-08-17

Status: **Approved, ready for implementation**
Provenance: defensive security review of wabi-server/socket.io/addons/Tauri conducted
2026-08-17 (read-only). This document is the implementation plan derived from that
review, ordered by severity. The implementing agent (Hermes) has no other context —
everything needed is in this file.

---

## 0. Ground rules for the implementing agent (read first)

- Read `AGENTS.md` before touching anything. Respect its golden rules: Svelte 5 runes
  only (no `export let`, no `$:`), never switch the minifier to terser, adapter
  emit-shape rule 8, no postcard-encoded record changes (this plan touches none),
  headless Chromium cannot render Wabi (verify UI in a real browser), tests accompany
  changes.
- **Hard boundaries:**
  - NO end-to-end-encryption work of any kind. Do not touch `encrypted`/`iv` message
    fields or restore any E2EE labeling. E2EE requires a protocol spec, threat model,
    downgrade tests, multi-device/recovery design, and independent crypto review —
    a separate project.
  - `/uploads/` stays a capability URL. No membership/auth check in `serve_upload`.
    Only Phase 0/1 items from the accepted decision
    (`FILE_SECURITY_AUDIT_DECISION_2026-07-31.md`) are in scope: response headers,
    a registry-backed revocation kill-switch, and ops listing endpoints.
- Branch off `wip/all-local-work-2026-08-17` (or `main` if cleaner on your machine).
  The working tree may contain unrelated uncommitted changes — stage only files this
  plan touches. Never commit `data/` contents, `data/admin_policies.json`,
  `data/jwt_secret`, or `docs/wabi-carl-watch.md`. No push, no deploy without the
  explicit word.
- Out of scope: the lore addon (`core/addons/lore`, `api/lore.rs`), CI/workflow fixes
  (covered by a parallel CI-determinism effort), mesh heartbeat redesign.

## 1. Why: findings being fixed (severity-ordered)

| # | Finding | Sev | Location |
|---|---------|-----|----------|
| 1 | Unauthenticated SSRF pair: `/api/url-preview` + `/api/image-proxy` fetch arbitrary URLs; no scheme/IP/redirect validation; image-proxy streams the full body back | High | `api/preview.rs:151`, `api/preview.rs:308` |
| 2 | Socket.IO core events (`join-channel`, `message`, `load-history`) enforce no channel membership; DM room ids are deterministic (`dm-user-{a}-{b}`) and `dm-channel-added` is broadcast to everyone → any connected socket can eavesdrop on DMs; `load-history` is unauthenticated; `on_join` trusts client usernames for token-less sockets | High | `socketio/presence.rs:552`, `socketio/messages.rs:20`, `messages.rs:271`, `dm_moderation.rs:45`, `dm_moderation.rs:111` |
| 3 | `/api/sync/pull|push|status` unauthenticated; `push` ingests attacker commit-index entries + segments into WabiDB; status leaks the data dir | High | `api/sync.rs:109`–`240` |
| 4 | Token revocation bypassed by hand-rolled JWT decoders (TURN, whiteboard, node admin) and by most socket events beyond join/message/update-profile | Med | `api/auth.rs:583`, `api/whiteboard.rs:567`, `api/nodes.rs:151` |
| 5 | Blob download serves client-declared MIME with no `nosniff`/CSP sandbox (unlike `/uploads/`) | Med | `api/blobs.rs:113` |
| 6 | Resumable upload: init-resume hands another user's `upload_token` to any caller; `complete` removes the session before verifying the token | Med | `api/upload.rs:171`, `api/upload.rs:348` |
| 7 | Memory-exhaustion DoS: `DefaultBodyLimit` defaults to 50 GiB (`main.rs:850`) and every multipart handler buffers the whole file in RAM before any size check (whiteboard's 10 MB check runs after buffering) | Med | `main.rs:850`, `api/upload.rs`, `api/whiteboard.rs:272` |
| 8 | Guest/RBAC inconsistencies: `upload_group_avatar` callable by any user (guests included) for any channel; `upload_simple` (branding) not admin-gated and its doc comment claims validation that doesn't exist; `upload_profile_picture` has no guest/type check | Med | `api/upload.rs:422`, `:536`, `:631` |
| 9 | Rate limiter trusts spoofable `Forwarded`/`XFF`/`X-Real-IP` with no trusted-proxy config; limiter key map unbounded; `/api/auth/guest` creates unlimited user rows | Med | `rate_limit.rs:44`, `api/auth.rs:317` |
| 10 | LAN route tokens minted unauthenticated with `user_id: 0`; HMAC key reuses the JWT signing secret; mesh `/status` `/config` unauthenticated | Med | `api/lan.rs:86`, `api/mesh.rs:45` |
| 11 | Webhook delivery posts to stored URLs with no internal-address validation | Med-Low | `bot_delivery.rs:112` |
| 12 | Revocation store persists non-atomically and loads fail-open on corruption | Low | `state.rs:452`–`467` |
| 13 | Whiteboard file GET skips the membership check entirely when no Bearer header is present | Low | `api/whiteboard.rs:374` |
| 14 | Tauri: `csp: null`; `open_external_url` accepts any scheme | Low | `src-tauri/tauri.conf.json:25`, `src-tauri/src/main.rs:23` |

Not fixed here (documented decisions, do not "fix" them): `/uploads/` capability-URL
read posture; any-size upload policy (WS 3d preserves it while removing the RAM
cost); `wbi-*` files served under `/uploads/` (only the new revocation kill-switch
can remove a file); mesh heartbeat without credentials; DMs not E2EE.

## 2. Workstreams

### WS-1 — Socket.IO event-level authorization (highest priority)

Files: `socketio/shared.rs`, `socketio/presence.rs`, `socketio/messages.rs`,
`socketio/dm_moderation.rs`, `api/channels.rs`, small frontend addition.

**1a. Shared helpers in `socketio/shared.rs`:**
- `resolve_identity(socket, &SioState) -> Option<SocketIdentity>` — decode the
  `AuthToken` JWT once (sub, username, is_guest, jti, iat); reject on failed decode;
  check `socket_token_revoked`; check `wdb.is_user_banned`. `None` ⇒ the handler
  emits an error event and returns. Replaces the scattered
  `username_from_token`/`user_id_from_token` pairs and extends revocation
  enforcement to events that currently skip it (delete/edit/react/load-history…).
- `can_access_channel(&SioState, user_id, channel_id) -> bool` — copy the proven
  pattern from `socketio/whiteboard_ops.rs:69`: owner → admin (`state.is_admin`) →
  membership via `wdb.list_channels(Some(uid))`. No DM special-casing here.
- `can_access_dm(&SioState, user_id, channel_id) -> bool` — for
  `dm-user-{a}-user-{b}` ids: prefer the persisted members list
  (`get_channels_raw` row `members`); fall back to parsing the two ids from the
  channel id. The caller's `user-{id}` must be one of the two. **No admin/owner
  override — admins must not silently read DMs.** Unknown/parse-failure ⇒ deny.

**1b. `on_join_channel` (`presence.rs:552`):** require `resolve_identity`
(unauthenticated sockets can no longer join any room). DM rooms: `can_access_dm`;
regular channels: `can_access_channel`. Delete the dead min_role block (see 1e).

**1c. `on_message` (`messages.rs:20`):** replace token plumbing with
`resolve_identity`; DM rooms require `can_access_dm`, others `can_access_channel`,
before any persist/broadcast/session-cache insert. Keep the existing mute check.

**1d. `on_load_history` (`messages.rs:271`):** add `resolve_identity` + the same
channel access check (DM or channel).

**1e. Fix `AppState::get_user_highest_role` (`state.rs:397`, currently a stub
returning `"Member"`):** implement via `wdb.get_user_role("default-workspace", uid)`
mapping Owner/Admin/Moderator → their names; `None` → `"Guest"` for guest tokens,
else `"Member"`. Reintroduce min_role enforcement in `on_join_channel` with
case-insensitive comparison — the old code matched only lowercase `"member"` and
scored the stub's `"Member"` as 0, blocking everyone including the owner.

**1f. `on_join` (`presence.rs:22`):** require a valid token (guest JWTs are fine).
Remove the fallback that trusts the client-supplied username when a token is
present but fails to decode (display-name spoofing). Unauthenticated sockets get
an error event — not the init payload with the full user directory.

**1g. `on_create_dm` (`dm_moderation.rs:111`):** stop `io.broadcast()` of
`dm-channel-added`; emit to the two participants only (`io.to("user-{a}")`,
`io.to("user-{b}")` — those per-user rooms already exist).

**1h. Channel self-join — required so 1b/1c don't lock out real users.** Verified:
no join route exists today; only channel creation adds the creator via
`add_channel_member`. Add `POST /api/channels/{id}/join` in `api/channels.rs`:
`AuthUser` extractor; insert the caller as Member via `add_channel_member` when the
channel exists and its min_role (if any) is satisfied by the caller; 403 otherwise.
Frontend: call it once when the user opens a channel they aren't in (locate the
channel-open flow via the `join-channel` socket emit call site; runes-safe edit).
**Ship 1h in the same change as 1b/1c/1d** or messaging breaks for existing users.

**1i. Sweep remaining socket handlers** (`delete-message`, `edit-message`,
reactions, `typing`) onto `resolve_identity` where the plumbing already exists.
Whiteboard socket ops already membership-check; add the revocation check via the
helper. Do not refactor correct handlers beyond the identity swap.

**Acceptance:** integration tests in wabi-server covering: non-member cannot
`join-channel`/`message`/`load-history`; DM non-participant (including an admin)
rejected; revoked token gets `auth-revoked` on message AND load-history;
`dm-channel-added` not delivered to a third party; a user who self-joined via the
new route can message.

### WS-2 — Unauthenticated endpoints

**2a. `api/preview.rs`:** add `AuthUser` to `url_preview` and `image_proxy`. New
URL validator helper: parse; scheme must be http/https; resolve DNS and reject
loopback, private (RFC1918 + ULA `fc00::/7`), link-local (`169.254.0.0/10`,
`fe80::/10`), multicast, and unspecified addresses for both A and AAAA. Enforce the
same validation across redirects (custom reqwest redirect policy that re-checks
each hop, or `Policy::none` plus a manual redirect loop — pick the simpler correct
option). Cap bodies by streaming with hard limits: 2 MB preview HTML, 10 MB image.
`image_proxy`: require upstream content-type to start with `image/` (else 404) and
respond with `X-Content-Type-Options: nosniff`.

**2b. `api/sync.rs`:** require an `x-wabi-sync-token` header, constant-time
compared against a `WABIDB_SYNC_TOKEN` env var (mirror the operator-secret pattern
in `api/operator.rs` — constant-time compare, disabled when unset). Unset/empty
env ⇒ all three routes return 503 with a clear operator-facing message. Remove
`dataDir` from the `/status` response.

**2c. `api/lan.rs`:** add `AuthUser` to `get_lan_route` and `get_lan_discover`;
put the real `auth.user_id` into the token instead of the current `0`. Key
separation: derive the HMAC key as `SHA-256(jwt_secret || "wabi-lan-route-v1")`
inside `lan/mod.rs` so `sign_token` and `verify_token` change together — update
both sides including `helper_api.rs` and its tests.

**2d. `api/mesh.rs`:** admin-gate `/status` and `/config` (`AuthUser` +
`state.is_admin`). Leave `/heartbeat` as-is with a comment documenting the accepted
posture (authority-less peer liveness).

**2e. Webhook SSRF:** locate the registration caller
(`grep -rn upsert_webhook core/crates/wabi-server/src` — no REST route surfaced
during review; it may be socket-driven or admin-internal) and apply the 2a URL
validator at registration. In `bot_delivery.rs::deliver_to_url`, re-validate the
URL immediately before the POST and disable redirects for webhook delivery
(`Policy::none`) with a code comment explaining why.

**Acceptance:** preview tests rejecting `http://127.0.0.1` and
`http://169.254.169.254` (directly and via redirect); sync returns 503 without env
and 401 with wrong token; lan route requires auth and carries the caller's user_id;
helper-api token verification still passes with the derived key.

### WS-3 — Upload pipeline

**3a. `api/upload.rs` init resume (~line 171):** when resuming an existing
session, require `session.uploader_id == Some(auth.user_id)`; mismatch ⇒ 404 (do
not confirm the session's existence).

**3b. `complete_upload`:** verify `upload_token` BEFORE `sessions.remove(...)`.
Today a wrong-token finalize destroys the session and orphans the temp file.

**3c. Session hygiene:** spawn a sweeper task (mirror `spawn_sweep_loop` in
`socketio/shared.rs`) dropping sessions idle > 1 h and deleting their `.tmp`
files; cap concurrent sessions per user (e.g., 20) at init.

**3d. Streaming multipart:** new `api/multipart_util.rs` with
`stream_field_to_file(field, max_bytes) -> Result<(PathBuf, len, mime, filename)>`
writing chunks to a temp file with running size enforcement. Adopt in:
`upload_group_avatar`, `upload_simple`, `upload_profile_picture`, `api/emoji.rs`,
and the whiteboard image upload (which checks its 10 MB cap only after buffering).
Default cap via `WABI_MAX_UPLOAD_BYTES` (default 50 GB — the decision doc's
"any size" policy is preserved; what changes is that a request now costs disk
progressively instead of RAM). Align the `DefaultBodyLimit` default in `main.rs`
with the same env.

**3e. Guest/RBAC consistency:** `upload_group_avatar` — require non-guest AND
channel membership (mirror/import the whiteboard `can_access_channel` helper);
`upload_simple` (branding) — require `state.is_admin`; `upload_profile_picture` —
require non-guest (behavior change; matches the other guest denials). Fix the
`upload_simple` doc comment that claims image-type/size validation the code lacks.
Frontend: hide the corresponding affordances for guests/non-admins (runes-safe).

**3f. `api/blobs.rs` download:** apply the same headers as `/uploads/` — reuse
`upload_response_headers()` from `api/upload.rs` (nosniff + CSP sandbox) plus
`Cache-Control: private, max-age=3600`.

**Acceptance:** resume by non-owner ⇒ 404; wrong-token complete leaves the session
intact and retryable; a >cap multipart upload is rejected mid-stream without
spiking RAM (test with a small cap); blob download response carries nosniff + CSP;
group avatar from a non-member ⇒ 403; branding upload from a non-admin ⇒ 403.

### WS-4 — Auth consistency & revocation durability

**4a.** Replace hand-rolled JWT decoders with the `AuthUser` extractor (gains
revocation + bot-token support, behavior otherwise unchanged):
`api/whiteboard.rs::extract_user_id` (all three handlers),
`api/auth.rs::handle_turn_credentials`, `api/nodes.rs::require_admin`.

**4b.** `OptionalAuthUser` (`auth_extractor.rs:255`): add the same revocation
check; revoked ⇒ `None`. All current consumers ignore the resolved user, so this
is safe and future-proofs the type.

**4c.** Atomic revocation persistence (`state.rs`): write
`revocations.json.tmp` then `fs::rename`. On load-parse failure: log at ERROR,
preserve the corrupt file as `revocations.json.corrupt`, continue empty
(availability choice — deliberate, documented here).

**Acceptance:** unit test for the atomic write round-trip; a revoked token is
rejected by the TURN endpoint, whiteboard handlers, and node admin routes.

### WS-5 — Rate limiting & guest provisioning

**5a. `rate_limit.rs`:** thread `ConnectInfo<SocketAddr>` into the middleware
(the server already runs `into_make_service_with_connect_info`). New env
`WABI_TRUSTED_PROXIES` (comma-separated CIDRs). Empty/default: client IP = socket
peer address; forwarding headers ignored entirely. Non-empty and peer trusted:
use the rightmost untrusted XFF entry. Bound the limiter map (periodic retain of
recently-used keys, mirroring the socket sweep).

**5b. `api/auth.rs::handle_guest`:** dedicated per-IP limiter key for guest
creation (e.g., 5/hour) and a blacklist check before `create_user`.

**Acceptance:** unit tests for both trusted-proxy modes (headers ignored by
default; honored from a trusted peer only); guest creation above the cap ⇒ 429.

### WS-6 — Capability-URL Phase 0 + whiteboard leftovers

Per the accepted decision doc — these are Phase 0/1 items only; `serve_upload`
stays capability-URL.

**6a.** `serve_upload` (`main.rs`): add `Cache-Control: private, max-age=3600`
and `Referrer-Policy: no-referrer`. Same two headers on the SPA `serve_static`
index.html response.

**6b. Registry-backed kill-switch + ops listing** (activates the currently
`#[allow(dead_code)]` reads in `upload_registry.rs`): `UploadRegistry::revoke(filename)`
persisting revocation in `upload_registry.json`; `serve_upload` and
`serve_whiteboard_file` return 410 for revoked names; admin routes
`POST /api/admin/uploads/revoke {filename}` and `GET /api/admin/uploads?channelId=`
in `api/admin.rs` (admin-gated; **no step-up** — step-up stays reserved for the
existing destructive four).

**6c.** With 4a done, `serve_whiteboard_file` requires real auth — the
"no Bearer ⇒ skip membership check" branch disappears. Verify `wbi-*` under
`/uploads/` remains servable (accepted decision; only the new revocation can
remove a file).

**Acceptance:** `/uploads/` responses carry the new headers; a revoked filename
returns 410 from both serve paths; the admin listing returns registry rows
filtered by channel.

### WS-7 — Tauri hardening

**7a. `src-tauri/tauri.conf.json`:** replace `"csp": null` with a pragmatic policy
that keeps arbitrary self-hosted server URLs working:
`default-src 'self'; connect-src 'self' ws: wss: http: https:; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; style-src 'self' 'unsafe-inline'; script-src 'self'`.
**Must be smoke-tested in the real desktop app** (headless Chromium cannot render
Wabi) against a real server — adjust directives until login, messaging, and media
all work.

**7b. `src-tauri/src/main.rs::open_external_url`:** allowlist `http://`/`https://`
schemes only; reject everything else with an error string.

**Acceptance:** desktop build boots, connects to a real server, renders media;
`open_external_url("file:///etc")` (or any non-http scheme) is rejected.

### WS-8 — Tests & documentation (woven through, not last)

- Integration/unit tests listed per workstream above.
- Update `docs/SECURITY-MODEL.md`: socket.io authz section (it currently describes
  events as admin-gated only), sync/lan auth, upload revocation endpoints.
- Append a Phase 0 addendum to `FILE_SECURITY_AUDIT_DECISION_2026-07-31.md` rather
  than editing the accepted decision in place.
- No wabidb skill updates needed (no domain/projection/ChannelKind changes).
- Per-workstream verification: `cargo test -p wabi-server`; full `cargo test`;
  `bun run check` after frontend edits; `STATIC_BUILD=1 bun run build && cargo
  build --release -p wabi-server`; real-browser smoke (login, messaging, DM,
  media); Tauri desktop smoke for the CSP.

## 3. Sequencing & risk notes

- Order: WS-1 → WS-2 → WS-3 → WS-4 → WS-5 → WS-6 → WS-7. WS-1 is the
  confidentiality fix; 1h must land with 1b/1c/1d.
- Deliberate behavior changes to call out in the PR description: unauthenticated
  sockets fully locked out; admins cannot read DM rooms; group-avatar
  permission-gated; branding upload admin-only; profile pictures
  registered-users-only; webhook delivery no longer follows redirects.
- Explicitly out of scope: E2EE; media read-enforcement / signed URLs / hybrid
  media cookie (RFC Phases 2–3 of the decision doc); lore addon; CI workflows;
  mesh heartbeat redesign.

## 4. Completion log (append as workstreams land)

| Date | Workstream | Commit | Notes |
|------|-----------|--------|-------|
| — | — | — | — |
