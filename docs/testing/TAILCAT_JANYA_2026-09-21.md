# Tailcat transport field test — 2026-09-21

## Follow-up: actual direct file payload confirmed

The follow-up closes the original direct-payload evidence gap. With Janya hosting the unchanged release server, a fresh SOCKS session downloaded three random 1 MiB files with matching SHA-256. A diagnostic client exposing the existing magicsock counters measured **3,461,052 incoming direct IPv4 tunnel bytes and zero incoming DERP bytes**. The excess over 3 MiB is tunnel/protocol overhead. Some outgoing traffic still used DERP; this is not a claim that all connection/control traffic avoided relay.

The unmodified release client independently logged `now using` the server public UDP endpoint and `via=direct` while downloading three verified files in a fresh session. The diagnostic client used the same dependency versions but default build features rather than the release's stripped features. Its counters expose existing transport measurements; active discovery was disabled for the successful fresh-server run.

### Reconnect defect reproduced, not fixed

After the initial session, restarting the client with the same saved identity against the still-running server repeatedly produced relay-only downloads. One instrumented baseline measured 3,460,996 incoming DERP bytes and zero incoming direct bytes. Files remained correct and reachable.

The server's existing-peer admission branch skips endpoint reannouncement. A one-line experimental change to reannounce on that branch did **not** fix reconnects: its first session went direct, but its next session measured 3,462,204 incoming DERP bytes and zero incoming direct bytes. Explicit same-client discovery for up to 30 seconds also remained relayed. Therefore missing reannouncement is a suspect, **not an established sufficient root cause**. Do not ship the rejected candidate as a fix. Remaining investigation concerns reconnect endpoint state/NAT mapping and discovery handling.

No claim of universal direct traversal or confirmed ISP CGNAT follows from these results. Tim and wabi.chat were excluded throughout. The practical result is direct file delivery on fresh sessions, working relay fallback, and a reproducible loss of direct delivery on identity reuse in this setup.

### Follow-up evidence and reproduction

[Measurements](tailcat-janya-2026-09-21/followup-results.json) distinguish stock, diagnostic, and candidate runs. The diagnostic patch and read-only magicsock counter accessor are alongside those measurements; the rejected server change is explicitly named `reannounce-rejected.patch`. They are experimental evidence, not changes to Wabi's bundled sidecar.

Source used for diagnosis: v0.4.0 tag. Its tailcat.go, CLI file, go.mod and go.sum were byte-checked against the shipped binary's embedded revision ce6fedcabc220bab3b94d470ab330219111eeae8. Binary hashes are in the results. Raw logs and runner scripts are private under ~/.local/share/tailcat-janya-field-20260921/followup.

Reproduce with a fresh loopback-only random file server and allowlisted Tailcat listener on Janya. Run the diagnostic SOCKS client with active discovery unset, wait for its listening socket, download three 1 MiB files, compare hashes, and record final per-path counters. Stop only the client, start another with the same key against the unchanged listener, and repeat. The client waits for readiness; an earlier optional-discovery trial that raced startup is excluded, not counted as a transport failure.

All follow-up fixtures were stopped and remote test files removed. No production service, packaged sidecar, or firewall was changed.

## Initial run (superseded only where the follow-up provides new evidence)

Server: Janya (Iyoku); client: Ronin. Tim and wabi.chat were not used. No Wabi production services, firewall rules, router mappings, or host VPN settings were changed. SSH over the existing management VPN started/stopped the disposable fixture; file payloads used Tailcat SOCKS. This is a transport fixture test, not Wabi application acceptance.

## Results

- Pinned Tailcat v0.4.0: route probe first replied via DERP(tok), 207.82 ms, then direct public IPv4 UDP, 21.84 ms (`ping --until-direct --timeout=30s`, exit 0). One trial, not a reliability estimate.
- Public peer routes selected Wi-Fi on both ends: Ronin wlp6s0 and Janya wlp3s0, not tailscale0.
- Normal SOCKS client: three 1 MiB downloads, all SHA-256 correct, 2.800 / 2.746 / 2.804 seconds. Logs showed DERP contacts; no direct file path was established by the evidence.
- Process-only forced relay: TS_DEBUG_ALWAYS_USE_DERP=true and TS_DEBUG_NEVER_DIRECT_UDP=true. Runtime explicitly logged UDP4 and UDP6 disabled. Three 1 MiB downloads all correct, 2.668 / 2.296 / 1.932 seconds.
- New normal client after removing impairment: three further verified downloads, 3.351 / 2.089 / 2.344 seconds. This is restart/reconnect recovery, not uninterrupted migration of an active stream.
- Total: nine verified MiB. Disposable random payload held in Janya memory, service bound only to loopback, Tailcat listener allowlisted only the test client key.

## Boundaries

NAT traversal was demonstrated. ISP-level CGNAT was **not confirmed**: Janya had a private LAN address and a different public address; this alone does not identify carrier NAT. Read-only NAT-PMP external-address queries timed out at both routers. Router WAN address or ISP evidence is still needed.

Direct UDP probe success must not be described as direct UDP file-transfer success. Normal SOCKS sessions showed relay contacts, and no packet capture was available to establish every payload packet's path. Forced-relay payload success is supported by the client's explicit UDP-disable logs. Relay test changed only child-process environment, not host networking.

[Upstream magicsock source](https://raw.githubusercontent.com/tailscale/tailscale/main/wgengine/magicsock/magicsock.go) documents the force-DERP switch; the pinned binary independently confirmed its effect in runtime logs. Current upstream source is explanatory, not a pinned build provenance claim.

## Evidence and cleanup

Sanitized measurements and binary SHA-256: [results.json](tailcat-janya-2026-09-21/results.json). Raw logs and reproduction scripts remain operator-private under ~/.local/share/tailcat-janya-field-20260921; they contain network addresses. No keys or connection blobs are published.

The remote fixture exited, its owned process check was empty, and its temporary files/binary were removed. Local SOCKS clients exited and the temporary client key was deleted. Production was not deployed or modified.

## Permanent regression harness

The reusable [two-host regression](../../scripts/tailcat/README.md) and pinned counter-client builder now live in the repository. The final runner was executed against Janya, with successful cleanup, and returned **exit 1 / RECONNECT_REGRESSION** as intended for the unfixed defect. Fresh incoming counters: 3,461,276 direct IPv4 bytes, zero DERP. Reconnect: zero direct IPv4 bytes, 3,461,612 DERP. All six 1 MiB file hashes matched. [Saved exact runner counters](tailcat-janya-2026-09-21/permanent-runner-results.json).

CI separately replays saved evidence through the assertion logic. It does not claim to provide a real multi-network CI environment. A successful offline test means the known bad reconnect is still rejected, not that the defect has been fixed.
