# Wabi Production-Readiness Audit — 2026-08-21

**Trigger:** An X post listing ~120 production concerns ("Who's gonna tell vibe coders about…"), reviewed item-by-item against wabi's core.

**Scope:** Core only — `core/crates/wabi-server` (axum REST + socket.io), `core/crates/wabidb` (embedded engine), `frontend/` (SvelteKit SPA). Addons (webhooks/mesh/lore), relay-node, media-gateway, coturn, and Tauri desktop are out of scope except where they intersect core security.

**Method:** Source review. Every "covered" claim below cites a file. No code was changed.

**Legend:** ✅ covered · 🟡 partial/scaffolded · ❌ genuine gap · ⚪ N/A by design (self-hosted single binary)

---

## Verdict

| Status | Count | Reading |
|---|---|---|
| ✅ Covered | 44 | Most of the list is either built or structurally unnecessary |
| ⚪ N/A by design | 41 | K8s, sharding, serverless, gRPC, Terraform, etc. — self-hosted single-binary app |
| 🟡 Partial/scaffolded | 22 | Real code exists but incomplete or config-dependent |
| ❌ Genuine gaps | 9 | Ranked in the next section |

The post's premise doesn't really apply here: wabi is not a microservices deployment pretending to be an app. It is one Rust binary with an embedded event-sourced database, so most distributed-systems machinery is out of scope by architecture, not by ignorance.

---

## Genuine gaps, ranked by risk/effort

### 1. JWT lifecycle: 30-day static tokens, no rotation or revocation
- `api/auth.rs`: main tokens expire after `Duration::days(30)`; step-up tokens get a short TTL; guests 24h.
- Revocation is login-time only: IP blacklist check (`auth.rs:116`) + user ban check after auth (`auth.rs:238-240`). A stolen token is valid until natural expiry.
- **Risk:** highest of the gaps — a leaked token is a 30-day skeleton key. **Fix shape:** short-lived access + refresh rotation, or a token-version claim checked against the user record.

### 2. No general metrics / observability export
- Only `/admin/compression-metrics` exists (`api/admin.rs`). No request-rate/latency/error counters, no P99/tail-latency visibility at runtime.
- Logging is fine: `tracing_subscriber` + `EnvFilter` (`main.rs:404`) and `TraceLayer` (`main.rs:926`).
- **Risk:** operators can't see degradation until users report it. **Fix shape:** a `/metrics` endpoint (Prometheus text format needs no deps beyond formatting) with histogram buckets.

### 3. `/health` is static JSON — no liveness/readiness distinction
- `main.rs:977` returns hardcoded `"status": "ok"` without touching WabiDB. The compose healthcheck (`docker-compose.yml:71`) therefore only proves the HTTP stack is up, not that the engine is readable/writable.
- **Fix shape:** probe the store (cheap read) and return 503 when degraded; optionally split `/livez` vs `/readyz`.

### 4. Socket.io auth is per-event, not at handshake
- Handlers extract a token from the socket and decode per call: `user_id_from_token(&token, &state.app.config.jwt_secret)` (e.g. `socketio/group_members_messages.rs:27`, repeated across ops files).
- Unauthenticated sockets can complete the connection; every event fails auth individually. The `unwrap_or(-1)` fallback means identity failures become a sentinel user id rather than a disconnect.
- **Risk:** wasted resources + one refactor away from an auth bypass if a handler forgets the check. **Fix shape:** authenticate in the handshake middleware, reject the connection on failure.

### 5. Webhooks addon delivery is a stub — latent SSRF surface
- `core/addons/webhooks/backend/src/lib.rs:93`: delivery logs `"Would deliver to webhook: …"` and does nothing. When real outbound POST lands, it must reuse the SSRF validation already written for URL previews/image proxy (`api/preview.rs`: scheme allowlist + resolve + reject loopback/private/link-local/multicast) — including the DNS-rebinding caveat (validate the resolved IP used for the actual connection).

### 6. No tower Timeout layer on the HTTP stack
- Layers are CORS → TraceLayer → DefaultBodyLimit (`main.rs:920-927`). No `TimeoutLayer`, so a slow handler holds connections indefinitely. Low urgency (handlers are local engine calls) but cheap insurance.

### 7. Job queue has failure reporting but no dead-letter handling
- `api/jobs.rs` supports submit/claim/result/cancel; failed jobs are reported via `/claim`-flow results but there is no DLQ/retry-cap/poison-job quarantine. Minor — the queue is admin-driven, not high-volume.

### 8. Backpressure posture depends on one env var
- `WABI_MAX_BODY_SIZE` defaults to **50GB** (`docker-compose.yml:59`, `.env.example:52`). Uploads stream to disk so memory is protected, but a public instance should document lowering this; socket.io send-buffer limits are library defaults, not tuned.

