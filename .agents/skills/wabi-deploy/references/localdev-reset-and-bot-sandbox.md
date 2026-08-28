# Wabi Localdev Reset + Bot Sandbox Notes

Use when Ronin wants Wabi local development to stop being half-real/half-mock and become a simple localhost stack.

## Durable lesson

Do not defend or extend fake localdev. The sane target is:

- `dev:local`: real Rust `wabi-server` + fresh/local SpacetimeDB + localhost ports.
- `dev:mock`: visual-only frontend smoke, explicitly not valid for persistence/auth/messages/profile/upload verification.
- `dev:seed` / `dev:bot`: deliberate developer tooling that drives the real local backend/STDB path with generated users and messages.

A generated-user/bot mode is not a mock fallback if it sends through the same reducer/API/socket path the app uses.

## Localdev impossibility checklist

When `bun run dev:local` feels cursed, inspect these before changing architecture:

1. Root scripts: confirm `dev` maps to `dev:local` and what script it runs.
2. Compose ports: identify STDB, proxy, backend, and frontend ports.
3. Required STDB module path: usually `spacetimedb/wabi_state_bridge`.
4. Workspace membership: if root `Cargo.toml` lists the module but the folder is absent, localdev cannot be real.
5. Compose binary mount: if compose mounts `target/release/wabi-server`, the dev script must build release or compose must mount the debug binary.
6. Live ports/processes: check whether stale frontend/backend/STDB processes already occupy expected ports.
7. `.env` key names only: inspect for old migration/canary/shadow flags without printing secrets.

If the STDB module is missing, `dev:local` should fail loudly before starting fake persistence. Do not silently route to `VITE_WABI_LOCAL_MOCK`.

## Sane target commands

Suggested user-facing shape:

```bash
bun run dev:local
bun run dev:reset
bun run dev:seed
bun run dev:bot -- --user "Mina" --channel general --message "hello"
```

Implementation intent:

- `dev:reset`: wipe local-only STDB/data, republish module, never touch production/Tailscale remotes.
- `dev:seed`: create local test server/channels/generated users/initial messages through the real backend/reducer path.
- `dev:bot`: send messages/events as generated users through the real local backend/reducer/socket path.

## Pitfalls

- Do not call bot/seed mode “mock”; that confuses verification semantics.
- Do not deploy Tim from a local tree whose real localdev cannot prove the server/frontend build path.
- Static checks can pass while the local runtime is fake or pointed at stale services; verify HTTP readiness for STDB proxy and Rust `/health`.
