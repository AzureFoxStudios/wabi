# Self-host onboarding: turnkey first boot (2026-08-16)

Goal: a fresh self-hoster's path is (1) run it, (2) watch it boot, (3) claim
ownership — with zero required configuration. Implemented in one pass:

## 1. First-boot secrets (auto-generate + persist)

- New `wabi-server/src/secrets.rs` (mirrored in `main.rs` + `lib.rs` module trees).
  - `resolve_root_key(data_dir)`: `WABIDB_ROOT_KEY` env (64 hex) → persisted
    `<data_dir>/root_key` → generated + persisted (0600) with a loud backup
    warning. Passed to the engine as `BootstrapSource::Provided`; wabidb's
    env-only design is unchanged. Corrupt/empty persisted key is a hard error
    (never silently regenerate over existing data).
  - `resolve_jwt_secret(data_dir)`: `WABI_JWT_KEY` env (primary — this fixes
    dead config: compose demanded it but the binary only read `JWT_SECRET`) →
    `JWT_SECRET` (legacy alias) → persisted `jwt_secret` → generated + persisted
    (now 0600, previously world-readable).
- `WdbAdapter::open` / `WdbAdapter::resolved_config` use the resolver; the
  replication path in `state.rs` (`from_env_var`) was converted too.
- Consequence: bare `wabi-server` and `docker compose up` boot with NO env.

## 2. Docker: multi-stage image

- `core/crates/wabi-server/Dockerfile`: frontend-builder (npm ci, OpenMoji
  fetch, `STATIC_BUILD=1`) → rust-builder (rust:1.93, embeds
  `frontend/build`; no BuildKit cache mounts so legacy builders work too) →
  fedora runtime (UID 1000, binary baked in).
  Fresh clone + `docker compose up -d --build` works with no host toolchain.
  The old model (runtime-only image + bind-mounted host binary) broke the
  documented quick start; bind-mount override remains available for dev.
- `docker-compose.yml`: dropped the `WABI_JWT_KEY`/`WABIDB_ROOT_KEY` `:?`
  hard-fails (env_file still passes operator-set values) and the binary
  bind-mount/entrypoint override. `TURN_HMAC_KEY` `:?` replaced with
  entrypoint enforcement in `turn-server/docker-entrypoint.sh` (which also
  removed a hardcoded fallback TURN secret).

## 3. Owner claim hardening

- `AppState.setup_claim_lock` serializes the fresh-server setup window in
  `handle_register`: exactly one account may be created before an owner
  exists; concurrent losers get 409 and re-register under normal policy.
  The owner-claim registration ignores auth policy (bootstrap, not a join).
- New `AppError::Conflict` (409).

## 4. Setup wizard: owner + join policy

- `Login.svelte` wizard is now two steps: owner account (unchanged form) →
  "Who can join this server?" (Open / Closed + guest toggle) written via the
  existing `POST /api/admin/policies/auth_policy` with the fresh owner token
  (owner = admin on fresh server). Policy-save failure still lets the owner
  in (setting is changeable later in Settings).
- Invite-only intentionally NOT offered: `mode:"invite"` blanket-rejects
  registrations (no invite-code system yet) — offering it would lock
  everyone out.
- `'auth_policy'` added to the frontend `AdminPolicyKey` union (backend
  accepted it; the type didn't).
- Boot shell first-run flavor: while `setupRequired`, `+page.svelte` retitles
  the boot screen "Setting up Wabi".
- i18n: new `login.wizard.join_*` keys in `en.json` + `es.json` (locale
  parity is type-enforced).
- Network/mesh/branding wizard steps remain deferred (strings exist unused).

## 5. Docs

- README quick start, INSTALL.md (cargo + docker + pitfalls), `wabi-serve`
  stub, `.env.example` updated to the new reality: no required secrets;
  env overrides; back up the data dir (root key inside).

## Verification

- `cargo test -p wabi-server`: 90 lib + 99 bin + 4 integration tests pass,
  including new `tests/first_boot_onboarding.rs` (zero-env boot generates
  root_key; concurrent first registrations → one owner + one 409; post-setup
  registration follows policy) and 7 unit tests in `secrets.rs`.
- `bun run check`: 0 errors. `STATIC_BUILD=1 bun run build`: SPA emits.
  (Also re-patched generated `ChannelType.ts` with `"category"|"lore"` per
  the known ts-rs regen rule.)
- Manual smoke (debug binary, empty env): boot → `/health` ok →
  `setupRequired:true` → register owner → `setupRequired:false` → owner
  writes closed join policy → public policy reflects it → late registration
  rejected → clean restart reuses keys, owner and policy persist.
