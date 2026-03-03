# SpacetimeDB Wabi State Plan

Last updated: 2026-03-03
Status: Active implementation baseline (core state supports STDB primary mode)
Owner: Backend/state-plane workstream

## 1) Scope

This document is the working context anchor for migrating Wabi's realtime state backend to SpacetimeDB.

In scope:
- Chat/domain state (users, channels, memberships, messages, reactions, presence, moderation)
- Incremental migration strategy from current backend storage
- Reliability, security, observability, rollback, and operational runbook requirements

Out of scope:
- Replacing WebRTC media transport right now
- Storing media payloads (audio/video/frame binaries) in SpacetimeDB

## 2) Current Baseline (Observed in Code)

Core references used for this plan:
- `backend/src/server.ts`
- `backend/src/db/schema.sql`
- `backend/src/db/schema.postgres.sql`
- `backend/src/db/database.ts`
- `backend/src/db/repositories/*.ts`
- `backend/src/api/mediaRoutes.ts`
- `backend/scripts/migrate-sqlite-to-postgres.mjs`
- `frontend/src/lib/socket-manager.ts`
- `spacetimedb/wabi_state_bridge/src/lib.rs`

Current state summary:
- Wabi mixes in-memory runtime maps with SQL persistence (SQLite/Postgres mode support).
- Socket.IO protocol is the client realtime contract today.
- Media plane is separate (TURN/media-gateway/LiveKit controls) and should remain separate during this migration.
- Existing auth is JWT + server-side session checks.

## 3) Target Architecture (State Plane)

- Keep current Wabi backend as edge/API contract.
- Introduce a `StatePlaneAdapter` abstraction in backend:
  - `LegacySqlAdapter`
  - `DualWriteAdapter`
  - `StdbAdapter`
- SpacetimeDB becomes source-of-truth in controlled phases.
- Backend continues emitting existing Socket.IO events while backing state moves.

State/media boundary:
- SpacetimeDB: state only.
- Existing media stack: transport/session media control and RTP path.

## 4) Migration Strategy (Phased)

Phase 0:
- Add adapter abstraction and config kill switches.
- Add parity logging framework and SLO instrumentation.
- Status: completed.

Phase 1:
- Dual-write for core entities.
- Reads stay on legacy path.
- Run drift/parity checks continuously.
- Status: completed.

Phase 2:
- Read-switch selected endpoints to SpacetimeDB projections.
- Keep legacy fallback switch.
- Status: completed for core state entities (messages/channels/channel-members/users/sessions/rbac).

Phase 3:
- SpacetimeDB primary read/write.
- Legacy retained only as rollback shadow until decommission criteria are met.
- Status: implemented for core state entities with explicit strict/non-strict startup resolution.

## 5) Critical Risks And Required Mitigations

- Auth model mismatch:
  - Keep backend-auth as trust anchor first.
  - Reducers receive signed actor envelope from backend.

- RBAC mismatch:
  - Enforce in reducers, not only edge.
  - Add filtered read-model/subscription boundaries.

- Cold-start memory pressure:
  - Hot/cold split of messages.
  - Bounded hot tables and archive path.

- Hot-path contention:
  - Channel-scoped sequencing.
  - Small reducers + idempotency keys.

- Recovery gaps:
  - Backup/restore runbook + integrity check tooling + regular drills.

## 6) SQLite/Postgres Patterns Reused (Already Solved Problems)

The plan intentionally reuses proven relational rollout/ops patterns instead of inventing new ones:

1. Expand/contract schema migration discipline
- Similar to current migration style in `backend/src/db/database.ts` (additive changes first, backfill, then switch).
- Applied to SpacetimeDB as versioned table evolution + cutover gates.

2. Dual-write + read-switch + parity validation
- Mirrors safe migration practice already present in project mindset (`migrate-sqlite-to-postgres.mjs` and DB mode support).
- Avoids big-bang cutovers.

3. Idempotency + conflict-safe writes
- Equivalent concept to SQL unique constraints/upserts (for example `message_id` uniqueness).
- Required for at-least-once delivery tolerance in distributed write paths.

4. Hot/cold data lifecycle
- Inspired by common PostgreSQL retention/partitioning behavior:
  - keep recent data hot for low-latency reads
  - archive historical volume separately

5. Operational guarantees first
- Borrowing standard DB operations hygiene:
  - restore drills
  - explicit RPO/RTO goals
  - integrity checks post-restore
  - kill switches for immediate rollback

6. Projection/read-model indexing mindset
- Equivalent to SQL index/materialized-read-model practices:
  - avoid expensive runtime joins/scans
  - precompute inbox/channel list projections for fast UI reads

