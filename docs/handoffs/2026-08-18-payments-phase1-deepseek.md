# Payments Phase 1 — WabiDB payment projection (handoff)

Status: **Ready for implementation — handoff to DeepSeek/opencode, 2026-08-18**
Provenance: payments audit session 2026-08-18 (ZCode). The implementing agent is
assumed to have NO other context. Read `AGENTS.md` first, then this file, then
`docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md` (strategy + §5
execution record of the frontend pass that just landed).

---

## 0. Ground rules and current tree state (read first)

- `AGENTS.md` golden rules apply. The ones that bite THIS work:
  - **#5 postcard records**: never add fields to existing postcard-encoded
    records (`UserRecord`, `MessageRecord`, `Channel`, …) without a dual-decode
    V0/V1 fallback. CREATING brand-new records (this plan does) is fine. The
    fallback pattern to imitate if you ever touch an existing record:
    `core/crates/wabidb/src/projections/users.rs:56-104`.
  - **#8 adapter emit-shape**: when emitting events via `WdbAdapter`, copy the
    emit call from the TARGET module's existing method — a wrong emit compiles
    but silently doesn't persist.
  - **#9 two lock files** on restart/deploy: `data/wabi-server/.lock` AND
    `data/wabi-server/wabidb/.lock`. Remove both after a binary swap or the
    server won't start.
  - Tests accompany changes (wabidb unit/property/fuzz + wabi-server
    integration). Never commit `data/` contents, `data/admin_policies.json`,
    `data/jwt_secret`. No push/deploy without the explicit word.
- **Tooling on this machine**: `bun` is NOT on the default PATH — use
  `export PATH="$HOME/.bun/bin:$PATH"`. Frontend commands: `bun run check`
  (svelte-check), `STATIC_BUILD=1 bun run build` (must run from `frontend/`;
  emits `frontend/build`, which `rust_embed` requires before
  `cargo build -p wabi-server`). Backend: `cargo test` from the repo root.
- **Working tree right now**: 29 uncommitted files = the COMPLETED,
  VERIFIED payments-UX pass from 2026-08-18 (runes migration of the payments
  suite, manual-cash removal, API rewiring to real Rust routes, BaseModal
  additive `title`/`subtitle` props, CSS tokenization). It passed
  `bun run check` (0 errors) and the static build. **Commit it before starting
  Phase 1** — it is finished work; do not revert or mix it into your changes.
  The roadmap doc + API-layer files were already committed in `b7fac94`.
- Branch off the current branch (`wip/combined-handoff-2026-08-18`) or `main`,
  your call — but keep Phase 1 commits separate from the pending UX files.

## 1. Scope

Phase 1 of the payments roadmap: move payment intents, account links, policies,
and user blocks from the current JSONL/stub storage into WabiDB event-sourced
storage (commands → events → projections), and light up the frontend hooks that
were left intentionally dormant (each marked with a code comment).

OUT of scope: marketplace/commission-sheet UI (Phase 5, legal-gated), new
payment rails (crypto/EU/US addons — Phases 2-4), the lore addon, the
breakout/calling work that lives in this branch.

## 2. Current backend state (all verified 2026-08-18)

| Thing | Where | State |
|---|---|---|
| Payment routes | `core/crates/wabi-server/src/api/payments/mod.rs:18-55` | 8 route groups live: access, account-links, donations, user-blocks, intents (+confirm/reject) |
| Account-link struct | `api/payments/mod.rs:83-100` | `PaymentAccountLink` defined; persistence STUBBED |
| Persistence stubs | `api/payments/mod.rs:234-247` | `get_policy_row`/`upsert_policy`/`upsert_account_link` are no-ops, comments say "follow-up" — this is THE core TODO |
| Intents storage | `api/payments/intents.rs` | JSONL at `{data_dir}/payments/intents.jsonl`, whole-file rewrite on confirm/reject, guarded by `state.intents_mutex` (`state.rs:91`). PromptPay-only (`provider == "promptpay"`) |
| Account-links handler | `api/payments/handlers.rs:49-98` | list returns empty (comment "WDB-compat"); create echoes but doesn't persist |
| User-blocks handlers | `api/payments/handlers.rs:154-242` | already write via `state.wdb.ingest_event("payment", ...)` — the working ingest precedent to copy |
| Payment ingest arm | `core/crates/wabi-server/src/adapter/mod.rs:1508` | `("payment", _)` events already append to the stream log; NO projection consumes them |
| Reserved table names | `core/crates/wabi-server/src/standby/tables.rs:25-37` | `state_payment_account_link`, `state_payment_intent`, `state_payment_policy`, `state_payment_user_block` already reserved |
| Projection registry | `core/crates/wabidb/src/engine/mod.rs` (TypeRegistry, ~780-979) | add the new projection here; worked examples: `projections/forum.rs`, `projections/users.rs` |
| QR builder | `api/payments/promptpay.rs` | DONE — do not touch (EMVCo + CRC16, env: `WABI_PROMPTPAY_PROXY_ID`, `_MERCHANT_NAME`, `_MERCHANT_CITY`) |