### 9. Distributed tracing stops at local spans
- `TraceLayer` produces spans in logs only; no OTLP/export. Fine for single-node self-hosting; would matter if mesh replication goes mainstream.

---

## Item-by-item mapping

### Traffic & edge
| Item | Status | Evidence / note |
|---|---|---|
| Rate Limiting | ✅ | `rate_limit.rs` — governor per-IP limiters, trusted-proxy CIDRs (`WABI_TRUSTED_PROXIES`), tunable via `WABI_RATE_LIMIT_RPS/BURST` (`main.rs:897-905`); separate guest limiter (`auth.rs:323`) |
| Caching | 🟡 | Reads served from in-memory projections (SkipMap); static SPA embedded via rust_embed. No HTTP cache-header strategy |
| Load Balancing | ⚪ | Single binary; mesh URL template exists for multi-instance topology |
| Reverse Proxies | ✅ | `Caddyfile.example`, `Caddyfile.tunnel`, cloudflared profiles in compose |
| API Gateways | ⚪ | One app, no service mesh to gate |
| CDN / Edge Caching | ⚪ | Self-hosted; Cloudflare tunnel optional |
| WebSockets | ✅ | socket.io layer (`socketio_impl.rs` + ops modules) |
| Long Polling | ✅ | socket.io polling fallback transport (library default) |
| Server-Sent Events | ⚪ | Not needed; socket.io covers push |
| Webhooks | 🟡 | Addon scaffolded; delivery stubbed (`lib.rs:93`) — see gap #5 |
| gRPC | ⚪ | No cross-service RPC to do |
| HTTP/2 & HTTP/3 | ✅ | Provided by Caddy at the edge; origin is plain HTTP behind tunnel/proxy |
| DNS / TCP vs UDP | ⚪ | OS concern; TURN port ranges documented in compose |

