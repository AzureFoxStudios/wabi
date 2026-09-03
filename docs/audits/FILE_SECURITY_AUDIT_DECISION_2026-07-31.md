# File / Media Security Audit — Decision Record (2026-07-31)

Status: **Accepted** · Scope: file/attachment/media read + write security
Owner: Ronin · Consultation: Grok, external review of `main` (2026-07-31)

---

## 1. Audit outcome

A security review of file/media handling found 30 issues. Write-path holes,
attachment persistence, and token-in-URL leaks were fixed. One design decision
remained: **who may read uploaded files.**

### Fixed in this round

- Auth enforced on write/read APIs that previously had none (blobs, albums,
  gallery, Lore).
- Channel-membership checks added to all Lore handlers (`ensure_channel_member`
  + 403 `Forbidden`).
- Message file-attachment metadata now persisted through the event store
  (`FileAttachmentRecord`, survives restart).
- Resumable-upload token moved from query string to `x-upload-token` header
  (no longer leaks into logs/browser history).
- Removed all hardcoded upload size caps and MIME-type whitelists — any file
  type, any size. Self-hosted operators are accountable for their own storage.

### The remaining decision: read access to `/uploads/`

Files are served at `GET /uploads/{uuid}.{ext}` with no access control. UUIDs
are unguessable (128-bit random), so the posture is capability-URL obscurity,
not authorization.

#### The technical crux

Auth is Bearer-token (`Authorization` header, sessionStorage/localStorage),
**not cookies**. The frontend renders every uploaded file as a plain `<img>`,
`<video>`, `<a>`, or CSS `url()`. None of those can attach a Bearer header.
There is no same-origin cookie escape hatch without converting the entire auth
system to cookies (CSRF implications, its own large project).

Enforcing auth on `/uploads/` therefore requires:
1. An ownership registry (Option 1 anyway)
2. A blob-URL fetch pipeline across every `<img>/<video>/<a>` consumer
3. Signed short-lived URLs for the CSS `url()` cases (server banner, map layers)
4. Expiry, cache-bust, failure/retry UX
5. A second auth mode maintained forever

That is a feature project, not an audit fix.

---

## 2. Options considered

| Option | Description | Verdict |
|---|---|---|
| 1. Ownership registry | Persist file→{channel, uploader, kind, time}; no read enforcement | **Accepted** |
| 2. Full per-channel enforcement | Serve-path membership checks + blob-URL/signed-URL pipeline | Rejected (now) |
| 3. Drop entirely | Accept obscurity, build nothing | Rejected |
| 4. Config toggle | `strict_upload_access` flag whose "on" branch needs the whole of Option 2 | Rejected |

**Why not the toggle:** a flag whose "on" state still requires the complete
Option 2 pipeline adds a second code path to maintain/test without reducing
the work. Lying to the operator.

**Rejected middle paths (deferred, not forgotten):**
- *Service worker injects `Authorization` on `/uploads/*`* — install race, weak
  for CSS `url()`, non-SW clients.
- *Hybrid media cookie* (`HttpOnly SameSite=Strict`, short-lived, set at login)
  — makes `serve_upload` enforceable without blob URLs; real auth-architecture
  change; **best candidate if a future threat forces enforcement**.
- *Signed per-message URLs* — doesn't remove the registry need; crypto + expiry
  churn; CSS/avatar cases remain.

---

## 3. Decision: Option 1 — ownership registry

Record ownership now; enforce never-until-needed.

- **Protection posture stays:** capability URL (128-bit UUID) + CSP sandbox +
  `nosniff` + login-gated write paths + channel-membership checks on API routes.
  This is the accepted posture for operator-owned self-hosted nodes.
- **Registry is ops metadata, not an authz brain.** It is not read on the serve
  path. `serve_upload` stays open.
- **Failure policy:** registry write fails → log + continue serving upload
  success. Never fail an upload because the accounting file hiccuped.

### What it looks like

Mirrors the existing `blob_registry.json` pattern:

```text
<data_dir>/upload_registry.json
filename -> { channel_id, uploader_id, kind, created_at, original_name, size }
```

