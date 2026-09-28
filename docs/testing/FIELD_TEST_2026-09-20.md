# Controlled Wabi field test — 2026-09-20

Status: controlled pass complete, with the explicit failures, blockers and untested scenarios below. This is an internal field candidate, not a general release or calling certification.

## What this establishes

Iyoku/Janya, a Ryzen 7 3750H machine with about 15.4 GiB RAM, successfully ran a disposable packaged Authority. Native setup, authenticated chat persistence, stop/restart, backup/restore and quit/reopen passed. A coordinator client on a different observed internet uplink reached that Authority through the desktop Tailcat SOCKS/HTTP path after explicit test-device pre-enrollment.

The first package exposed a real WebSocket forwarding defect. Both forwarding layers discarded the downstream HTTP upgrade handle. Focused regression tests reproduced the resulting early EOF; retaining the incoming request's handle fixed both layers. The rebuilt package passed cross-network WebSocket connection and populated native channel state. The final run delivered 12 live messages over two minutes without refreshing the native receiving UI, then disconnected/reconnected successfully.

This does **not** establish fresh-user remote onboarding, physical calling, four-client capacity, helper effectiveness, long-duration stability, GPU/media performance, or independence from the existing management network. Those boundaries matter more than a connected badge.

## Machines and permitted changes

| Machine | Verified hardware / OS | Actual role and work |
|---|---|---|
| Coordinator | Ryzen 7 5800X, 8 cores/16 threads, ~31.2 GiB RAM, RTX 3070; Bazzite 44.20260914 | Builds, isolated native baseline, Tailcat native client and protocol probe. No physical mic/camera. Existing local Wabi preserved. |
| Iyoku / Janya | Ryzen 7 3750H, 4 cores/8 threads, ~15.4 GiB RAM, GTX 1660 Ti Mobile/Vega; Bazzite 44.20260919 | Principal disposable Authority and colocated native client. Updated deployment booted; no pending update transaction. Isolated portable AppImages/profiles only. Reported microphone not activated. |
| ironin | Ryzen 5 7520U, 4 cores/8 threads, ~14.9 GiB RAM, AMD Mendocino; Mint 22.3 | Read-only SSH inventory. Mobile hotspot. Reported camera/mic not activated; no package installation or GUI interference. |
| Tim | i7-7700HQ, 4 cores/8 threads, ~7.6 GiB RAM, GTX 1060/HD 630; Mint 22.3 | Read-only inventory and existing-service health/reference checks. Existing Wabi, Caddy, coturn and cloudflared preserved. No helper installed. |

All four SSH identities were verified with actual commands. Network checks observed four different public IPv4 egress addresses; UDP was available. Raw addresses are private. NTP was enabled/synchronized where inspected; durations use monotonic clocks. Different timezone labels were not used for one-way timing claims.

Redmi/mobile was excluded by the user. No firewall, production data, public listener, paid infrastructure, replication, standby or multi-Authority experiment was introduced. Only one disposable Authority was active at a time.

[Sanitized inventory](field-2026-09-20/inventory.json)

## Candidate and build provenance

Base checkout: `dcfa8a3b986eba964929cac10f94d9994744aef8`, branch `crash-harness-hardening`, already dirty before the campaign. Existing desktop-hosting and other work was preserved. Candidate builds used a separate source snapshot, not an assumed clean commit.

| Identity | Candidate A | Candidate B — forwarding fix |
|---|---|---|
| Source-manifest SHA-256 / compiled revision | `8f93a080d4047bf801091a822a5210feca485d98d9922793bd5c666a79f91f82` | `b092bff398160adcb5b82c11ff846b5eb5192cecfb5519d41636e437d8dd29e0` |
| AppImage SHA-256 | `9cee8b52ab51ce423d8f01ce81de7fb5b1583239e436d5fb5235dca34ce5dd0e` | `d8d647b97eeda2183b3366f97aadeabdf0936320ab5c0895024360d64ea5cec5` |

Both: Wabi Host Test 0.1.0, `chat.wabi.hosttest`, x86-64 release, embedded static frontend, Authority built with `addons`, bundled Tailcat 0.4.0 and media framework. Remote package checksums matched. Candidate B's runtime Authority identity and native compiled revision matched its source manifest. Post-build verification found no source-manifest mismatches.

Pinned path: Rust 1.93.1; Node 22.22.2; locked frontend dependencies via `npm ci`, Vite 8.2.2; Tauri CLI 2.11.4. An initially stale frontend dependency cache was replaced inside the isolated snapshot. Frontend check passed with 0 errors and 130 warnings; 18 desktop contract tests passed. Final Rust gates: 25 server integration tests, 5 Tailcat tests, 38 native library tests. Release startup and account/persistence/recovery smoke checks passed again after the fix.