### API shape & web security
| Item | Status | Evidence / note |
|---|---|---|
| API Versioning | 🟡 | No URL versioning; instead protocol types are generated (`wabi-core --features ts` → `packages/wabi-protocol`) and event records dual-decode. Works, but breaking REST shapes have no version escape hatch |
| Semantic Versioning | ✅ | Cargo/package versions |
| CORS | ✅ | `ALLOWED_ORIGINS` → `build_cors_layer()` (`main.rs:243`) |
| CSRF | ✅ | Bearer-token auth (`auth_extractor.rs`), no session cookies → classic CSRF moot |
| SQL Injection | ⚪ | No SQL anywhere; embedded engine |
| XSS | ✅ | DOMPurify strict allowlist over marked output (`frontend/src/lib/markdown.ts`), Svelte auto-escape; verified in `docs/security-audit-2026-07-28.md` |
| SSRF | ✅/🟡 | `api/preview.rs` validates scheme + resolves + rejects internal IPs for previews/image-proxy. Webhook outbound = latent gap (#5) |

### Data layer
| Item | Status | Evidence / note |
|---|---|---|
| Database Indexing | ✅ | `.widx` index files + typed projection queries (`wabidb/src/projections/`) |
| Query Optimization | ✅ | In-memory materialized views; benchmark harnesses exist (`bench:compression`, `bench:state-plane`) |
| N+1 Queries | ⚪ | No client-server query chatty-ness; direct projection reads |
| Connection Pooling | ⚪ | Embedded engine, in-process |
| Read Replicas | 🟡 | `wabidb/src/replication/` has anti_entropy, snapshot_shipping, sync_worker, sync_protocol, state_machine — real code, not wired into default single-node deployment |
| Sharding | ⚪/🟡 | Mesh instance URL template (`WABI_MESH_INSTANCE_URL_TEMPLATE`) sketches horizontal split |
| Partitioning | 🟡 | Retention classes (`live`/`timed`/`forever`) partition data lifecycle; resolved pre-write |
| Replication | 🟡 | Same replication module as above; incl. `failover.rs` |
| Leader Election | 🟡 | `WABI_SERVER_ROLE=authority` + replication failover scaffolding |
| CAP Theorem | ✅(implicit) | Single-writer commit sequencer = consistency-first by construction; documented mental model in AGENTS.md |
| Eventual Consistency | ✅ | Client optimistic sends merged via stable `clientMessageId` keys |
| Optimistic Locking | ✅ | Commit sequencer serializes; optimistic client merge |
| Pessimistic Locking | ⚪ | Single writer makes it unnecessary |
| Distributed Locks | 🟡 | Data-dir lock files (`data/.lock`, `wabidb/.lock` — AGENTS.md rule #9); mesh coordination key env |
| Race Conditions | ✅ | Rust ownership + sequencer serialization + Arc/RwLock state |
| Deadlocks | ⚪ | Single-writer design; no multi-lock ordering |
| Memory Leaks / GC | ⚪ | Rust |
| Thread Safety | ✅ | Rust; rate-limiter map bounded with eviction (`rate_limit.rs:56-63`) |
| DB Migrations | ✅ | Dual-decode `RecordV0`/`V1` fallbacks; event replay rebuilds projections (AGENTS.md rule #5 — this bit someone once, which is why it's a golden rule) |
| Schema Versioning | ✅ | Same mechanism |
| Backups | ✅ | Documented unit-of-backup + root-key criticality (`INSTALL.md:114`) |
| Disaster Recovery / Failover | 🟡 | Replication/failover module exists; default deploy is single-node with restart-on-failure |
| Multi-Region | 🟡 | Region/instance env vars present; topology aspirational |

### Reliability & resilience
| Item | Status | Evidence / note |
|---|---|---|
| Circuit Breakers | ⚪ | Core makes no outbound calls to break circuits against |
| Timeouts | 🟡 | Frontend classifies timeouts (`socketConnectionCore.ts:183`); no server-side `TimeoutLayer` — gap #6 |
| Retries | ✅ | `SocketReconnectionManager` (`frontend/src/lib/socketConnectionCore.ts:201`) |
| Exponential Backoff | ✅ | Configured with jitter: base 250–1000ms, cap 5–30s (`socketConnectionCore.ts:259,264`) |
| Idempotency | ✅ | `clientMessageId` end-to-end; AGENTS.md golden rule #3 exists because this was battle-tested |
| Message Queues | 🟡 | Admin job queue: submit/claim/result/cancel (`api/jobs.rs`, `src/jobs`) |
| Pub/Sub | ✅ | Events → socket.io rooms is the live-update backbone |
| Event-Driven Architecture | ✅ | Commands → events → projections → push is the core design (AGENTS.md mental model) |
| Saga Pattern | ⚪ | No distributed transactions to coordinate |
| Distributed Transactions | ⚪ | Single-node authority |
| Dead Letter Queues | ❌ | Job queue reports failures but quarantines nothing — gap #7 |
| Cron Jobs | ✅ | Durable retention reaper loop (`main.rs:707+`) sweeps channel retention policies |
| Backpressure | 🟡 | Body-limit caps upload size (default 50GB — gap #8); socket.io buffers at library defaults |
| Graceful Shutdown | ✅ | SIGINT/SIGTERM handled (`main.rs:939-959`); shutdown plumbing stored in AppState (`main.rs:766`) |
| Health Checks | ✅ | `/health` + compose healthcheck w/ retries & start_period |
| Liveness & Readiness Probes | ❌ | `/health` is static JSON, never touches the engine — gap #3 |
| Network Partitions | 🟡 | Offline-first frontend architecture doc'd (`docs/offline-first-architecture.md`); replication anti-entropy designed for this |
| Clock Skew | 🟡 | Server-authoritative timestamps; JWT `exp` validation depends on host clock like everything else |

### Scaling & runtime
| Item | Status | Evidence / note |
|---|---|---|
| Autoscaling / Horizontal / Vertical | ⚪ | Self-hosted; operator scales their box |
| Service Discovery | ⚪/🟡 | Static mesh URL template |
| Cold Starts / Serverless Limits | ⚪ | Not serverless |
| Latency / Throughput / P99 / Tail Latency | 🟡 | Benchmarks exist pre-release; no runtime latency metrics — gap #2 |
| Chaos Engineering | ⚪ | Out of culture for self-hosted audience |
| Cost Optimization | ⚪ | User's own hardware |

### Delivery & ops
| Item | Status | Evidence / note |
|---|---|---|
| CI/CD | ✅ | `.github/workflows/`: ci.yml, build.yml, codeql.yml, tauri-build.yml, release-tui.yml; dependabot.yml |
| Docker | ✅ | Multi-stage build, non-root UID 1000, scoped bind-mounts, no privileged/cap_add (`docker-compose.yml:26-31`) |
| Kubernetes | ⚪ | Deliberately not the deployment story |
| Feature Flags | ✅ | Env-driven: `PLUGINS_ENABLED`, `PLUGINS_ALLOW_INSTALL`, profile-gated compose services |
| Blue-Green / Canary / Rolling | ⚪ | `docker compose up -d --build` + restart; single-instance idiom |
| Rollbacks | 🟡 | Event-log compatibility (dual-decode) means old data survives new binaries; no automated rollback tooling |
| Monitoring | 🟡 | Logs yes (`tracing_subscriber` + `EnvFilter`, `main.rs:404`; TraceLayer `main.rs:926`); dashboards no |
| Logging | ✅ | Structured tracing with env-filtered levels |
| Distributed Tracing | ❌ | Local spans only, no export — gap #9 |
| Metrics | ❌ | Only compression-specific admin endpoint — gap #2 |
| Alerting / SLOs / SLIs / Error Budgets | ⚪ | Operator concern for a self-hosted deployable |
| Observability | 🟡 | Half of it (logs) is solid; metrics/tracing are the gaps above |
| Secrets Management | ✅ | First-boot auto-generation persisted with restrictive modes (`secrets.rs`, `Permissions::from_mode` + mode test); env override supported; secrets excluded from image/compose |
| IAM | ✅ | RBAC roles, admin policies, guest codes, ban/blacklist system (`docs/BAN_SYSTEM.md`) |
| OAuth | ⚪ | No third-party IdP login by design (privacy stance) |
| JWT Rotation | ❌ | Gap #1 |
| TLS | ✅ | Terminated at Caddy (auto-HTTPS) or Cloudflare tunnel |
| Encryption at Rest | ✅ | `WABIDB_ROOT_KEY` encrypts stream keys (`wabidb/src/crypto/`); auto-generated on first boot |
| Encryption in Transit | ✅ | Edge TLS; internal traffic is container-local |
| WAF / DDoS Protection | 🟡 | Cloudflare tunnel path provides it; bare exposed port does not (rate limiter is the only shield) |
| Infrastructure as Code | ✅(equivalent) | `docker-compose.yml` is the declarative environment; Terraform/Helm would be ceremony |
| Build Caching | 🟡 | Standard cargo/bun caching via CI; multi-stage Docker keeps rebuilds honest |
| Dependency Hell | ✅ | `Cargo.lock` + bun lockfile + dependabot + pinned versions throughout |
| Production Incidents / On-call / Postmortems | ⚪ | Self-hosted; notably there IS an incidents tracking API (`api/incidents.rs`) for in-app use |

---

## What the post gets wrong about projects like wabi

Roughly half the list (K8s, service discovery, sagas, sharding, leader election, canary analysis, chaos engineering…) is machinery for coordinating *many processes owned by one operator*. Wabi's architecture — one binary, embedded event-sourced DB, edge TLS via Caddy/tunnel — dissolves those problems instead of solving them. The items that DO apply to any networked app regardless of architecture (rate limiting, auth lifecycle, input validation, health semantics, observability) are mostly done, and the residue is the nine ranked gaps above.

## Suggested order of attack (when we plan fixes)

1. JWT refresh/rotation (#1) — security-critical, contained in `api/auth.rs`
2. Real readiness in `/health` (#3) — small, high operator value
3. Handshake auth for socket.io (#4) — removes a whole class of future bugs
4. `/metrics` endpoint (#2) — unlocks everything observability-shaped afterwards
5. TimeoutLayer (#6), body-size docs (#8), webhook SSRF-at-implementation note (#5), DLQ (#7), tracing export (#9)

---

## CORRECTIONS (appended — history preserved, not rewritten)

### Correction to Gap #1 (2026-08-21, Hermes verification pass)

The claim "Revocation is login-time only" was **stale at audit time**. Per-request
revocation checks shipped in the 2026-07-23 era and are live on `main`:

- `auth_extractor.rs:196-202` — every authenticated request checks `is_token_revoked`
- `state.rs:494-535` — revocation store consulted per request
- `api/admin.rs:638-640` — `/admin/revoke/*` endpoints take effect immediately

The **real residual gap** in #1 was lack of **rotation** (30-day static tokens),
not missing revocation. That residual gap is now addressed by kanban card [A1]
(commit `b755498`): 15-minute access tokens + 30-day single-use rotating refresh
tokens with reuse detection → family revocation.

All other gap citations were verified accurate as of 2026-08-21.

---

## Resolution log

| Gap | Card(s) | Commit(s) | Status |
|---|---|---|---|
| #1 JWT lifecycle / rotation | A1, A2 | `b755498`, `5ff08da` | DONE — refresh rotation backend + frontend silent-refresh |
| #2 Metrics export | C2 | `f71a8ea` | DONE — Prometheus-text `/metrics` (zero new deps) |
| #3 Liveness/readiness split | C1 | `f71a8ea` | DONE — `/livez` + `/readyz` engine canary; compose healthcheck → `/livez` |
| #4 Socket.io handshake auth | B1 | `73aedd3` | DONE — handshake-time validation, sentinel sweep |
| #5 Webhook SSRF (latent) | W3 | this commit | DONE — catalog `enabled:false`; feature remains unwired by design until product need |
| #6 TimeoutLayer | C3 | `f71a8ea` | DONE — scoped to `/api` only; uploads/static exempt |
| #7 Jobs DLQ | W2 | this commit | DONE — retry cap + dead-letter quarantine + admin list/requeue |
| #8 Body-size docs | W1 | this commit | DONE — INSTALL.md hardening table + `.env.example` guidance |
| #9 Tracing export | — | — | DEFERRED — no consumer until mesh replication matters |

Deploy status: local green only. Not yet built into the Tim binary.