## 7) Minimum Guarantees (Realistic, Production-Sufficient)

Instead of trying to perfectly replicate SQLite semantics everywhere:
- Per-reducer atomicity
- Per-channel message ordering
- Idempotent write handling
- Read-model convergence under bounded latency
- Defined RPO/RTO with tested restore path

## 8) Kill Switches (Required)

Recommended config flags:
- `STATE_BACKEND_MODE=legacy|dual_write|stdb_primary`
- `STATE_STDB_READ_ENABLED=true|false`
- `STATE_STDB_MESSAGE_READ_CANARY_PERCENT=0..100`
- `STATE_STDB_CHANNEL_READ_CANARY_PERCENT=0..100`
- `STATE_STDB_CHANNEL_MEMBER_READ_CANARY_PERCENT=0..100`
- `STATE_STDB_USER_READ_CANARY_PERCENT=0..100`
- `STATE_STDB_SESSION_READ_CANARY_PERCENT=0..100`
- `STATE_STDB_RBAC_READ_CANARY_PERCENT=0..100`
- `STATE_SHADOW_WARMUP_ENABLED=true|false`
- `STATE_SHADOW_WARMUP_LIMIT=100..500000`
- `STATE_STDB_WRITE_ENABLED=true|false`
- `STATE_STDB_SUBSCRIPTIONS_ENABLED=true|false`
- `STATE_STDB_ENFORCE_RBAC=true|false`
- `STATE_OUTBOX_REDACT_SENSITIVE=true|false`
- `STATE_OUTBOX_MAX_BYTES=1048576..1073741824`
- `STATE_OUTBOX_TRUNCATE_MIN_BYTES=1048576..STATE_OUTBOX_MAX_BYTES`
- `STATE_SHADOW_SIGNING_SECRET=<secret>`
- `STATE_SHADOW_SIGNING_KEY_ID=<key-id>`
- `STATE_SHADOW_COMMAND=<shell command>`
- `STATE_SHADOW_COMMAND_TIMEOUT_MS=100..300000`
- `STATE_PLANE_SCHEMA_VERSION=1..1000`
- `STATE_PLANE_SCHEMA_AUTO_APPLY=true|false`
- `STATE_REDUCER_INGRESS_ENABLED=true|false`
- `STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true|false`
- `STATE_REDUCER_INGRESS_MAX_SKEW_MS=1000..3600000`
- `STATE_REDUCER_INGRESS_MAX_BODY_BYTES=4096..16777216`
- `STATE_SHADOW_POLL_INTERVAL_MS=250..60000`
- `STATE_SHADOW_BATCH_SIZE=1..5000`

## 9) Immediate Hardening Backlog

1. Add production alert thresholds and paging policy around `GET /api/admin/state-plane` drift counters.
2. Add sustained-load soak validation with STDB primary enabled (latency + reducer throughput + outbox growth).
3. Expand reducer-side authorization assertions for any future entity classes beyond current core state set.
4. Define legacy-mirror decommission criteria and archive/retention policy once STDB primary is stable in production.

## 10) Context Continuity Notes

This document is the canonical checkpoint for state-plane migration context.
If priorities change, update this file first, then adjust implementation tasks.

## 11) Implementation Progress (2026-03-03)

Completed in this pass:
- Added backend state-plane module scaffolding:
  - `backend/src/state-plane/config.ts`
  - `backend/src/state-plane/adapter.ts`
  - `backend/src/state-plane/messageStore.ts`
  - `backend/src/state-plane/userStore.ts`
  - `backend/src/state-plane/sessionStore.ts`
  - `backend/src/state-plane/rbacStore.ts`
  - `backend/src/state-plane/index.ts`
- Added supporting dual-write runtime modules:
  - `backend/src/state-plane/outbox.ts`
  - `backend/src/state-plane/channelStore.ts`
  - `backend/src/state-plane/channelMemberStore.ts`
  - `backend/src/state-plane/shadowWriter.ts`
- Wired server message persistence/retrieval calls through `stateMessageStore` abstraction.
- Added state-plane mode logging on backend startup.
- Added config surface for operators:
  - `.env.example`
  - `wabi.config.example`
  - `scripts/setup.sh` generated `.env`
  - `scripts/launch.sh` load/apply pipeline from `wabi.config` to `.env`
- Added deployment doc section for new state-plane flags (`PROJECT_DOCS/DEPLOYMENT.md`).
- Upgraded dual-write message path:
  - in-memory shadow message mirror
  - durable outbox file at `${DATA_DIR}/state-plane-outbox.ndjson`
  - sampled parity checks between primary and shadow reads
  - admin status endpoint: `GET /api/admin/state-plane`