Packaging needed build-local dependency discovery metadata, a newer-capable stripping workaround (`NO_STRIP=1`), packaged `patchelf`, and explicit Fedora GStreamer paths. No system packages were installed. These artifacts require glibc 2.43 and therefore cannot be distributed as working Mint/glibc 2.39 packages. An older supported build environment and Mint installation acceptance remain necessary.

The artifacts were launched as actual portable AppImages with isolated profiles. Desktop menu integration, an installer transaction, updater behavior and general distribution were not certified. The suspected Tailcat helper lookup problem did **not** reproduce in this AppImage: its launcher made the bundled helper available. No speculative resolver patch was applied.

[Build provenance](field-2026-09-20/build-provenance.json) · [A package](field-2026-09-20/package.json) · [B package](field-2026-09-20/package-b.json) · [Gates](field-2026-09-20/gates.json)

## Executed scenarios

| Run | Actual scenario | Functional result | Measurement limit |
|---|---|---|---|
| F01 | Candidate A, coordinator native client + local Authority; 30 s idle / 30 messages over 30 s / 30 s post-activity; native recovery | PASS | Localhost, one trial; no media or remote client |
| F02 | Same candidate/workload on Iyoku; native setup, 30 retained messages, restart, backup/restore, quit/reopen | PASS | Native IPC/DOM verified; remote screenshot capture unavailable |
| F03 | A, coordinator native Tailcat client → Iyoku; pre-enrolled device, login, 10 durable messages, 64 KiB upload/download, disconnect/reconnect | HTTP paths PASS; WebSocket FAIL | Native shell rendering alone did not prove live state; direct/relay path unknown |
| F04 | B, repeated Iyoku baseline and native recovery | PASS | Same 30 s phase lengths; no media; rendering not visually accepted on Iyoku |
| F05 | B, repeated cross-network transport; protected endpoint, version identity, WebSocket, native channel state and refresh | Those checks PASS; REST-to-live-message check FAIL | REST write did not produce the normal live chat event |
| F06 | B, normal-chat test preparation | Incomplete: harness clicked the channel wrapper rather than its button | Retained as a harness failure; not a product regression |
| F07 | B, corrected normal chat protocol, native receiving UI, short sustained run, disconnect/reconnect | PASS: 12 live updates / 120 s; disconnect/reconnect | Protocol sender colocated on coordinator; two physical computers, not four participants |

The [scenario manifest](field-2026-09-20/scenarios.json) records machines, networks, build IDs, layout, requested/observed routes, steps, expectations, actual results, evidence, limitations and measurement sufficiency. A deterministic checker validates required fields and evidence links; it does not manufacture functional proof.

### Access-path boundary

Pre-enrollment was deliberate and separate from the product onboarding verdict: the native client generated its device key; management SSH and the ordinary disposable owner account registered that key at the Authority. Wabi payload then traveled through the native local proxy → bundled Tailcat SOCKS → Tailcat listener/tagging forwarder → Authority loopback. Login credentials were sent through that path. No SSH HTTP tunnel or direct management-IP Wabi URL substituted for it.

Fresh-profile, invitation-only Tailcat enrollment remains **BLOCKED** by the current implementation. Pre-enrollment is not a passed new-user workflow.

Management Tailscale stayed active. Distinct public egress and an active Tailcat tunnel do not prove the tunnel's underlay was independent of every management interface. The active route is **unknown**, not assumed direct or relayed. A sanitized process socket observation records public TCP activity but does not establish per-flow route selection. No one-way or mouth-to-ear latency is claimed.

### Test tooling friction

The first remote launch lacked the appropriate desktop display environment. With that corrected, native control/DOM actions worked. Remote WebKit snapshots timed out, and X11 captures failed. A software-rendering diagnostic did not fix capture. Scored Iyoku runs used the default rendering configuration, but no visual acceptance is claimed there. The native receiving window on the coordinator was rendered and inspected.

Two initial F03 diagnostic requests used nonexistent endpoint paths and returned 404. Those were harness mistakes, not authorization/build-identity defects; the corrected B checks returned an unauthenticated 401 and the expected public build identity.

## Resource observations

CPU convention: 100% is one logical core. Each phase has 31 samples spanning ~30 s at 1 s intervals. These are descriptive, single-trial measurements, not capacity benchmarks.

| Candidate A phase | Coordinator Authority mean CPU / mean RSS | Iyoku Authority mean CPU / mean RSS |
|---|---|---|
| Idle | 0 sampled ticks / 26.7 MiB | 0 sampled ticks / 26.7 MiB |
| 30 durable chat writes | 0.07% / 28.3 MiB | 0.23% / 28.5 MiB |
| Post-activity | 0 sampled ticks / 28.8 MiB | 0 sampled ticks / 28.8 MiB |

