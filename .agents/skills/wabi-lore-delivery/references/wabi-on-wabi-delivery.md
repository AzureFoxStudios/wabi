# Wabi-on-Wabi Delivery Reference

## Verified Tim facts

- SSH: `tim@100.96.11.45`.
- Host Lore CLI: `/home/tim/.local/bin/lore`.
- Container Lore CLI: `/usr/local/lorebin/lore`.
- Canonical fixture repo: `~/Desktop/Wabi/lore-data/2` / `/var/wabi/lore/2`.
- Lore version verified: `0.8.6+373`.
- Native fixture initial revision verified with identity `Wabi Test Fixture <wabi-test@localhost>`.
- Runtime Lore environment: `WABI_LORE_ENABLED=true`, `WABI_LORE_MODE=embedded`, `WABI_LORE_DATA_DIR=/var/wabi/lore`, `WABI_LORE_BINARY_PATH=/usr/local/lorebin/lore`, `WABI_LORE_SERVER_URL=lore://host.docker.internal:41337`.

## Fixture contents

The Git fixture is `tests/fixtures/lore-meta/`:

- `README.md`
- `src/hello.rs`
- `docs/design-notes.md`
- `assets/test.svg`
- `.wabiignore`

Keep each fixture addition small and additive. Pair each source commit with a Lore revision message.

## Deployment proof

For runtime changes, verify all of:

```text
local release SHA == Tim bind-mounted binary SHA
wabi-server container == healthy
Tim :3001/health == 200
Tim Caddy :8088/health == 200
public https://wabi.chat/health == 200
public / == 200 with cache-control: no-cache
```

Inspect startup logs for awaited Lore rehydration. A warning that an async rehydration future is unused means the runtime is not restoring the Lore index.
