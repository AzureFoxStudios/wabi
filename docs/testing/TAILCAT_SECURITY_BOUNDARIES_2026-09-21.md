# Tailcat transport and authorization boundary audit — 2026-09-21

Scope: current Wabi Tailcat integration, pinned Tailcat transport source, and focused authorization/forwarder tests. This is not a cryptographic audit or a review of every Wabi API/helper.

## Relay visibility

Tailcat uses WireGuard between its client and server endpoints. DERP transports the encrypted tunnel; it is not the endpoint holding the tunnel private keys. DERP can observe connection identities/metadata, traffic sizes and timing. It should not be described as anonymous transport.

In Wabi, that endpoint is normally the Wabi host. The local tagging forwarder then sends HTTP to the Authority over loopback. **Current Wabi messages and DMs remain server-readable.** Tailcat transport encryption does not create device-to-device message E2EE. A volunteer attachment cache is also a different role from DERP: an authorized source caches the attachment bytes it serves. Do not apply DERP's opaque-payload claim to every helper, Authority, or booster.

Pinned source: [Tailcat transport implementation](https://github.com/tailscale/tailcat/blob/ce6fedcabc220bab3b94d470ab330219111eeae8/tailcat.go), [upstream README](https://github.com/tailscale/tailcat/blob/ce6fedcabc220bab3b94d470ab330219111eeae8/README.md). These establish implementation design, not a new independent cryptographic proof.

## Distinct gates

| Boundary | Current enforcement | Evidence |
|---|---|---|
| Know an address → admitted transport | Explicit device public-key allowlist; empty list does not start a listener | Wabi manager spawn contract/lifecycle tests |
| Admitted transport → arbitrary host service | Wabi launches `serve` with exactly one numeric pipe port; no `all`, `exit-node`, or SSH service. Forwarder binds loopback and rewrites the target to the fixed Wabi loopback endpoint | Manager/forwarder source; pinned Tailcat CLI also applies served-port filtering and an OnTCP port gate |
| Reach Wabi → authenticated account | AuthUser requires an account credential; a valid pipe tag alone is not a credential | New valid-pipe/no-account `/connect` test returns 401 |
| Authenticated account → administrative action | admin_auth separately requires an authorized, non-guest admin | New tests cover status, key listing, enable, disable, port changes, key access and key revocation; valid pipe tag without account gives 401, ordinary account gives 403 |

The service-scope conclusion is source-reviewed here; this batch did not conduct a complete live arbitrary-port penetration test. Device-key registration currently uses AuthUser self-service and does not explicitly reject guest/bot AuthUser variants. It is **not** a policy requiring admin approval of every device. This does not grant arbitrary services or an admin role, but operators should not be told admission is admin-only.

## Header flaw found and corrected

The forwarding code previously copied caller `x-wabi-pipe-auth` and `x-wabi-pipe-client` headers, then appended trusted values. The backend's first-value lookup could see the attacker-provided values. A hostile-header regression failed with the caller's token and identity before the change.

The forwarder now discards both incoming reserved headers before inserting its own. The regression requires the trusted token and actual connection address. This fixes ingress-tag integrity; it was not demonstrated to bypass account/admin authorization. The valid-tag authorization tests explicitly verify that even a genuine tag cannot grant those privileges.

Files: `core/addons/tailcat/backend/src/forwarder.rs`, `core/crates/wabi-server/tests/tailcat_private_access_contract.rs`. No deployed server or bundled Tailcat binary was changed during this audit.

## Validation caveat

The pre-existing enable/disable lifecycle test failed once because `running=false` still had a nonempty address snapshot, then passed on rerun. An asynchronous address-reader/status race is suspected; no claim that this race is fixed. This is separate from account/admin access and from the real-network reconnect defect. Preserve the failure in the test history rather than interpreting the rerun as proof of absence.

Final focused checks: 5 Tailcat library tests and 4 HTTP/lifecycle contract tests passed. The Python evidence/assertion suite passed 10 tests. The real two-host regression returned exit 1 for the intentionally unfixed reconnect defect, with cleanup confirmed.
