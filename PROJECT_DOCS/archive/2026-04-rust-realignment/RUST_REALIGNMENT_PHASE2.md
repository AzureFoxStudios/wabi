# Rust Realignment — Phase 2 Complete

**Date:** 2026-04-26  
**Status:** ✅ Auth + Plugin Types Added

## What We Added

### New Rust Modules

1. **`crates/wabi-core/src/auth.rs`** — Authentication & Session Protocol
   - `JwtClaims` — JWT token structure (session_id, user_id, exp, iat)
   - `UserRole` — Hierarchical roles (owner > admin > mod > contributor > viewer)
   - `LoginCommand`, `RegisterCommand` — Auth commands
   - `AuthResponse` — Login/register response with JWT + session + user
   - `AuthSessionView` — Full session details (different from workspace `SessionView`)
   - `SessionCreatedEvent`, `SessionDestroyedEvent` — Session lifecycle events
   - `GuestCode` — Guest access code structure

2. **`crates/wabi-core/src/plugin.rs`** — Plugin System Protocol
   - `PluginManifest` — Plugin metadata (id, name, version, permissions, etc.)
   - `PluginPermission` — 11 permission types (ReadMessages, SendMessages, SocketEvents, etc.)
   - `PluginConfig` — Runtime plugin configuration
   - `PluginEvent` — 9 event types plugins can subscribe to
   - `PluginApiMethod` — 13 plugin API methods
   - `PluginStatus` — Plugin lifecycle states
   - `PluginError` — Structured plugin error reporting

### Updated Exports

**`crates/wabi-core/src/lib.rs`:**
```rust
pub use auth::{AuthResponse, AuthSessionView, GuestCode, JwtClaims, ...};
pub use plugin::{PluginApiMethod, PluginConfig, PluginError, PluginEvent, ...};
```

### Generated TypeScript Types (63 total, +15 new)

**Auth types:**
- `AuthResponse.ts`
- `AuthSessionView.ts`
- `JwtClaims.ts`
- `LoginCommand.ts`
- `RegisterCommand.ts`
- `SessionCreatedEvent.ts`
- `SessionDestroyedEvent.ts`
- `SessionEndReason.ts`
- `UserRole.ts`
- `GuestCode.ts`

**Plugin types:**
- `PluginManifest.ts`
- `PluginPermission.ts`
- `PluginConfig.ts`
- `PluginEvent.ts`
- `PluginApiMethod.ts`
- `PluginStatus.ts`
- `PluginError.ts`

## Verification

All checks pass:
```bash
cargo test -p wabi-core --features ts   # ✅ 98 tests passed
npm --prefix backend run build          # ✅ Success
npm --prefix frontend run check         # ✅ 0 errors
npm run protocol:generate               # ✅ 63 types generated
```

## Architecture Notes

### SessionView Naming

There are now **two** session types:
- `workspace::SessionView` — Simple `{ session_id: String }` reference
- `auth::AuthSessionView` — Full session details (id, user_id, timestamps, etc.)

This distinction is intentional:
- Workspace events reference sessions by ID only
- Auth flows need full session details

### JSON Handling

Plugin types use `serde_json::Value` for flexible config schemas. These fields are marked with `#[ts(skip)]` to avoid ts-rs generation issues while keeping Rust serialization working.

## Next Steps

### Immediate (Self-Hosting Focus)

You mentioned self-hosting should be "Minecraft.jar simple" — just run + port forward, no Cloudflare headaches.

**Current state:**
- ✅ Docker Compose setup exists
- ✅ Cloudflare tunnel support (optional)
- ⚠️ Default setup may still be complex for non-technical users

**Recommended next actions:**
1. Create a **single-command setup** script
2. Add **auto-UPnP/NAT-PMP** for automatic port forwarding
3. Simplify `.env` generation (auto-generate secrets)
4. Add **health check dashboard** for non-technical operators

### Rust Expansion (Optional)

More types to port when ready:
- Payment contracts (`shared/paymentContracts.ts`)
- Whiteboard types
- Album/media types
- Settings/preferences schemas

---

**Summary:** wabi-core now has 98 tests, 63 generated TypeScript types, and covers auth, sessions, plugins, messages, workspace, and retention. Backend/frontend build successfully with the new types.
