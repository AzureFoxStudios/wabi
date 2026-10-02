# Three-uplink bounded Wabi field check — 2026-10-01

**Result:** PASS for the executed transport and bounded chat assertions.
Main Wabi candidate; no merge, deployment, automatic recovery or capacity
certification. Gates A–D remain open.

## Build and network qualification

Execution computer: dotRonin, `/home/ironin/wabi`, branch
`codex/security-boundary-hardening-20260930`, base HEAD
`138abe39e08e400188d1812ed3bfd378df435315` with shared uncommitted changes.
After dotRonin's interruption, the September 30 frozen `field-embed` binary
survived in its disposable remote stages. Its recovered local copy and both
fresh remote copies matched SHA-256
`4b4814f5db6e6056b4f30908354e2d5f1ba4173c305a378e3a5ccec5d69a0e45`
and 153,260,768 bytes. This debug binary has stripped debug symbols and embeds
the matching frontend. It does **not** represent every subsequent October 1
security/organizer edit. No local Rust rebuild was needed.

Immediately before this run, independent internet egress queries from dotRonin,
Iyoku and Ronin observed **three distinct IPv4 egresses**. Addresses are not
retained in the receipt. SSH authentication succeeded, including a fresh
user-approved Tailscale check. Disposable roles were Iyoku Authority, Ronin
materials Anchor and dotRonin equipment Anchor. Traffic used Tailscale private
IPv4; no firewall rules or production services were changed. This is a physical
network protocol check, not an installed desktop, Tailcat or public-IP test.

## Executed workload and failures

The existing real-Authority harness ran with six clients, twenty 512-byte
messages, a two-message/second ceiling and a 90-second deadline. The
[field receipt](geographic-2026-10-01/field-load-receipt.json) records:

| Measurement | Result |
|---|---:|
| Connected clients / provided credentials | 6 / 2 |
| Acknowledged messages | 20 / 20 |
| Observed / expected deliveries | 120 / 120 |
| Missing, duplicate or mismatched-ID deliveries | 0 |
| Achieved message rate | 1.97 / second |
| Acknowledgment p95 | 286.30 ms |
| Delivery p95 | 322.40 ms |

The workload sessions originate on dotRonin. Separate authenticated HTTP and
WebSocket probes originate on both remote computers; accepted message IDs
matched delivered messages and cross-site durable history. Two credentials
are reused, so six connections do not mean six accounts. Envelope-byte counts
are not whole-network traffic. No saturation, calls or reconnect workload ran.

Both Anchors served the same 27,277-byte versioned app asset locally, with zero
Authority-to-Anchor bytes for those requests. A 262,144-byte upload miss used
263,175 Authority-to-Anchor bytes; its subsequent hit used 504 bytes for fresh
validation. These are scoped measurements. Stopping one Anchor left a write
through the other successful. Stopping the Authority returned 503 for community
API/cached-file requests while a public app asset stayed local. That outage
confirms the current Authority dependency; the test did not recover it.

An independent loopback run using the **same frozen binary** also passed
6/20/120 with zero missing/duplicate/mismatched IDs; acknowledgment p95 was
18.60 ms and delivery p95 was 18.91 ms. Its
[receipt](geographic-2026-10-01/frozen-local-load-receipt.json) is separate from
the physical-network evidence.

## Cleanup and outstanding work

The harness closed its owned processes and sockets. A subsequent audit found
zero remaining test processes on both remote computers, then removed both the
old September 30 stages and fresh October 1 stages. Removed logical bytes were
307,327,976 on Iyoku and 306,833,586 on Ronin; the recovered 153,260,768-byte
local binary was removed too. Production installations, data and normal build
outputs were preserved. See the [cleanup receipt](geographic-2026-10-01/cleanup-receipt.json).

This supersedes the September 30 pending field launch; that earlier NOT_RUN
receipt remains accurate for its date. The shared Codex test geographic card
records the continuation. Full desktop/media acceptance, whole-instance clean
restore validation, durable writer authority/fencing, automatic recovery,
regional room owners and measured capacity remain in the
[master plan](../plans/2026-09-26-geographic-community-nodes.md).
`fullInstanceReady` remains false. No Lore revision or synchronization is
established by this test.
