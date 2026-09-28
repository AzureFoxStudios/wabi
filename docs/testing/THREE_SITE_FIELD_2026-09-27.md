# Three-host regional access field check — 2026-09-27

**Scope:** Disposable main Wabi Authority and two stateless Anchors. This is a partial Gate A result, not recovery, local room ownership or high availability.

**Current placement:** After the operator reported another iRonin move, the
[2026-09-28 run](THREE_SITE_FIELD_2026-09-28.md) again qualified three distinct
uplinks and added authenticated WebSocket clients running on Ronin and Iyoku.
The historical observations below retain their original network qualification.

## Placement and transport

| Test role | Computer | Process | Member-facing path |
|---|---|---|---|
| Roofing/fabrication | Iyoku | Authority | Tailscale private IPv4, TCP 3000 |
| Materials/sales | Ronin | Anchor | Tailscale private IPv4, ephemeral TCP port |
| Equipment storage | iRonin | Anchor | Local Tailscale IPv4, ephemeral TCP port |

These are simulated business roles for the test. The computers were not installed at the partner's roofing, materials and equipment facilities, and no real business workflow was exercised.

The three computers returned three different public IPv4 egress values during this run. Only their equality was compared; the addresses, Tailcat tokens and disposable account credentials are not recorded here. The test used private HTTP over the existing Tailscale tailnet, not Tailcat or a public-IP HTTPS deployment. No domain was used. Iyoku's existing firewall policy already allowed TCP 3000 and Ronin's allowed the tested high port; no firewall policy was changed. An initial random Authority port failed with `No route to host`, which is why the check was rerun on port 3000. Iyoku's first owner was created through a loopback-only SSH forward before its Authority bound the private network address.

All three processes used the same static-frontend release `wabi-server` build, SHA-256 `d3e28fd3a42e7bded8c760e4560493043a39c0d6c2feb5c594096c6eb4aa4fad` (`--features addons`, x86-64 Linux, Wabi 0.1.0 working tree). The build does not embed a source revision; the repository HEAD at build time was `cf00e3cb` with uncommitted changes. Each process used its own disposable temporary data path. This check did not touch existing Wabi installations or data on those computers.

## Observed behavior

`scripts/three-site-real-authority-smoke.mjs`, in field-config mode, returned `PASS` for:

- Owner and member authentication through different entry points, a signed three-entry community roster, durable shared history, Engine.IO polling and two Socket.IO WebSocket sessions.
- Live messages accepted and delivered in both directions across the two Anchors, with canonical message IDs.
- A resumable upload through Ronin, followed by a cross-Anchor download with a verified cache miss and hit. Each Anchor served the same 28,424-byte versioned app chunk locally, byte for byte, with `X-Wabi-Anchor-Static: local`.
- A client process running **on Ronin** used its local Anchor to sign in, read history, fetch that app chunk and create a write visible through the other site. The four sequential HTTP operations took 540 ms in that sample. A client process running **on Iyoku** repeated those actions through the Authority in 237 ms. These are whole-sequence samples, not isolated message latency or throughput benchmarks.
- After Ronin's Anchor stopped, the surviving equipment Anchor accepted another canonical write. After the Authority stopped, it returned 503 for chat API and cached upload requests while still serving the public embedded app chunk. It did not claim authority or accept community writes.

## Acceptance boundary

This establishes three-host, three-egress **regional API access over Tailscale** and scoped local static-file/cache behavior. It does not finish Gate A: the same Tauri desktop build was not operated at all three sites; signed-roster reconnect and local offline state were not observed from those desktops; call/media placement, long-lived sessions, per-site Authority egress bytes, cache hit rate and origin bandwidth were not measured. The Ronin and Iyoku client processes exercised HTTP, while the local harness exercised WebSocket. It is not a Tailcat field result or a tailscaleless/public-IP result.

The expected outage after Authority loss directly contradicts any Gate B/C survival claim. No local room owner, standby promotion, election, quorum or split-brain test ran here. Keep Gates B, C and D open.

## Follow-up: byte-metered three-computer run

