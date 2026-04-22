# STDB Migration — P7 + P8 Handoff Guide

Context: the hybrid SQLite+STDB → STDB-only migration completed phases P1–P6 on 2026-04-22.
All 6 state plane stores (`message`, `channel`, `channel_member`, `user`, `session`, `rbac`) run in
`stdb_primary` mode on tim with clean writes and no shadow/warmup/parity/outbox-replay plumbing.
This guide exists so a future session can finish P7 (cleanup) and P8 (multi-server client features)
without re-deriving the context.

Verify current state: `curl http://tim:8080/state-plane/healthz` should return `mode=stdb_primary`
in every `*_store` block with no `warmup`/`shadow`/`parity`/`read_switch` sections.

---

## P7 — Cleanup (deferred from P6)

P6 removed the state-plane code paths, dead scripts, and obvious env flags. P7 finishes the job:
kill dead SQL tables, strip remaining backcompat env plumbing in shell scripts, retire one admin
endpoint, and update the docs.

### P7a — Drop dead state_* repositories + findByMessageId path

**Problem.** These still exist but nothing in the running code path calls them since P5:

- `backend/src/db/repositories/messageRepository.ts` — used only by `stdbMessageStore.toClientFormat()` (pure formatter — can inline or pull into a `formatMessage` helper) and `findLegacyMessageByMessageId` (dead).
- `/api/admin/legacy-message-status` in `backend/src/api/runtimeAdminRoutes.ts` — introspects the SQLite message_archive table that P5 stopped writing to.
- The `findByMessageId` repo method it calls.
- `backend/src/api/followRoutes.ts` reference — verify whether it's still in the hot path or a vestige.

**Steps.**

1. Grep: `grep -rn "legacy-message-status\|findLegacyMessageByMessageId\|messageRepository\." backend/src`.
2. For each caller, either delete the call site (dead admin route, dead helper) or replace the
   repo call with the state-plane store equivalent (most should already be routed through
   `stateMessageStore`).
3. Once `messageRepository` has zero callers outside its own file, delete the repository file
   and remove the import from `db/database.ts`.
4. Apply the same treatment to `channelRepository`, `channelMemberRepository`, `userRepository`,
   `sessionRepository`, and the RBAC repo — anything under `backend/src/db/repositories/` that
   wraps a `state_*` concept is dead. Keep non-state repos (payments, plugins, etc).
5. `backend/src/db/schema.sql`: drop the `CREATE TABLE` statements for `state_message`,
   `state_channel`, `state_channel_member`, `state_user`, `state_session`, `state_rbac_*`, and
   `message_archive`. Keep non-state tables (users? check — user_profile stays, but `users` may be
   dead if `stateUserStore` owns everything).
6. `backend/src/db/database.ts`: remove any migration that depended on the removed tables. The
   `applySchema no such column tolerance` safety net stays.
7. Verify: `bun run build` succeeds. Deploy to tim. `/state-plane/healthz` still clean. Create a
   message, a channel, a user via normal flow and confirm they round-trip.

**Gotcha.** Some tests in `backend/tests/` and `backend/scripts/*-smoke.ts` may still seed via the
dead repos. Update them to seed through the state-plane stores, or delete the test if its premise
(shadow/parity/dual-write) no longer applies. Smoke scripts already touched in P6 include
`operator-reset-password-smoke.ts` and `payments-stdb-hybrid-smoke.ts` — the second can probably be
renamed (no longer "hybrid").

### P7b — Clean launch.sh / setup.sh / platform variants

Affected files (each has ~dozens of refs to the removed env flags):

- `scripts/launch.sh` (~1700 lines)
- `scripts/setup.sh` (~500 lines)
- `scripts/local-dev.sh`, `scripts/local-dev.ps1`
- `scripts/setup-forWindows.ps1`
- `scripts/state-plane-stdb-benchmark.ps1`

**Strings to purge (all removed as valid envs in P5/P6):**
`STATE_BACKEND_MODE`, `STATE_STDB_READ_ENABLED`, `STATE_STDB_WRITE_ENABLED`,
`STATE_BACKEND_STRICT`, `STATE_SHADOW_TOKEN`, `STATE_SHADOW_POLL_INTERVAL_MS`,
`STATE_SHADOW_BATCH_SIZE`, `STATE_SHADOW_WARMUP_ENABLED`, `STATE_SHADOW_WARMUP_LIMIT`,
`STATE_STDB_PRIMARY_MIRROR_LEGACY_WRITES`, `STATE_SHADOW_SIGNING_SECRET`,
`STATE_SHADOW_SIGNING_KEY_ID`.

**Strings to keep** (still valid): `STATE_STDB_SUBSCRIPTIONS_ENABLED`, `STATE_STDB_ENFORCE_RBAC`,
`STATE_OUTBOX_*`, `WABI_STDB_BRIDGE_*`, `WABI_STDB_AUTH_TOKEN`, `STATE_PLANE_SCHEMA_*`,
`STATE_REDUCER_INGRESS_*`.

**Approach.** launch.sh is load-bearing for operators — don't do a find/replace blind. Read each
function that references a dead flag and:
  - if it's help text / prompt → drop the paragraph.
  - if it's a case/menu branch that wrote the flag to `.env` → remove the branch and simplify the
    enclosing menu.
  - if it's a `sed -i` that rewrites the flag → drop the command.
  - if it's a pre-flight check that errored on bad values → drop the check.

