# Wabi as the glue: ecosystem and control-plane direction

**Recorded:** 2026-09-21. **Status:** product direction grounded in local implementation, focused security review and isolated transport tests; not a release or production-security claim.

Wabi is evolving from a self-hosted Discord/TeamSpeak/LINE-style communication and workspace application toward an **optional ecosystem/control plane**: shared identity, roles and permissions, device identity, service discovery and authorization, and Tailcat private connectivity. Separate mature tools should feel like capabilities of the same environment. **Wabi is the glue, not a replacement for every application.**

The normal single-Authority communication app remains useful on its own. Shared identity means identity within that Authority's trust boundary, not a global Wabi account database or federation between independent servers. This direction does not promote candidate features to shipped functionality; [PROJECT_STATUS](../PROJECT_STATUS.md) remains the maturity reference.

## The experience we want

A person should be able to select a known device, understand what is available to them, and act without configuring ports or understanding relay selection. An illustrative target menu is:

```text
Janya — known device
  Message
  Send File / Browse Files
  Remote Desktop
  Open Terminal
  Join Game / Open Private Service
  System Information (limited)
```

This is a target UX, not a list of implemented device actions. Entries depend on registered capabilities, current authorization, installed integrations and availability. Message uses the associated Wabi communication context; a device name is not itself an account credential. Service authentication or explicit target-user consent may still be required after selecting an action. Failures should explain the relevant access or availability problem in ordinary language. Networking details belong in optional diagnostics.

The useful Apple-ecosystem analogy is coherence: separate capabilities feel related because identity, device context and connectivity carry across them. Wabi should pursue that convenience while remaining FOSS-friendly, supporting Linux, Windows and other systems through existing open protocols and tools. It should not require a vertically locked hardware/software stack.

## Responsibilities and architecture

```text
User selects a device / capability
                 |
                 v
Wabi Authority: community identity, device/service discovery,
               roles, explicit service authorization
                 |
                 v
Tailcat: admitted device transport, private connectivity
         direct UDP where possible / DERP relay fallback
                 |
                 v
Scoped integration / gateway: only the registered service
                 |
                 v
Target application: its own protocol, authentication and privileges
  OpenSSH/SFTP | RustDesk | printer | game/application server | ...
```

This diagram assigns responsibilities; it does not imply that every control request traverses these boxes in this order or that arbitrary device services are currently wired up. The current Tailcat Wabi listener exposes one numeric Wabi pipe port with a fixed loopback Authority destination. The [service-access candidate](../features/SERVICE_ACCESS.md) separately provides an authenticated gateway to explicitly registered TCP endpoints from the Authority host. It is not a generic device tunnel, UDP application gateway or automatic native-client launcher.

Prefer OpenSSH for terminal sessions and SFTP for file browsing/transfers, RustDesk for remote desktop, and existing game/application servers for their respective capabilities. Addons should connect the UI and permission context to those tools, with their dependencies and limits made clear. Tailcat's direct UDP transport does not by itself establish support for a game's UDP application protocol.

Target applications retain their own authentication where appropriate. **Wabi permission to reach SSH must not automatically equal SSH authentication, an operating-system account, or root access.** SSH credentials, host verification and target OS permissions remain meaningful. The same separation applies to remote-support consent and application-specific access controls.

## Generic registered services and role UX

A service is an explicitly registered capability with a stable identity, human-readable name, device/host association where applicable, a narrowly scoped endpoint, integration/protocol requirements, exposure state and role grants. This is a design model, not a claim that every field exists in the current registry. Service kinds describe capabilities; they must not become a hard-coded list of special privilege exceptions.

Roles should eventually express access to services such as Wabi Chat, Office Printer, Company Files, Remote Support, Terminal/SSH, Minecraft or another private application. These are examples, not mandatory bundled services. Listing Wabi Chat here does not claim the candidate service gateway replaces existing chat admission or channel permissions.

The admin direction is a compact inline checkbox/dropdown service picker on each role, with enough context to understand grants without tab-hopping. The working-tree service-access candidate already has inline service/member pickers and an explicit endpoint registry; native integrations and the broader device menu remain separate work. See its [contracts and limits](../features/SERVICE_ACCESS.md) rather than inferring availability from this design.

Device enrollment is a separate configurable-policy question: self-service, approval-required, admin-only or a configurable mode need explicit decisions about eligibility, revocation and migration. Current enrollment accepts authenticated members and also eligible guest/bot credentials; it is not admin-only. A service grant must neither admit a device nor change its key allowlist. Admitting a device must not create service grants, and account-token expiry must not be mistaken for automatic device-key revocation.

## Security boundaries established by the audit

The [2026-09-21 boundary audit](../testing/TAILCAT_SECURITY_BOUNDARIES_2026-09-21.md) separates these gates:

| Boundary | Meaning |
|---|---|
| Knowing an address != admitted transport | Device-key admission is still required; an empty allowlist does not start the listener. |
| Admitted transport != arbitrary host/LAN service access | The Wabi pipe is scoped to one service, not the host or subnet. |
| Service reachability != Wabi account authentication | A valid transport tag is not an account credential. |
| Authenticated account != admin privilege | Administrative operations require their own authorization. |
| Role permission for a service != device admission or target-service authentication | Transport keys, service grants and application credentials remain separate checks. |

