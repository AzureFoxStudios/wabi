# Iyoku roster scale experiment — 2026-09-24

## Scope

Iyoku (Bazzite, 8 logical CPUs, 15 GiB RAM) ran the current packaged release `wabi-server` binary (SHA-256 `78d1bf3b0f7cc070e0211a03cd494ea57392f3ed79921ba8bde82d610db7ae99`) in isolated `~/wabi-loadtest-20260924` and `~/wabi-loadtest-100` data directories. The old staging trees were not modified. Both servers bound only to Iyoku's Tailscale address; the load generator and native client reached them through private SSH tunnels from Ronin. The servers were alternated rather than run together during native client comparisons.

The larger dataset had 1,001 entries in `serverMembers`; the control had 101. Disposable accounts were created through the real registration API. Registration and its password-hashing CPU work completed before connection measurements. Each connection used a distinct registered account for the concurrent runs. The connection ramp started one login/connection task every 250 ms; its init timer started **after** login completed. Socket.IO used WebSocket transport. The 50 clients stayed connected briefly after receiving `init`.

## Results

| Roster | One-client `init` payload | Three isolated `init` samples | 50-client init p50 | 50-client init p95 | 50-client max |
| ---: | ---: | --- | ---: | ---: | ---: |
| 101 | 37,982 bytes | 149, 308, 396 ms | 385 ms | 787 ms | 1,098 ms |
| 1,001 | 353,593 bytes | 449, 816, 930 ms | 1,484 ms | 13,181 ms | 13,796 ms |
| 1,001, server restarted | ~353,595 bytes | — | 5,982 ms | 12,897 ms | 13,712 ms |

The initial 10-client trial on the 1,001-member server had 643 ms p50 and 1,568 ms p95. This does not establish a maximum capacity, but the 50-client p95 slowdown reproduced after a fresh server start. The large roster's `init` wire payload was about 9.3 times the control's. During the first 50-client hold, server process PSS was 104 MiB versus about 28 MiB when idle after account seeding. It remained near 102 MiB shortly after disconnect; allocator retention and a leak are not distinguished by this brief observation.

The real Tauri/WebKit desktop connected successfully to both datasets. Fresh-workspace, 15-second idle PSS (desktop + WebKit content + WebKit network, no local Authority) varied more than the roster effect we were trying to measure: 312 and 482 MiB for two default-renderer 1,001-member runs, and 358 MiB for the default-renderer 101-member run. With `WEBKIT_DISABLE_DMABUF_RENDERER=1`, the values were 371 and 399 MiB respectively. Idle CPU was 0.26–0.33% of one core. These samples **do not establish a client RAM growth slope**; the renderer/process variation is too large. Both workspaces showed 470 DOM nodes and one online user.

## Code path and next gate

`socketio/presence.rs` reads the full user list for **every** join, builds each complete user view with role, layout/media and badge lookups, then includes the whole roster in `init`. The frontend stores that array in `serverMembers`. This is a concrete per-connect path whose work and bytes grow with community membership. It is a likely contributor to the observed slowdown; the test did not separately time each query or serialization step.

Before claiming support for thousand-member communities, measure a revised join path under the same 101/1,001 × 50-client matrix, plus a one-hour soak and reconnect surge. The client-memory question needs a more stable measurement such as WebKit heap snapshots and repeated same-renderer process runs; these PSS samples are insufficient. Messages, voice/video, thousands of *simultaneous* clients, internet latency, and production operator hardware were not tested.

Reusable probes: `frontend/scripts/roster-scale-probe.mjs`, `frontend/scripts/roster-connection-load.mjs`, and `scripts/desktop-roster-profile.mjs`. Set `WABI_LOAD_URL`, `WABI_LOAD_USER`, `WABI_LOAD_PASSWORD`, and for the connection ramp `WABI_LOAD_USER_PREFIX`. Use only isolated test accounts and data.

## Follow-up: roster cache and test-path control

A server change now shares one complete `serverMembers` build across concurrent Socket.IO joins. Account, profile, layout, role, and badge writes invalidate that cache; a short expiry also forces refresh. The focused `cached_roster_refreshes_after_registration_and_profile_update` integration test passed. The release binary was built on Iyoku with the repository-pinned Rust 1.93 toolchain and two Cargo jobs (SHA-256 `8451d98dcd5efdbc4ab8e7530540b2ddcf7c4177435bcae6dcba5ba0c5b658f3`). The first attempt to build locally on iRonin exhausted swap and caused an OOM kill; the local release build was abandoned, and the test used the remote binary. No live deployment was changed.

The same 1,001-member data and 50 distinct accounts were tested with both old and new binaries, alternating one isolated server on port 38001. The script, 250 ms connection ramp, and 5-second hold were the same. All clients connected when the script ran **on Iyoku**:

| Load generator location | Server binary | Successful clients | Init p50 | Init p95 | Max |
| --- | --- | ---: | ---: | ---: | ---: |
| Iyoku (same host) | Cached roster | 50/50 | 15 ms | 25 ms | 283 ms |
| Iyoku (same host) | Previous binary | 50/50 | 18 ms | 31 ms | 268 ms |
| iRonin over one SSH/Tailscale tunnel | Previous binary | 31/50 | — | — | 19 init timeouts at 30 s |
| iRonin over one SSH/Tailscale tunnel | Cached roster | 30/50 | — | — | 20 init timeouts at 30 s |

The old and new binaries perform similarly on each test path. The large original slowdown therefore cannot be attributed solely to repeated roster projection reads. Each `init` still sends about 354 KB per client. The tunneled run includes iRonin, Tailscale, and a single SSH forwarding connection; it is **not** a clean server capacity measurement and does not establish which part of that path is limiting. The cache is a bounded server-side work reduction, not a fix for the 50-client cross-machine timeout. The next useful investigation is to measure bytes and throughput at each hop and reduce or defer the full directory payload on join without losing the offline People/DM/admin experience. The isolated servers and tunnel were stopped after the comparison; datasets were retained.