Do a final grep on the pruned files to confirm zero matches for the kill-list above.

### P7c — Documentation pass

- `PROJECT_DOCS/SPACETIMEDB_WABI_STATE_PLAN.md` — plan doc, likely describes the phased rollout.
  Rewrite to reflect "P1–P6 done, STDB is sole source of truth." Keep it as a historical record
  rather than a forward plan.
- `PROJECT_DOCS/DEPLOYMENT.md` — remove any dual-write / shadow / read-canary sections. Operators
  now just need `WABI_STDB_BRIDGE_*` + token.
- `spacetimedb/wabi_state_bridge/README.md` — should already describe the Rust module. Ensure it
  doesn't reference `dual_write` or the command sink scripts deleted in P6b.
- `frontend/scripts/state-plane-benchmark.mjs` — quick check: if it calls removed admin endpoints,
  update or delete.
- `scripts/state-plane-ingress-check.mjs` — kept in P6 because it has no legacy refs. Re-verify
  after P7a that it still works (touches state-plane healthz).

### P7d — Build + tim verify + git push

1. `cd backend && bun run build` — must succeed.
2. `rsync` to tim (`--exclude 'data/'` — see the tim deploy memory for why this is critical).
3. `docker compose build backend && docker compose up -d backend` on tim.
4. Check `/state-plane/healthz` — all stores `mode=stdb_primary`, no write failures.
5. Smoke test: create a message, create a channel, reset a password via operator script — all
   should round-trip through STDB.
6. Once green, user will push to git. Do NOT push without explicit ask.

---

## P8 — Multi-server client features

The original migration plan ended at P8: once STDB is the sole source of truth, the backend is no
longer a shared-state bottleneck, so clients can move between backend instances without losing
presence/sessions/subscriptions. P8 delivers the features that were gated on this.

**P8 is a design phase first.** Don't jump to implementation — the user will want to align on scope
before code. Start by asking which of these items they want to tackle, in what order:

1. **Mesh presence leases.** Each backend node already registers with `WABI_MESH_*` envs; add a
   shared presence table in STDB (`state_presence_lease`?) and have each backend write a
   heartbeat-expiring row keyed by `(user_id, instance_id)`. Frontend/other backends read the
   table to know who's online and where.
2. **Cross-backend socket routing.** When User A on backend-1 sends a DM to User B who is connected
   to backend-2, route the realtime event through the mesh. Current code in
   `backend/src/services/presenceMeshRuntime.ts` has scaffolding — it needs to consume the
   presence table from P8.1 to pick the right peer.
3. **Subscription failover on the client.** When a client's backend goes down, the client should
   reconnect to any healthy backend and resume subscriptions without losing messages. STDB's
   subscription model gives us the raw tools; the client code in `frontend/src/lib/state-plane/`
   needs to handle "backend endpoint rotation" (not just "socket reconnect").
4. **Horizontal scale test.** Stand up 2 backends on tim + 1 on a dev box, point all at the same
   STDB instance, verify messages sent to one show up on clients of the other. The mesh shared
   token (`WABI_MESH_SHARED_TOKEN` in `wabi.config`) is already wired for inter-node auth.

**Prereqs before P8 code work:**
- STDB subscriptions enabled (`STATE_STDB_SUBSCRIPTIONS_ENABLED=true`) — currently off on tim.
- A second STDB bridge table for presence leases (add to `spacetimedb/wabi_state_bridge/src/lib.rs`
  and republish — see tim deploy memory for the owner-identity gotcha).
- Either use the Rust module bindings from the Node backend (SpacetimeDB Node SDK) or keep using
  the HTTP helper. Subscription mode will want the SDK — the HTTP helper is poll-based.

**What user flagged as the end-goal:** catch up all dev computers (not just tim) and then push to
git. So P7 + P8 should land together, with git push the final step, not per-phase.

---

## Key files to re-read before starting

- `backend/src/state-plane/index.ts` — how the 6 stores are wired.
- `backend/src/state-plane/stdbSyncClient.ts` — HTTP helper client. Don't forget the
  runHelper-stdout-on-failure patch (2026-04-22).
- `backend/src/server.ts` line ~1947 — `/state-plane/healthz` endpoint; shape of the response.
- `spacetimedb/wabi_state_bridge/src/lib.rs` — all state_* tables.
- `docker-compose.yml` — service wiring (backend / spacetimedb / stdb-proxy / stdb-publisher).
- Tim deploy memory (`project_tim_deploy.md` in Claude's auto-memory) — gotchas that will burn an
  hour if you don't know them.

## Key invariants to preserve

- All `state_*` tables in the Rust bridge are `public` so non-owner identities can SELECT.
  `ingest_auth_config` stays private.
- `WABI_STDB_AUTH_TOKEN` in `.env` must match the token in
  `data/stdb-publisher-config/cli.toml` after every republish.
- Never wipe only one of `data/spacetimedb/` or `data/stdb-publisher-config/` — wipe both or
  neither. Mismatched wipe = `403 Forbidden: not authorized to update database`.
- `rsync` to tim always needs `--exclude 'data/'`.
