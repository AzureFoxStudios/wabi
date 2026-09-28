# Desktop Tailcat entry switch — 2026-09-26

**Scope:** The desktop app's temporary loopback forwarder and URL-scoped Wabi session during a private Tailcat connection. This is a local code check, not a three-site transport result.

The connection card now probes `/readyz` through the new proxy without credentials, clears any account state left under a reused proxy port, saves the previous server address and its remember preference, then reloads at the proxy URL. The member signs in at that URL. The login screen offers a way to leave the tunnel if sign-in there is unavailable. Disconnect restores the prior address. Before account bootstrap on the next launch, the client checks native tunnel status and restores either the live proxy address or the previous server address if the tunnel stopped. A manual switch to another server is preserved.

The native command binds the forwarder listener before returning its port. Status requires both the Tailcat child process and local forwarder to be alive. A dead component closes the other and clears the port state.

Focused checks: `bun test src/lib/tailcatConnection.test.ts` passed six cases, including lost session storage after a restart, stale markers and a reused port with a legacy bearer token. `bun run check` reported zero errors. `cargo check --manifest-path src-tauri/Cargo.toml --locked` passed. The stopped Authority move's ten first-boot integration tests also passed separately; see [local writer fence](LOCAL_WRITER_FENCE_2026-09-26.md).

This does not prove peer identity for automatic token carry over Tailcat. It also does not test an actual WireGuard path, relay behavior, cross-network reachability, login at the proxy, upload, Socket.IO or call media. Those remain field acceptance steps in the [geographic node plan](../plans/2026-09-26-geographic-community-nodes.md).
