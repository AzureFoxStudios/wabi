# Wabi Server — Owner & Admin Security Model

> Audience: an engineer picking this up fresh. This document explains how the
> wabi-server owner/admin account is protected *today* (post-hardening), what
> each mechanism does, how they fit together, and how to recover from a
> compromise or lockout. Read it top-to-bottom the first time; afterwards the
> "Endpoint reference" and "Recovery runbook" sections are the daily drivers.

---

## Launch review caveat (2026-09-07)

This document describes individual mechanisms, not a completed launch security
audit. The [channel-access pass](plans/2026-09-07-channel-access-boundary.md)
closes the reproduced anonymous workspace/history reads, unauthorized writes,
DM self-join, group-DM admin override and selected socket-content bypasses.
Independent admin/session helpers still require further audit; the bounded
group-membership lifecycle work and verification are described below.
The [call admission](plans/2026-09-07-call-admission-boundary.md)
and [call-state authorization](plans/2026-09-07-call-state-authorization.md) passes
cover the corresponding voice/relay and REST/raw-WebSocket boundaries locally.
The historical remediation sections
below do not prove that every entry point is protected.

The current [Lore credential-boundary work](plans/2026-09-07-lore-credential-boundary.md)
separates external-tool tokens from account authentication, binds them to one
channel and scope, enforces revocation/current membership, and repairs the
membership projection's ignored removal events (including affected snapshots).
See [Lore connect tokens](addons/lore.md#84c-connect-tokens-server-minted) for
the exact allowed operations. This is a bounded improvement, not an overall
security sign-off.

Raw `/ws` now accepts only authenticated, authorized call subscriptions, not
client-controlled broadcasts. It rejects refresh/tool/step-up credentials, checks
revocation/expiry while idle, rechecks resource access on delivery and filters
targeted signaling. General account bearer extraction shares the access-token
type/revocation check; independent legacy admin/Socket.IO extractors still need
their own audit. Frontend refresh requests are server-scoped and guarded against
logout/account-change races. Old `wabi_refresh_token:default` credentials have no
provable server binding and are not reused; affected sessions require a fresh login
when their current access expires. This is an intentional upgrade compatibility
boundary, not an automatic migration of an unknown issuer's token.

Removing tracked instance secrets from the current tree does not remove them
from Git history. Before launch, the operator must assess exposure and arrange
safe credential/key remediation. Do not rotate WabiDB's root key casually:
existing data requires its key for recovery.

### Channel-content boundary

`channel_access.rs` is shared by REST content and Socket.IO channel helpers.
Channel existence and persisted `channel_members` determine access; DM-like
ID strings cannot create membership. Both `Dm` and `GroupDm` have no server
owner/admin override. Ordinary channels retain the existing admin override;
there is no persisted ordinary-channel private/min-role policy today.

- Authenticated channel discovery lists ordinary channels and only the caller's
  conversations. Discovery does not grant content access. Self-join is available
  only for ordinary channels; joining an existing conversation is idempotent for
  its existing members, forbidden to outsiders.
- History, reactions, wiki, forum, gallery, incidents, albums and whiteboard
  data require account authentication and resource access. Content router guards
  protect reads and writes; albums resolve the stored parent before item access.
  Nested updates cannot manufacture missing wiki/forum/gallery IDs.
- Socket init filters conversations and supplies persisted member IDs. Group
  creation/DM deletion events target participant user rooms. Join/history/message,
  sync-newer, edit/delete/pin/reaction/typing checks use the same channel policy;
  message mutations also validate the message's actual channel.
- The browser/Tauri client waits for membership acknowledgment before joining
  its socket room or loading wiki/forum/gallery feedback/album scopes. In-flight
  joins are coalesced, not cached as durable authorization. Failed or stale
  requests do not turn into successful joins.

Group creation/add/kick/leave now have a server-owned lifecycle: one durable
membership/ownership command, then account-wide chat/whiteboard/relay eviction
and correlated `group-operation-result`. Only the current group owner may add
or kick; any current registered member may leave. Owner succession and last-member
retirement are durable. Instance administrators do not override private access.
Commands require a UUID request ID and mutations require the expected membership
revision; an old queued intent cannot silently apply to a changed roster.
Admission and mutation share `AppState.membership_gate`; raw call subscriptions
receive versioned revocation and old persisted call participation is retired.
See the [membership work record](plans/2026-09-07-group-membership-revocation.md).

The shared browser/Tauri client now awaits correlated group command results,
fences stale snapshots/HTTP joins by account/server and membership lifecycle,
clears removed groups' in-memory views, and prevents unsafe offline intent replay.
Headful production-module/UI and IndexedDB checks cover these behaviors.

Group-call start/answer now await server admission before capture; removal
cancels the local owner and fences late initial capture, peer setup and relay
completion. Background listening sessions are preserved. Current clients pin
persisted call create/join/leave requests to a membership revision, and raw-call
revocation retires cached rows and subscription identities. Headful race checks
cover these paths, but are not physical/native-device verification.

Camera toggles and screen pickers now retain cancellable call scope. Group/voice
socket replacement retires old transports before readmission; group readmission
pins the original membership revision. Device-owned group admission prevents an
unadmitted sibling connection from inheriting call consent or evicting another
admitted device. Headful tests cover late permissions, move/kick teardown and
repeated reconnects; these are not physical/native-device or LiveKit certification.

The obsolete local archive and native chat-sidecar paths are retired, not a new
parallel persistence system. There was no active incoming-message archive writer,
and the old records did not identify their account. The current app does not
read/export/migrate/trim those records, including after removal or login changes.
They remain on the device for explicit recovery; this is **not secure erasure**
or recall of already delivered content. Files previously exported are unchanged.
Only existing server-scoped Planner settings remain reachable through `storage.ts`;
that utility is not a new account-private Planner store. The outbound queue remains
separate and does not promise a full offline conversation history.

Combined local engine/server, headful browser, Tauri/static frontend and packaged
runtime checks have passed; an isolated copy of Tim's database also reached
readiness twice with the candidate. **Authorized deployment is still pending.**
Server and client must ship together. Persisted call
participants remain account-level; same-membership explicit leave/rejoin races,
general multi-device P2P and direct-call reconnect are not claimed solved.
Album reorder/featured endpoints and group avatar upload still return
501/NOT_IMPLEMENTED, not fake success. Low-level out-of-band WabiDB membership
writes are not a live group lifecycle API: use the admitted group command path
for room/consent eviction. Already delivered content cannot be recalled.

This is not per-author moderation parity or a guarantee about every transport:
voice/call admission, legacy socket expiry, server-wide metadata operations,
and unrelated REST modules are not covered by this pass. Upload URLs retain
their documented capability-URL behavior. Lore capabilities retain their
separate, stricter opt-in boundary.

---

## 1. Threat model

The owner account is the root of trust for a wabi server. If it is taken over,
an attacker can transfer ownership, revoke everyone, and lock the real operator
out; if it is locked out (lost password, corrupted session), the server becomes
unmanageable. The hardening below defends against both:

- **Stolen long-lived bearer token** → can no longer, by itself, perform
  destructive admin actions (step-up auth, §6) or survive a global revocation
  (§4).
- **"Always-admin" bug** → `is_admin` is no longer unconditionally true; it is a
  real check (§3).
- **Owner takeover / demotion** → the owner is protected from ban, demotion, and
  forced removal (§3, §9).
- **Lost owner credentials** → recovery codes (§5) and a loopback break-glass
  operator (§7) provide two independent escape hatches.
- **Weak/static `jwt_secret`** → generated and persisted on first run (§8).

---

## 2. Mechanisms at a glance

| # | Mechanism | File(s) | What it buys you |
|---|-----------|---------|-----------------|
| 0 | Real `is_admin` / `has_role` | `state.rs:342`, `:362` | Authorization is actually enforced |
| 1 | Token revocation (`jti`) | `state.rs:120` `RevocationStore`, `auth_extractor.rs` | Kill a token/user/all without rotating secret |
| 2 | Hybrid governance | `admin.rs` transfer-ownership, recovery-codes | Ownership can move; owner can re-assert via codes |
| 3 | Break-glass operator | `api/operator.rs`, `routes.rs:54` | Loopback-only recovery when locked out |
| 4 | Step-up authentication | `auth.rs:366` `handle_stepup`, `admin.rs:648` `admin_auth_stepup` | Destructive actions need a fresh password proof |
| 5 | `jwt_secret` hardening | `main.rs:211` `resolve_jwt_secret` | No weak built-in default secret |
| 6 | wabiDB `rbac_roles` index | `projections/audit.rs:130` `get_role`, `engine/wabi_store.rs:144` `get_user_role` | Live role lookup backing `is_admin` |

---

## 3. Authorization model — who is "admin"?

`is_admin(user_id)` (`state.rs:362`) returns `true` only if the user is **one of**:

1. the **owner** (first registrant; persisted in `AppState::owner_user_id` and
   in the WDB `owner` marker), **or**
2. listed in `admin_user_ids` (from env `WABI_ADMIN_USER_IDS`, comma-separated), **or**
3. holds the `Admin` (or higher) role, resolved live via
   `WabiStore::get_user_role` → the `rbac_roles` projection index.

`has_role(user_id, role)` (`state.rs:342`) checks the same `rbac_roles` index.

**Owner protections** (cannot be bypassed by a normal admin):
- Cannot be **banned** (`socketio/dm_moderation.rs:262`).
- Cannot be **demoted or removed**; only the owner may grant the `Owner` role,
  and a role assignment that would strip the owner is rejected
  (`socketio/wiring_handlers.rs:62`, `:72`, `:118`).

The legacy always-true stub has been removed — `is_admin` is now a genuine gate
used by both REST handlers (`api/payments/mod.rs:215` `is_admin_user`) and the
live socketio handlers (`wiring_handlers.rs`, `dm_moderation.rs`).

---

## 4. Token model & revocation

Every JWT now carries a **`jti`** (unique ID) and the token is validated against
the `RevocationStore` (`state.rs:120`) on every authenticated request
(`auth_extractor.rs`). Revocation is persisted to `<data_dir>/revocations.json`.

Revocation kinds:
- **single token** — by `jti` (`revoke_token`).
- **whole user** — `revoke_user(user_id)` force-logs out every token for that
  user (cannot target the owner).
- **all tokens (epoch bump)** — `revoke_all_tokens()` raises an epoch; any token
  issued before it is rejected.

HTTP endpoints (all require admin):
- `POST /api/auth/logout` — revokes the caller's own `jti`.
- `POST /api/admin/revoke/user`  `{ "userId": <id> }`
- `POST /api/admin/revoke/token` `{ "jti": "<id>" }`
- `POST /api/admin/revoke/all`    (global re-auth; see step-up, §6)

Tokens are signed with `jwt_secret` (§8) using HS256.

---

## 5. Hybrid governance — ownership transfer & recovery codes

- **`POST /api/admin/transfer-ownership`** `{ "userId": <id> }` — **owner-only**.
  Transfers ownership, revokes the old owner's sessions, and persists the new
  owner in the WDB. (Step-up required — §6.)
- **`POST /api/admin/recovery-codes`** — **owner-only**. Returns a fresh set of
  one-time codes (`state.rs:469` `generate_recovery_codes`). Shown once.
- **`POST /api/auth/recover`** `{ "userId": <id>, "code": "..." }` — **public, no
  JWT**. Consumes a recovery code (`state.rs:485` `consume_recovery_code`),
  reasserts ownership, and force-revokes all tokens. This is the escape hatch
  when the password is lost but codes are available.

Design principle: ownership is never "lost" as long as either recovery codes or
machine-console access (§7) exists.

---

## 6. Step-up authentication (destructive-action gate)

A stolen bearer token is not enough to take over the server, because the four
most destructive admin actions require a **step-up token** — a short-lived
(10-minute) JWT minted only after the user re-proves their password.

Flow:
1. Client calls `POST /api/auth/stepup` `{ "password": "..." }` with a valid
   bearer token. The server verifies the password against the stored bcrypt hash
   (`auth.rs:366` `handle_stepup`) and returns `{ "stepupToken": "...",
   "expiresInSeconds": 600 }`.
2. Client retries the destructive request with the step-up token in the
   `X-Stepup-Token` header.
3. `admin_auth_stepup` (`admin.rs:648`) enforces: valid admin bearer **and** a
   `stepup` JWT whose subject matches the caller and which is unexpired.

Gated endpoints (require both `Authorization: Bearer …` and `X-Stepup-Token`):
- `POST /api/admin/revoke/user`
- `POST /api/admin/revoke/all`
- `POST /api/admin/transfer-ownership`
- `POST /api/admin/recovery-codes`

`verify_stepup_token` (`auth_extractor.rs:154`) rejects: a normal token
(`stepup` claim absent/false), a token whose subject differs from the caller,
and a token signed with the wrong secret. Guests (no password) cannot step up.

> Note: live socketio destructive actions (channel delete / ban via realtime
> events) remain `is_admin`-gated only; extending step-up there would require
> threading the token through the socket payload and is intentionally out of
> scope for now.

---

## 7. Break-glass operator (loopback only)

`/api/operator/*` (`api/operator.rs`) is for the "person with console access to
the machine" scenario: the owner is compromised/locked out **and** recovery
codes are unavailable.

Both guards must pass or the request is rejected:
1. **Loopback only** — `is_loopback` checks `ConnectInfo` source IP
   (`operator.rs:47`). Routed via `into_make_service_with_connect_info` in
   `main.rs`.
2. **Operator secret** — `x-operator-secret` header must equal `WABI_OPERATOR_SECRET`
   (constant-time compare, `operator.rs:52`). If the env var is unset/empty the
   endpoints are disabled.

Endpoints:
- `GET  /api/operator/status` — shows current owner + whether enabled.
- `POST /api/operator/reset-owner` `{ "userId": <id> }` — reassigns ownership,
  revokes old owner's tokens, force-revokes all.
- `POST /api/operator/revoke-all` — global token revocation.

These bypass normal JWT auth by design; the loopback + secret dual control is the
only thing standing between the network and full takeover, so never expose the
operator port off-machine and always set `WABI_OPERATOR_SECRET` in production.

---

## 8. `jwt_secret` hardening

`resolve_jwt_secret(data_dir)` (`main.rs:211`):
- If `JWT_SECRET` env is set, use it.
- Else if `<data_dir>/jwt_secret` exists, load it.
- Else generate a random secret, **persist it to `<data_dir>/jwt_secret`**, and
  use it.

There is no weak built-in default. Losing/rotating this file invalidates all
issued tokens (users re-authenticate).

---

## 9. wabiDB backing — the `rbac_roles` index

`AuditProjection` (`projections/audit.rs`) now maintains a secondary
**`rbac_roles`** index keyed by `workspace_id` + `user_id`, updated on
`role_assigned` / `role_removed` events (reverts to `Member` on removal).
`get_role(state, workspace_id, user_id)` (`audit.rs:130`) reads it.

`WabiStore::get_user_role(workspace_id, user_id)` (`engine/wabi_store.rs:144`)
exposes this to the server; `LocalWabiStore` (in-memory test store) returns
`Ok(None)` since it has no role tracking. This index is what makes `is_admin`
and `has_role` O(1) and live, instead of a hardcoded constant.

---

## 10. Endpoint reference (security-relevant)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/api/auth/register` | none | first registrant becomes owner |
| POST | `/api/auth/login` | password | bcrypt verify |
| POST | `/api/auth/logout` | bearer | revokes own `jti` |
| POST | `/api/auth/recover` | none | one-time recovery code → reassert owner |
| POST | `/api/auth/stepup` | bearer | password → 10-min step-up token |
| POST | `/api/admin/revoke/user` | admin + **step-up** | cannot target owner |
| POST | `/api/admin/revoke/token` | admin | by `jti` |
| POST | `/api/admin/revoke/all` | admin + **step-up** | global epoch bump |
| POST | `/api/admin/transfer-ownership` | owner + **step-up** | |
| POST | `/api/admin/recovery-codes` | owner + **step-up** | returns codes once |
| GET/POST | `/api/operator/*` | loopback + `WABI_OPERATOR_SECRET` | break-glass only |

---

## 11. Recovery runbook (for operators)

**Lost owner password, but have recovery codes:**
1. `POST /api/auth/recover` with `userId` + a recovery code → ownership
   reasserted, all tokens revoked.
2. Log in fresh, rotate recovery codes via `/api/admin/recovery-codes`.

**Lost password AND no recovery codes, but have machine console:**
1. Ensure `WABI_OPERATOR_SECRET` is set and you're hitting the server from
   localhost.
2. `POST /api/operator/reset-owner` with the new owner `userId` → ownership
   reassigned, global tokens revoked.
3. Log in as the new owner.

**Suspected bearer-token theft:**
1. `POST /api/auth/stepup` (re-prove password) → get step-up token.
2. `POST /api/admin/revoke/all` with the step-up token → force everyone
   (including the attacker) to re-authenticate.
3. Optionally revoke a specific user with `/api/admin/revoke/user`.

**Rotating `jwt_secret`:** delete `<data_dir>/jwt_secret` (or set `JWT_SECRET`)
and restart; all existing tokens become invalid and users re-auth.

---

## 12. Configuration / environment variables

| Variable | Purpose |
|----------|---------|
| `WABI_ADMIN_USER_IDS` | Comma-separated user IDs granted admin (in addition to owner/role). |
| `WABI_OPERATOR_SECRET` | Enables loopback break-glass operator; send via `x-operator-secret`. Leave unset to disable. |
| `JWT_SECRET` | Override the persisted `jwt_secret`. |
| `<data_dir>/jwt_secret` | Auto-generated, persisted signing secret. |

---

## 13. File map

- `core/crates/wabi-server/src/state.rs` — `is_admin`, `has_role`,
  `RevocationStore`, recovery-code generation/consumption.
- `core/crates/wabi-server/src/auth_extractor.rs` — JWT decode, `stepup` claim,
  `verify_stepup_token`, `STEPUP_HEADER` / `STEPUP_TTL_SECONDS`.
- `core/crates/wabi-server/src/api/auth.rs` — login/register/logout/recover,
  `handle_stepup`, step-up JWT generation, route mount.
- `core/crates/wabi-server/src/api/admin.rs` — `admin_auth`, `admin_auth_stepup`,
  revoke/transfer/recovery endpoints.
- `core/crates/wabi-server/src/api/operator.rs` — break-glass operator.
- `core/crates/wabi-server/src/api/routes.rs` — operator nest (loopback).
- `core/crates/wabi-server/src/main.rs` — `resolve_jwt_secret`,
  `into_make_service_with_connect_info`, operator status log.
- `core/crates/wabi-server/src/socketio/wiring_handlers.rs`,
  `dm_moderation.rs` — owner/role protections on realtime events.
- `core/crates/wabidb/src/projections/audit.rs` — `rbac_roles` index + `get_role`.
- `core/crates/wabidb/src/engine/wabi_store.rs` — `get_user_role` trait method.

---

## 14. Tests

- `auth_extractor::tests` (in `auth_extractor.rs`) covers `verify_stepup_token`
  for the valid case and three failure cases (missing `stepup` claim, wrong
  subject, wrong secret). Run with `cargo test -p wabi-server --bin wabi-server
  auth_extractor`.
- The wabiDB audit projection tests cover `rbac_roles` maintenance on
  `role_assigned` / `role_removed`.

---

## 15. Recent security remediation (2026-08-18)

A defensive security review of wabi-server/socket.io/addons/Tauri was conducted
2026-08-17. The following findings were remediated in this branch:

### WS-1 — Socket.IO event-level authorization
- `resolve_identity`, `can_access_channel`, `can_access_dm` helpers added to
  `socketio/shared.rs`.
- `on_join` requires valid token (no init payload for anonymous sockets).
- `on_join_channel`, `on_message`, `on_load_history` enforce channel access.
- `on_create_dm` emits `dm-channel-added` to participants only (no broadcast).
- `get_user_highest_role` maps real roles from WDB RBAC.
- `POST /api/channels/{id}/join` self-join route added.

### WS-2 — Unauthenticated endpoints
- SSRF validation (`validate_outbound_url`) for `url-preview` + `image-proxy`:
  http/https only, DNS resolution, rejects loopback/private/link-local/
  multicast/unspecified.
- Auth-required on preview, image-proxy, LAN, mesh status/config.
- Sync token auth (`x-wabi-sync-token`, constant-time compare, 503 when unset).
- LAN route token uses real user_id + derived HMAC key.
- Webhook delivery disables redirects.
- Removed `dataDir` from sync `/status` response.

### WS-3 — Upload pipeline
- `init-resume` requires session ownership (404 on mismatch).
- `complete_upload` verifies token BEFORE removing session.
- Guest/RBAC consistency: group avatar requires membership, branding requires
  admin, profile picture requires non-guest.

### WS-4 — Auth consistency & revocation durability
- Replaced hand-rolled JWT decoders with `AuthUser` extractor (whiteboard
  handlers, `handle_turn_credentials`, `nodes require_admin`).
- `OptionalAuthUser` gains revocation check — revoked ⇒ `None`.
- Removed dead `extract_user_id`/`extract_user_id_optional` from whiteboard.rs.

### WS-5 — Rate limiting & guest provisioning
- Rate limiter respects trusted proxies (`WABI_TRUSTED_PROXIES` env var).
- Uses `ConnectInfo<SocketAddr>` for peer IP.
- Bounded limiter map with eviction at 10k keys.
- Guest creation rate-limited per IP (5/hour).

### WS-6 — Capability-URL Phase 0 + whiteboard leftovers
- `Cache-Control: private, max-age=3600` + `Referrer-Policy: no-referrer`
  on `/uploads/` and SPA index.html responses.
- Registry-backed kill-switch: `UploadRegistry::revoke/is_revoked`.
- `serve_upload` returns 410 for revoked names.
- Admin routes: `POST /api/admin/uploads/revoke` + `GET /api/admin/uploads`.
- Whiteboard `serve_whiteboard_file` requires real auth.

### WS-7 — Tauri hardening
- Replaced `csp: null` with pragmatic CSP.
- `open_external_url` allowlists http/https schemes only.

### New environment variables
| Variable | Purpose |
|----------|---------|
| `WABI_TRUSTED_PROXIES` | Comma-separated CIDRs of trusted proxies for rate limiting. Empty = no trusted proxies. |
| `WABI_SYNC_TOKEN` | Required for `/api/sync/*` endpoints. Unset = 503. |