- Added state-plane wrappers for channel and channel-member writes (outbox-instrumented), and wired server runtime channel/member operations through those wrappers.
- Upgraded channel + channel-member wrappers to true dual-write behavior:
  - in-memory shadow state for core channel/membership entities
  - sampled parity checks on read paths
  - shadow write error counters and drift/mismatch counters in runtime stats
- Added user dual-write wrapper:
  - registration/profile user writes now flow through `stateUserStore`
  - in-memory user shadow with parity sampling on user read paths
  - user write/outbox instrumentation and runtime drift counters
- Added session dual-write wrapper:
  - auth/session reads + writes now flow through `stateSessionStore`
  - in-memory session shadow with parity sampling
  - session write/outbox instrumentation and runtime drift counters
  - hourly expired-session cleanup now runs through state-plane session path
- Added RBAC dual-write wrapper:
  - role assignment/removal paths now flow through `stateRbacStore`
  - in-memory RBAC shadow with parity sampling on role reads
  - RBAC write/outbox instrumentation and runtime drift counters
  - owner-presence checks and shared role read helpers now route through state-plane RBAC reads
- Added config-gated dual-write activation:
  - `STATE_BACKEND_MODE=dual_write` with `STATE_STDB_WRITE_ENABLED=true` enables shadow writes/outbox
  - `STATE_STDB_WRITE_ENABLED=false` keeps legacy-only writes even in `dual_write` mode (kill-switch behavior)
  - `STATE_BACKEND_STRICT=true` makes shadow write failures fail-fast in dual-write mode
- Added shadow-writer poller with offset tracking, dead-letter handling, and runtime stats.
- Added state-plane watchdog loop for continuous drift checks:
  - compares parity/shadow-failure/read-canary-failure counters across message/channel/channel-member/user/session/rbac stores
  - tracks outbox write errors and shadow-writer health signals (writer failures, truncate failures, backlog-over-limit)
  - emits `system/watchdog_alert` outbox events on drift deltas
  - exposes watchdog status in `GET /api/admin/state-plane`
- Added CLI drift gate:
  - `scripts/state-plane-check.mjs`
  - returns non-zero when parity/shadow failure counters are detected
  - intended for deploy checks and rollback automation hooks
- Added presence event instrumentation into state-plane outbox for:
  - user joined
  - profile updated
  - user left/disconnect
- Added full config-only controls for outbox + shadow-writer settings in:
  - `wabi.config.example`
  - `.env.example`
  - `scripts/setup.sh`
  - `scripts/launch.sh`
- Added core state read canary routing in dual-write mode:
  - configurable sample percent via `STATE_STDB_MESSAGE_READ_CANARY_PERCENT` with per-entity overrides
  - runs only when `STATE_STDB_READ_ENABLED=true`
  - validates shadow read parity and hard-fallbacks to legacy reads on mismatch/error
  - currently active for messages/channels/members/users/sessions/rbac store read paths
- Added configurable startup shadow warmup for dual-write mode:
  - `STATE_SHADOW_WARMUP_ENABLED` gates warmup
  - `STATE_SHADOW_WARMUP_LIMIT` applies per-store row cap
  - warmup status/counters are exposed in `GET /api/admin/state-plane` and checked by `scripts/state-plane-check.mjs`
- Added outbox backlog/truncation guardrails for dual-write shadow-writer operations:
  - `STATE_OUTBOX_MAX_BYTES` sets backlog upper bound used by runtime health and drift checks
  - `STATE_OUTBOX_TRUNCATE_MIN_BYTES` controls when a fully consumed outbox file is auto-truncated
  - shadow-writer runtime now reports backlog/truncation metrics in `GET /api/admin/state-plane`
  - `scripts/state-plane-check.mjs` now fails strict checks when backlog exceeds configured limit
- Added outbox payload redaction controls:
  - `STATE_OUTBOX_REDACT_SENSITIVE=true` (default) redacts token/secret-like fields before outbox persist/sink
  - outbox runtime stats track whether redaction is enabled and cumulative redacted field count
- Added outbox/shadow idempotency safeguards:
  - outbox appends now stamp `eventId` when absent
  - shadow writer skips duplicate events via recent id/hash cache, surfaced as `duplicatesSkipped`
