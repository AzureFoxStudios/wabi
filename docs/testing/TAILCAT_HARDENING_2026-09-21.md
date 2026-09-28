# Tailcat networking hardening — 2026-09-21

**Result: lifecycle race fixed; tested service boundaries held; P0 direct reconnect remains unresolved.** No transport candidate fix, dependency bump, packaged binary replacement, deployment, firewall change, or enrollment-policy change was made. Existing service-role/admin work was preserved.

## Proven lifecycle cause and change

The manager already used an `RwLock`, but the detached address-file reader belonged to no particular child. `set_running(false)` cleared the address atomically; a reader completing afterward unconditionally repopulated it. An old reader could also publish an address or timeout into a replacement listener's state. Adding another mutex would not correct that ownership error.

`core/addons/tailcat/backend/src/lib.rs` now assigns a monotonically increasing generation to each spawned listener. Address and timeout publication checks both `running` and the generation under the existing state lock. Stop still clears address and start time in that same lock. Thus externally published stopped state cannot subsequently acquire a stale reader's address, and a replacement rejects old-reader results.

The deterministic regression executes the historical stop-then-late-reader ordering and replacement ordering for 100 generations. An isolated copy restoring unconditional publication failed at `stopped.address.is_none()`; the fixed library passes. The original transient HTTP failure remains documented in `TAILCAT_SECURITY_BOUNDARIES_2026-09-21.md`; its earlier passing rerun is not erased or presented as proof of correctness.

## Reconnect evidence and limits

The unchanged stock server and pinned counter client reproduced the failure. The final extended run tested a fresh connection, three reconnects with the same saved key against the same running server, and process-only forced DERP fallback. Each session downloaded three random 1 MiB files with matching SHA-256.

| Session | Incoming direct IPv4 bytes | Incoming DERP bytes |
|---|---:|---:|
| Fresh | 3,461,724 | 0 |
| Reconnect 1 | 0 | 3,460,892 |
| Reconnect 2 | 0 | 3,474,252 |
| Reconnect 3 | 0 | 3,460,860 |
| Forced DERP | 0 | 3,461,804 |

The runner returned failure (`RECONNECT_REGRESSION`), not an expected pass. Fallback passed. Counts include tunnel overhead; outgoing control traffic is separately retained and is not claimed to be all direct. See [final exact counters](tailcat-hardening-2026-09-21/final-field.json). All trials, including failed and mixed diagnostic controls, are preserved in the adjacent evidence directory.

Instrumented, isolated builds of the pinned Tailcat and Tailscale sources established:

1. Client restarts retained the node/discovery identity but acquired new local UDP sockets and advertised new STUN endpoints.
2. The server accepted the known peer, with matching discovery key, and received those new endpoint advertisements.
3. The existing-peer admission branch omitted server endpoint reannouncement. The restarted client had zero discovery endpoints in the unchanged trace.
4. Repeating the previously rejected reannouncement experiment supplied the server endpoints to the restarted client. Both sides processed CallMeMaybe and reported successful UDP ping writes to the advertised endpoints. Direct delivery still failed; no incoming UDP discovery was logged in the failing sessions, including verbose disco rejection logging. This is not proof of packet arrival at either host interface.
5. One additional admitted, fresh-identity control went direct against the same server after a failed reconnect. A separate repeat did **not**: its new-identity control and subsequent original-identity reconnect both stayed relayed. Therefore identity-specific cached state is not established as the sole cause. A new key is not a validated workaround.

**The sufficient root cause is not established.** Successful UDP writes do not prove correct public source mapping, delivery, or receipt. The remaining gap is between socket sends and remote ingress/receive handling. No speculative rebind, key rotation, peer reset, or reannouncement fix was shipped. Packet capture on both hosts was unavailable (`CAP_NET_RAW` denied; noninteractive sudo requires a password). A synchronized, authorized capture of the disposable fixture, with socket/source/destination tuples and NAT observations, is the next discriminating investigation; it requires no production or firewall change. No ISP/CGNAT cause is claimed.

The builder now offers `--trace-discovery` with checked-in read-only patches. It logs endpoint propagation, repeated-peer admission, discovery sends/receives and crypto rejection paths. It uses immutable Tailcat revision `ce6fedcabc220bab3b94d470ab330219111eeae8`, Go 1.27.0 and its pinned dependency graph. A clean download/apply/build passed. Default diagnostic build features differ from stripped release features; manifests and hashes distinguish them. The experimental reannouncement is excluded from these patches and the permanent builder.

## Hostile service boundary

The extended harness now tests TCP admission directly through SOCKS, rather than treating an HTTP error as proof of denied TCP access. The final stock-server run observed:

| Target through admitted client | Result |
|---|---|
| Explicit numeric service | TCP accepted before and after probes; verified file payload |
| SSH 22; SMB 445 | SOCKS failure; no TCP admission |
| Unrelated live random-port HTTP listener | SOCKS failure |
| Literal loopback to that live listener | SOCKS failure |
| Server LAN address to live random listener | SOCKS failure |
| Server LAN address to the allowed port | SOCKS failure |
| Separate LAN gateway TCP 80 | Reachable directly from fixture server; SOCKS failure through Tailcat |

No boundary escape was found. The random unrelated fixture served only disposable bytes and was removed. These are specific TCP probes, not a claim of exhaustive protocol or network penetration testing. The SSH/SMB ports were not newly bound; the random listener and other LAN service provide known-live negative controls.

Wabi's launch contract still specifies `serve --json --allow=<keys> <one numeric pipe port>`; empty allowlists do not launch. No `all`, `exit-node`, `no-auth-ssh`, arbitrary subnet forwarding, or port range is added. Pinned CLI source applies both `ServedTCPPorts` filtering and the `OnTCP` gate; `OnTCPForward` is enabled only by exit-node mode. The Wabi forwarder keeps its fixed loopback Authority destination.

Reserved caller `x-wabi-pipe-auth` and `x-wabi-pipe-client` headers are still discarded and replaced with trusted values. The forwarder test passes. HTTP contracts still prove a valid pipe tag without account credentials cannot authenticate, and ordinary account credentials plus a genuine pipe tag do not grant admin access.

## Device enrollment policy — unchanged

Current `POST /api/addons/tailcat/keys` accepts `AuthUser`, with no role, guest, bot or service-grant check. New valid keys are persisted with `allowed=true`:

- Ordinary members and admins can self-enroll.
- A valid guest access JWT accepted by `AuthUser` can self-enroll; guest status is not rejected by this handler.
- An enabled, registered bot with a valid `Bot <token>` and existing account row can self-enroll.
- Missing/invalid account credentials are rejected. Refresh, step-up and scoped tool credentials are not account access credentials here.
- Keys must be 64 hexadecimal digits (optional `nodekey:` prefix); case/prefix are canonicalized. A key owned by another member is rejected. Same-owner registration updates its label without silently unblocking an existing blocked key.
- Enrollment alone does not enable the listener, grant a service role, authenticate subsequent application requests, or grant administration. Device admission is persisted separately from account token lifetime; token expiry is not automatic transport-key revocation.

A new characterization HTTP test confirms guest and bot enrollment and confirms the listener remains disabled. This records current policy; it is not approval of that policy.

| Option | Concrete behavior | Interaction with service roles |
|---|---|---|
| Self-service | Keep immediate admission; explicitly decide guest/bot eligibility and revocation lifecycle | Device admission never creates a service grant |
| Approval-required | Register pending/blocked keys; separately authorized approver admits them | Service membership cannot approve a device; approval cannot grant a service |
| Admin-only | Reject non-admin enrollment; admins enroll keys for explicitly identified accounts | Service administrators do not implicitly become account/device administrators |
| Configurable server policy | Persist an explicit mode and guest/bot rules; define migration and existing-key handling | Evaluate transport admission and current service authorization independently |

No option was selected or implemented. Existing role-scoped service authorization remains a separate check against the operator's explicit endpoint registry and current grants. Account authentication, device admission, service exposure and administrative authority remain separate gates.

## Validation and changed files

- Tailcat library: **6 passed**, including generation regression, trusted headers and bidirectional upgrade forwarding.
- Tailcat HTTP/lifecycle contracts: **5 passed**, including guest/bot characterization and valid-tag account/admin denial.
- Service authorization contracts: **6 passed**, 1 subprocess fixture ignored by the test runner (invoked by its parent test).
- Admin role contracts: **14 passed**, 1 subprocess fixture ignored by the test runner (invoked by its parent test).
- Helper admin authentication: **4 passed**.
- Python evidence/adversarial assertion suite: **15 passed**; historical failing reconnect captures still require a failure verdict.
- Real stock two-host test: **failed P0**, all 15 MiB correct, all boundary probes denied as intended, forced fallback passed, cleanup confirmed.
- Read-only diagnostic builder: clean pinned build passed. Existing build warnings were not changed.

Changes are limited to manager publication ownership; the Tailcat enrollment characterization test; the diagnostic builder and its two trace patches; reconnect harness and assertion tests; README and this evidence report. No service-role implementation was edited. The shipped sidecar SHA-256 remains `8e72a7932baf395c79383c668a5856bbc911d5b24f8a329813246c8a73252566`.

All nine field/diagnostic trials report cleanup success; a final remote process check found zero owned fixtures. Private logs and diagnostic sources are retained in this task's working files; only sanitized counters/manifests are saved as reviewable repository files. No commit, push, merge or deployment was performed.
