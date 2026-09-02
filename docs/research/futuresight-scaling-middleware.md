# Wabi Scaling Middleware — Futuresight Notes

**Status:** Not for implementation now. Structural work (fracture) must land first. These are notes for when Wabi servers exceed ~50 concurrent users.

---

## Why This Exists

The "wooden house with a lock" problem. A 5-person server needs nothing. A 1000-person server needs basic protections — not enterprise architecture, just hygiene. The right level is a front door lock and a fire extinguisher, not a bank vault.

---

## 1. Socket Event Rate Limiting

**Problem:** Any connected client can emit Socket.IO events as fast as JS allows. At scale, one misbehaving client (or bot) can flood the server.

**Solution:** Per-connection throttle middleware in Rust. ~50-80 lines.

```
// Conceptual — attach to socket.io server as middleware
// Per-connection: max N events per second, burst allowance, 
// progressive backoff on violation
// Event-type specific limits (voice join = low freq, typing = high freq)
```

**Where:** `core/crates/wabi-server/src/socketio/mod.rs` — add a layer before event handlers.

**When:** When a single Wabi server serves 50+ concurrent users, or when any user reports lag that traces to event flooding.

---

## 2. Consistent Auth Middleware

**Problem:** Currently `is_admin()` checks are scattered across 15+ files, copy-pasted inline. No role granularity (admin/mod/member/guest). No consistent deny pattern.

**Solution:** Single `require_role(minimum)` middleware that all socket handlers pass through. Removes duplicated auth checks. Enables role hierarchy later.

```
// Conceptual
socket.on("channel:create", require_role(Role::Admin), |data, session| { ... })
socket.on("message:send", require_role(Role::Member), |data, session| { ... })
```

**Where:** New file `core/crates/wabi-server/src/socketio/middleware.rs`. Each handler file imports and wraps with the middleware.

**Prerequisite:** The Socket.IO handler files need to be reasonably sized first (fracture of socketio.rs). Currently 3200+ lines in some handlers.

**When:** When adding role-based permissions beyond just admin/non-admin.

---

## 3. Call Transport Validation

**Problem:** calling_impl_core.ts accepts WebRTC offers/signaling without verifying the user is actually in the voice channel they're signaling for. Ad-hoc checks exist but aren't centralized.

**Solution:** Before accepting `webrtc-offer`, `webrtc-answer`, `webrtc-ice-candidate`, verify:
- User is a member of the server
- User has joined the voice channel in question
- User isn't already in another call (or handle gracefully)

**Where:** In the signaling handlers, both client-side (calling_impl_core.ts) and server-side (direct_calls.rs, 491 lines).

**When:** When voice/video calls work reliably end-to-end. Fix call functionality first, then harden.

---

## 4. Admin API Rate Limiting

**Problem:** Admin endpoints (channel management, payment config, whiteboard) have `is_admin()` checks but no rate limiting. A compromised admin session could hammer these.

**Solution:** HTTP-level rate limiting on admin API routes. Simple sliding window per-session.

**Where:** `core/crates/wabi-server/src/api/` — add tower middleware layer on the Axum router.

**When:** When admin API endpoints are used in production beyond the server operator.

---

## What NOT to Add (Yet)

These are patterns from enterprise/CDN-scale systems that don't apply to Wabi's self-hosted model:

- **Template-based config pipelines** (Sovereign pattern) — Wabi has 1 server operator, not 1000 dev teams. No need.
- **Sidecar auth/rate-limit containers** — Everything runs in one Rust binary. Keep it that way.
- **Request validation with schema rendering** — Wabi's config comes from the UI, not from developer-submitted JSON templates.
- **DDoS protection at the proxy layer** — That's Cloudflare's job (if the operator chooses) or the hosting provider's job. Not Wabi's.

---

## Prerequisites (Current Work)

Before any of this, the code structure needs to be in place:

1. **Fracture calling_impl_core.ts** — In progress (2762→2014, 5 modules extracted). The signaling validation can only be added cleanly when handlers aren't tangled in a god file.

2. **Fracture socketio handler files** — direct_calls.rs (491 lines), messages.rs (274 lines), presence.rs (306 lines). Middleware pattern requires handlers to be composable, not monolithic match arms.

3. **Define role enum** — Currently just `is_admin(bool)`. Need `enum Role { Owner, Admin, Moderator, Member, Guest }` in `wabi-core` types.

4. **Consistent error responses** — Socket.IO error responses should follow a standard shape, not ad-hoc strings.

---

*Added after watching Vasilios Syrakis's "8 Years at Atlassian" walkthrough. The control-plane pattern (separating decision from execution) is good architecture for maintainability regardless of scale — that's what the fracture work achieves. The middleware concerns above are scale-specific and get added when needed.*