A later disposable run used the same three computers and placements with a frontend-embedded debug build (`--features field-embed,addons`), stripped only of debug symbols before transfer. All three Wabi processes used binary SHA-256 `70e0fea0fa027524bd176c4a70bb62f24ba788600b8a3c3e4bb20fdb2f9dffd0`. The source checkout was still `cf00e3cb` with uncommitted changes. Each Anchor pointed through a temporary **loopback-only** TCP byte meter on its own computer to Iyoku's Authority over Tailscale. The meters counted HTTP wire bytes at the Anchor-to-Authority boundary; they did not read content or measure whole-interface traffic.

The full `scripts/three-site-real-authority-smoke.mjs` flow passed again: sign-in, signed roster, polling, two WebSockets, bidirectional live/durable messages, upload/download, one-Anchor loss, and the expected 503 after Authority loss. Both Anchors served the same 28,424-byte versioned app chunk locally. The meters counted **zero Authority-to-Anchor bytes** during those two asset requests. A 262,144-byte upload downloaded through the equipment Anchor had these per-request counts:

| Equipment cache response | Authority to Anchor | Anchor to Authority |
|---|---:|---:|
| Miss | 263,175 bytes | 1,107 bytes |
| Hit after fresh HEAD check | 504 bytes | 554 bytes |

The hit therefore avoided retransmitting the file across that measured Anchor uplink in this run. It still required an Authority validation request and still returned 503 once the Authority stopped. The remote client probes' four sequential HTTP operations took 1,398 ms on Ronin and 1,180 ms on Iyoku; these are small samples, not throughput or latency distributions. The metrics cover this chosen static asset and upload, not all application, media or call traffic.

**Network qualification changed:** fresh queries to two public IPv4 echo services produced the same egress value for iRonin and Iyoku, and a different one for Ronin. Tailscale reported Iyoku's current endpoint as a `192.168.1.11` LAN address from iRonin. The operator confirmed that iRonin returned to Iyoku's network between the two runs, explaining why the earlier three-egress observation and this two-egress observation differ. Treat the physical three-network Gate A requirement as **open** for the current placement until three separate locations are verified together during a run. This result is three-computer access and scoped byte offload over Tailscale. It still does not cover the same Tauri desktop at all sites, Tailcat/public-IP entry, live calls, sustained sessions, privacy races, recovery, or local room ownership.

The field harness stopped all test processes and removed its local data. The two remote binaries, remote data/log directories, local stripped binary, and field configuration were removed after the run. Existing Wabi installations and firewall rules were not changed.

## 2026-09-28 route inventory before another field run

A read-only tailnet inventory found the peers named `192`, `bazzite` and `tim-Predator-G3-572` online. One Tailscale ping to each returned through the Singapore DERP relay; the `192` peer also advertised a local LAN endpoint. Relay reachability and a computer count do not prove three independent public uplinks. The operator had already confirmed iRonin with Iyoku at one site and Ronin with Tim at another, so the third physical site remains unverified. Tim's fresh Tailscale SSH browser approval was not completed before the connection timed out; no command ran on Tim during this follow-up. Do not reuse this route inventory as Gate A or as a three-site traffic measurement.

### Authentication follow-up — 2026-09-28, 00:57 UTC

After the operator approved the browser authentication, a fresh read-only
Tailscale SSH connection as `tim` succeeded and returned hostname
`tim-Predator-G3-572` with exit status zero. Tim's and the local computer's
Tailscale status checks both then reported a direct path between them. The
inventory still showed `192` and `bazzite` online and the phone offline.
This confirms authenticated remote-command access at that moment. No Wabi
process, installation, firewall rule or live data was changed on Tim. It does
not establish a third physical network or any Wabi acceptance gate.

### Authentication recheck — 2026-09-28, 01:47 UTC

Following the operator's additional approval message, a fresh bounded,
read-only Tailscale SSH hostname check as `tim` again returned
`tim-Predator-G3-572` with exit status zero. The check made no installation,
firewall or live-data changes. It confirms login access only; the physical
three-network requirement remains open.