The audit found and fixed a reserved-header trust-boundary issue: the forwarder copied caller-supplied `x-wabi-pipe-auth` and `x-wabi-pipe-client` before appending trusted values, allowing a first-value lookup to see the caller's values. It now discards those incoming headers before inserting trusted values. A hostile-header regression covers the fix. This was an ingress-tag integrity flaw; the audit did not demonstrate an account/admin bypass. Separate tests establish that even a genuine pipe tag cannot authenticate an account or elevate an ordinary account to admin. This local fix is not evidence of deployment.

The later [hardening report](../testing/TAILCAT_HARDENING_2026-09-21.md) records denied TCP probes to unrelated host/LAN services through the admitted transport, alongside successful transfers to the explicitly allowed service. Those focused tests strengthen the scoped-access evidence; they are not an exhaustive penetration test. Neither report is a cryptographic audit or certification of production-grade security.

## What transport testing proves, and what remains open

The [isolated Janya-hosted field test](../testing/TAILCAT_JANYA_2026-09-21.md) excluded Tim and wabi.chat. It used disposable fixtures, not a Wabi production deployment or full application acceptance test.

- Direct UDP was established. A follow-up diagnostic client measured **3,461,052 incoming direct IPv4 tunnel bytes (about 3.46 MB), with zero incoming DERP bytes**, while downloading three 1 MiB files whose SHA-256 hashes all matched. The count includes protocol/tunnel overhead. The stock client independently logged direct delivery in a fresh session. Some outgoing traffic still used DERP; this does not mean all control traffic avoided relay.
- Relay fallback also delivered hash-verified files, including process-only forced-relay tests. This demonstrates scoped transfer correctness and fallback in that setup, not universal NAT traversal, a reliability percentage, or seamless migration of an active stream.
- **Saved-identity reconnect remains unresolved.** Later sessions against the still-running server can become stranded on DERP despite correct file delivery. The extended hardening run reproduced three relay-only reconnects. Endpoint reannouncement did not fix it, identity-specific state is not an established sole cause, and a new key is not a validated workaround. The sufficient root cause remains unknown; no ISP/CGNAT cause is established.
- **Lifecycle/status race timeline:** the initial audit observed `running=false` with a stale nonempty address and left an asynchronous reader race under investigation. Later same-day hardening identified stale child-reader publication and added generation-checked publication, with a deterministic regression that fails under the old behavior. This is a locally tested working-tree fix, not deployed certification. Preserve the original failure record; it is distinct from the still-open reconnect defect.

The [permanent regression harness](../../scripts/tailcat/README.md) retains real-network evidence and rejects the known reconnect failure. Offline replay checks assertion behavior, not multi-network reliability. Do not turn a passing evidence-parser test or an earlier lifecycle rerun into a claim that transport is fully fixed.

## Privacy: authorization without surveillance

Wabi may give admins information necessary for access control, security, moderation and operation: explicit grants, enrollment/revocation records, service health and proportionate security events. Limited device information should have a clear operational purpose and an explicit access boundary.

There should be a very high bar for collecting human-behavior or productivity telemetry: mouse movement, idle-time scoring, channel dwell time, engagement scores or similar employee-surveillance analytics. These are not an automatic extension of managing devices. Collecting more activity merely because the control plane can observe it conflicts with **authorization without surveillance**.

Self-hosted does not mean invisible to the server operator. **Current Wabi messages and DMs are server-readable. Tailcat/WireGuard transport encryption is not device-to-device message E2EE.** The Wabi host normally terminates this tunnel, and endpoint applications retain their own visibility. DERP relays encrypted tunnel traffic but can observe connection metadata, timing and sizes; it must not be described as anonymous. Other helpers, such as attachment caches, can have different payload visibility. Explain each boundary honestly rather than applying one blanket privacy claim to every component.

## Infrastructure sovereignty and modularity

Wabi deployments should not fundamentally depend on wabi.chat or one central Wabi-operated relay, authentication, discovery or update service. Relay/rendezvous and other optional infrastructure should remain replaceable and operator-configurable where technically feasible. Defaults must not quietly become mandatory trust or availability dependencies; integration design should document any technical limits to replacement.

This is a direction for self-hosting, jurisdiction/data residency, resilience and organizational control. The isolated test's exclusion of wabi.chat is evidence about that test, not proof that every infrastructure dependency is already replaceable. This is not a censorship-circumvention feature and does not call for traffic obfuscation or firewall-evasion mechanisms. Operators should use authorized connectivity within their network policies.

## Design guardrails

- Don't rebuild mature protocols unnecessarily; integrate existing tools and preserve their security semantics.
- Don't let connectivity imply authorization; independently enforce device, account, service and application boundaries.
- Don't let Wabi admin imply target-machine root or automatic target-service authentication.
- Don't expose whole LANs when one explicitly registered service is sufficient; fail closed on missing or invalid scope.
- Don't hard-code central Wabi infrastructure as an unavoidable dependency.
- Don't advertise transport encryption as message E2EE or relay use as anonymity.
- Keep optional heavy capabilities as addons, with clear dependencies and a usable core when disabled.
- Preserve auditable boundaries and regression tests, including hostile headers, account/admin denial, service scope and revocation, lifecycle ownership and real-network reconnect failures.