- Added signed HTTP shadow envelopes for reducer ingress hardening:
  - optional `STATE_SHADOW_SIGNING_SECRET` enables HMAC-SHA256 signed headers on HTTP sink writes
  - optional `STATE_SHADOW_SIGNING_KEY_ID` is propagated as key-id metadata
  - runtime/admin stats expose signing enabled state and key-id (secret is masked)
  - `scripts/state-plane-check.mjs` supports `WABI_STATE_PLANE_REQUIRE_SIGNED_HTTP=true` to fail unsigned HTTP sink deployments
- Added authenticated reducer ingress endpoint scaffolding:
  - `POST /api/internal/state-plane/reducer` gated by `STATE_REDUCER_INGRESS_ENABLED`
  - bearer token auth (when `STATE_SHADOW_TOKEN` is set)
  - signed-envelope verification + replay/skew checks when `STATE_REDUCER_INGRESS_REQUIRE_SIGNATURE=true`
  - accepted events persist to `${DATA_DIR}/state-plane-reducer-ingest.ndjson`
  - `scripts/state-plane-ingress-check.mjs` validates signed ingress end-to-end
- Added durability drill tooling for state-plane files:
  - `scripts/state-plane-backup.mjs` snapshots outbox/shadow/schema/ingress artifacts with SHA-256 manifest and NDJSON verification
  - `scripts/state-plane-restore.mjs` restores from a selected backup snapshot with checksum validation
- Added schema operations CLI:
  - `scripts/state-plane-schema.mjs status` for contract visibility
  - `scripts/state-plane-schema.mjs reconcile` for required-version reconciliation
  - `scripts/state-plane-schema.mjs set --version <n>` for controlled manual version bumps
- Added replay/backfill CLI:
  - `scripts/state-plane-replay.mjs` replays outbox/deadletter NDJSON into reducer ingress
  - supports bearer/HMAC signed envelope posting, resume byte offsets, strict/non-strict modes, and dry-run validation
  - now supports `--mode command` to replay through `STATE_SHADOW_COMMAND` (for direct SpacetimeDB bridge backfill)
- Added command-based shadow sink path:
  - `STATE_SHADOW_SINK=command` executes `STATE_SHADOW_COMMAND` for each outbox event and passes JSON via stdin
  - enables local reducer bridge workers (including SpacetimeDB bridge processes) without introducing mandatory HTTP ingress services
- Added executable SpacetimeDB bridge command:
  - `scripts/state-plane-stdb-bridge.mjs` consumes one outbox event from stdin and invokes `spacetime call` safely
  - supports reducer mapping by `entity.operation` via `--map-file`, timeout bounds, and dry-run/testing modes
  - includes `scripts/state-plane-stdb-bridge-map.example.json` for operator customization
  - launch/config helper keys (`WABI_STDB_BRIDGE_*`) can auto-generate `STATE_SHADOW_COMMAND` for config-only operators
- Added bridge preflight checker:
  - `scripts/state-plane-bridge-check.mjs` executes `STATE_SHADOW_COMMAND` with a synthetic event and reports pass/fail
  - intended for rollout gates before enabling command sink traffic
- Added initial SpacetimeDB bridge module scaffold:
  - `spacetimedb/wabi_state_bridge/src/lib.rs`
  - reducer `ingest_wabi_event(event_json: String)` with idempotent event-log ingest and core projection tables
  - module README with deploy wiring for `STATE_SHADOW_SINK=command`
- Added schema-version contract manager for state-plane runtime:
  - `backend/src/state-plane/schemaVersion.ts` reconciles `${DATA_DIR}/state-plane-schema-version.json` at startup
  - `STATE_PLANE_SCHEMA_VERSION` sets required schema version
  - `STATE_PLANE_SCHEMA_AUTO_APPLY` controls bootstrap/forward-upgrade behavior
  - mismatch status is exposed in `GET /api/admin/state-plane` and enforced at startup when `STATE_BACKEND_STRICT=true`
- Completed full config-only wiring for schema controls:
  - `.env.example`
  - `wabi.config.example`
  - `scripts/setup.sh`
  - `scripts/launch.sh` (parse, defaults, apply, and normalization/upsert flow)
- Completed STDB primary store routing in backend mode resolver:
  - `backend/src/state-plane/index.ts` now activates true `stdb_primary` when prerequisites are met.
  - strict mode (`STATE_BACKEND_STRICT=true`) fails fast on missing prerequisites.
  - non-strict mode rolls to `dual_write` (when write-enabled) or `legacy` (when write-disabled).