`kind` vocabulary (Rust enum, serialized snake_case):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadKind { Attachment, Avatar, Profile, Branding, Whiteboard, Other }
```

Write at every path that lands bytes under the generic `/uploads/` URL space:

- resumable upload complete → `attachment`
- `upload_simple` (branding) → `branding`
- group avatar → `avatar`
- profile picture → `profile`
- whiteboard image → `whiteboard`

### Whiteboard correction (verified against `main`, 2026-07-31)

Earlier conclusion — "whiteboard is gated and not exposed via `/uploads/`" —
was **false**. Verified facts:

- Whiteboard writes `wbi-<tag>-<ts>-<nonce>-<name>` into the top level of
  `uploads_dir`, and `serve_upload` serves any top-level file there with no
  `wbi-` exclusion → `/uploads/wbi-...` bypasses every board check.
- The whiteboard GET route treats auth as optional: `extract_user_id_optional`
  returns `None` without a Bearer header and **skips the access check entirely**.
- `can_access_channel` calls `list_channels(None)` — establishes the channel
  exists, does **not** test the requester's membership.
- No whiteboard file-delete lifecycle exists (upload + GET routes only).
- Whiteboard file responses set `Content-Type` + `Cache-Control` but **not**
  the CSP sandbox / `nosniff` applied by `/uploads/`.

**Decision:** whiteboard files qualify for the registry by the same definition
("what landed in the ungated `/uploads/` URL space") → include as `Whiteboard`
kind. Isolating whiteboard storage / blocking `wbi-*` in `serve_upload` is the
cleaner long-term fix but is deliberately out of scope for this patch.

**Deferred follow-ups (not bundled):**
1. Apply CSP sandbox + nosniff to whiteboard file responses (same hardening as
   `/uploads/`).
2. Revisit `can_access_channel` — `list_channels(None)` never tests membership.
3. If a future threat forces read enforcement, prefer the hybrid media-cookie
   (or service-worker) approach over a panic rewrite of `MessageList`.

---

## 4. Explicit non-goals

- No membership check in `serve_upload`
- No MIME/size caps coming back
- No `strict_upload_access` flag
- No frontend media pipeline refactor
- No whiteboard storage migration / `wbi-*` block in this patch

---

## 5. Close-out statement for the audit

> `/uploads/` remains capability-URL (128-bit UUID) + CSP sandbox. Write APIs
> are authz'd and channel-membership-checked. File→channel ownership is
> persisted for operator tooling and as the prerequisite for any future read
> gate. Full read enforcement deferred: Bearer-in-header auth is incompatible
> with plain media elements without a dedicated blob-URL/signed-URL (or
> media-cookie) project.

---

## 6. Phase 0 addendum (2026-08-18)

A follow-up security review (2026-08-17) identified additional hardening for
the upload pipeline. These are Phase 0/1 items per the accepted decision:

### Registry-backed revocation kill-switch
- `UploadRegistry::revoke(filename)` persists revocation in
  `upload_registry.json` under a `revoked` set.
- `serve_upload` returns **410 Gone** for revoked names.
- Admin routes: `POST /api/admin/uploads/revoke {filename}` and
  `GET /api/admin/uploads?channelId=` (admin-gated, no step-up).

### Response headers
- `/uploads/` responses now carry `Cache-Control: private, max-age=3600`
  and `Referrer-Policy: no-referrer`.
- SPA `index.html` response carries `Referrer-Policy: no-referrer`.

### Whiteboard auth fix
- `serve_whiteboard_file` now requires a valid token (the previous
  "no Bearer ⇒ skip membership check" branch was removed).

### Upload session hardening
- `init-resume` requires `session.uploader_id == Some(auth.user_id)`;
  mismatch ⇒ 404 (does not confirm the session's existence).
- `complete_upload` verifies `upload_token` BEFORE removing the session
  (previously a wrong-token finalize destroyed the session).

### Guest/RBAC consistency
- `upload_group_avatar` requires non-guest AND channel membership.
- `upload_simple` (branding) requires `state.is_admin`.
- `upload_profile_picture` requires non-guest.
