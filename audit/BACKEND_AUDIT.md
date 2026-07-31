> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Wabi Backend Audit — June 6, 2026

## Executive Summary
**Status: Production-ready for self-hosted/small-scale with Phase 1 fixes.**
Core architecture is solid: Axum + Socket.IO + SpacetimeDB, single binary, helper-node job queue, comprehensive API coverage.

---

## ✅ What Works Well

| Area | Details |
|------|---------|
| **Auth** | JWT (30d registered / 24h guest), bcrypt, TURN creds, blacklist |
| **Real-time** | Socket.IO: presence, voice, DMs, group calls, moderation, reactions |
| **Helper Nodes** | Pairing tokens, heartbeats, capabilities (thumbnail, transcode, search, relay), job queue with retries |
| **Persistence** | Node registry, job queue, blob registry, media rooms, blacklist → JSON files |
| **Deployment** | Docker Compose (STDB, proxy, coturn, media-gateway, LiveKit profiles) + native `wabi-serve` |
| **Tests** | Unit tests in `nodes/mod.rs`, `jobs/mod.rs` |
| **Config** | Env-driven, documented in `.env` + `wabi.config.example` |

---

## 🔴 Phase 1: Pre-Launch Critical (Do Before Real Users)

### 1. Rate Limiting
**Problem:** No rate limiting on auth, uploads, API — abuse vector.
**Fix:** Add tower-http `RateLimitLayer` or `governor` crate middleware.
**Scope:** `/api/auth/*`, `/api/upload/*`, `/api/messages`, `/api/channels` (POST/DELETE)

### 2. Graceful Shutdown
**Problem:** In-flight requests/jobs/websockets dropped on deploy/restart.
**Fix:** `tokio::signal::ctrl_c()` + `axum::Server::with_graceful_shutdown()`; drain job queue, close Socket.IO, finish uploads.

### 3. JWT Auth Extractor (Deduplication)
**Problem:** 20+ copy-pasted `claims_from_bearer` functions across handlers.
**Fix:** Create reusable Axum extractor/middleware `AuthUser { user_id, username, is_guest }`.

### 4. SpacetimeDB Module Missing from Repo
**Problem:** `docker-compose.yml` mounts `./spacetimedb/wabi_state_bridge` but it's not in git.
**Fix:** Either add module to repo OR document external clone step clearly.

### 5. User Endpoints Are Stubs
**Problem:** `/api/user/me`, `/settings`, `/profile/{id}`, `/layout` return hardcoded placeholders.
**Fix:** Implement real STDB queries (see `state.rs` `get_user_layout` / `upsert_user_layout` pattern).

---

## 🟠 Phase 2: Post-Launch Hardening (1-2 Weeks)

### 6. Request Validation Framework
**Current:** Manual checks in each handler (works but inconsistent).
**Option:** `validator` crate + derive macros on request structs.

### 7. Metrics & Health
**Current:** Only `/health` returning basic JSON.
**Philosophy conflict:** You want minimal tracking (anti-Facebook).
**Compromise:** Optional Prometheus endpoint behind flag (`WABI_METRICS_ENABLED`), structured logs only.

### 8. Correlation IDs
**Current:** None — hard to trace requests across logs.
**Fix:** Middleware generating `x-request-id` header, propagated to logs.

### 9. Multi-Workspace / RBAC
**Current:** Hardcoded `"default-workspace"` in `state.rs:168`, `state.rs:197`.
**Fix:** Extract workspace from JWT claims or header; support multi-tenant if needed.

---

## 🟡 Phase 3: Nice-to-Have

- Integration tests against real STDB
- Load test job queue + helper scaling
- Backup/restore docs for JSON persistence files
- OpenAPI/Swagger spec generation

---

## 📝 Config-in-DB Design (User Request)

> "All config items should be loaded into the DB so changing anything doesn't require a hard reset"

### Current State
Config loaded once at startup from env vars → `ServerConfig` struct → `AppState.config`.

### Proposed Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Env Vars   │────▶│  Startup Bootstrap│────▶│  STDB Table     │
│  (defaults) │     │  (one-time sync)  │     │  app_setting    │
└─────────────┘     └──────────────────┘     └────────┬────────┘
                                                      │
                    ┌─────────────────────────────────┘
                    ▼
         ┌─────────────────────┐
         │  Config Cache       │
         │  (AppState.config)  │
         │  + hot-reload watch │
         └──────────┬──────────┘
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
   HTTP Handlers          Socket.IO Handlers
```

### STDB Table Schema (app_setting)
```rust
// Via ingest_wabi_event reducer
{
  "entity": "app_setting",
  "operation": "upsert",
  "payload": {
    "row": {
      "key": "max_body_size",
      "value": "53687091200",
      "value_type": "u64",
      "description": "Max request body size in bytes",
      "updated_at": 1717680000000,
      "updated_by": 1
    }
  }
}
```

### Implementation Plan

1. **Add `app_setting` table to STDB module** (if not exists)
2. **Bootstrap on startup:** Read env vars → upsert to STDB if missing/changed
3. **Load into `AppState.config`** from STDB (override env defaults)
4. **Hot-reload:** Background task polls STDB every 30s or watches Socket.IO event
5. **Admin API:** `GET/PUT /api/admin/settings` (authenticated, owner/admin only)
6. **Type-safe access:** `config.get::<u64>("max_body_size")` with fallback

### Migration Path
- Phase 1: Add table + bootstrap + load (no hot-reload yet)
- Phase 2: Admin API + hot-reload
- Phase 3: Migrate all env vars to DB-backed

---

## 📋 Quick Wins Already Done (This Session)

- ✅ Configurable upload limit (`WABI_MAX_BODY_SIZE`, default 50GB)
- ✅ Added to `docker-compose.yml`, `wabi.config.example`, `main.rs`, `config.rs`

---

## 🎯 Next Steps (Your Call)

1. **Rate limiting** — want me to add `governor` middleware?
2. **Graceful shutdown** — straightforward, ~30 lines
3. **JWT extractor** — reduces 20+ duplicated functions to 1
4. **Config-in-DB** — start with bootstrap + load (Phase 1 above)
5. **User endpoints** — implement real STDB queries

Pick one and I'll implement it.