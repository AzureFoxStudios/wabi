# Lore Handshake and Auth Verification

## Why a matching SHA is not enough

A Tim binary can match the local release SHA while still being built without Lore. The addon is feature-gated:

```bash
cargo build --release -p wabi-server --features addons
```

Before deployment, prove the binary contains the addon:

```bash
strings target/release/wabi-server | grep -c 'Lore addon initialized'
strings target/release/wabi-server | grep -c 'wabi_lore'
```

The first count must be non-zero. After recreation, prove the runtime contract:

```bash
curl -fsS http://127.0.0.1:3001/api/addons
curl -fsS http://127.0.0.1:3001/api/addons/lore/health
```

Expected: `/api/addons` contains an enabled `lore` entry and Lore health returns `{"addon":"lore","status":"ok"}`. Also inspect startup logs for:

```text
[lore] Rehydrated N Lore repo(s) from WDB
[lore] Lore addon initialized
```

## Authenticated repo probes

Do not use a guest token to test Lore repo access. Lore routes enforce channel membership, so a guest commonly gets `403` even when the addon is healthy. A failed unauthenticated/guest repo probe is an authorization result, not proof of a broken handshake.

Guest-token smoke, when needed for general auth only:

```bash
curl -fsS -H 'Content-Type: application/json' \\
  -X POST http://127.0.0.1:3001/api/auth/guest -d '{}'
```

For repo/file verification, use an existing authorized account/session token or real browser DevTools request from a member of the Lore channel. Do not create probe accounts, register users, or weaken `ensure_channel_member` merely to make a smoke curl pass.

## Fixture interpretation

A Lore working tree may contain `.lore`, `.wabi-repo.json`, and `.loreignore` metadata while still having no user content. Distinguish:

- addon missing: `/api/addons` has no `lore`, Lore health is 404;
- repo row/tree missing: authorized repo GET is 404;
- empty native repo: authorized repo GET is 200 but files/history are empty;
- populated repo: authorized repo GET/files/history are 200 with content.

The current Wabi-on-Wabi fixture has Lore revision 1 and files such as `README.md`, `src/hello.rs`, `docs/design-notes.md`, and `assets/test.svg`. Its presence in channel 2 does not make channel 2 a product constant.

## Browser gate

Build and health checks are not browser verification. After a frontend/binary deployment, the user must hard-refresh the real browser and verify Code/Files, repository badge, channel selection, and console errors. Cloudflare beacon CORS/SRI warnings are unrelated analytics noise unless the actual app request fails.