Zero sampled ticks means below the observation's tick resolution, not literally no work. The UI process trees had very different activity/rendering conditions; their numbers are not evidence that one GPU or machine is faster. Existing coordinator applications contributed background load. All campaign builds and Hermes workers were stopped during the baseline windows.

The read-only collector exports per-process identity, CPU ticks/percentage, RSS, IO counters, host/interface counters, load, UTC labels, monotonic durations, and collector read time. First CPU samples are unavailable, not zero. Collection took roughly 22–25 ms of wall time per interval; that is not an isolated collector CPU measurement. RSS sums may double-count shared pages. The AppImage mount daemon, desktop compositor, driver, traffic-generating harness and collector are not all part of the native-client subtree; excluded processes are not silently treated as free.

Interface bytes are host-wide and must not be attributed to Wabi or summed across overlay/physical interfaces. Process IO counters do not prove physical device writes; retained data was verified independently after restart/restore. GPU, frame, codec, audio queue, per-participant media and application-attributed bandwidth measurements are unavailable here.

[Raw samples and resource summary](field-2026-09-20/resource-summary.json) · [Collector verification](field-2026-09-20/collector-validation.json)

## Helper and comparisons

No helper carried workload. Tim had existing coturn and domain ingress, but no observed isolated LiveKit SFU for this candidate. The implemented shared media controller needs a reachable Authority API and an independently client-reachable SFU/signaling/media endpoint. Deploying a new public service or changing Tim's existing service was prohibited. Pairing an idle controller would not answer the offload question.

Helper-off/on comparison: **BLOCKED**. Four-client deployment: **NOT TESTED**. Hardware comparison: local Authority observations retained, but no comparable calling workload or matched rendering conditions. Domain-versus-Tailcat comparison to the same test instance: **BLOCKED**; Tim's existing instance is a separate deployment and its healthy response is not equivalent evidence.

## Fix and remaining work

Fixed only the reproduced WebSocket forwarding defect in:

- `core/addons/tailcat/backend/src/forwarder.rs`
- `src-tauri/src/tailcat_proxy.rs`

Both now retain the downstream request's upgrade handle and pair it with the upstream connection's own handle. New tests require actual bidirectional bytes after HTTP 101. Both failed with early EOF before the change and pass afterward; the native field WebSocket probe also changed from timeout to success. Header-tagging and auth contract tests remain passing.

Temporary additions: the opt-in Linux metric collector and the report completeness checker. No AI dependency, broad refactor, database format change or auth weakening was added.

Prioritized remaining boundaries: fresh Tailcat enrollment; Mint-compatible packaging; verified application readiness instead of a child-alive badge; stable server/account identity across proxy-port and Authority restarts; active direct/relay observation; actual helper workload attribution; per-participant media statistics; visual acceptance on Iyoku; REST message writes' missing live notification. See the [diagnostic backlog](field-2026-09-20/diagnostic-backlog.json) for each missing observation, owner, minimum next change and verification method.

Physical two-person and group voice, everyone-hears-everyone, camera, screenshare, late joins, mute/deafen, capture denial/cancellation, ghost/duplicate audio, capture stopping on leave, network switching and failures during calls are **NOT TESTED**. Session/room authorization contract tests passed; field-level media isolation was not exercised. A two-minute chat run is not a long soak or a leak test.

## Evidence, budget and cleanup

Sanitized evidence is under `docs/testing/field-2026-09-20/`. Operator-private packages, source manifests, harnesses and raw logs/profiles are retained outside the repository under `~/.local/share/wabi-field-20260920/`; transient execution details also remain under `/tmp/wabi-field-20260920/` and the named private native-run directories. Do not commit profile databases, keys, connection addresses, credentials or raw window/message captures.

Four free LongCat/Hermes Ultra workers performed bounded preparation. One exhausted its output allowance without a final report; another reached its turn limit. Their findings were checked against source. Jev was unavailable and was not invoked. Codex owned decisions and validation. Weekly allowance moved from 40% remaining at the start to 31% remaining at the final check; that is an account-wide reading, not exact task-attributed billing.

All test Authorities, private-access listeners, native clients and client proxies were stopped after verification. Existing local Wabi and Tim’s containers remained running, and the public domain health check passed. See [cleanup verification](field-2026-09-20/cleanup.json). No persistent startup service is installed. The portable files/profiles can be removed later from the exact campaign directories after reviewing evidence; retain them if a rerun is wanted. Existing local Wabi and Tim production services are outside those directories and must not be stopped or deleted.

Remaining human work: allow a compatible package/client installation on ironin or another eligible device; visibly accept the native UI on Iyoku; run microphone/camera/screenshare checks with people present; then arrange an authorized, independently reachable SFU if helper comparison is still wanted. Fresh-user enrollment needs product implementation before it can pass.
