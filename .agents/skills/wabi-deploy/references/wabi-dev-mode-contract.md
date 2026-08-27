# Wabi Dev Mode Contract: Real Stack vs Mock

Use this when fixing Wabi development scripts, local setup, deployment docs, or architecture drift.

## Core contract

- Real Wabi dev mode means the real stack: Rust `wabi-server` + SpacetimeDB + real auth/profile/upload/message behavior + frontend.
- Frontend mock mode is allowed only as explicitly labeled visual smoke for layout/UI screenshots.
- Mock mode must not be used as verification for profile pictures, auth, permissions, uploads, reducers, or persistence.
- Shared/server state belongs in SpacetimeDB.
- Browser-local client cache belongs in IndexedDB.
- Do not introduce SQLite/Postgres as runtime, development, rollback, or compatibility persistence unless Ronin explicitly asks for legacy/archive analysis.

## When user challenges dev-mode chaos

If Ronin says the dev mode is fake/chaotic or asks why not just run STDB:

1. Stop defending frontend mock mode.
2. Inspect the current repo scripts/docs/config before claiming what dev mode does.
3. Separate the terms clearly:
   - `dev:mock` / mock socket / fake data = visual smoke only.
   - `dev:local` / real dev = Rust + STDB + frontend.
4. Make fake fallbacks fail loudly rather than silently substituting mock/local legacy state.
5. Verify with a repo-wide search for stale database terms and run syntax/check gates.

## Cleanup pattern

Recommended active-surface search terms:

```text
SQLite|sqlite|DB_MODE|DATABASE_PATH|chat\.db|Postgres|postgres|better-sqlite3|normal \+ node|community \+ node
```

Search active source/docs/scripts separately from generated/dependency dirs. Exclude at least:

```text
.git, node_modules, target
```

If the user says “fully gone,” include archive docs too or explicitly state what archive/history remains and ask before preserving it.

## Dev script behavior

A real local dev script should:

- refuse `VITE_WABI_LOCAL_MOCK` when running `dev:local`
- check for the Wabi STDB module (`spacetimedb/wabi_state_bridge`) or an explicit already-published STDB target
- check Docker/Compose or the configured local STDB service
- verify the script builds the same binary path that Compose mounts (for example: if Compose mounts `target/release/wabi-server`, do not only run `cargo build` debug)
- check for stale listeners on expected localhost ports before starting long-lived services
- start/verify STDB and the Rust server before starting the frontend
- set frontend connection env to the real backend
- exit with a clear blocker if prerequisites are missing

It should not:

- start a fake persistence layer under a real-dev name
- silently substitute frontend mock mode when the STDB module is missing
- emit `DB_MODE` or `DATABASE_PATH`
- document Node/Bun as backend runtime selectors after Rust cutover
- use legacy SQL stores as rollback guidance

## Generated-user / bot sandbox mode

If Ronin asks for generated users, fake Discord bots, or a quick way to populate local chat, treat it as a real-stack developer tool, not mock mode. Prefer explicit commands such as `dev:reset`, `dev:seed`, and `dev:bot` that hit the same local Rust/STDB reducer/API/socket path as the app. Keep `dev:mock` reserved for visual-only UI smoke.

See `references/localdev-reset-and-bot-sandbox.md` for the detailed checklist and command shape.

## Verification gates

At minimum after cleanup:

```bash
python3 -m json.tool package.json >/dev/null
bash -n scripts/local-dev.sh scripts/setup.sh scripts/launch.sh
cargo check -p wabi-server
cd frontend && bun run check
```

Then run the repo-wide stale-term search and report the count. If `dev:local` cannot launch because STDB module/config is missing, execute the script far enough to prove it fails before any fake fallback starts and quote the blocker.