## 3. Workstreams (suggested order)

**WS-1 — wabidb payment projection (pure Rust, no HTTP).**
New postcard records in `core/crates/wabidb/src/domain/` — `PaymentIntentRecord`,
`PaymentAccountLinkRecord`, `PaymentPolicyRecord`, `PaymentUserBlockRecord` —
mirroring the JSON shapes the API already speaks (camelCase serde, see
`mod.rs:83-150`; statuses `pending|completed|rejected|expired`). New projection
file in `projections/` (SkipMap indexes: intents by id + by user, links by
(user, pluginId), policies by key, blocks by user), rebuilt from events on
startup, registered in the engine TypeRegistry. Typed query + command methods on
the `WabiStore` trait + `WdbAdapter` impls. Unit tests: event roundtrip,
replay-from-events, idempotent replay.

**WS-2 — wire the API layer to the store.**
Replace the three stubs in `mod.rs:234-247`; make `handlers.rs` account-links
list/create/delete hit the store; swap `intents.rs` from JSONL to the store
(keep the JSONL reader as a one-time import: if `intents.jsonl` exists and the
store is empty on boot, ingest its intents as events, then rename the file to
`.imported`). Keep the mutex discipline or replace it with the store's own
sequencer ordering. Policy rows keyed exactly `policy:payments_access` and
`policy:payments_donations` (get_policy_row's key contract). Emit-shape: follow
rule #8 — the user-blocks handlers (`handlers.rs:109-121, 203-215`) show the
`wdb.ingest_event("payment", op, json)` shape already in use; for adapter-level
emits copy from the forum/wiki create paths.

**WS-3 — access policy actually enforced (behavior change, coordinate).**
Today `intents::create_intent` checks only auth, and the frontend
`paymentAccessStore.ts` deliberately ignores `policy.enabled` (marked with a
comment — the stub always returned default-false and would have hidden the UI
forever). Once the policy persists for real: enforce it server-side in
create_intent (enabled + role names + guest flag), then RESTORE the client
gating by reverting the marked block in `frontend/src/lib/payments/paymentAccessStore.ts`
to respect `policy.enabled`. Integration tests: disabled policy → 403;
role-not-allowed → 403; owner bypasses.

**WS-4 — socket realtime (optional but high-value).**
Emit `payments:intent-updated` (after confirm/reject/create) and
`payments:account-links-updated` socket events. The frontend already subscribes
via `frontend/src/lib/payments/paymentRealtime.ts` (a local event bus — wire the
socket payload into `emitPaymentRealtimeEvent`) and PaymentSheetImpl/History/
Connections refresh on them. Keep polling as the fallback.

**WS-5 — frontend migrations (small, each marked by a comment).**
- `paymentAccessStore.ts`: restore policy gating (see WS-3).
- `api/paymentHistory.ts`: account-links switch from localStorage to the server
  list (keep localStorage as offline fallback if you like; the storage helpers
  are self-contained).
- `api/paymentCheckout.ts`: `V1_PROVIDER_CATALOG` may stay — moving the provider
  list server-side only matters when a second rail exists (Phase 2+).
- Any frontend edit: Svelte 5 runes only, esbuild minifier stays (rules #1-2).

**WS-6 — docs + skills (repo policy, not optional).**
Append a Phase 1 execution record to
`docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md` §6, and update the
wabidb skill docs for the new projection/records.

## 4. Definition of done

- `cargo test` green (wabidb unit/property + wabi-server integration incl. new
  payment tests); `cargo build -p wabi-server` succeeds with `frontend/build`
  present; `bun run check` 0 errors; `STATIC_BUILD=1 bun run build` passes.
- Manual REST flow: create intent → QR payload present → confirm as admin →
  list shows `completed`; account-link save survives server restart (the thing
  the stub never did).
- Restart the server once to prove replay (mind the two lock files, rule #9).
- Docs updated (WS-6). No `data/` contents committed.

## 5. Quick orientation for the frontend side (state after the 2026-08-18 pass)

- Provider rail is keyed by pluginId `promptpay` (was TS-era `th-payments`;
  helpers accept both — see `paymentSheetHelpers.ts`).
- Intent JSON from the server is mapped in `api/paymentCheckout.ts`
  (`mapIntent`, statuses `completed→succeeded`, `rejected→failed`).
- There is NO user-side cancel route; confirm/reject are admin-only
  (`confirmPaymentIntent`/`rejectPaymentIntent` clients exist, no UI yet — a
  small admin section in PaymentHistoryModal is a welcome bonus, gate it on an
  actual admin signal, don't fake one).
- `BaseModal.svelte` now accepts optional `title`/`subtitle`/`headerTag` props
  (additive; legacy slot still works) — use them from runes components instead
  of slot interop.