- Added STDB primary adapters for all required core entities:
  - `backend/src/state-plane/stdbMessageStore.ts`
  - `backend/src/state-plane/stdbChannelStore.ts`
  - `backend/src/state-plane/stdbChannelMemberStore.ts`
  - `backend/src/state-plane/stdbUserStore.ts`
  - `backend/src/state-plane/stdbSessionStore.ts`
  - `backend/src/state-plane/stdbRbacStore.ts`
- Expanded bridge reducer coverage in `spacetimedb/wabi_state_bridge/src/lib.rs`:
  - operation support for message/channel/member/user/session/rbac writes and lifecycle actions
  - idempotent ingest table (`ingested_event`) and projection `row_json` persistence
  - channel delete cascades to projection rows for messages + members
- Added deterministic STDB-primary cutover smoke checker:
  - `scripts/state-plane-stdb-primary-smoke.mjs`
  - publishes module (unless skipped), emits fixed event sequence, and asserts projection outputs for all core entities.
- Verified local bridge module toolchain on this workstation:
  - `cargo check` passes for `spacetimedb/wabi_state_bridge`.

Current mode behavior:
- `legacy`: primary and default.
- `dual_write`: with `STATE_STDB_WRITE_ENABLED=true`, uses legacy primary + in-memory shadows + outbox + parity stats + optional shadow-writer sink.
- `dual_write` + `STATE_STDB_WRITE_ENABLED=true` + `STATE_STDB_READ_ENABLED=true`: core state read canary can route sampled reads by entity (`STATE_STDB_*_READ_CANARY_PERCENT`) to shadow reads with hard fallback to legacy on mismatch/error.
- `dual_write` with `STATE_STDB_WRITE_ENABLED=false`: legacy-only writes (shadow/offbox disabled) while keeping dual-write mode configured.
- `stdb_primary`: true STDB source-of-truth mode for core state (messages/channels/channel-members/users/sessions/rbac).
  - startup prerequisites: `STATE_STDB_WRITE_ENABLED=true`, `STATE_STDB_READ_ENABLED=true`, and STDB client config (`WABI_STDB_BRIDGE_SERVER`, `WABI_STDB_BRIDGE_DATABASE`, helper script present).
  - strict mode (`STATE_BACKEND_STRICT=true`): fail-fast if prerequisites are not met.
  - non-strict + write enabled: falls back to `dual_write` preflight when prerequisites are not met.
  - non-strict + write disabled: falls back to `legacy`.
  - STDB subscription flag behavior (`STATE_STDB_SUBSCRIPTIONS_ENABLED=true`): backend remains Socket.IO realtime source; no direct STDB-to-socket fanout path is enabled.

## 12) Cutover And Rollback (Config-First)

Cutover sequence (recommended):
1. Configure `wabi.config` STDB connection values (`WABI_STDB_BRIDGE_SERVER`, `WABI_STDB_BRIDGE_DATABASE`, optional `WABI_STDB_AUTH_TOKEN`, `WABI_STDB_ANONYMOUS`).
2. Publish the bridge module:
   - `spacetime publish --module-path spacetimedb/wabi_state_bridge --server <server> <database> --yes --no-config`
3. Run deterministic smoke verification:
   - `node scripts/state-plane-stdb-primary-smoke.mjs --server <server> --database <database> --json`
4. Start in `dual_write` preflight:
   - `STATE_BACKEND_MODE=dual_write`
   - `STATE_STDB_WRITE_ENABLED=true`
   - `STATE_STDB_READ_ENABLED=true` (and canary percentages as desired)
   - apply with `./scripts/launch.sh --reconfigure`
5. Confirm health in `GET /api/admin/state-plane` (no drift/parity growth, no STDB client errors).
6. Switch to primary:
   - `STATE_BACKEND_MODE=stdb_primary`
   - keep `STATE_STDB_WRITE_ENABLED=true` and `STATE_STDB_READ_ENABLED=true`
   - set `STATE_BACKEND_STRICT=true` once primary path is validated in environment
   - apply with `./scripts/launch.sh`

Rollback sequence (instant, explicit):
1. Fast safety rollback to legacy reads with STDB still receiving shadow writes:
   - set `STATE_BACKEND_MODE=dual_write`
   - keep `STATE_STDB_WRITE_ENABLED=true`
   - apply with `./scripts/launch.sh`
2. Full rollback to legacy-only:
   - set `STATE_BACKEND_MODE=legacy`
   - set `STATE_STDB_WRITE_ENABLED=false`
   - set `STATE_STDB_READ_ENABLED=false`
   - apply with `./scripts/launch.sh`
3. Keep database-level recovery available via `scripts/state-plane-backup.mjs` and `scripts/state-plane-restore.mjs` when needed.
